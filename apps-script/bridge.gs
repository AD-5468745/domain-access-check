/**
 * 접속점검 브리지 (Google Apps Script) — 시트 + 텔레그램 전체 조작 + 스케줄
 * ─────────────────────────────────────────────────────────────────────────
 * 이 스크립트 하나가 '두뇌' 역할을 한다. 서버·요금·카드 등록이 필요 없다.
 *
 *   담당자 ──텔레그램 채널──▶ 이 스크립트 ──▶ 구글시트 (즉시 반영)
 *                                    └──▶ GitHub Actions (한국 IP 점검) ──▶ 결과 회신
 *
 * 담당자가 채널에서 할 수 있는 것(전부):
 *   도메인 추가·삭제·주소변경·업체이동 / 업체 추가·삭제·이름변경 / 목록·상태 보기
 *   지금 점검 / 점검시각 변경 / 알림수준 변경 / 일시중지·재개 / 되돌리기 / 도움말
 *
 * 시트 탭 (자동 생성)
 *   접속점검  담당자가 관리하는 도메인 목록(1행 업체명, 열 하나=업체, 세로로 주소)
 *   결과      최근 점검 결과 표
 *   이력      누가 언제 무엇을 바꿨나
 *   시스템    잘 돌고 있는지(마지막 점검·설정·오류) ← 운영자 모니터링용
 *   _백업     되돌리기용(숨김)
 *
 * 스크립트 속성 (⚙️ 프로젝트 설정 → 스크립트 속성)
 *   [필수] ACCESS_TOKEN      웹앱 URL 잠금용 아무 문자열. GitHub SHEET_BRIDGE_TOKEN 과 동일하게.
 *   [필수] BOT_TOKEN         텔레그램 봇 토큰
 *   [필수] ALLOWED_CHAT_IDS  조작을 허용할 채널 chat_id(쉼표로 여러 개). 비면 조작 전면 거부.
 *   [필수] GITHUB_TOKEN      GitHub Fine-grained 토큰(Actions: Read and write)
 *   [필수] GITHUB_REPO       예) myid/domain-access-check
 *   [선택] WORKFLOW_FILE     기본 check.yml
 *   [선택] GIT_REF           기본 main
 *   [선택] WEBHOOK_SECRET    텔레그램 비밀헤더(아무 문자열). 넣으면 보안이 한 단계 더 올라감.
 *   [선택] WEBAPP_URL        setupAll 이 URL을 못 찾을 때만 직접 지정(/exec 로 끝나는 주소)
 *   [선택] GITHUB_TOKEN_EXPIRES  GitHub 토큰 만료일(YYYY-MM-DD). 30일 전부터 채널에 알림.
 *
 * ※ 코드를 고친 뒤에는 [배포 → 배포 관리 → 편집 → 새 버전]으로 재배포해야 반영된다.
 */

// ═══════════════════════════════════════════════════════════════════
// 설정값
// ═══════════════════════════════════════════════════════════════════
var SHEET_INPUT  = '접속점검';
var SHEET_RESULT = '결과';
var SHEET_LOG    = '이력';
var SHEET_SYS    = '시스템';
var SHEET_BACKUP = '_백업';

var MAX_COMPANIES = 15;      // A~O
var MAX_DOMAINS_PER_CO = 200;
var LOG_KEEP = 500;          // 이력 최대 보관 행수
var STATE_TTL = 300;         // 대화 상태 유지 시간(초)
var TG_LIMIT = 3500;         // 텔레그램 메시지 분할 기준(한도 4096보다 여유 있게)
var WATCHDOG_MIN = 25;       // 점검 요청 후 이 시간 안에 결과가 없으면 경고

// ★ 깨우기형 대기조(relay) — 담당자가 조작을 시작한 순간에만 깃허브에서 '빠른 응답조'를 띄운다.
//   평소엔 꺼져 있다(24시간 놀리지 않는다). 살아 있는 동안 버튼 반응이 0~59초 → 1~3초.
var RELAY_IDLE_MIN = 20;         // 채널이 이만큼 조용하면 대기조가 스스로 꺼진다(분)
// ★ 2026-09-05 실측으로 조정.
//   대기조가 조용히 죽었는데 '살아있음' 표시가 오래 남으면, 그동안 1분 폴링도 물러나 있어
//   버튼이 아예 안 먹는 것처럼 보인다. 하트비트 주기(약 20초)의 세 배로 줄인다.
var RELAY_ALIVE_MS = 60000;      // 하트비트가 이 시간 안에 없으면 죽은 것으로 보고 1분 방식으로 복귀
var RELAY_WAKE_COOLDOWN_MS = 25000;  // 죽은 대기조를 빨리 대체할 수 있게 짧게

var COL_LETTERS = 'ABCDEFGHIJKLMNO';

// ═══════════════════════════════════════════════════════════════════
// <<<PURE-LOGIC-START>>>  ※ lib/core.js 와 **완전히 같은 알고리즘**이어야 한다.
//    test/check.test.mjs 가 이 블록을 잘라내어 core.js 와 대조 검증한다.
// ═══════════════════════════════════════════════════════════════════
function isIPv4_(host) {
  var parts = String(host).split('.');
  if (parts.length !== 4) return false;
  for (var i = 0; i < 4; i++) {
    var p = parts[i];
    if (!/^\d{1,3}$/.test(p)) return false;
    if (Number(p) > 255) return false;
    if (String(Number(p)) !== p) return false;
  }
  return true;
}

function normalizeDomain_(raw) {
  if (raw === null || raw === undefined) return null;
  var s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/^[\s"'`<([]+/, '').replace(/[\s"'`>)\],.;]+$/, '');
  if (!s) return null;
  if (/\s/.test(s)) return null;

  s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  s = s.split('/')[0].split('?')[0].split('#')[0];
  s = s.replace(/^[^@]*@/, '');
  s = s.replace(/:\d+$/, '');
  s = s.toLowerCase().replace(/\.+$/, '');
  if (s.indexOf('www.') === 0) s = s.slice(4);

  if (!s || s.length > 253) return null;
  if (s.indexOf('.') === -1) return null;
  if (isIPv4_(s)) return s;
  if (s.indexOf(':') !== -1 || s.indexOf('[') !== -1) return null;

  var labels = s.split('.');
  if (labels.length < 2) return null;
  for (var i = 0; i < labels.length; i++) {
    var l = labels[i];
    if (!l || l.length > 63) return null;
    if (l.charAt(0) === '-' || l.charAt(l.length - 1) === '-') return null;
    if (!/^[a-z0-9à-ÿЀ-ӿ぀-ヿ㐀-鿿가-힣-]+$/.test(l)) return null;
  }
  var tld = labels[labels.length - 1];
  if (!/^([a-z]{2,}|xn--[a-z0-9-]+)$/.test(tld)) return null;
  return s;
}
// <<<PURE-LOGIC-END>>>

// ═══════════════════════════════════════════════════════════════════
// 공통 유틸
// ═══════════════════════════════════════════════════════════════════
function props_() { return PropertiesService.getScriptProperties(); }

/**
 * ★ 명령을 받는 방식은 두 가지고, 둘은 동시에 못 쓴다(텔레그램 제약).
 *   'poll'    — 앱스스크립트가 1분마다 가지러 간다 + 깃허브 대기조(기본값, 서비스 0개)
 *   'webhook' — 클라우드플레어 즉답기가 받아서 넘겨준다(가장 빠름)
 *   전환: setupEdge() / setupPolling()
 */
function mode_() { return prop_('MODE', 'poll') === 'webhook' ? 'webhook' : 'poll'; }

/**
 * ★ 설정값 읽기는 한 번 실행에 스무 번 넘게 일어난다. 그때마다 구글에 물어보면
 *   그것만으로 몇 초가 쌓인다(2026-09-05 반응 지연 원인 중 하나).
 *   실행 한 번 동안은 통째로 한 번만 읽어 기억해 둔다.
 *   실행이 끝나면 사라지므로 '옛 값이 남는' 문제가 없다.
 */
var PROP_MEMO = null;

function propAll_() {
  if (!PROP_MEMO) {
    try { PROP_MEMO = props_().getProperties() || {}; }
    catch (e) { PROP_MEMO = {}; }
  }
  return PROP_MEMO;
}

function prop_(key, fallback) {
  var all = propAll_();
  var v = Object.prototype.hasOwnProperty.call(all, key) ? all[key] : null;
  return (v === null || v === undefined || v === '') ? (fallback === undefined ? '' : fallback) : v;
}

function setProp_(key, value) {
  props_().setProperty(key, String(value));
  propAll_()[key] = String(value);      // 기억해 둔 값도 같이 갱신(같은 실행 안에서 어긋나지 않게)
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function esc_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 시트에 쓰기 전 안전 처리.
 * 구글시트는 = + - @ 로 시작하는 글자를 '수식'으로 실행한다.
 * 누군가 업체명이나 결과값에 =IMPORTXML(...) 같은 걸 넣으면
 * 시트 주인 계정이 그 주소로 접속해 데이터를 밖으로 보내게 된다 → 앞에 ' 를 붙여 글자로 고정.
 */
function safeCell_(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (v === null || v === undefined) return '';
  var s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) return "'" + s;
  return s;
}

function safeRow_(row) {
  var out = [];
  for (var i = 0; i < row.length; i++) out.push(safeCell_(row[i]));
  return out;
}

/** UTF-8 바이트 기준으로 자른다 — 앱스스크립트 속성은 글자수가 아니라 바이트(9KB)로 제한된다 */
function byteLen_(s) {
  return Utilities.newBlob(String(s)).getBytes().length;
}

/** 텔레그램 리포트를 안전하게 보관용으로 줄인다: 인용블록 경계에서만 자르고, 바이트 상한을 지킨다 */
function trimReport_(text, maxBytes) {
  var t = String(text || '');
  if (byteLen_(t) <= maxBytes) return t;
  var blocks = t.split('\n\n');
  var out = '';
  for (var i = 0; i < blocks.length; i++) {
    var next = out ? out + '\n\n' + blocks[i] : blocks[i];
    if (byteLen_(next) > maxBytes - 60) break;
    out = next;
  }
  return out ? out + '\n\n(이하 생략 — 전체는 시트 결과 탭에서)' : '(리포트가 너무 길어 보관하지 못했습니다)';
}

function nowKst_() {
  return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
}

function kstHour_() {
  return Number(Utilities.formatDate(new Date(), 'Asia/Seoul', 'H'));
}

function kstDayHourKey_() {
  return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMddHH');
}

function ss_() { return SpreadsheetApp.getActive(); }

function sheet_(name, create) {
  var sh = ss_().getSheetByName(name);
  if (!sh && create) sh = ss_().insertSheet(name);
  return sh;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('다른 작업이 진행 중입니다. 잠시 뒤 다시 시도해 주세요.');
  try { return fn(); } finally { lock.releaseLock(); }
}

// ═══════════════════════════════════════════════════════════════════
// 설정 (담당자가 채널에서 바꿀 수 있는 값)
// ═══════════════════════════════════════════════════════════════════
function settings_() {
  var hours = prop_('CHECK_HOURS', '9,21').split(',')
    .filter(function (h) { return /^\s*\d+\s*$/.test(h); })
    .map(function (h) { return Number(String(h).trim()); })
    .filter(function (h) { return h >= 0 && h <= 23; });
  if (!hours.length) hours = [9, 21];
  return {
    hours: hours,
    notify: prop_('NOTIFY_LEVEL', 'all') === 'problem' ? 'problem' : 'all',
    paused: prop_('PAUSED', 'no') === 'yes',
  };
}

function settingsText_() {
  var s = settings_();
  return [
    '⚙️ 현재 설정',
    '',
    '<blockquote>점검 시각 : 매일 ' + s.hours.map(function (h) { return ('0' + h).slice(-2) + '시'; }).join(' · ') + ' (한국시간)',
    '알림 수준 : ' + (s.notify === 'all' ? '항상 받기(정상이어도 발송)' : '문제 있을 때만'),
    '자동 점검 : ' + (s.paused ? '⏸ 일시중지됨' : '▶️ 켜짐') + '</blockquote>',
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// 데이터 모델 — '접속점검' 탭 읽기/쓰기
// ═══════════════════════════════════════════════════════════════════
/**
 * ★ 시트 읽기는 이 시스템에서 가장 비싼 동작이다(한 번에 1~3초).
 *   버튼 한 번에 이 읽기가 두세 번 일어나 반응이 느렸다(2026-09-05 실측: 한 건 7~19초).
 *   그래서 아주 짧게 캐시한다 — 봇으로 고치면 즉시 무효화되므로 담당자는 항상 최신을 본다.
 *   사람이 시트를 직접 고친 경우에만 최대 MODEL_CACHE_SEC 초 동안 옛 목록이 보일 수 있다.
 */
var MODEL_CACHE_SEC = 25;
var MODEL_CACHE_KEY = 'model:v1';

function invalidateModel_() {
  try { cache_().remove(MODEL_CACHE_KEY); } catch (ignore) {}
}

/** → [{name:'누드티비', domains:['a.com', ...]}, ...] */
function loadModel_() {
  try {
    var hit = cache_().get(MODEL_CACHE_KEY);
    if (hit) return JSON.parse(hit);
  } catch (ignore) {}
  var fresh = readModel_();
  try { cache_().put(MODEL_CACHE_KEY, JSON.stringify(fresh), MODEL_CACHE_SEC); } catch (ignore2) {}
  return fresh;
}

/** 시트에서 진짜로 읽어온다(캐시를 거치지 않는다) */
function readModel_() {
  var sh = sheet_(SHEET_INPUT, true);
  var lastRow = Math.max(1, sh.getLastRow());
  var lastCol = Math.min(Math.max(1, sh.getLastColumn()), MAX_COMPANIES);
  var v = sh.getRange(1, 1, lastRow, lastCol).getDisplayValues();

  var out = [];
  for (var c = 0; c < lastCol; c++) {
    var name = String((v[0] || [])[c] || '').trim();
    var list = [];
    for (var r = 1; r < lastRow; r++) {
      var t = String((v[r] || [])[c] || '').trim();
      if (!t) continue;
      var d = normalizeDomain_(t);
      if (d && list.indexOf(d) === -1) list.push(d);
    }
    if (name || list.length) out.push({ name: name || (COL_LETTERS.charAt(c) + '열'), domains: list });
  }
  return out;
}

function saveModel_(model) {
  invalidateModel_();          // 고쳤으면 캐시는 즉시 버린다
  var sh = sheet_(SHEET_INPUT, true);
  var maxLen = 0;
  for (var i = 0; i < model.length; i++) maxLen = Math.max(maxLen, model[i].domains.length);

  // 예전 내용이 남지 않도록 '예전에 쓰던 범위'까지 함께 덮어쓴다(빈칸으로).
  // 단 P열(16번째) 이후는 건드리지 않는다 — 사람이 적어둔 메모가 지워지면 안 되니까.
  var oldRows = Math.max(1, sh.getLastRow());
  var oldCols = Math.min(MAX_COMPANIES, Math.max(1, sh.getLastColumn()));
  var rows = Math.max(1 + maxLen, oldRows);
  var cols = Math.max(Math.min(MAX_COMPANIES, model.length), oldCols, 1);

  var grid = [];
  for (var r = 0; r < rows; r++) {
    var row = [];
    for (var c = 0; c < cols; c++) {
      if (r === 0) row.push(model[c] ? safeCell_(model[c].name) : '');
      else row.push(model[c] && model[c].domains[r - 1] ? safeCell_(model[c].domains[r - 1]) : '');
    }
    grid.push(row);
  }

  sh.getRange(1, 1, grid.length, cols).setValues(grid);
  sh.getRange(1, 1, 1, cols).setFontWeight('bold').setBackground('#E8F0FE');
  sh.setFrozenRows(1);
  try { sh.autoResizeColumns(1, cols); } catch (ignore) {}
  invalidateModel_();          // 쓰기 도중 다른 실행이 옛 값을 캐시했을 수 있다
}

function totalDomains_(model) {
  var n = 0;
  for (var i = 0; i < model.length; i++) n += model[i].domains.length;
  return n;
}

function findCompany_(model, name) {
  var key = String(name || '').trim().toLowerCase();
  for (var i = 0; i < model.length; i++) {
    if (model[i].name.trim().toLowerCase() === key) return i;
  }
  return -1;
}

/** 도메인이 어느 업체에 있는지 → [{ci, di}] */
function findDomain_(model, domain) {
  var d = normalizeDomain_(domain);
  var hits = [];
  if (!d) return hits;
  for (var i = 0; i < model.length; i++) {
    var j = model[i].domains.indexOf(d);
    if (j !== -1) hits.push({ ci: i, di: j });
  }
  return hits;
}

// ═══════════════════════════════════════════════════════════════════
// 되돌리기 (직전 상태 1회 보관)
// ═══════════════════════════════════════════════════════════════════
function snapshot_(label) {
  var src = sheet_(SHEET_INPUT, true);
  var bk = sheet_(SHEET_BACKUP, true);
  bk.clearContents();
  var lastRow = Math.max(1, src.getLastRow());
  var lastCol = Math.max(1, src.getLastColumn());
  var v = src.getRange(1, 1, lastRow, lastCol).getDisplayValues();
  bk.getRange(1, 1, v.length, v[0].length).setValues(v);
  try { bk.hideSheet(); } catch (ignore) {}
  setProp_('UNDO_LABEL', label || '변경');
  setProp_('UNDO_AT', nowKst_());
}

function undo_() {
  invalidateModel_();          // 시트를 직접 되돌리므로 캐시도 함께 버린다
  var bk = sheet_(SHEET_BACKUP, false);
  if (!bk || bk.getLastRow() < 1) throw new Error('되돌릴 내용이 없습니다.');
  var v = bk.getRange(1, 1, bk.getLastRow(), Math.max(1, bk.getLastColumn())).getDisplayValues();

  // 지금 상태를 다시 백업(되돌리기의 되돌리기)
  var cur = sheet_(SHEET_INPUT, true);
  var curV = cur.getRange(1, 1, Math.max(1, cur.getLastRow()), Math.max(1, cur.getLastColumn())).getDisplayValues();

  cur.clearContents();
  cur.getRange(1, 1, v.length, v[0].length).setValues(v);
  cur.getRange(1, 1, 1, v[0].length).setFontWeight('bold').setBackground('#E8F0FE');
  cur.setFrozenRows(1);

  bk.clearContents();
  bk.getRange(1, 1, curV.length, curV[0].length).setValues(curV);

  invalidateModel_();
  var label = prop_('UNDO_LABEL', '변경');
  setProp_('UNDO_LABEL', '되돌리기');
  return label;
}

// ═══════════════════════════════════════════════════════════════════
// 이력
// ═══════════════════════════════════════════════════════════════════
function log_(actor, action, detail) {
  try {
    var sh = sheet_(SHEET_LOG, true);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, 4).setValues([['시각', '누가', '무엇을', '상세']])
        .setFontWeight('bold').setBackground('#F1F3F4');
      sh.setFrozenRows(1);
    }
    sh.appendRow(safeRow_([nowKst_(), actor || '담당자', action, detail || '']));
    var over = sh.getLastRow() - 1 - LOG_KEEP;
    if (over > 0) sh.deleteRows(2, over);
  } catch (e) {
    // 이력 실패가 본 작업을 막지 않도록 무시
  }
}

// ═══════════════════════════════════════════════════════════════════
// 시스템 탭 (운영자 모니터링)
// ═══════════════════════════════════════════════════════════════════
function sysWrite_(extra) {
  try {
    var sh = sheet_(SHEET_SYS, true);
    var s = settings_();
    var model = loadModel_();
    var rows = [
      ['항목', '값'],
      ['현재 시각(KST)', nowKst_()],
      ['등록 업체', model.length + '곳'],
      ['등록 도메인', totalDomains_(model) + '개'],
      ['점검 시각', s.hours.map(function (h) { return ('0' + h).slice(-2) + '시'; }).join(' · ')],
      ['알림 수준', s.notify === 'all' ? '항상' : '문제만'],
      ['자동 점검', s.paused ? '⏸ 일시중지' : '▶️ 켜짐'],
      ['마지막 점검 요청', prop_('LAST_DISPATCH_AT', '-')],
      ['마지막 결과 도착', prop_('LAST_RESULT_AT', '-')],
      ['마지막 결과 요약', prop_('LAST_RESULT_SUMMARY', '-')],
      ['실행 상태', prop_('RUN_STATE', '대기')],
      ['마지막 오류', prop_('LAST_ERROR', '-')],
      ['GitHub 토큰 만료일', prop_('GITHUB_TOKEN_EXPIRES', '(미입력)')],
    ];
    if (extra) rows.push(['비고', extra]);
    rows = rows.map(safeRow_);

    sh.clear();
    sh.getRange(1, 1, rows.length, 2).setValues(rows);
    sh.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground('#F1F3F4');
    sh.setFrozenRows(1);
    try { sh.autoResizeColumns(1, 2); } catch (ignore) {}
  } catch (e) {
    // 모니터링 실패가 본 작업을 막지 않도록 무시
  }
}

// ═══════════════════════════════════════════════════════════════════
// 텔레그램 송신
// ═══════════════════════════════════════════════════════════════════
/**
 * 텔레그램 호출.
 * ★ 예전엔 응답을 확인하지 않아, 글자 서식이 깨지면 메시지가 '조용히 안 감' → 버튼이 영구 먹통처럼 보였다.
 *   이제 실패를 확인해서 ① 서식 없이 다시 보내고 ② 시스템 탭에 남긴다.
 */
function tgApi_(method, payload, noRetry) {
  var bot = prop_('BOT_TOKEN');
  if (!bot) return null;
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + bot + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  var body = null;
  try { body = JSON.parse(res.getContentText()); } catch (e) { body = null; }
  if (body && body.ok) return body;

  var desc = (body && body.description) || ('HTTP ' + res.getResponseCode());
  if (/message is not modified/i.test(desc)) return body;      // 같은 화면 다시 누른 것 — 정상

  if (!noRetry && payload && payload.parse_mode) {
    // 서식 때문에 실패한 경우 → 태그를 벗겨서라도 반드시 전달한다
    var plain = {};
    for (var k in payload) if (k !== 'parse_mode') plain[k] = payload[k];
    if (plain.text) {
      plain.text = String(plain.text).replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    }
    var retry = tgApi_(method, plain, true);
    if (retry && retry.ok) {
      try { setProp_('LAST_ERROR', nowKst_() + ' 텔레그램 서식 오류(평문으로 대체 발송): ' + desc.slice(0, 120)); } catch (i1) {}
      return retry;
    }
  }
  try { setProp_('LAST_ERROR', nowKst_() + ' 텔레그램 ' + method + ' 실패: ' + desc.slice(0, 150)); } catch (i2) {}
  return body;
}

// <<<PURE-SPLIT-START>>> (check.js 의 splitForTelegram 과 같은 알고리즘 — 테스트가 대조한다)
function splitForTelegram_(text, limit) {
  limit = limit || TG_LIMIT;
  if (text.length <= limit) return [text];
  var blocks = text.split('\n\n');
  var chunks = [], buf = '';
  function flush() { if (buf) { chunks.push(buf); buf = ''; } }

  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    if (b.length > limit) {
      flush();
      var m = /^<blockquote>([\s\S]*)<\/blockquote>$/.exec(b);
      var body = m ? m[1] : b;
      var wrapL = m ? '<blockquote>' : '', wrapR = m ? '</blockquote>' : '';
      var lines = body.split('\n'), buf2 = '';
      for (var k = 0; k < lines.length; k++) {
        if (buf2 && (wrapL + buf2 + '\n' + lines[k] + wrapR).length > limit) { chunks.push(wrapL + buf2 + wrapR); buf2 = ''; }
        buf2 = buf2 ? buf2 + '\n' + lines[k] : lines[k];
      }
      if (buf2) chunks.push(wrapL + buf2 + wrapR);
      continue;
    }
    if (buf && (buf + '\n\n' + b).length > limit) flush();
    buf = buf ? buf + '\n\n' + b : b;
  }
  flush();
  return chunks;
}
// <<<PURE-SPLIT-END>>>

function tgSend_(chatId, text, keyboard) {
  if (!chatId) return null;
  var parts = splitForTelegram_(text);
  var last = null;
  for (var i = 0; i < parts.length; i++) {
    var payload = {
      chat_id: chatId,
      text: (parts.length > 1 ? '(' + (i + 1) + '/' + parts.length + ')\n' : '') + parts[i],
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (keyboard && i === parts.length - 1) payload.reply_markup = keyboard;
    last = tgApi_('sendMessage', payload);
  }
  return last;
}

/**
 * 버튼을 눌렀을 때의 답.
 * ★ 예전엔 누른 메시지를 '제자리에서 고쳐' 썼다. 그러면 그 메시지가 화면 위로 밀려 있을 때
 *   화면 아래에는 아무 변화가 없어 "눌러도 반응이 없다"로 보였다(2026-09-04 에이든 실측).
 *   이제는 항상 화면 맨 아래에 새 메시지로 답하고, 눌린 옛 메시지의 버튼만 떼어낸다
 *   — 옛 버튼을 다시 눌러 같은 화면이 계속 쌓이는 것을 막는다.
 */
function tgReply_(chatId, messageId, text, keyboard) {
  // ★ '새 메시지 보내기'와 '옛 버튼 떼기'는 서로 기다릴 이유가 없다.
  //   한 번에 같이 보내면 왕복 한 번 분량(약 0.5~1초)을 아낀다.
  var parts = splitForTelegram_(text);
  if (parts.length === 1 && messageId) {
    var bot = prop_('BOT_TOKEN');
    if (bot) {
      var base = 'https://api.telegram.org/bot' + bot + '/';
      var reqs = [
        { url: base + 'sendMessage', method: 'post', contentType: 'application/json', muteHttpExceptions: true,
          payload: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML',
            disable_web_page_preview: true, reply_markup: keyboard || { inline_keyboard: [] } }) },
        { url: base + 'editMessageReplyMarkup', method: 'post', contentType: 'application/json', muteHttpExceptions: true,
          payload: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }) },
      ];
      try {
        var res = UrlFetchApp.fetchAll(reqs);
        var body = null;
        try { body = JSON.parse(res[0].getContentText()); } catch (e) { body = null; }
        if (body && body.ok) return body;
        // 서식 문제 등으로 실패하면 기존 경로(재시도 포함)로 확실히 전달한다
      } catch (ignore) {}
    }
  }
  var sent = tgSend_(chatId, text, keyboard);
  tgStripButtons_(chatId, messageId);
  return sent;
}

/** 옛 메시지의 버튼만 떼어낸다. 실패해도 조용히 넘어간다(마지막 오류를 더럽히지 않는다). */
function tgStripButtons_(chatId, messageId) {
  var bot = prop_('BOT_TOKEN');
  if (!bot || !messageId || !chatId) return;
  try {
    UrlFetchApp.fetch('https://api.telegram.org/bot' + bot + '/editMessageReplyMarkup', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
      muteHttpExceptions: true,
    });
  } catch (ignore) {}
}

/** 방금 보낸 메시지의 번호(없으면 0). 확인 버튼의 '주인'을 가릴 때 쓴다. */
function sentMid_(res) {
  return (res && res.result && res.result.message_id) || 0;
}

/**
 * ★ 버튼을 누른 사람에게 '받았다'를 알리는 응답.
 *   대기조가 살아 있으면 대기조가 이미 0.3초 안에 먼저 보낸다(즉답).
 *   같은 버튼에 두 번 답할 수는 없으므로, 그럴 땐 여기서 건너뛴다
 *   — 안 그러면 매번 실패로 기록돼 '마지막 오류'가 더러워진다.
 */
var PRE_ANSWERED = false;

function tgAnswer_(cbId, text) {
  if (PRE_ANSWERED) return;
  tgApi_('answerCallbackQuery', { callback_query_id: cbId, text: text || '' });
}

/** 결과 채널(설정된 첫 chat_id)로 알림 */
function notifyChannel_(text, keyboard) {
  var ids = allowedChats_();
  if (!ids.length) return;
  tgSend_(ids[0], text, keyboard);
}

// ═══════════════════════════════════════════════════════════════════
// 키보드(버튼)
// ═══════════════════════════════════════════════════════════════════
function kbMain_() {
  return { inline_keyboard: [
    [{ text: '🔍 지금 점검', callback_data: 'run' }, { text: '📋 목록 보기', callback_data: 'list' }],
    [{ text: '➕ 도메인 추가', callback_data: 'add' }, { text: '🗑 도메인 삭제', callback_data: 'del' }],
    [{ text: '🏢 업체 관리', callback_data: 'co' }, { text: '⚙️ 설정', callback_data: 'cfg' }],
    [{ text: '↩️ 되돌리기', callback_data: 'undo' }, { text: '❓ 도움말', callback_data: 'help' }],
  ] };
}

function kbBack_() {
  return { inline_keyboard: [[{ text: '◀️ 메뉴로', callback_data: 'm' }]] };
}

function kbCompanies_(model, prefix, extraRows) {
  var rows = [], row = [];
  for (var i = 0; i < model.length; i++) {
    row.push({ text: model[i].name, callback_data: prefix + ':' + i });
    if (row.length === 2) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);
  if (extraRows) for (var k = 0; k < extraRows.length; k++) rows.push(extraRows[k]);
  rows.push([{ text: '◀️ 메뉴로', callback_data: 'm' }]);
  return { inline_keyboard: rows };
}

// ═══════════════════════════════════════════════════════════════════
// 대화 상태 (채널 단위 + 잠금)
// ═══════════════════════════════════════════════════════════════════
function cache_() { return CacheService.getScriptCache(); }

function getState_(chatId) {
  var raw = cache_().get('state:' + chatId);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function setState_(chatId, state) {
  cache_().put('state:' + chatId, JSON.stringify(state), STATE_TTL);
}

function clearState_(chatId) { cache_().remove('state:' + chatId); }

/**
 * 채널은 여러 담당자가 함께 씁니다. A가 '추가' 중인데 B가 '삭제'를 시작하면
 * A가 보낸 주소가 B의 절차로 흘러들어갈 수 있습니다 —
 * 채널 글에는 '누가 썼는지'가 없어 구분이 안 되기 때문입니다.
 * 그래서 진행 중인 절차가 있으면 2분간 다른 사람의 새 절차를 막습니다.
 * → null 이면 진행 가능, 문자열이면 그 안내문을 보여주고 중단.
 */
function busyBy_(chatId, actor) {
  var st = getState_(chatId);
  if (!st || !st.at) return null;
  if (String(st.by || '') === String(actor || '')) return null;
  if (Date.now() - st.at > 120000) return null;
  return '⏳ ' + esc_(st.by || '다른 담당자') + '님이 지금 작업 중입니다.\n\n<blockquote>2분이 지나면 자동으로 풀립니다. 잠시 뒤 다시 눌러주세요.</blockquote>';
}

/** 텔레그램이 같은 알림을 재전송해도 두 번 실행되지 않게 한다 */
function seenUpdate_(updateId) {
  if (!updateId && updateId !== 0) return false;
  var key = 'upd:' + updateId;
  if (cache_().get(key)) return true;
  cache_().put(key, '1', 600);
  return false;
}

// ═══════════════════════════════════════════════════════════════════
// 권한
// ═══════════════════════════════════════════════════════════════════
function allowedChats_() {
  return prop_('ALLOWED_CHAT_IDS', '').split(',')
    .map(function (s) { return String(s).trim(); })
    .filter(function (s) { return !!s; });
}

function canControl_(chatId) {
  var ids = allowedChats_();
  if (!ids.length) return false;                 // 미설정 = 조작 전면 거부(안전 기본값)
  return ids.indexOf(String(chatId)) !== -1;
}

function actorOf_(msg, from) {
  if (from) {
    var n = [from.first_name, from.last_name].filter(Boolean).join(' ');
    return n || ('id' + from.id);
  }
  if (msg && msg.from) {
    var m = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
    return m || ('id' + msg.from.id);
  }
  if (msg && msg.author_signature) return msg.author_signature;
  return '담당자';
}

// ═══════════════════════════════════════════════════════════════════
// 화면 만들기
// ═══════════════════════════════════════════════════════════════════
function menuText_() {
  var model = loadModel_();
  var s = settings_();
  var lines = [
    '🎛 <b>접속점검 관리</b>',
    '',
    '<blockquote>업체 ' + model.length + '곳 · 도메인 ' + totalDomains_(model) + '개',
    '점검 시각 ' + s.hours.map(function (h) { return ('0' + h).slice(-2) + '시'; }).join(' · ') +
      (s.paused ? '  ⏸ 일시중지' : '') ,
    '마지막 점검 ' + esc_(prop_('LAST_RESULT_AT', '-')),
    esc_(prop_('LAST_RESULT_SUMMARY', '아직 점검 기록이 없습니다')) + '</blockquote>',
    '',
    speedLine_(),
    '',
    '<blockquote>이 패널이 위로 밀리면 <b>ㅁ</b> 이라고 보내면 다시 나옵니다.</blockquote>',
  ];
  return lines.join('\n');
}

/**
 * 지금 반응이 빠른 상태인지 한 줄로 알려준다.
 * ★ 버튼을 '누른 순간'에 '잠시만요'를 보낼 방법은 없다 —
 *   대기조가 자는 동안은 눌렸다는 사실 자체를 아무도 모르기 때문이다.
 *   그래서 누르기 '전에' 알 수 있게 패널에 상태를 적는다.
 */
function speedLine_() {
  if (mode_() === 'webhook') {
    return '<blockquote>⚡ <b>즉시 반응</b> — 누르면 바로 받습니다</blockquote>';
  }
  if (relayAlive_()) {
    return '<blockquote>⚡ <b>지금은 빠릅니다</b> — 버튼 반응 2~4초</blockquote>';
  }
  return '<blockquote>💤 <b>지금은 쉬는 중입니다</b>\n' +
    '다음 첫 조작 하나만 <b>최대 1분</b> 걸립니다. 한 번 깨어나면 그 뒤 20분간 2~4초입니다.\n' +
    '반응이 없어 보여도 여러 번 누르지 마세요 — 누른 만큼 답이 쌓입니다.</blockquote>';
}

function listText_() {
  var model = loadModel_();
  if (!model.length) return '📋 등록된 도메인이 없습니다.\n\n<blockquote>[➕ 도메인 추가] 로 시작해 보세요.</blockquote>';
  var parts = ['📋 <b>등록된 도메인</b> (총 ' + totalDomains_(model) + '개)'];
  for (var i = 0; i < model.length; i++) {
    var c = model[i];
    var lines = ['〔' + esc_(c.name) + '〕 ' + c.domains.length + '개'];
    if (!c.domains.length) lines.push('(비어 있음)');
    for (var j = 0; j < c.domains.length; j++) lines.push(esc_(c.domains[j]));
    parts.push('<blockquote>' + lines.join('\n') + '</blockquote>');
  }
  return parts.join('\n\n');
}

function helpText_() {
  return [
    '❓ <b>사용법</b>',
    '',
    '<blockquote>버튼으로 전부 할 수 있습니다.',
    '패널이 안 보이면 <b>ㅁ</b> 한 글자만 보내세요 (메뉴 · /menu 도 됩니다).</blockquote>',
    '',
    '⌨️ 글로 바로 쓰는 방법',
    '',
    '<blockquote>점검                     지금 점검',
    '목록                     전체 보기',
    '상태                     마지막 결과 다시 보기',
    '추가 누드티비 a.com b.com  업체에 주소 추가',
    '삭제 a.com b.com         주소 삭제(여러 개 가능)',
    '변경 a.com b.com         주소 갈아끼우기',
    '이동 a.com b.com 파트너사  다른 업체로 옮기기',
    '업체추가 새업체           (줄바꿈으로 여러 곳)',
    '업체삭제 누드티비          (줄바꿈으로 여러 곳)',
    '이름변경 누드티비 누드티비2',
    '점검시각 9 21            매일 09시·21시로',
    '알림 문제만 / 알림 항상',
    '일시중지 / 재개',
    '되돌리기                 직전 변경 취소</blockquote>',
    '',
    '<blockquote>주소는 https://·www·뒤 경로를 붙여도 알아서 정리됩니다.',
    '여러 개는 줄바꿈·띄어쓰기·쉼표 아무거나로 한 번에 넣으세요.</blockquote>',
    '',
    '📦 <b>한 번에 여러 개</b>',
    '',
    '<blockquote>업체 이름을 맨 윗줄에 적고 그 아래에 주소를 붙여넣으면',
    '그 업체로 한 번에 들어갑니다. 예)',
    '누드티비',
    'a.com',
    'b.com',
    '',
    '업체 이름 없이 주소만 붙여넣으면 어느 업체에 넣을지 물어봅니다.',
    '지울 때는 [🗑 도메인 삭제] → 업체 → [🗑 여러 개 한 번에]</blockquote>',
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// 동작 — 점검 실행
// ═══════════════════════════════════════════════════════════════════
/** 깃허브 워크플로 하나를 깨운다(점검·대기조 공용). 성공하면 아무 것도 돌려주지 않는다. */
function ghDispatch_(file, inputs) {
  var repo = prop_('GITHUB_REPO');
  var token = prop_('GITHUB_TOKEN');
  var ref = prop_('GIT_REF', 'main');
  if (!repo || !token) throw new Error('GITHUB_REPO / GITHUB_TOKEN 속성이 없습니다');

  var url = 'https://api.github.com/repos/' + repo + '/actions/workflows/' +
    encodeURIComponent(file) + '/dispatches';
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    payload: JSON.stringify({ ref: ref, inputs: inputs || {} }),
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code !== 204) throw new Error('GitHub 응답 ' + code + ' ' + res.getContentText().slice(0, 200));
}

// ───────────────────────────────────────────────────────────────────
// 깨우기형 대기조 — 버튼 반응 0~59초를 1~3초로 줄인다
// ───────────────────────────────────────────────────────────────────
/**
 * 왜 이런 구조인가.
 *  · 앱스스크립트 트리거는 최소 간격이 1분이라, 혼자서는 절대 1분보다 빨라질 수 없다.
 *  · 텔레그램 웹훅은 앱스스크립트가 302를 돌려주기 때문에 못 쓴다(2026-09-04 실측).
 *  → 그래서 담당자가 '첫 조작'을 한 순간에만 깃허브에서 대기조를 깨워, 그 뒤 연속 조작을
 *    초 단위로 처리한다. 조용해지면 대기조가 스스로 꺼지고 다시 1분 방식으로 돌아온다.
 *  · 대기조는 어디까지나 '빠르게 하는 장치'다. 죽어도 1분 방식이 그대로 다 처리한다.
 */
function relayAlive_() {
  return (Number(prop_('RELAY_ALIVE_UNTIL', '0')) || 0) > Date.now();
}

function relayTouch_() { setProp_('RELAY_ALIVE_UNTIL', String(Date.now() + RELAY_ALIVE_MS)); }

// ★ 값에 빈 문자열을 쓰지 않는다 — 앱스스크립트 설정 화면이 '필수 입력'으로 막아
//   다른 속성까지 저장이 안 되는 사고가 있었다(2026-09-05).
function relayStop_() { setProp_('RELAY_ALIVE_UNTIL', '0'); setProp_('RELAY_ID', '-'); }

/** 지금 등록된 대기조가 보낸 신호인가 (고유번호가 없던 옛 방식은 그대로 허용) */
function relayOwner_(body) {
  var rid = String((body && body.relayId) || '');
  if (!rid) return true;
  return prop_('RELAY_ID', '') === rid;
}

/**
 * ★ 자동 예열 — '첫 조작만 느린' 문제를 없앤다.
 *
 *   대기조가 자고 있으면 버튼을 눌러도 아무도 눌린 걸 모르는 구간이 최대 1분 생긴다.
 *   그 구간에는 '잠시만요' 조차 보낼 수 없다(눌렸다는 사실 자체를 모르므로).
 *   → 없앨 방법은 하나뿐이다: 담당자가 쓰는 시간대에는 대기조를 미리 깨워 둔다.
 *
 *   기본 09시~다음날 02시(한국시간). 밤에는 켜지 않는다.
 *   끄고 싶으면 스크립트 속성 RELAY_PREHEAT = no.
 */
function preheatRelay_() {
  if (mode_() === 'webhook') return;                      // 즉답기가 받는다 — 예열 불필요
  if (prop_('RELAY_PREHEAT', 'yes') === 'no') return;
  if (relayAlive_()) return;
  var h = kstHour_();
  var from = Number(prop_('RELAY_HOURS_FROM', '9'));
  var to = Number(prop_('RELAY_HOURS_TO', '2'));
  var inHours = (from <= to) ? (h >= from && h < to) : (h >= from || h < to);
  if (!inHours) return;
  wakeRelay_();
}

function wakeRelay_() {
  try {
    if (mode_() === 'webhook') return;                    // 즉답기가 받는다 — 대기조 불필요
    if (prop_('RELAY_ENABLED', 'yes') === 'no') return;   // 끄고 싶으면 이 속성만 no 로
    if (relayAlive_()) return;                            // 이미 깨어 있다
    var last = Number(prop_('RELAY_WAKE_AT', '0')) || 0;
    if (Date.now() - last < RELAY_WAKE_COOLDOWN_MS) return;  // 방금 깨웠다 — 겹쳐 띄우지 않는다
    setProp_('RELAY_WAKE_AT', String(Date.now()));
    ghDispatch_(prop_('RELAY_FILE', 'relay.yml'), { minutes: String(RELAY_IDLE_MIN) });
    setProp_('RELAY_LAST_WAKE_KST', nowKst_());
  } catch (e) {
    // 실패해도 기능은 살아 있다(1분 방식). 조용히 기록만 남긴다.
    try { setProp_('RELAY_LAST_ERROR', nowKst_() + ' ' + String(e && e.message || e).slice(0, 140)); } catch (ignore) {}
  }
}

function dispatchWorkflow_(reason) {
  ghDispatch_(prop_('WORKFLOW_FILE', 'check.yml'), { mode: reason || 'manual' });

  setProp_('LAST_DISPATCH_AT', nowKst_());
  setProp_('RUN_STATE', '실행중');
  setProp_('LAST_ERROR', '-');
  armWatchdog_();
  sysWrite_();
}

/** 15분 뒤에도 결과가 안 오면 경고 */
function armWatchdog_() {
  clearWatchdog_();
  ScriptApp.newTrigger('watchdog').timeBased().after(WATCHDOG_MIN * 60 * 1000).create();
}

function clearWatchdog_() {
  var ts = ScriptApp.getProjectTriggers();
  for (var i = 0; i < ts.length; i++) {
    if (ts[i].getHandlerFunction() === 'watchdog') ScriptApp.deleteTrigger(ts[i]);
  }
}

function watchdog() {
  PROP_MEMO = null;
  clearWatchdog_();
  if (prop_('RUN_STATE', '대기') !== '실행중') return;
  setProp_('RUN_STATE', '무응답');
  setProp_('LAST_ERROR', nowKst_() + ' 점검 요청 후 ' + WATCHDOG_MIN + '분간 결과 없음');
  sysWrite_();
  notifyChannel_([
    '⚠️ <b>점검 결과가 오지 않았습니다</b>',
    '',
    '<blockquote>' + esc_(prop_('LAST_DISPATCH_AT', '-')) + ' 에 점검을 요청했는데',
    WATCHDOG_MIN + '분이 지나도 결과가 도착하지 않았습니다.',
    'VPN 연결 실패이거나 GitHub 실행이 막혔을 수 있습니다.</blockquote>',
  ].join('\n'), { inline_keyboard: [[{ text: '🔄 다시 점검', callback_data: 'run' }]] });
}

/**
 * ★ 설치 함수를 '속성 하나'로 실행한다.
 *
 *   앱스스크립트 편집기의 [실행할 함수] 선택은 자동화에서 자주 어긋난다
 *   (2026-09-05 실측: setupEdge 를 골랐는데 setupWebhook 이 실행됐다 —
 *    잘못 실행되면 텔레그램 연결이 엉뚱한 곳으로 바뀌는 위험한 사고다).
 *
 *   그래서 설정 화면(프로젝트 설정 → 스크립트 속성)에서 PENDING_SETUP 에
 *   아래 값 하나만 넣으면, 1분 안에 그 함수가 정확히 한 번 실행된다.
 *
 *     edge      → setupEdge()     즉답기(웹훅)로 전환
 *     poll      → setupPolling()  예전 방식(1분 폴링 + 대기조)으로 복귀
 *     all       → setupAll()      전체 재설치
 *     commands  → setupCommands() '/' 명령 메뉴 재등록
 *     pin       → pinGuide()      안내문 재발송·고정
 *
 *   결과는 PENDING_SETUP_RESULT 속성에 남는다. 값은 실행 직전에 지우므로
 *   실패해도 1분마다 무한히 반복되지 않는다.
 */
function runPendingSetup_() {
  var want = String(prop_('PENDING_SETUP', '')).trim().toLowerCase();
  if (!want || want === '-') return;
  setProp_('PENDING_SETUP', '-');          // 먼저 지운다 — 두 번 돌지 않게
  try {
    if (want === 'edge') setupEdge();
    else if (want === 'poll') setupPolling();
    else if (want === 'all') setupAll();
    else if (want === 'commands') setupCommands();
    else if (want === 'pin') pinGuide();
    else throw new Error('모르는 값: ' + want);
    setProp_('PENDING_SETUP_RESULT', nowKst_() + ' · ' + want + ' 실행 완료');
  } catch (e) {
    setProp_('PENDING_SETUP_RESULT', nowKst_() + ' · ' + want + ' 실패: ' + String(e && e.message || e).slice(0, 150));
  }
}

/** 매시간 실행 — 설정된 시각이면 점검 요청 */
function hourlyTick() {
  PROP_MEMO = null;
  try { runPendingSetup_(); } catch (ignoreSetup2) {}
  try {
    checkTokenExpiry_();
    try { preheatRelay_(); } catch (ignorePre2) {}
    var s = settings_();
    if (s.paused) return;
    // ★ 매시간 트리거는 정각에 딱 맞춰 오지 않는다(08:56, 10:02 처럼 어긋난다).
    //   '지금 시각이 목록에 있나'만 보면 09시 점검이 통째로 건너뛰어진다.
    //   그래서 최근 3시간 안에 지나간 예정 시각 중 아직 안 돌린 게 있으면 지금 돌린다.
    var due = '';
    for (var back = 0; back < 3; back++) {
      var t = new Date(Date.now() - back * 3600000);
      var hh = Number(Utilities.formatDate(t, 'Asia/Seoul', 'H'));
      if (s.hours.indexOf(hh) === -1) continue;
      var k = Utilities.formatDate(t, 'Asia/Seoul', 'yyyyMMddHH');
      if (prop_('LAST_AUTO_KEY', '') === k) break;    // 이미 돌린 회차 → 그 이전은 볼 필요 없음
      due = k;
      break;
    }
    if (!due) return;
    setProp_('LAST_AUTO_KEY', due);

    dispatchWorkflow_('auto');
  } catch (e) {
    setProp_('LAST_ERROR', nowKst_() + ' ' + String(e && e.message || e));
    sysWrite_();
    notifyChannel_('⚠️ 자동 점검을 시작하지 못했습니다.\n\n<blockquote>' + esc_(String(e && e.message || e)) + '</blockquote>');
  }
}

function checkTokenExpiry_() {
  var d = prop_('GITHUB_TOKEN_EXPIRES', '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
  var left = Math.floor((new Date(d + 'T00:00:00+09:00') - new Date()) / 86400000);
  if (left > 30 || left < -3) return;
  if (prop_('TOKEN_WARN_KEY', '') === d + ':' + left) return;
  setProp_('TOKEN_WARN_KEY', d + ':' + left);
  notifyChannel_('🔑 <b>GitHub 토큰 만료 안내</b>\n\n<blockquote>만료까지 ' + left + '일 남았습니다 (' + esc_(d) + ').\n만료되면 자동 점검이 멈춥니다. 운영자에게 알려주세요.</blockquote>');
}

// ═══════════════════════════════════════════════════════════════════
// 동작 — 도메인·업체 편집
// ═══════════════════════════════════════════════════════════════════
/** 업체 이름 규칙 — 한 곳에서만 판단한다(추가 경로마다 달라지면 구멍이 생긴다) */
// ═══════════════════════════════════════════════════════════════════
// 대량 입력 — 여러 개를 한 번에 (2026-09-05)
// ★ 담당자는 주소를 옆으로 죽 나열하기도 하고, 한 줄에 하나씩 붙여넣기도 한다.
//   줄바꿈·띄어쓰기·쉼표·탭 어느 것으로 나눠도 똑같이 알아듣도록 한 곳에서 처리한다.
//   예전엔 조각 하나만 주소가 아니어도 메시지 전체를 조용히 버렸다 —
//   대량 붙여넣기에서 오타 하나 때문에 아무 반응이 없던 사고의 원인.
// ═══════════════════════════════════════════════════════════════════
/** 아무렇게나 붙여넣은 글을 조각으로 나눈다(줄바꿈·띄어쓰기·쉼표·세미콜론·탭). */
function tokens_(text) {
  return String(text === null || text === undefined ? '' : text)
    .split(/[\s,;]+/)
    .map(function (x) { return String(x).trim(); })
    .filter(function (x) { return !!x; });
}

/** 줄 단위로 나눈다(업체 이름처럼 띄어쓰기가 들어갈 수 있는 것용). */
function lines_(text) {
  return String(text === null || text === undefined ? '' : text)
    .split(/[\r\n]+/)
    .map(function (x) { return String(x).trim(); })
    .filter(function (x) { return !!x; });
}

/** 첫 줄만 (업체 이름을 물었는데 목록을 통째로 붙여넣는 경우 대비) */
function firstLine_(text) {
  var ls = lines_(text);
  return ls.length ? ls[0] : String(text === null || text === undefined ? '' : text).trim();
}

/** '주소를 적으려던 것'인가 — 점이 있거나 http 로 시작하면 그렇게 본다. */
function looksLikeDomain_(tok) {
  var s = String(tok === null || tok === undefined ? '' : tok);
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s) || s.indexOf('.') !== -1;
}

/**
 * 조각들을 셋으로 가른다.
 *   ok    제대로 된 주소(중복 제거)
 *   bad   주소를 적으려다 틀린 것 → '형식이 아님'으로 알려준다
 *   words 그냥 말(업체 이름일 수도 있다)
 */
function splitTokens_(list) {
  var ok = [], bad = [], words = [];
  for (var i = 0; i < list.length; i++) {
    var d = normalizeDomain_(list[i]);
    if (d) { if (ok.indexOf(d) === -1) ok.push(d); continue; }
    if (looksLikeDomain_(list[i])) bad.push(String(list[i]));
    else words.push(String(list[i]));
  }
  return { ok: ok, bad: bad, words: words };
}

/**
 * 앞쪽 조각들이 등록된 업체 이름과 맞는지 본다(띄어쓰기가 든 이름까지).
 * '추가 우리 회사 a.com' 처럼 업체 이름에 공백이 있어도 알아듣게 한다.
 */
function pickLeadingCompany_(model, toks) {
  for (var n = Math.min(toks.length, 5); n >= 1; n--) {
    var name = toks.slice(0, n).join(' ');
    if (findCompany_(model, name) !== -1) return { name: name, rest: toks.slice(n) };
  }
  return { name: toks.length ? toks[0] : '', rest: toks.slice(1) };
}

/** 결과 묶음을 담당자용 줄로 바꾼다(추가/삭제/이동/변경 공통). */
function bulkLines_(head, groups) {
  var lines = [head];
  for (var g = 0; g < groups.length; g++) {
    var mark = groups[g][0], items = groups[g][1];
    for (var i = 0; i < items.length; i++) lines.push(mark + ' ' + esc_(String(items[i])));
  }
  return lines;
}

// ═══════════════════════════════════════════════════════════════════
// 동작 — 여러 개 한 번에 (자물쇠·백업·저장·기록을 한 번만 한다)
// ═══════════════════════════════════════════════════════════════════
function opRemoveDomains_(rawList, companyName, actor) {
  return withLock_(function () {
    var model = loadModel_();
    var wanted = String(companyName === null || companyName === undefined ? '' : companyName).trim().toLowerCase();
    var removed = [], missing = [], wrongCo = [], ambiguous = [], bad = [], touched = false;
    for (var i = 0; i < rawList.length; i++) {
      var d = normalizeDomain_(rawList[i]);
      if (!d) { bad.push(String(rawList[i])); continue; }
      var all = findDomain_(model, d);
      if (!all.length) { missing.push(d); continue; }
      var hits = all;
      if (wanted) {
        hits = all.filter(function (h) { return model[h.ci].name.trim().toLowerCase() === wanted; });
        if (!hits.length) { wrongCo.push(d); continue; }
      } else if (all.length > 1) {
        ambiguous.push({ domain: d, names: all.map(function (h) { return model[h.ci].name; }) });
        continue;
      }
      if (!touched) { snapshot_('삭제'); touched = true; }
      var co = model[hits[0].ci];
      co.domains.splice(hits[0].di, 1);
      removed.push({ company: co.name, domain: d });
    }
    if (touched) {
      saveModel_(model);
      log_(actor, '도메인 삭제', removed.map(function (r) { return '〔' + r.company + '〕 ' + r.domain; }).join(', '));
      sysWrite_();
    }
    return { removed: removed, missing: missing, wrongCo: wrongCo, ambiguous: ambiguous, bad: bad };
  });
}

function opMoveDomains_(rawList, toCompany, actor) {
  return withLock_(function () {
    var model = loadModel_();
    var ti = findCompany_(model, toCompany);
    if (ti === -1) throw new Error('그런 업체가 없습니다: ' + toCompany);
    var moved = [], missing = [], already = [], bad = [], touched = false;
    for (var i = 0; i < rawList.length; i++) {
      var d = normalizeDomain_(rawList[i]);
      if (!d) { bad.push(String(rawList[i]) + ' (주소 형식이 아님)'); continue; }
      var hits = findDomain_(model, d);
      if (!hits.length) { missing.push(d); continue; }
      if (hits[0].ci === ti) { already.push(d); continue; }
      if (model[ti].domains.length >= MAX_DOMAINS_PER_CO) { bad.push(d + ' (한 업체에 최대 ' + MAX_DOMAINS_PER_CO + '개까지)'); continue; }
      if (!touched) { snapshot_('이동'); touched = true; }
      var from = model[hits[0].ci];
      from.domains.splice(hits[0].di, 1);
      if (model[ti].domains.indexOf(d) === -1) model[ti].domains.push(d);
      moved.push({ domain: d, from: from.name });
    }
    var toName = model[ti].name;
    if (touched) {
      saveModel_(model);
      log_(actor, '업체 이동', moved.map(function (v) { return v.domain + ' : 〔' + v.from + '〕 → 〔' + toName + '〕'; }).join(', '));
      sysWrite_();
    }
    return { to: toName, moved: moved, missing: missing, already: already, bad: bad };
  });
}

function opReplaceDomains_(pairs, actor) {
  return withLock_(function () {
    var model = loadModel_();
    var changed = [], missing = [], bad = [], touched = false;
    for (var i = 0; i < pairs.length; i++) {
      var od = normalizeDomain_(pairs[i][0]);
      var nd = normalizeDomain_(pairs[i][1]);
      if (!od) { bad.push(String(pairs[i][0]) + ' (주소 형식이 아님)'); continue; }
      if (!nd) { bad.push(String(pairs[i][1]) + ' (새 주소가 올바르지 않음)'); continue; }
      var hits = findDomain_(model, od);
      if (!hits.length) { missing.push(od); continue; }
      if (!touched) { snapshot_('변경'); touched = true; }
      var co = model[hits[0].ci];
      if (co.domains.indexOf(nd) !== -1 && co.domains.indexOf(nd) !== hits[0].di) co.domains.splice(hits[0].di, 1);
      else co.domains[hits[0].di] = nd;
      changed.push({ company: co.name, from: od, to: nd });
    }
    if (touched) {
      saveModel_(model);
      log_(actor, '주소 변경', changed.map(function (c) { return '〔' + c.company + '〕 ' + c.from + ' → ' + c.to; }).join(', '));
      sysWrite_();
    }
    return { changed: changed, missing: missing, bad: bad };
  });
}

function opAddCompanies_(names, actor) {
  return withLock_(function () {
    var model = loadModel_();
    var added = [], dup = [], bad = [], touched = false;
    for (var i = 0; i < names.length; i++) {
      var n = null;
      try { n = validCompanyName_(names[i]); }
      catch (e) { bad.push({ raw: String(names[i]), why: String(e.message || e) }); continue; }
      if (findCompany_(model, n) !== -1) { dup.push(n); continue; }
      if (model.length >= MAX_COMPANIES) { bad.push({ raw: n, why: '업체는 최대 ' + MAX_COMPANIES + '곳까지 등록할 수 있습니다.' }); continue; }
      if (!touched) { snapshot_('업체추가'); touched = true; }
      model.push({ name: n, domains: [] });
      added.push(n);
    }
    if (touched) { saveModel_(model); log_(actor, '업체 추가', added.join(', ')); sysWrite_(); }
    return { added: added, dup: dup, bad: bad };
  });
}

function opRemoveCompanies_(names, actor) {
  return withLock_(function () {
    var model = loadModel_();
    var removed = [], missing = [], touched = false;
    for (var i = 0; i < names.length; i++) {
      var ci = findCompany_(model, names[i]);
      if (ci === -1) { missing.push(String(names[i])); continue; }
      if (!touched) { snapshot_('업체삭제'); touched = true; }
      var co = model.splice(ci, 1)[0];
      removed.push({ name: co.name, count: co.domains.length, domains: co.domains });
    }
    if (touched) {
      saveModel_(model);
      log_(actor, '업체 삭제', removed.map(function (r) { return r.name + ' (도메인 ' + r.count + '개 함께 삭제)'; }).join(', '));
      sysWrite_();
    }
    return { removed: removed, missing: missing };
  });
}

function opRenameCompanies_(pairs, actor) {
  return withLock_(function () {
    var model = loadModel_();
    var renamed = [], missing = [], bad = [], touched = false;
    for (var i = 0; i < pairs.length; i++) {
      var ci = findCompany_(model, pairs[i][0]);
      if (ci === -1) { missing.push(String(pairs[i][0])); continue; }
      var n = null;
      try { n = validCompanyName_(pairs[i][1]); }
      catch (e) { bad.push({ raw: String(pairs[i][1]), why: String(e.message || e) }); continue; }
      if (findCompany_(model, n) !== -1) { bad.push({ raw: n, why: '이미 있는 이름입니다: ' + n }); continue; }
      if (!touched) { snapshot_('이름변경'); touched = true; }
      var prev = model[ci].name;
      model[ci].name = n;
      renamed.push({ from: prev, to: n });
    }
    if (touched) {
      saveModel_(model);
      log_(actor, '업체 이름변경', renamed.map(function (r) { return r.from + ' → ' + r.to; }).join(', '));
      sysWrite_();
    }
    return { renamed: renamed, missing: missing, bad: bad };
  });
}

function validCompanyName_(name) {
  var n = String(name === null || name === undefined ? '' : name).trim();
  if (!n) throw new Error('업체 이름을 적어주세요.');
  if (n.length > 20) throw new Error('업체 이름은 20자 이내로 해주세요.');
  if (/[<>]/.test(n)) throw new Error('업체 이름에 < > 는 쓸 수 없습니다.');
  if (/^[=+\-@]/.test(n)) throw new Error('업체 이름은 = + - @ 로 시작할 수 없습니다.');
  return n;
}

function opAddDomains_(companyName, rawList, actor) {
  return withLock_(function () {
    var model = loadModel_();
    var ci = findCompany_(model, companyName);
    if (ci === -1) {
      var newName = validCompanyName_(companyName);
      if (model.length >= MAX_COMPANIES) throw new Error('업체는 최대 ' + MAX_COMPANIES + '곳까지 등록할 수 있습니다.');
      model.push({ name: newName, domains: [] });
      ci = model.length - 1;
    }
    var added = [], dup = [], bad = [], moved = [];
    for (var i = 0; i < rawList.length; i++) {
      var d = normalizeDomain_(rawList[i]);
      if (!d) { bad.push(String(rawList[i])); continue; }
      if (model[ci].domains.indexOf(d) !== -1) { dup.push(d); continue; }
      var other = findDomain_(model, d);
      if (other.length) moved.push(d + ' (〔' + model[other[0].ci].name + '〕에도 있음)');
      // ★ 한도를 넘으면 통째로 실패시키지 않는다 — 대량 등록에서 앞부분까지 날아가면 안 된다
      if (model[ci].domains.length >= MAX_DOMAINS_PER_CO) { bad.push(String(rawList[i]) + ' (한 업체에 최대 ' + MAX_DOMAINS_PER_CO + '개까지)'); continue; }
      model[ci].domains.push(d);
      added.push(d);
    }
    if (added.length) {
      snapshot_('추가');
      saveModel_(model);
      log_(actor, '도메인 추가', '〔' + model[ci].name + '〕 ' + added.join(', '));
      sysWrite_();
    }
    return { company: model[ci].name, added: added, dup: dup, bad: bad, moved: moved };
  });
}

// ── 한 개짜리 명령은 위 '여러 개' 동작을 그대로 쓴다(규칙이 두 벌이 되지 않게).
function opRemoveDomain_(domain, companyName, actor) {
  var r = opRemoveDomains_([domain], companyName, actor);
  if (r.removed.length) return { company: r.removed[0].company, domain: r.removed[0].domain };
  if (r.bad.length) throw new Error('주소 형식이 아닙니다: ' + r.bad[0]);
  if (r.wrongCo.length) throw new Error('〔' + companyName + '〕에는 그 주소가 없습니다.');
  if (r.ambiguous.length) {
    var a = r.ambiguous[0];
    throw new Error('여러 업체에 있습니다(' + a.names.join(', ') + '). 업체를 지정해 주세요: 삭제 ' + a.domain + ' ' + a.names[0]);
  }
  throw new Error('등록되지 않은 주소입니다: ' + domain);
}

function opReplaceDomain_(oldD, newD, actor) {
  var r = opReplaceDomains_([[oldD, newD]], actor);
  if (r.changed.length) return { company: r.changed[0].company, from: r.changed[0].from, to: r.changed[0].to };
  if (r.missing.length) throw new Error('등록되지 않은 주소입니다: ' + oldD);
  if (!normalizeDomain_(oldD)) throw new Error('등록되지 않은 주소입니다: ' + oldD);
  throw new Error('새 주소가 올바르지 않습니다: ' + newD);
}

function opMoveDomain_(domain, toCompany, actor) {
  var r = opMoveDomains_([domain], toCompany, actor);
  if (r.moved.length) return { domain: r.moved[0].domain, from: r.moved[0].from, to: r.to };
  if (r.already.length) throw new Error('이미 〔' + toCompany + '〕에 있습니다.');
  if (r.bad.length) throw new Error('주소 형식이 아닙니다: ' + domain);
  throw new Error('등록되지 않은 주소입니다: ' + domain);
}

function opAddCompany_(name, actor) {
  var r = opAddCompanies_([name], actor);
  if (r.added.length) return r.added[0];
  if (r.dup.length) throw new Error('이미 있는 업체입니다: ' + r.dup[0]);
  throw new Error(r.bad.length ? r.bad[0].why : '업체를 추가하지 못했습니다.');
}

function opRemoveCompany_(name, actor) {
  var r = opRemoveCompanies_([name], actor);
  if (!r.removed.length) throw new Error('그런 업체가 없습니다: ' + name);
  return { name: r.removed[0].name, domains: r.removed[0].domains || [] };
}

function opRenameCompany_(oldName, newName, actor) {
  var r = opRenameCompanies_([[oldName, newName]], actor);
  if (r.renamed.length) return { from: r.renamed[0].from, to: r.renamed[0].to };
  if (r.missing.length) throw new Error('그런 업체가 없습니다: ' + oldName);
  throw new Error(r.bad.length ? r.bad[0].why : '이름을 바꾸지 못했습니다.');
}

// ═══════════════════════════════════════════════════════════════════
// 텔레그램 — 글 명령 처리
// ═══════════════════════════════════════════════════════════════════
function handleTextCommand_(chatId, text, actor) {
  var t = String(text || '').trim();
  var lower = t.toLowerCase();

  // 진행 중인 대화 상태가 있으면 그쪽이 우선
  var st = getState_(chatId);
  if (st && !/^(취소|cancel|\/cancel)$/i.test(t)) {
    return handleStateInput_(chatId, st, t, actor);
  }
  if (/^(취소|cancel|\/cancel)$/i.test(t)) {
    clearState_(chatId);
    return tgSend_(chatId, '취소했습니다.', kbMain_());
  }

  // ★ 패널은 최대한 쉽게 불러야 한다 — 한 글자 'ㅁ' 으로도 뜬다(에이든 지시 2026-09-04)
  if (/^(ㅁ|메뉴|패널|menu|\/menu|\/panel|시작|\/start)$/i.test(t)) return tgSend_(chatId, menuText_(), kbMain_());
  if (/^(도움말|help|\/help|사용법)$/i.test(t)) return tgSend_(chatId, helpText_(), kbBack_());
  if (/^(목록|list|\/list)$/i.test(t)) return tgSend_(chatId, listText_(), kbBack_());
  if (/^(설정|config)$/i.test(t)) return tgSend_(chatId, settingsText_(), kbSettings_());

  if (/^(점검|\/check|지금점검)$/i.test(t)) {
    try {
      dispatchWorkflow_('manual');
      return tgSend_(chatId, '🌐 점검을 시작합니다.\n\n<blockquote>1~3분 뒤 결과를 보내드릴게요.</blockquote>');
    } catch (e) {
      return tgSend_(chatId, '❌ 실행 요청 실패\n\n<blockquote>' + esc_(String(e.message || e)) + '</blockquote>');
    }
  }

  if (/^(상태|결과)$/i.test(t)) {
    var last = prop_('LAST_REPORT', '');
    if (!last) return tgSend_(chatId, '아직 점검 기록이 없습니다.', kbMain_());
    return tgSend_(chatId, last, kbMain_());
  }

  if (/^되돌리기$/i.test(t)) return askUndo_(chatId);

  if (/^일시중지$/i.test(t)) { setProp_('PAUSED', 'yes'); sysWrite_(); log_(actor, '설정', '자동 점검 일시중지'); return tgSend_(chatId, '⏸ 자동 점검을 멈췄습니다.\n\n<blockquote>수동 점검은 계속 됩니다. 다시 켜려면 [재개]</blockquote>', kbSettings_()); }
  if (/^재개$/i.test(t)) { setProp_('PAUSED', 'no'); sysWrite_(); log_(actor, '설정', '자동 점검 재개'); return tgSend_(chatId, '▶️ 자동 점검을 다시 켰습니다.', kbSettings_()); }

  var m;
  if ((m = /^알림\s+(항상|전체|문제만|문제)$/.exec(t))) {
    var lv = /문제/.test(m[1]) ? 'problem' : 'all';
    setProp_('NOTIFY_LEVEL', lv); sysWrite_(); log_(actor, '설정', '알림 수준 ' + (lv === 'all' ? '항상' : '문제만'));
    return tgSend_(chatId, '🔔 알림 수준을 <b>' + (lv === 'all' ? '항상 받기' : '문제 있을 때만') + '</b>으로 바꿨습니다.', kbSettings_());
  }

  if ((m = /^점검시각\s+(.+)$/.exec(t))) return applyHours_(chatId, m[1], actor);

  // ── 도메인 추가 — 주소는 몇 개든, 옆으로 나열하든 한 줄에 하나씩이든 된다
  if ((m = /^추가\s+([\s\S]+)$/.exec(t))) {
    var addToks = tokens_(m[1]);
    var lead = pickLeadingCompany_(loadModel_(), addToks);
    if (!lead.rest.length) {
      return tgSend_(chatId, '❌ 넣을 주소도 함께 적어주세요.\n\n<blockquote>예) 추가 누드티비 a.com b.com c.com\n여러 개는 띄어쓰기·쉼표·줄바꿈 아무거나 됩니다.</blockquote>', kbMain_());
    }
    return doAdd_(chatId, lead.name, lead.rest, actor);
  }

  // ── 도메인 삭제 — 한 개든 여러 개든. 주소가 아닌 말 하나는 업체 이름으로 본다
  if ((m = /^삭제\s+([\s\S]+)$/.exec(t))) {
    var dsp = splitTokens_(tokens_(m[1]));
    var dCo = dsp.words.join(' ');
    var dList = dsp.ok.concat(dsp.bad);
    if (!dList.length) {
      return tgSend_(chatId, '❌ 지울 주소를 적어주세요.\n\n<blockquote>예) 삭제 a.com\n여러 개: 삭제 a.com b.com c.com (줄바꿈도 됩니다)</blockquote>', kbMain_());
    }
    if (dList.length === 1) {
      try {
        var r1 = opRemoveDomain_(dList[0], dCo, actor);
        return tgSend_(chatId, '✅ 삭제됨 — 〔' + esc_(r1.company) + '〕 ' + esc_(r1.domain) + '\n\n<blockquote>잘못 지웠으면 [되돌리기]</blockquote>', kbMain_());
      } catch (e) { return tgSend_(chatId, '❌ ' + esc_(String(e.message || e)), kbMain_()); }
    }
    return doDelMany_(chatId, dList, dCo, actor);
  }

  // ── 주소 변경 — 짝(옛 주소 새 주소)으로. 한 줄에 한 짝씩 여러 줄도 된다
  if ((m = /^변경\s+([\s\S]+)$/.exec(t))) {
    var cToks = tokens_(m[1]);
    if (cToks.length < 2 || cToks.length % 2 !== 0) {
      return tgSend_(chatId, '❌ 바꿀 주소와 새 주소를 <b>짝</b>으로 적어주세요.\n\n<blockquote>변경 a.com b.com\n\n여러 개면 한 줄에 한 짝씩:\n변경\na.com b.com\nc.com d.com</blockquote>', kbMain_());
    }
    var cPairs = [];
    for (var cp = 0; cp < cToks.length; cp += 2) cPairs.push([cToks[cp], cToks[cp + 1]]);
    if (cPairs.length === 1) {
      try {
        var rc = opReplaceDomain_(cPairs[0][0], cPairs[0][1], actor);
        return tgSend_(chatId, '✅ 〔' + esc_(rc.company) + '〕 ' + esc_(rc.from) + ' → ' + esc_(rc.to), kbMain_());
      } catch (e) { return tgSend_(chatId, '❌ ' + esc_(String(e.message || e)), kbMain_()); }
    }
    try {
      var rcm = opReplaceDomains_(cPairs, actor);
      var cl = bulkLines_('✅ 주소 ' + rcm.changed.length + '개 변경', [
        ['↔', rcm.changed.map(function (x) { return '〔' + x.company + '〕 ' + x.from + ' → ' + x.to; })],
        ['⚠️', rcm.missing.map(function (x) { return x + ' (등록되지 않은 주소)'; })],
        ['⚠️', rcm.bad],
      ]);
      return tgSend_(chatId, '<blockquote>' + cl.join('\n') + '</blockquote>\n\n<blockquote>잘못됐으면 [되돌리기]</blockquote>', kbMain_());
    } catch (e) { return tgSend_(chatId, '❌ ' + esc_(String(e.message || e)), kbMain_()); }
  }

  // ── 업체 이동 — 주소 여러 개 + 맨 뒤에 옮겨갈 업체 이름
  if ((m = /^이동\s+([\s\S]+)$/.exec(t))) {
    var vToks = tokens_(m[1]);
    var vsp = splitTokens_(vToks);
    var vCo = vsp.words.join(' ');
    var vList = vsp.ok.concat(vsp.bad);
    // 업체 이름이 주소처럼 생긴 경우(드묾) — 맨 뒤 조각을 업체로 본다
    if (!vCo && vToks.length >= 2) {
      vCo = vToks[vToks.length - 1];
      vList = splitTokens_(vToks.slice(0, vToks.length - 1)).ok;
    }
    if (!vCo || !vList.length) {
      return tgSend_(chatId, '❌ 옮길 주소와 업체를 적어주세요.\n\n<blockquote>이동 a.com 파트너사\n여러 개: 이동 a.com b.com 파트너사</blockquote>', kbMain_());
    }
    if (vList.length === 1) {
      try {
        var rm = opMoveDomain_(vList[0], vCo, actor);
        return tgSend_(chatId, '✅ ' + esc_(rm.domain) + ' : 〔' + esc_(rm.from) + '〕 → 〔' + esc_(rm.to) + '〕', kbMain_());
      } catch (e) { return tgSend_(chatId, '❌ ' + esc_(String(e.message || e)), kbMain_()); }
    }
    try {
      var rmm = opMoveDomains_(vList, vCo, actor);
      var vl = bulkLines_('✅ 〔' + esc_(rmm.to) + '〕 로 ' + rmm.moved.length + '개 이동', [
        ['→', rmm.moved.map(function (x) { return x.domain + ' (〔' + x.from + '〕에서)'; })],
        ['⏭', rmm.already.map(function (x) { return x + ' (이미 이 업체)'; })],
        ['⚠️', rmm.missing.map(function (x) { return x + ' (등록되지 않은 주소)'; })],
        ['⚠️', rmm.bad],
      ]);
      return tgSend_(chatId, '<blockquote>' + vl.join('\n') + '</blockquote>', kbMain_());
    } catch (e) { return tgSend_(chatId, '❌ ' + esc_(String(e.message || e)), kbMain_()); }
  }

  // ── 업체 추가 — 한 줄에 한 업체씩 여러 개도 된다(이름에 띄어쓰기가 있을 수 있으므로 '줄' 기준)
  if ((m = /^업체추가\s+([\s\S]+)$/.exec(t))) {
    var coNames = lines_(m[1]);
    if (coNames.length <= 1) {
      try { return tgSend_(chatId, '✅ 업체 〔' + esc_(opAddCompany_(coNames[0] || m[1], actor)) + '〕 추가됨', kbMain_()); }
      catch (e) { return tgSend_(chatId, '❌ ' + esc_(String(e.message || e)), kbMain_()); }
    }
    var rac = opAddCompanies_(coNames, actor);
    var al = bulkLines_('✅ 업체 ' + rac.added.length + '곳 추가', [
      ['+', rac.added],
      ['⏭', rac.dup.map(function (x) { return x + ' (이미 있음)'; })],
      ['⚠️', rac.bad.map(function (x) { return x.raw + ' (' + x.why + ')'; })],
    ]);
    return tgSend_(chatId, '<blockquote>' + al.join('\n') + '</blockquote>', kbMain_());
  }

  // ── 업체 삭제 — 한 줄에 한 업체씩. 도메인이 함께 지워지므로 반드시 확인을 묻는다
  if ((m = /^업체삭제\s+([\s\S]+)$/.exec(t))) {
    var delNames = lines_(m[1]);
    if (!delNames.length) delNames = [String(m[1]).trim()];
    return askCompanyDelete_(chatId, delNames, actor);
  }

  // ── 업체 이름변경 — 한 줄에 '옛이름 새이름' 한 짝씩
  if ((m = /^이름변경\s+([\s\S]+)$/.exec(t))) {
    var nLines = lines_(m[1]);
    var nPairs = [];
    for (var nl = 0; nl < nLines.length; nl++) {
      var seg = nLines[nl].split(/\s+/).filter(Boolean);
      if (seg.length >= 2) nPairs.push([seg[0], seg.slice(1).join(' ')]);
    }
    if (!nPairs.length) {
      return tgSend_(chatId, '❌ 옛 이름과 새 이름을 적어주세요.\n\n<blockquote>이름변경 누드티비 누드티비2\n여러 개면 한 줄에 한 짝씩</blockquote>', kbMain_());
    }
    if (nPairs.length === 1) {
      try {
        var rr = opRenameCompany_(nPairs[0][0], nPairs[0][1], actor);
        return tgSend_(chatId, '✅ 업체 이름 변경 — 〔' + esc_(rr.from) + '〕 → 〔' + esc_(rr.to) + '〕', kbMain_());
      } catch (e) { return tgSend_(chatId, '❌ ' + esc_(String(e.message || e)), kbMain_()); }
    }
    var rnm = opRenameCompanies_(nPairs, actor);
    var nlz = bulkLines_('✅ 업체 이름 ' + rnm.renamed.length + '개 변경', [
      ['↔', rnm.renamed.map(function (x) { return '〔' + x.from + '〕 → 〔' + x.to + '〕'; })],
      ['⚠️', rnm.missing.map(function (x) { return x + ' (그런 업체가 없음)'; })],
      ['⚠️', rnm.bad.map(function (x) { return x.raw + ' (' + x.why + ')'; })],
    ]);
    return tgSend_(chatId, '<blockquote>' + nlz.join('\n') + '</blockquote>', kbMain_());
  }

  // ── 주소만 덜렁 보낸 경우 → 어디에 추가할지 물어본다
  //   ① 주소만 왔다(오타 섞여도 됨) → 목록으로 본다
  //   ② 섞인 말이 '등록된 업체 이름' 하나면 → 그 업체에 바로 넣는다
  //      (담당자가 업체명을 맨 윗줄에 적고 아래에 주소를 붙여넣는 실제 습관)
  //   ③ 말이 섞였지만 주소가 2개 이상 → 주소만 골라 어디에 넣을지 묻는다
  //   그 밖(주소 1개 + 잡담 등)은 예전처럼 조용히 넘긴다 — 채널 대화에 끼어들지 않기 위해
  var bulk = splitTokens_(tokens_(t));
  var bulkList = bulk.ok.concat(bulk.bad);
  if (bulk.ok.length) {
    var model1 = loadModel_();
    var wordText = bulk.words.join(' ');
    var coHit = wordText ? findCompany_(model1, wordText) : -1;
    if (coHit !== -1) return doAdd_(chatId, model1[coHit].name, bulkList, actor);
    if (!bulk.words.length || bulk.ok.length >= 2) {
      if (!model1.length) {
        setState_(chatId, { op: 'add-pick-newco', domains: bulkList, by: actor, at: Date.now() });
        return tgSend_(chatId, '🏢 등록된 업체가 없습니다. 이 주소를 넣을 업체 이름을 보내주세요.\n\n<blockquote>예) 누드티비   (취소: 취소)</blockquote>');
      }
      setState_(chatId, { op: 'add-pick-company', domains: bulkList, by: actor, at: Date.now() });
      var head1 = bulk.ok.length === 1 && !bulk.bad.length
        ? '➕ <b>' + esc_(bulk.ok[0]) + '</b> 을(를) 어느 업체에 추가할까요?'
        : '➕ 주소 ' + bulk.ok.length + '개를 어느 업체에 추가할까요?\n\n<blockquote>' +
          bulk.ok.slice(0, 15).map(esc_).join('\n') +
          (bulk.ok.length > 15 ? '\n외 ' + (bulk.ok.length - 15) + '개' : '') +
          (bulk.bad.length ? '\n\n⚠️ 주소 형식이 아닌 것 ' + bulk.bad.length + '개는 건너뜁니다' : '') + '</blockquote>';
      return tgSend_(chatId, head1, kbCompanies_(model1, 'a', [[{ text: '+ 새 업체', callback_data: 'an' }]]));
    }
  }

  return null;   // 모르는 말은 조용히 무시(채널에 잡담이 오갈 수 있으므로)
}

function kbSettings_() {
  var s = settings_();
  return { inline_keyboard: [
    [{ text: '🕘 점검 시각 바꾸기', callback_data: 'cfgh' }],
    [{ text: s.notify === 'all' ? '🔔 알림: 항상 → 문제만' : '🔕 알림: 문제만 → 항상', callback_data: 'cfgn' }],
    [{ text: s.paused ? '▶️ 자동 점검 재개' : '⏸ 자동 점검 일시중지', callback_data: 'cfgp' }],
    [{ text: '◀️ 메뉴로', callback_data: 'm' }],
  ] };
}

function applyHours_(chatId, raw, actor) {
  // ★ 빈 조각을 먼저 걸러야 한다. Number('') 는 0 이라서 '9시 21시' 가 '0,9,21' 이 되어
  //   부탁하지 않은 자정 점검이 매일 돌게 된다.
  var hours = String(raw).split(/[^0-9]+/)
    .filter(function (x) { return /^\d+$/.test(x); })
    .map(function (x) { return Number(x); })
    .filter(function (x) { return x >= 0 && x <= 23; });
  // 중복 제거 + 정렬
  var uniq = [];
  for (var i = 0; i < hours.length; i++) if (uniq.indexOf(hours[i]) === -1) uniq.push(hours[i]);
  uniq.sort(function (a, b) { return a - b; });

  if (!uniq.length) return tgSend_(chatId, '❌ 시각을 못 알아들었습니다.\n\n<blockquote>예) 점검시각 9 21</blockquote>', kbSettings_());
  if (uniq.length > 6) return tgSend_(chatId, '❌ 하루 최대 6번까지만 설정할 수 있습니다.', kbSettings_());

  setProp_('CHECK_HOURS', uniq.join(','));
  clearState_(chatId);
  sysWrite_();
  log_(actor, '설정', '점검 시각 ' + uniq.join(',') + '시');
  return tgSend_(chatId, '🕘 점검 시각을 <b>매일 ' +
    uniq.map(function (h) { return ('0' + h).slice(-2) + '시'; }).join(' · ') + '</b> (한국시간)로 바꿨습니다.', kbSettings_());
}

function doAdd_(chatId, company, rawList, actor) {
  try {
    var r = opAddDomains_(company, rawList, actor);
    // ★ 수백 개를 붙여넣어도 답이 끝없이 길어지지 않게 각 묶음을 30줄로 자른다.
    var cap = function (arr, tail) {
      var out = arr.slice(0, 30).map(function (x) { return x + (tail || ''); });
      if (arr.length > 30) out.push('… 외 ' + (arr.length - 30) + '개');
      return out;
    };
    var lines = bulkLines_('✅ 〔' + esc_(r.company) + '〕 ' + r.added.length + '개 추가', [
      ['+', cap(r.added)],
      ['⏭', cap(r.dup, ' (이미 있음)')],
      ['⚠️', cap(r.bad, ' (주소 형식이 아님)')],
      ['ℹ️', cap(r.moved)],
    ]);
    clearState_(chatId);
    var kb = r.added.length
      ? { inline_keyboard: [[{ text: '🔍 지금 점검', callback_data: 'run' }, { text: '◀️ 메뉴로', callback_data: 'm' }]] }
      : kbMain_();
    return tgSend_(chatId, '<blockquote>' + lines.join('\n') + '</blockquote>', kb);
  } catch (e) {
    clearState_(chatId);
    return tgSend_(chatId, '❌ ' + esc_(String(e.message || e)), kbMain_());
  }
}

/** 여러 개를 한 번에 지운다(글 명령·버튼 공용). mid 가 있으면 버튼 응답으로 답한다. */
function doDelMany_(chatId, list, company, actor, mid) {
  var say = function (text, kb) { return mid ? tgReply_(chatId, mid, text, kb) : tgSend_(chatId, text, kb); };
  try {
    var r = opRemoveDomains_(list, company, actor);
    var lines = bulkLines_('✅ ' + r.removed.length + '개 삭제' + (company ? ' — 〔' + esc_(company) + '〕' : ''), [
      ['−', r.removed.map(function (x) { return '〔' + x.company + '〕 ' + x.domain; })],
      ['⚠️', r.missing.map(function (x) { return x + ' (등록되지 않은 주소)'; })],
      ['⚠️', r.wrongCo.map(function (x) { return x + ' (그 업체엔 없음)'; })],
      ['⚠️', r.ambiguous.map(function (x) { return x.domain + ' (여러 업체에 있음: ' + x.names.join(', ') + ')'; })],
      ['⚠️', r.bad.map(function (x) { return x + ' (주소 형식이 아님)'; })],
    ]);
    clearState_(chatId);
    return say('<blockquote>' + lines.join('\n') + '</blockquote>\n\n<blockquote>잘못 지웠으면 [↩️ 되돌리기]</blockquote>', kbMain_());
  } catch (e) {
    clearState_(chatId);
    return say('❌ ' + esc_(String(e.message || e)), kbMain_());
  }
}

/** 업체 삭제 확인을 묻는다(한 곳이든 여러 곳이든). 도메인이 함께 지워지므로 항상 확인한다. */
function askCompanyDelete_(chatId, names, actor, mid) {
  var say = function (text, kb) { return mid ? tgReply_(chatId, mid, text, kb) : tgSend_(chatId, text, kb); };
  var model = loadModel_();
  var found = [], missing = [], total = 0, list = [];
  for (var i = 0; i < names.length; i++) {
    var ci = findCompany_(model, names[i]);
    if (ci === -1) { missing.push(String(names[i])); continue; }
    if (found.indexOf(model[ci].name) !== -1) continue;
    found.push(model[ci].name);
    total += model[ci].domains.length;
    list.push('〔' + esc_(model[ci].name) + '〕 도메인 ' + model[ci].domains.length + '개');
  }
  if (!found.length) return say('❌ 그런 업체가 없습니다: ' + esc_(names.join(', ')), kbMain_());
  var head = found.length === 1
    ? '🗑 업체 〔' + esc_(found[0]) + '〕 를 도메인 ' + total + '개와 함께 삭제할까요?'
    : '🗑 업체 ' + found.length + '곳을 도메인 ' + total + '개와 함께 삭제할까요?\n\n<blockquote>' + list.join('\n') + '</blockquote>';
  if (missing.length) head += '\n\n<blockquote>⚠️ 없는 업체는 건너뜁니다: ' + esc_(missing.join(', ')) + '</blockquote>';
  var sent = say(head, { inline_keyboard: [[{ text: '예, 삭제', callback_data: 'codelok' }, { text: '아니오', callback_data: 'x' }]] });
  setState_(chatId, { op: 'codel-confirm', names: found, name: found[0], by: actor, at: Date.now(), mid: sentMid_(sent) });
  return sent;
}

function askUndo_(chatId) {
  var label = prop_('UNDO_LABEL', '');
  var at = prop_('UNDO_AT', '');
  if (!label) return tgSend_(chatId, '되돌릴 내용이 없습니다.', kbMain_());
  return tgSend_(chatId, '↩️ 직전 <b>' + esc_(label) + '</b> 작업(' + esc_(at) + ')을 되돌릴까요?',
    { inline_keyboard: [[{ text: '예, 되돌리기', callback_data: 'undook' }, { text: '아니오', callback_data: 'x' }]] });
}

// 대화 중 입력 받기
function handleStateInput_(chatId, st, text, actor) {
  if (st.op === 'add-input') {
    // 옆으로 나열하든 한 줄에 하나씩이든 똑같이 받는다
    return doAdd_(chatId, st.company, tokens_(text), actor);
  }
  if (st.op === 'add-newco') {
    // 업체 이름만 적을 수도 있고, 첫 줄에 업체·다음 줄부터 주소를 한꺼번에 붙여넣을 수도 있다
    var nls = lines_(text);
    var coName = nls.length ? nls[0] : String(text).trim();
    if (nls.length > 1) {
      var rest = splitTokens_(tokens_(nls.slice(1).join(' ')));
      if (rest.ok.length) { clearState_(chatId); return doAdd_(chatId, coName, rest.ok.concat(rest.bad), actor); }
    }
    setState_(chatId, { op: 'add-input', company: coName, by: actor, at: Date.now() });
    return tgSend_(chatId, '➕ 〔' + esc_(coName) + '〕 에 추가할 주소를 보내주세요.\n\n<blockquote>여러 개면 줄바꿈이나 띄어쓰기로 한 번에. (취소: 취소)</blockquote>');
  }
  if (st.op === 'add-pick-newco') {
    clearState_(chatId);
    return doAdd_(chatId, firstLine_(text), st.domains, actor);
  }
  if (st.op === 'add-pick-company') {
    // 버튼 대신 업체 이름을 글로 적은 경우 — 예전엔 여기서 조용히 사라졌다
    clearState_(chatId);
    return doAdd_(chatId, firstLine_(text), st.domains, actor);
  }
  if (st.op === 'del-input') {
    // 여러 개 한 번에 삭제 — 지우기 전에 무엇을 지울지 보여주고 확인받는다
    var dsp = splitTokens_(tokens_(text));
    if (!dsp.ok.length) {
      clearState_(chatId);
      return tgSend_(chatId, '❌ 주소를 못 알아들었습니다.\n\n<blockquote>다시 [🗑 도메인 삭제] 부터 해주세요.</blockquote>', kbMain_());
    }
    var dHead = '🗑 〔' + esc_(st.company) + '〕 에서 ' + dsp.ok.length + '개를 지울까요?\n\n<blockquote>' +
      dsp.ok.slice(0, 20).map(esc_).join('\n') +
      (dsp.ok.length > 20 ? '\n… 외 ' + (dsp.ok.length - 20) + '개' : '') +
      (dsp.bad.length ? '\n\n⚠️ 주소 형식이 아닌 ' + dsp.bad.length + '개는 건너뜁니다' : '') + '</blockquote>';
    var dSent = tgSend_(chatId, dHead,
      { inline_keyboard: [[{ text: '예, 삭제', callback_data: 'dmok' }, { text: '아니오', callback_data: 'x' }]] });
    setState_(chatId, { op: 'del-multi-confirm', company: st.company, domains: dsp.ok, by: actor, at: Date.now(), mid: sentMid_(dSent) });
    return dSent;
  }
  if (st.op === 'co-add') {
    var nameLines = lines_(text);
    // 업체 여러 곳을 한 줄에 하나씩 붙여넣은 경우
    if (!st.thenAdd && nameLines.length > 1) {
      clearState_(chatId);
      var rac = opAddCompanies_(nameLines, actor);
      var acl = bulkLines_('✅ 업체 ' + rac.added.length + '곳 추가', [
        ['+', rac.added],
        ['⏭', rac.dup.map(function (x) { return x + ' (이미 있음)'; })],
        ['⚠️', rac.bad.map(function (x) { return x.raw + ' (' + x.why + ')'; })],
      ]);
      return tgSend_(chatId, '<blockquote>' + acl.join('\n') + '</blockquote>', kbMain_());
    }
    var newName = firstLine_(text);
    try {
      var made = opAddCompany_(newName, actor);
      if (st.thenAdd) {
        // 업체가 하나도 없을 때 [➕ 도메인 추가]로 들어온 경우 — 만들고 끝내면 안 되고 주소까지 이어받아야 한다
        setState_(chatId, { op: 'add-input', company: made, by: actor, at: Date.now() });
        return tgSend_(chatId, '✅ 업체 〔' + esc_(made) + '〕 추가됨\n\n➕ 이제 추가할 주소를 보내주세요.\n\n<blockquote>여러 개면 줄바꿈이나 띄어쓰기로 한 번에. (취소: 취소)</blockquote>');
      }
      clearState_(chatId);
      return tgSend_(chatId, '✅ 업체 〔' + esc_(made) + '〕 추가됨', kbMain_());
    } catch (e) {
      clearState_(chatId);
      return tgSend_(chatId, '❌ ' + esc_(String(e.message || e)), kbMain_());
    }
  }
  if (st.op === 'co-rename') {
    clearState_(chatId);
    try {
      var rr = opRenameCompany_(st.name, firstLine_(text), actor);
      return tgSend_(chatId, '✅ 〔' + esc_(rr.from) + '〕 → 〔' + esc_(rr.to) + '〕', kbMain_());
    } catch (e) { return tgSend_(chatId, '❌ ' + esc_(String(e.message || e)), kbMain_()); }
  }
  if (st.op === 'cfg-hours') return applyHours_(chatId, text, actor);

  // 확인(예/아니오)을 기다리는 중에 다른 말을 쓴 경우 — 예전엔 아무 말 없이 절차가 사라졌다
  if (st.op === 'del-confirm' || st.op === 'codel-confirm' || st.op === 'del-multi-confirm') {
    clearState_(chatId);
    return tgSend_(chatId, '확인을 기다리다 취소했습니다.\n\n<blockquote>버튼을 누르지 않고 다른 말을 쓰면 취소됩니다.\n다시 하시려면 [🗑 도메인 삭제]</blockquote>', kbMain_());
  }
  clearState_(chatId);
  return tgSend_(chatId, '진행 중이던 작업을 취소했습니다.\n\n<blockquote>다시 시작하려면 아래 버튼을 눌러주세요.</blockquote>', kbMain_());
}

// ═══════════════════════════════════════════════════════════════════
// 텔레그램 — 버튼 처리
// ═══════════════════════════════════════════════════════════════════
function handleCallback_(cb) {
  var chatId = String(cb.message.chat.id);
  var mid = cb.message.message_id;
  var data = String(cb.data || '');
  var actor = actorOf_(null, cb.from);

  if (!canControl_(chatId)) { tgAnswer_(cb.id, '권한이 없습니다'); return; }
  tgAnswer_(cb.id, '');

  var model = loadModel_();
  var parts = data.split(':');
  var head = parts[0];

  // 다른 담당자가 절차를 진행 중이면 새 절차 시작을 막는다(입력이 섞이는 사고 방지)
  if (['add', 'del', 'coa', 'cor', 'cod', 'cfgh', 'dx', 'dm', 'codp', 'corp'].indexOf(head) !== -1) {
    var busy = busyBy_(chatId, actor);
    if (busy) return tgReply_(chatId, mid, busy, kbMain_());
  }

  if (head === 'm')    return tgReply_(chatId, mid, menuText_(), kbMain_());
  if (head === 'x')    { clearState_(chatId); return tgReply_(chatId, mid, '취소했습니다.', kbMain_()); }
  if (head === 'help') return tgReply_(chatId, mid, helpText_(), kbBack_());
  if (head === 'list') return tgReply_(chatId, mid, listText_(), kbBack_());
  if (head === 'cfg')  return tgReply_(chatId, mid, settingsText_(), kbSettings_());

  if (head === 'run') {
    try {
      dispatchWorkflow_('manual');
      return tgReply_(chatId, mid, '🌐 점검을 시작합니다.\n\n<blockquote>1~3분 뒤 결과를 보내드릴게요.</blockquote>', kbBack_());
    } catch (e) {
      return tgReply_(chatId, mid, '❌ 실행 요청 실패\n\n<blockquote>' + esc_(String(e.message || e)) + '</blockquote>', kbBack_());
    }
  }

  if (head === 'add') {
    if (!model.length) {
      // thenAdd: 업체를 만든 뒤 곧바로 주소 입력으로 이어간다(여기서 끊기면 셋업 첫 단계에서 막힌다)
      setState_(chatId, { op: 'co-add', thenAdd: true, by: actor, at: Date.now() });
      return tgReply_(chatId, mid, '🏢 등록된 업체가 없습니다. 먼저 업체 이름을 보내주세요.\n\n<blockquote>예) 누드티비\n업체를 만들면 바로 주소를 물어봅니다. (취소: 취소)</blockquote>');
    }
    return tgReply_(chatId, mid, '➕ 어느 업체에 추가할까요?',
      kbCompanies_(model, 'a', [[{ text: '+ 새 업체', callback_data: 'an' }]]));
  }
  if (head === 'a') {
    var ci = Number(parts[1]);
    if (!model[ci]) return tgReply_(chatId, mid, '목록이 바뀌었습니다. 다시 시도해 주세요.', kbMain_());
    var st0 = getState_(chatId);
    if (st0 && st0.op === 'add-pick-company') {
      clearState_(chatId);
      return doAdd_(chatId, model[ci].name, st0.domains, actor);
    }
    setState_(chatId, { op: 'add-input', company: model[ci].name, by: actor, at: Date.now() });
    return tgReply_(chatId, mid, '➕ 〔' + esc_(model[ci].name) + '〕 에 추가할 주소를 보내주세요.\n\n<blockquote>여러 개면 줄바꿈으로 한 번에.\nhttps·www·뒤 경로는 알아서 정리됩니다. (취소: 취소)</blockquote>');
  }
  if (head === 'an') {
    var stn = getState_(chatId);
    setState_(chatId, (stn && stn.op === 'add-pick-company')
      ? { op: 'add-pick-newco', domains: stn.domains, by: actor, at: Date.now() }
      : { op: 'add-newco', by: actor, at: Date.now() });
    return tgReply_(chatId, mid, '🏢 새 업체 이름을 보내주세요.\n\n<blockquote>예) 누드티비   (취소: 취소)</blockquote>');
  }

  if (head === 'del') {
    if (!model.length) return tgReply_(chatId, mid, '등록된 도메인이 없습니다.', kbMain_());
    return tgReply_(chatId, mid, '🗑 어느 업체의 주소를 지울까요?', kbCompanies_(model, 'd'));
  }
  if (head === 'd') {
    var di = Number(parts[1]);
    if (!model[di]) return tgReply_(chatId, mid, '목록이 바뀌었습니다. 다시 시도해 주세요.', kbMain_());
    if (!model[di].domains.length) return tgReply_(chatId, mid, '〔' + esc_(model[di].name) + '〕 에 주소가 없습니다.', kbMain_());
    var rows = [];
    for (var i = 0; i < model[di].domains.length; i++) {
      rows.push([{ text: '🗑 ' + model[di].domains[i], callback_data: 'dx:' + di + ':' + i }]);
      if (rows.length >= 39) break;   // + [여러 개 한 번에] + [메뉴로] = 41줄(텔레그램 여유)
    }
    rows.push([{ text: '🗑 여러 개 한 번에', callback_data: 'dm:' + di }]);
    rows.push([{ text: '◀️ 메뉴로', callback_data: 'm' }]);
    var over = model[di].domains.length - rows.length + 2;
    var note = over > 0 ? '\n\n<blockquote>주소가 많아 앞 39개만 보여드립니다.\n나머지는 [🗑 여러 개 한 번에] 로 붙여넣거나 <b>삭제 a.com b.com</b> 처럼 적어주세요.</blockquote>' : '';
    return tgReply_(chatId, mid, '🗑 〔' + esc_(model[di].name) + '〕 에서 지울 주소를 고르세요.' + note, { inline_keyboard: rows });
  }
  if (head === 'dx') {
    var c1 = Number(parts[1]), d1 = Number(parts[2]);
    if (!model[c1] || !model[c1].domains[d1]) return tgReply_(chatId, mid, '목록이 바뀌었습니다. 다시 시도해 주세요.', kbMain_());
    // ★ 확인 메시지는 '새 메시지'로 나간다(2026-09-05 변경).
    //   그래서 담당자가 실제로 누를 메시지는 방금 보낸 그것이다 —
    //   옛 메시지 번호를 저장하면 항상 '지난 확인 버튼입니다'로 막힌다.
    var dsent = tgReply_(chatId, mid, '🗑 〔' + esc_(model[c1].name) + '〕 <b>' + esc_(model[c1].domains[d1]) + '</b> 을(를) 삭제할까요?',
      { inline_keyboard: [[{ text: '예, 삭제', callback_data: 'dok' }, { text: '아니오', callback_data: 'x' }]] });
    setState_(chatId, { op: 'del-confirm', company: model[c1].name, domain: model[c1].domains[d1], by: actor, at: Date.now(), mid: sentMid_(dsent) });
    return dsent;
  }
  if (head === 'dok') {
    var std = getState_(chatId);
    clearState_(chatId);
    if (!std || std.op !== 'del-confirm') return tgReply_(chatId, mid, '시간이 지나 취소되었습니다. 다시 시도해 주세요.', kbMain_());
    // 오래된 확인 버튼(위로 스크롤해서 누른 것)이 엉뚱한 대상을 지우지 않게 한다
    if (std.mid && std.mid !== mid) return tgReply_(chatId, mid, '지난 확인 버튼입니다. 새로 시작해 주세요.', kbMain_());
    try {
      var rd = opRemoveDomain_(std.domain, std.company, actor);
      return tgReply_(chatId, mid, '✅ 삭제됨 — 〔' + esc_(rd.company) + '〕 ' + esc_(rd.domain) + '\n\n<blockquote>잘못 지웠으면 [↩️ 되돌리기]</blockquote>', kbMain_());
    } catch (e) { return tgReply_(chatId, mid, '❌ ' + esc_(String(e.message || e)), kbMain_()); }
  }

  if (head === 'dm') {
    var mi = Number(parts[1]);
    if (!model[mi]) return tgReply_(chatId, mid, '목록이 바뀌었습니다. 다시 시도해 주세요.', kbMain_());
    setState_(chatId, { op: 'del-input', company: model[mi].name, by: actor, at: Date.now() });
    return tgReply_(chatId, mid, '🗑 〔' + esc_(model[mi].name) + '〕 에서 지울 주소를 보내주세요.\n\n<blockquote>여러 개면 줄바꿈이나 띄어쓰기로 한 번에.\n예) a.com b.com   또는 한 줄에 하나씩\n(취소: 취소)</blockquote>');
  }
  if (head === 'dmok') {
    var stm = getState_(chatId);
    clearState_(chatId);
    if (!stm || stm.op !== 'del-multi-confirm') return tgReply_(chatId, mid, '시간이 지나 취소되었습니다. 다시 시도해 주세요.', kbMain_());
    if (stm.mid && stm.mid !== mid) return tgReply_(chatId, mid, '지난 확인 버튼입니다. 새로 시작해 주세요.', kbMain_());
    return doDelMany_(chatId, stm.domains, stm.company || '', actor, mid);
  }

  if (head === 'co') {
    return tgReply_(chatId, mid, '🏢 <b>업체 관리</b>\n\n<blockquote>' + (model.length ? model.map(function (c) { return esc_(c.name) + ' (' + c.domains.length + ')'; }).join('\n') : '등록된 업체가 없습니다') + '</blockquote>',
      { inline_keyboard: [
        [{ text: '➕ 업체 추가', callback_data: 'coa' }],
        [{ text: '✏️ 이름 바꾸기', callback_data: 'cor' }, { text: '🗑 업체 삭제', callback_data: 'cod' }],
        [{ text: '◀️ 메뉴로', callback_data: 'm' }],
      ] });
  }
  if (head === 'coa') {
    setState_(chatId, { op: 'co-add', by: actor, at: Date.now() });
    return tgReply_(chatId, mid, '🏢 새 업체 이름을 보내주세요.\n\n<blockquote>예) 누드티비   (취소: 취소)</blockquote>');
  }
  if (head === 'cor') {
    if (!model.length) return tgReply_(chatId, mid, '등록된 업체가 없습니다.', kbMain_());
    return tgReply_(chatId, mid, '✏️ 이름을 바꿀 업체를 고르세요.', kbCompanies_(model, 'corp'));
  }
  if (head === 'corp') {
    var ri = Number(parts[1]);
    if (!model[ri]) return tgReply_(chatId, mid, '목록이 바뀌었습니다. 다시 시도해 주세요.', kbMain_());
    setState_(chatId, { op: 'co-rename', name: model[ri].name, by: actor, at: Date.now() });
    return tgReply_(chatId, mid, '✏️ 〔' + esc_(model[ri].name) + '〕 의 새 이름을 보내주세요.\n\n<blockquote>(취소: 취소)</blockquote>');
  }
  if (head === 'cod') {
    if (!model.length) return tgReply_(chatId, mid, '등록된 업체가 없습니다.', kbMain_());
    return tgReply_(chatId, mid, '🗑 삭제할 업체를 고르세요.\n\n<blockquote>그 업체의 도메인이 함께 지워집니다.</blockquote>', kbCompanies_(model, 'codp'));
  }
  if (head === 'codp') {
    var xi = Number(parts[1]);
    if (!model[xi]) return tgReply_(chatId, mid, '목록이 바뀌었습니다. 다시 시도해 주세요.', kbMain_());
    return askCompanyDelete_(chatId, [model[xi].name], actor, mid);
  }
  if (head === 'codelok') {
    var stc = getState_(chatId);
    clearState_(chatId);
    if (!stc || stc.op !== 'codel-confirm') return tgReply_(chatId, mid, '시간이 지나 취소되었습니다. 다시 시도해 주세요.', kbMain_());
    if (stc.mid && stc.mid !== mid) return tgReply_(chatId, mid, '지난 확인 버튼입니다. 새로 시작해 주세요.', kbMain_());
    try {
      var conames = (stc.names && stc.names.length) ? stc.names : [stc.name];
      var rco = opRemoveCompanies_(conames, actor);
      if (rco.removed.length === 1 && !rco.missing.length) {
        return tgReply_(chatId, mid, '✅ 업체 〔' + esc_(rco.removed[0].name) + '〕 삭제됨 (도메인 ' + rco.removed[0].count + '개)\n\n<blockquote>잘못 지웠으면 [↩️ 되돌리기]</blockquote>', kbMain_());
      }
      var col = bulkLines_('✅ 업체 ' + rco.removed.length + '곳 삭제', [
        ['−', rco.removed.map(function (x) { return x.name + ' (도메인 ' + x.count + '개)'; })],
        ['⚠️', rco.missing.map(function (x) { return x + ' (그런 업체가 없음)'; })],
      ]);
      return tgReply_(chatId, mid, '<blockquote>' + col.join('\n') + '</blockquote>\n\n<blockquote>잘못 지웠으면 [↩️ 되돌리기]</blockquote>', kbMain_());
    } catch (e) { return tgReply_(chatId, mid, '❌ ' + esc_(String(e.message || e)), kbMain_()); }
  }

  if (head === 'cfgh') {
    setState_(chatId, { op: 'cfg-hours', by: actor, at: Date.now() });
    return tgReply_(chatId, mid, '🕘 점검할 시각을 한국시간 기준 숫자로 보내주세요.\n\n<blockquote>예) 9 21   → 매일 09시·21시\n예) 7 13 19 → 하루 세 번\n(취소: 취소)</blockquote>');
  }
  if (head === 'cfgn') {
    var s2 = settings_();
    var nv = s2.notify === 'all' ? 'problem' : 'all';
    setProp_('NOTIFY_LEVEL', nv); sysWrite_(); log_(actor, '설정', '알림 수준 ' + (nv === 'all' ? '항상' : '문제만'));
    return tgReply_(chatId, mid, settingsText_(), kbSettings_());
  }
  if (head === 'cfgp') {
    var s3 = settings_();
    setProp_('PAUSED', s3.paused ? 'no' : 'yes'); sysWrite_();
    log_(actor, '설정', s3.paused ? '자동 점검 재개' : '자동 점검 일시중지');
    return tgReply_(chatId, mid, settingsText_(), kbSettings_());
  }

  if (head === 'undo') {
    if (!prop_('UNDO_LABEL', '')) return tgReply_(chatId, mid, '되돌릴 내용이 없습니다.', kbMain_());
    return tgReply_(chatId, mid, '↩️ 직전 <b>' + esc_(prop_('UNDO_LABEL', '변경')) + '</b> 작업(' + esc_(prop_('UNDO_AT', '-')) + ')을 되돌릴까요?',
      { inline_keyboard: [[{ text: '예, 되돌리기', callback_data: 'undook' }, { text: '아니오', callback_data: 'x' }]] });
  }
  if (head === 'undook') {
    try {
      var lbl = withLock_(function () { return undo_(); });
      log_(actor, '되돌리기', lbl + ' 작업을 되돌림');
      sysWrite_();
      return tgReply_(chatId, mid, '↩️ 되돌렸습니다 (' + esc_(lbl) + ').', kbMain_());
    } catch (e) { return tgReply_(chatId, mid, '❌ ' + esc_(String(e.message || e)), kbMain_()); }
  }

  return tgReply_(chatId, mid, menuText_(), kbMain_());
}

// ═══════════════════════════════════════════════════════════════════
// 텔레그램 진입점
// ═══════════════════════════════════════════════════════════════════
/**
 * ★ 명령 하나를 처리한다. 웹훅으로 오든 폴링으로 가져오든 여기로 모인다.
 *   → 'ignored:...' 또는 'ok' 를 돌려준다(호출한 쪽이 응답을 만든다).
 */
function processUpdate_(update) {
  if (!update) return 'ignored: empty';
  if (seenUpdate_(update.update_id)) return 'ignored: duplicate';

  // ★ 담당자가 조작을 시작했다 → 빠른 응답조를 깨운다.
  //   ① 이미 깨어 있거나 방금 깨웠으면 아무 일도 하지 않는다(§wakeRelay_)
  //   ② 반드시 '허용된 채널'일 때만 — 모르는 사람이 봇에게 말을 걸어
  //      깃허브 실행을 유발하지 못하게 한다.
  try {
    var srcChat = (update.callback_query && update.callback_query.message && update.callback_query.message.chat && update.callback_query.message.chat.id) ||
      ((update.message || update.channel_post || {}).chat || {}).id || '';
    if (srcChat && canControl_(String(srcChat))) wakeRelay_();
  } catch (ignoreWake) {}

  if (update.callback_query) {
    try { handleCallback_(update.callback_query); }
    catch (err) { try { tgAnswer_(update.callback_query.id, '오류: ' + String(err.message || err)); } catch (i2) {} }
    return 'ok';
  }

  // 수정된 글(edited_*)은 명령으로 처리하지 않는다 — 옛 글을 고쳐서 다시 실행되는 사고 방지
  var msg = update.message || update.channel_post;

  // ★ 진단용 흔적 — 무엇이 도착했는지 남긴다(비밀값 없음). '왜 답이 없나'를 추측 대신 사실로 본다.
  try {
    var kinds = [];
    for (var kk in update) if (kk !== 'update_id') kinds.push(kk);
    setProp_('LAST_UPDATE_DEBUG', nowKst_() + ' | 종류=' + kinds.join(',') +
      ' | chat=' + String((msg && msg.chat && msg.chat.id) || '없음') +
      ' | 글=' + String((msg && msg.text) || '').slice(0, 30) +
      ' | 허용=' + (canControl_(String((msg && msg.chat && msg.chat.id) || '')) ? 'Y' : 'N'));
  } catch (ignoreDbg) {}

  if (!msg || !msg.text) return 'ignored: no text';

  var chatId = String((msg.chat && msg.chat.id) || '');
  var text = String(msg.text || '').trim();
  var actor = actorOf_(msg, null);

  // 허용되지 않은 곳: 조용히 무시. (설정이 비어 있으면 여기로 온다)
  if (!canControl_(chatId)) return 'ignored: not allowed';

  try {
    handleTextCommand_(chatId, text, actor);
  } catch (err) {
    tgSend_(chatId, '❌ 오류\n\n<blockquote>' + esc_(String(err.message || err)) + '</blockquote>', kbMain_());
  }
  return 'ok';
}

function handleTelegram_(e) {
  var secret = prop_('WEBHOOK_SECRET', '');
  if (secret) {
    var got = (e.parameter && e.parameter.s) || '';
    if (got !== secret) return json_({ ok: true, ignored: 'bad secret' });
  }

  var update = {};
  try { update = JSON.parse((e.postData && e.postData.contents) || '{}'); } catch (ignore) {}

  return json_({ ok: true, result: processUpdate_(update) });
}

/**
 * ★ 폴링 — 앱스스크립트가 1분마다 텔레그램에 '새 명령 있나요' 하고 가지러 간다.
 *
 * 왜 웹훅을 안 쓰나: 앱스스크립트 웹앱은 응답으로 302(넘김)를 돌려준다.
 * 텔레그램은 302를 '실패'로 보고 같은 명령을 계속 재시도하며, 그동안 뒤에 온
 * 명령이 줄줄이 막힌다(2026-09-04 실측: 대기 5건, "Wrong response from the
 * webhook: 302 Found"). 구글 쪽에서 302를 없앨 방법이 없으므로 방향을 뒤집는다.
 *
 * 대가: 최대 1분 지연. 대신 명령이 사라지지 않는다.
 */
function pollUpdates() {
  PROP_MEMO = null;
  PRE_ANSWERED = false;      // 폴링으로 직접 가져온 명령은 아무도 먼저 답하지 않았다

  // ★ 설치 함수를 안전하게 실행하는 경로(아래 runPendingSetup_ 주석 참고)
  try { runPendingSetup_(); } catch (ignoreSetup) {}

  // ★ 즉답기(웹훅) 모드면 여기서 아무것도 하지 않는다.
  //   특히 아래 409 자동복구가 '우리 웹훅'을 지워버리는 사고를 막는다.
  if (mode_() === 'webhook') return;
  var bot = prop_('BOT_TOKEN');
  if (!bot) return;

  // ★ 깃허브 대기조가 살아 있으면 그쪽이 초 단위로 처리한다.
  //   여기서 또 가져가면 같은 명령을 두 곳이 나눠 가져 순서가 꼬인다 — 조용히 물러난다.
  if (relayAlive_()) return;

  // 자고 있다면, 업무시간에는 미리 깨워 둔다(첫 조작이 느려지지 않게).
  try { preheatRelay_(); } catch (ignorePre) {}

  // 두 실행이 겹치면 같은 명령을 두 번 처리한다 — 겹치면 조용히 물러난다.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;

  try {
    var offset = Number(prop_('TG_OFFSET', '0')) || 0;
    var url = 'https://api.telegram.org/bot' + bot + '/getUpdates?timeout=0&limit=30' +
      '&allowed_updates=' + encodeURIComponent(JSON.stringify(['message', 'channel_post', 'callback_query'])) +
      (offset ? '&offset=' + offset : '');
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var body = null;
    try { body = JSON.parse(res.getContentText()); } catch (e1) { body = null; }

    if (!body || !body.ok) {
      var desc = (body && body.description) || ('HTTP ' + res.getResponseCode());
      // 409 = 웹훅이 아직 걸려 있다 → 폴링과 공존 불가. 웹훅을 떼어내고 다음 회차에 이어간다.
      if (/can't use getUpdates method while webhook is active/i.test(desc)) {
        try { deleteWebhook(); } catch (i3) {}
        return;
      }
      setProp_('LAST_ERROR', nowKst_() + ' 텔레그램 getUpdates 실패: ' + String(desc).slice(0, 150));
      return;
    }

    var list = body.result || [];
    if (!list.length) return;

    var maxId = offset ? offset - 1 : 0;
    for (var i = 0; i < list.length; i++) {
      var u = list[i];
      if (u.update_id > maxId) maxId = u.update_id;
      // 하나가 터져도 나머지는 처리한다 — 한 명령 때문에 채널 전체가 멈추면 안 된다.
      try { processUpdate_(u); }
      catch (e2) {
        try { setProp_('LAST_ERROR', nowKst_() + ' 명령 처리 오류: ' + String(e2 && e2.message || e2).slice(0, 150)); } catch (i4) {}
      }
      // 처리한 데까지는 즉시 확정한다 — 도중에 시간이 다 돼도 같은 명령을 다시 처리하지 않게.
      setProp_('TG_OFFSET', String(maxId + 1));
    }
  } finally {
    try { lock.releaseLock(); } catch (i5) {}
  }
}

// ═══════════════════════════════════════════════════════════════════
// 웹앱 진입점 (GitHub ↔ 브리지)
// ═══════════════════════════════════════════════════════════════════
/** POST 본문을 한 번만 파싱해서 재사용한다(두 번 읽으면 빈 값이 된다) */
function bodyOf_(e) {
  try { return JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (ignore) { return {}; }
}

/**
 * 잠금값은 URL 질의문자열(?token=)로도, POST 본문({token:...})으로도 받는다.
 * ★ 본문 방식이 기본이다 — 한국 VPN 경유 시 질의문자열이 붙은 GET 이 중간에서
 *   404 로 잘리는 사례가 있었다(2026-09-04). 본문에 담으면 URL 에 비밀값이 남지도 않는다.
 *   텔레그램 웹훅만은 URL 에 넣을 수밖에 없으므로 두 방식을 모두 허용한다.
 */
function authorized_(e, body) {
  var token = prop_('ACCESS_TOKEN');
  if (!token) return false;
  var got = (e && e.parameter && e.parameter.token) || (body && body.token) || '';
  return String(got) === String(token);
}

/** 시트 '접속점검' 탭을 그대로 읽어 돌려준다(doGet·doPost 공용) */
function readPayload_() {
  var sh = sheet_(SHEET_INPUT, true);
  var lastRow = Math.max(1, sh.getLastRow());
  var lastCol = Math.min(Math.max(1, sh.getLastColumn()), MAX_COMPANIES);
  return {
    ok: true,
    values: sh.getRange(1, 1, lastRow, lastCol).getDisplayValues(),
    settings: settings_(),
  };
}

function doGet(e) {
  PROP_MEMO = null;          // 새 요청 — 설정값을 다시 읽는다
  try {
    if (!authorized_(e)) return json_({ ok: false, error: 'unauthorized' });
    var action = (e.parameter.action || 'read');
    if (action === 'read') return json_(readPayload_());
    if (action === 'ping') return json_({ ok: true, pong: true });
    return json_({ ok: false, error: 'unknown action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  PROP_MEMO = null;          // 새 요청 — 설정값을 다시 읽는다
  try {
    // 텔레그램 웹훅은 본문이 '업데이트'라 미리 파싱해도 해가 없다.
    var isTg = !!(e && e.parameter && e.parameter.action === 'tg');
    var body = isTg ? {} : bodyOf_(e);
    var action = (e && e.parameter && e.parameter.action) || body.action || 'write';

    if (action === 'tg') {
      if (!authorized_(e, null)) return json_({ ok: false, error: 'unauthorized' });
      return handleTelegram_(e);
    }
    if (!authorized_(e, body)) return json_({ ok: false, error: 'unauthorized' });

    // ★ read 를 POST 로도 받는다 — 한국 VPN 에서 GET 이 막히는 경우의 정식 경로.
    if (action === 'read') return json_(readPayload_());
    if (action === 'ping') return json_({ ok: true, pong: true });
    if (action === 'diag') return json_(diag_());
    if (action === 'write') {
      writeResults_(body.rows || [], body.meta || {});
      return json_({ ok: true, written: Math.max(0, (body.rows || []).length - 1) });
    }
    // ─── 즉답기(클라우드플레어 워커) 전용 ────────────────────
    //   워커가 텔레그램에서 받은 명령을 그대로 넘겨준다.
    //   preAnswered=true 면 버튼 응답은 워커가 이미 보냈다는 뜻이다.
    if (action === 'edge') {
      PRE_ANSWERED = !!body.preAnswered;
      var edgeResult = processUpdate_(body.update || null);
      PRE_ANSWERED = false;
      return json_({ ok: true, result: edgeResult });
    }

    // ─── 깨우기형 대기조 전용 ───────────────────────────────
    //   대기조는 텔레그램에 길게 귀 대고 있다가 명령이 오면 즉시 여기로 넘긴다.
    // ★ 대기조마다 고유번호(relayId)를 붙인다.
    //   2026-09-05 실측: 배포 직후 첫 요청이 느려 대기조 쪽에서 30초 만에 포기했는데,
    //   구글은 그 요청을 뒤늦게 실행해 '대기조 살아있음'만 켜둔 상태가 되었다.
    //   → 대기조가 죽었는데 폴링도 물러나 최대 90초 공백. 고유번호로 이걸 막는다:
    //     같은 번호로 다시 인사하면 '내 자리'로 인정하고, 지난 대기조의 신호는 무시한다.
    if (action === 'relay-hello') {
      var rid = String(body.relayId || '');
      if (relayAlive_() && prop_('RELAY_ID', '') !== rid) return json_({ ok: true, alreadyAlive: true });
      setProp_('RELAY_ID', rid);
      relayTouch_();
      setProp_('RELAY_STARTED_AT', nowKst_());
      return json_({ ok: true, offset: Number(prop_('TG_OFFSET', '0')) || 0, idleMinutes: RELAY_IDLE_MIN });
    }
    if (action === 'relay-ping' || action === 'relay-update' || action === 'relay-bye') {
      if (!relayOwner_(body)) return json_({ ok: false, error: 'stale relay' });   // 지난 대기조의 신호
      if (action === 'relay-bye') {                 // 종료 — 즉시 1분 방식으로 복귀
        if (body.offset) setProp_('TG_OFFSET', String(body.offset));
        relayStop_();
        return json_({ ok: true });
      }
      relayTouch_();                                 // 살아 있다는 신호
      var relayResult = null;
      if (action === 'relay-update') {
      PRE_ANSWERED = !!body.preAnswered;      // 대기조가 이미 즉답을 보냈나
      relayResult = processUpdate_(body.update || null);
      PRE_ANSWERED = false;
    }
      if (body.offset) setProp_('TG_OFFSET', String(body.offset));
      return json_({ ok: true, result: relayResult });
    }
    if (action === 'fail') {
      clearWatchdog_();
      setProp_('RUN_STATE', '실패');
      setProp_('LAST_ERROR', nowKst_() + ' ' + String(body.error || '알 수 없는 오류'));
      sysWrite_();
      return json_({ ok: true });
    }
    return json_({ ok: false, error: 'unknown action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function writeResults_(rows, meta) {
  clearWatchdog_();

  // ★ 순서가 중요하다. 예전엔 속성 저장을 먼저 했는데, 리포트가 길면 그 줄에서 예외가 나
  //   '결과' 탭이 아예 기록되지 않았다 — 하필 문제가 많은 날에만 조용히 실패했다.
  //   그래서 시트 기록을 먼저 하고, 부가 정보 저장은 각각 실패해도 넘어가게 한다.
  if (rows && rows.length && rows[0] && rows[0].length) {
    var sh = sheet_(SHEET_RESULT, true);
    var width = rows[0].length;
    var norm = rows.map(function (r) {
      var a = (r || []).slice(0, width);
      while (a.length < width) a.push('');
      return safeRow_(a);
    });
    sh.clear();
    sh.getRange(1, 1, norm.length, width).setValues(norm);
    sh.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#F1F3F4');
    sh.setFrozenRows(1);
    try { sh.autoResizeColumns(1, width); } catch (ignore) {}
  }

  // 형식이 잘못돼 점검조차 못 한 항목을 시트 아래에 덧붙인다(운영자가 바로 보게)
  try {
    if (meta.skipped && meta.skipped.length) {
      var sh2 = sheet_(SHEET_RESULT, true);
      var start = sh2.getLastRow() + 2;
      var extra = [['⚠️ 점검하지 못한 항목 (주소 형식이 아님)', '', '', '', '', '', '', '']];
      for (var i = 0; i < meta.skipped.length; i++) {
        extra.push([String(meta.skipped[i]), '', '', '', '', '', '', '']);
      }
      sh2.getRange(start, 1, extra.length, 8).setValues(extra.map(safeRow_));
    }
  } catch (ignore1) {}

  try { setProp_('RUN_STATE', '대기'); } catch (ignore2) {}
  try { setProp_('LAST_RESULT_AT', meta.nowKst || nowKst_()); } catch (ignore3) {}
  try { if (meta.summary) setProp_('LAST_RESULT_SUMMARY', String(meta.summary).slice(0, 200)); } catch (ignore4) {}
  try { if (meta.report) setProp_('LAST_REPORT', trimReport_(meta.report, 7000)); } catch (ignore5) {}
  try { setProp_('LAST_ERROR', '-'); } catch (ignore6) {}

  sysWrite_();

  // ★ 점검 결과 바로 뒤에 조작 패널을 '새 메시지'로 보낸다(에이든 지시 2026-09-04).
  //   버튼은 그 메시지를 제자리에서 고쳐 쓰기 때문에, 결과가 쌓이면 패널이 위로 밀려
  //   "눌러도 반응이 없다"처럼 보인다. 매 결과마다 아래에 새 패널을 두면 항상 손에 잡힌다.
  try { notifyChannel_(menuText_(), kbMain_()); } catch (ignore7) {}
}

// ═══════════════════════════════════════════════════════════════════
// 설치용 (편집기에서 직접 실행)
// ═══════════════════════════════════════════════════════════════════
function webhookUrl_() {
  var url = prop_('WEBAPP_URL') || ScriptApp.getService().getUrl();
  if (!url) throw new Error('웹앱 URL을 찾을 수 없습니다 → WEBAPP_URL 속성에 /exec URL을 넣어주세요');
  if (url.indexOf('/exec') === -1) throw new Error('웹앱 URL은 /exec 로 끝나야 합니다(배포 → 배포 관리에서 확인): ' + url);
  var u = url + '?token=' + encodeURIComponent(prop_('ACCESS_TOKEN')) + '&action=tg';
  var secret = prop_('WEBHOOK_SECRET', '');
  if (secret) u += '&s=' + encodeURIComponent(secret);
  return u;
}

/** ★ 셋업 마지막에 한 번 실행 — 시트 탭 생성 + 스케줄 + 텔레그램 연결 */
function setupAll() {
  sheet_(SHEET_INPUT, true);
  sheet_(SHEET_RESULT, true);
  sheet_(SHEET_LOG, true);
  sheet_(SHEET_SYS, true);
  log_('시스템', '설치', 'setupAll 실행');
  applySchedule_();
  // ★ 웹훅이 아니라 폴링으로 받는다(위 pollUpdates 주석 참고). 웹훅이 남아 있으면 폴링이 막히므로 먼저 뗀다.
  try { deleteWebhook(); } catch (ignore) {}
  setProp_('TG_OFFSET', '0');
  relayStop_();
  try { setupCommands(); } catch (ignore2) {}
  try { pinGuide(); } catch (ignore3) {}
  sysWrite_('설치 완료');
  Logger.log('✅ 설치 완료 — 시트 탭·스케줄·텔레그램 연결이 끝났습니다(명령은 1분 이내 처리).');
}

/** 매시간 트리거 하나만 둔다(시간대 설정 사고 방지 — 안에서 한국시간을 직접 계산) */
function applySchedule_() {
  var ts = ScriptApp.getProjectTriggers();
  for (var i = 0; i < ts.length; i++) {
    var fn = ts[i].getHandlerFunction();
    if (fn === 'hourlyTick' || fn === 'pollUpdates') ScriptApp.deleteTrigger(ts[i]);
  }
  ScriptApp.newTrigger('hourlyTick').timeBased().everyHours(1).create();
  // ★ 명령 수신 — 앱스스크립트가 만들 수 있는 가장 짧은 주기가 1분이다.
  ScriptApp.newTrigger('pollUpdates').timeBased().everyMinutes(1).create();
  Logger.log('스케줄 설정 완료 — 매시간 점검 확인 + 매분 명령 수신, 점검 시각: ' + settings_().hours.join(','));
}

/**
 * ★ 즉답기(클라우드플레어 워커)로 전환한다. 편집기에서 한 번 실행.
 *   필요한 속성: WORKER_URL (예: https://xxx.workers.dev), WEBHOOK_SECRET
 *   되돌리려면 setupPolling() 을 실행하면 된다.
 */
function setupEdge() {
  var bot = prop_('BOT_TOKEN');
  if (!bot) throw new Error('BOT_TOKEN 속성이 없습니다');
  var worker = String(prop_('WORKER_URL', '')).replace(/\/+$/, '');
  if (!/^https:\/\/.+/.test(worker)) throw new Error('WORKER_URL 속성에 워커 주소(https://...)를 넣어주세요');
  var secret = prop_('WEBHOOK_SECRET', '');
  if (!secret) throw new Error('WEBHOOK_SECRET 속성이 없습니다(아무 문자열, 워커에도 같은 값)');

  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + bot + '/setWebhook', {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({
      url: worker + '/tg',
      secret_token: secret,
      allowed_updates: ['message', 'channel_post', 'callback_query'],
      max_connections: 40,
    }),
    muteHttpExceptions: true,
  });
  var body = JSON.parse(res.getContentText());
  if (!body.ok) throw new Error('웹훅 등록 실패: ' + String(body.description || '').slice(0, 200));

  setProp_('MODE', 'webhook');
  relayStop_();
  sysWrite_('즉답기 전환');
  Logger.log('✅ 즉답기로 전환했습니다 — 이제 버튼을 누르면 바로 반응합니다.');
}

/** ★ 예전 방식(1분 폴링 + 깃허브 대기조)으로 되돌린다. 1분이면 원상복구. */
function setupPolling() {
  setProp_('MODE', 'poll');
  try { deleteWebhook(); } catch (ignore) {}
  relayStop_();
  applySchedule_();
  sysWrite_('폴링 방식 복귀');
  Logger.log('✅ 예전 방식(1분 폴링 + 대기조)으로 되돌렸습니다.');
}

function setupWebhook() {
  var bot = prop_('BOT_TOKEN');
  if (!bot) throw new Error('BOT_TOKEN 속성이 없습니다');
  var payload = {
    url: webhookUrl_(),
    allowed_updates: ['message', 'channel_post', 'callback_query'],
    drop_pending_updates: true,
  };
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + bot + '/setWebhook', {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify(payload), muteHttpExceptions: true,
  });
  Logger.log('setWebhook → ' + res.getContentText());
}

function getWebhookInfo() {
  var bot = prop_('BOT_TOKEN');
  if (!bot) throw new Error('BOT_TOKEN 속성이 없습니다');
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + bot + '/getWebhookInfo', { muteHttpExceptions: true });
  Logger.log(res.getContentText().replace(/token=[^&"]+/g, 'token=***').replace(/s=[^&"]+/g, 's=***'));
}

function deleteWebhook() {
  var bot = prop_('BOT_TOKEN');
  if (!bot) throw new Error('BOT_TOKEN 속성이 없습니다');
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + bot + '/deleteWebhook', { muteHttpExceptions: true });
  Logger.log('deleteWebhook → ' + res.getContentText());
}

/**
 * 진단 — 왜 명령이 안 먹는지 사실로 확인한다(비밀값은 전부 가린다).
 * 웹앱: POST {token, action:'diag'}
 */
function diag_() {
  var out = { ok: true, at: nowKst_() };
  out.allowedChats = allowedChats_();
  out.수신방식 = mode_() === 'webhook' ? '즉답기(웹훅) — 가장 빠름'
    : (relayAlive_() ? '대기조 가동중(초 단위)' : '폴링(1분마다 가지러 감)');
  out.대기조 = {
    켜짐: prop_('RELAY_ENABLED', 'yes') !== 'no',
    지금_살아있나: relayAlive_(),
    마지막_깨운시각: prop_('RELAY_LAST_WAKE_KST', '(없음)'),
    마지막_시작시각: prop_('RELAY_STARTED_AT', '(없음)'),
    마지막_오류: prop_('RELAY_LAST_ERROR', '(없음)'),
    자동예열: prop_('RELAY_PREHEAT', 'yes') !== 'no',
    예열시간: prop_('RELAY_HOURS_FROM', '9') + '시 ~ 다음날 ' + prop_('RELAY_HOURS_TO', '2') + '시 (한국시간)',
  };
  out.처리한_명령번호 = prop_('TG_OFFSET', '0');
  out.lastUpdate = prop_('LAST_UPDATE_DEBUG', '(아직 없음)');
  out.lastError = prop_('LAST_ERROR', '(없음)');
  out.settings = settings_();
  out.props = {};
  var names = ['ACCESS_TOKEN', 'BOT_TOKEN', 'GITHUB_TOKEN', 'WEBHOOK_SECRET', 'WEBAPP_URL', 'GITHUB_REPO'];
  for (var i = 0; i < names.length; i++) {
    var v = prop_(names[i], '');
    out.props[names[i]] = v ? ('설정됨(' + String(v).length + '자)') : '없음';
  }
  try {
    var bot = prop_('BOT_TOKEN');
    if (bot) {
      var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + bot + '/getWebhookInfo', { muteHttpExceptions: true });
      var info = JSON.parse(res.getContentText());
      var r = (info && info.result) || {};
      out.webhook = {
        설정됨: !!r.url,
        주소: String(r.url || '').replace(/token=[^&]*/g, 'token=***').replace(/[?&]s=[^&]*/g, '&s=***'),
        대기중인_업데이트: r.pending_update_count,
        허용된_종류: r.allowed_updates || '(전체 기본값)',
        마지막_오류: r.last_error_message || '(없음)',
        마지막_오류시각: r.last_error_date || null,
      };
      // 봇이 채널에서 실제로 무엇을 할 수 있는지
      var ids = allowedChats_();
      if (ids.length) {
        var me = JSON.parse(UrlFetchApp.fetch('https://api.telegram.org/bot' + bot + '/getMe', { muteHttpExceptions: true }).getContentText());
        var myId = me && me.result && me.result.id;
        out.bot = { 이름: me && me.result && me.result.username, 그룹메시지_전체수신: me && me.result && me.result.can_read_all_group_messages };
        if (myId) {
          var cm = JSON.parse(UrlFetchApp.fetch('https://api.telegram.org/bot' + bot + '/getChatMember?chat_id=' +
            encodeURIComponent(ids[0]) + '&user_id=' + myId, { muteHttpExceptions: true }).getContentText());
          out.botInChannel = cm && cm.ok ? { 자격: cm.result.status, 글쓰기: cm.result.can_post_messages } : { 오류: cm && cm.description };
        }
      }
    }
  } catch (e) {
    out.webhookError = String(e && e.message || e);
  }
  return out;
}

/** 입력창 옆 '/' 메뉴에 명령을 등록한다(텔레그램은 명령 이름에 한글을 못 쓴다) */
function setupCommands() {
  tgApi_('setMyCommands', {
    commands: [
      { command: 'menu',  description: '조작 패널 열기' },
      { command: 'check', description: '지금 점검' },
      { command: 'list',  description: '등록된 주소 보기' },
      { command: 'help',  description: '사용법' },
    ],
  });
  Logger.log('명령 메뉴 등록 완료 — /menu /check /list /help');
}

/** 채널 맨 위에 고정해 둘 안내문 — 버튼이 없으므로 시간이 지나도 유효하다 */
function pinText_() {
  return [
    '📌 <b>접속점검 — 이 채널 쓰는 법</b>',
    '',
    '<blockquote>조작 패널을 부르려면 아무 때나',
    '<b>ㅁ</b>  한 글자를 보내세요.',
    '(메뉴 · /menu 도 같습니다)</blockquote>',
    '',
    '<blockquote>패널이 뜨면 버튼으로 전부 조작할 수 있습니다.',
    '자세한 사용법은 패널의 [❓ 도움말].</blockquote>',
    '',
    '<blockquote>⏱ <b>반응 속도</b>',
    '한동안 조용했다면 <b>첫 조작 하나만 최대 1분</b> 걸립니다(깨우는 중).',
    '그 뒤 20분 동안은 2~4초면 답이 옵니다.',
    '느리다고 여러 번 누르면 누른 만큼 답이 쌓입니다 — 한 번만 누르고 기다려 주세요.',
    '지금이 빠른 상태인지 아닌지는 패널(<b>ㅁ</b>) 맨 아래에 표시됩니다.</blockquote>',
  ].join('\n');
}

/** 안내문을 보내고 채널 상단에 고정한다(봇이 관리자가 아니면 고정만 조용히 실패) */
function pinGuide() {
  var ids = allowedChats_();
  if (!ids.length) throw new Error('ALLOWED_CHAT_IDS 속성이 비어 있습니다');
  var r = tgSend_(ids[0], pinText_());
  var mid = r && r.result && r.result.message_id;
  if (!mid) { Logger.log('안내문 발송 실패'); return; }
  tgApi_('pinChatMessage', { chat_id: ids[0], message_id: mid, disable_notification: true });
  Logger.log('안내문을 보내고 고정했습니다 → ' + ids[0]);
}

/**
 * 성능 측정 — '어디가 느린가'를 추측 대신 숫자로 본다.
 * 편집기에서 직접 실행하면 각 단계가 몇 ms 걸리는지 실행 로그에 찍힌다.
 * (데이터를 바꾸지 않는 것만 잰다 — 백업/되돌리기 상태는 건드리지 않는다)
 */
function perfProbe() {
  function ms(fn) { var t = Date.now(); try { fn(); } catch (e) {} return Date.now() - t; }
  var tOpen  = ms(function () { SpreadsheetApp.getActive(); });
  var tProp  = ms(function () { prop_('BOT_TOKEN'); });
  var tCache = ms(function () { cache_().get('perf'); });
  var tModel = ms(function () { loadModel_(); });
  var tModel2 = ms(function () { loadModel_(); });
  var tSet   = ms(function () { settings_(); });
  var tMenu  = ms(function () { menuText_(); });
  var tList  = ms(function () { listText_(); });
  var tTg    = ms(function () { tgApi_('getMe', {}); });
  var tSys   = ms(function () { sysWrite_(); });
  Logger.log('시트열기 %s / 속성1회 %s / 캐시1회 %s / 모델읽기 %s / 모델재읽기 %s / 설정 %s / 패널만들기 %s / 목록만들기 %s / 텔레그램1회 %s / 시스템탭쓰기 %s  (단위 ms)',
    tOpen, tProp, tCache, tModel, tModel2, tSet, tMenu, tList, tTg, tSys);
}

/** 시트가 제대로 읽히는지 확인 */
function testRead() {
  var model = loadModel_();
  Logger.log('업체 ' + model.length + '곳 / 도메인 ' + totalDomains_(model) + '개');
  Logger.log(JSON.stringify(model).slice(0, 800));
}

/** 채널 연결 확인 — 채널로 시험 메시지를 보낸다 */
function testChannel() {
  var ids = allowedChats_();
  if (!ids.length) throw new Error('ALLOWED_CHAT_IDS 속성이 비어 있습니다');
  tgSend_(ids[0], menuText_(), kbMain_());
  Logger.log('시험 메시지를 보냈습니다 → ' + ids[0]);
}
