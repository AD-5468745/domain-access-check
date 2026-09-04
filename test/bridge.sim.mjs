// bridge.gs 실동작 검증 — 구글 API를 가짜로 만들어 앱스스크립트 코드를 그대로 돌린다.
// "문법 통과"가 아니라 "텔레그램 명령을 넣으면 시트가 실제로 이렇게 바뀐다"를 확인한다.
import assert from 'node:assert/strict';
import fs from 'node:fs';

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; failures.push(`${name}\n    → ${e.message.split('\n').slice(0, 2).join(' / ')}`); }
}

// ═══════════════════════════════════════════════════════════
// 가짜 구글 API
// ═══════════════════════════════════════════════════════════
function makeEnv() {
  const sheets = new Map();
  const sent = [];          // 텔레그램으로 나간 것
  const github = [];        // GitHub 으로 나간 것
  const triggers = [];
  const propStore = new Map();
  const cacheStore = new Map();

  function ensure(name) {
    if (!sheets.has(name)) sheets.set(name, { name, rows: [], frozen: 0, hidden: false });
    return sheets.get(name);
  }
  function pad(sh, r, c) {
    while (sh.rows.length < r) sh.rows.push([]);
    for (const row of sh.rows) while (row.length < c) row.push('');
  }

  function makeRange(sh, r0, c0, nr, nc) {
    const api = {
      getValues() {
        const out = [];
        for (let r = 0; r < nr; r++) {
          const row = [];
          for (let c = 0; c < nc; c++) row.push((sh.rows[r0 - 1 + r] || [])[c0 - 1 + c] ?? '');
          out.push(row);
        }
        return out;
      },
      getDisplayValues() { return api.getValues().map((row) => row.map((v) => (v === null || v === undefined ? '' : String(v)))); },
      setValues(vals) {
        pad(sh, r0 - 1 + vals.length, c0 - 1 + (vals[0] ? vals[0].length : 0));
        for (let r = 0; r < vals.length; r++) {
          for (let c = 0; c < vals[r].length; c++) sh.rows[r0 - 1 + r][c0 - 1 + c] = vals[r][c];
        }
        return api;
      },
      setFontWeight() { return api; },
      setBackground() { return api; },
    };
    return api;
  }

  function makeSheet(name) {
    const sh = ensure(name);
    const api = {
      getName: () => name,
      getLastRow: () => sh.rows.reduce((m, row, i) => (row.some((v) => v !== '' && v !== null && v !== undefined) ? i + 1 : m), 0),
      getLastColumn: () => sh.rows.reduce((m, row) => {
        let last = 0;
        row.forEach((v, i) => { if (v !== '' && v !== null && v !== undefined) last = i + 1; });
        return Math.max(m, last);
      }, 0),
      getRange: (r, c, nr, nc) => makeRange(sh, r, c, nr === undefined ? 1 : nr, nc === undefined ? 1 : nc),
      clear() { sh.rows = []; return api; },
      clearContents() { sh.rows = []; return api; },
      appendRow(row) { sh.rows.push(row.slice()); return api; },
      deleteRows(start, count) { sh.rows.splice(start - 1, count); return api; },
      setFrozenRows(n) { sh.frozen = n; return api; },
      autoResizeColumns() { return api; },
      hideSheet() { sh.hidden = true; return api; },
    };
    return api;
  }

  const SpreadsheetApp = {
    getActive: () => ({
      getSheetByName: (n) => (sheets.has(n) ? makeSheet(n) : null),
      insertSheet: (n) => { ensure(n); return makeSheet(n); },
    }),
  };

  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (propStore.has(k) ? propStore.get(k) : null),
      setProperty: (k, v) => { propStore.set(k, String(v)); },
    }),
  };

  const CacheService = {
    getScriptCache: () => ({
      get: (k) => (cacheStore.has(k) ? cacheStore.get(k) : null),
      put: (k, v) => { cacheStore.set(k, v); },
      remove: (k) => { cacheStore.delete(k); },
    }),
  };

  const LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };

  const UrlFetchApp = {
    fetch(url, opts) {
      const body = opts && opts.payload ? JSON.parse(opts.payload) : {};
      if (url.indexOf('api.telegram.org') !== -1) {
        const method = url.split('/').pop();
        sent.push({ method, body });
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, result: { message_id: sent.length } }) };
      }
      if (url.indexOf('api.github.com') !== -1) {
        github.push({ url, body });
        return { getResponseCode: () => 204, getContentText: () => '' };
      }
      return { getResponseCode: () => 200, getContentText: () => '{}' };
    },
  };

  let fakeNow = new Date('2026-08-28T12:00:00+09:00');
  const Utilities = {
    newBlob(s) { const b = Buffer.from(String(s), 'utf8'); return { getBytes: () => b }; },
    formatDate(date, tz, fmt) {
      const d = new Date(date);
      const p = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
      const H = p.hour === '24' ? '00' : p.hour;
      if (fmt === 'H') return String(Number(H));
      if (fmt === 'yyyyMMddHH') return `${p.year}${p.month}${p.day}${H}`;
      return `${p.year}-${p.month}-${p.day} ${H}:${p.minute}`;
    },
  };

  const ScriptApp = {
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger: (tr) => { const i = triggers.indexOf(tr); if (i !== -1) triggers.splice(i, 1); },
    newTrigger(fn) {
      const tr = { getHandlerFunction: () => fn };
      const builder = {
        timeBased: () => ({
          after: () => ({ create: () => { triggers.push(tr); return tr; } }),
          everyHours: () => ({ create: () => { triggers.push(tr); return tr; } }),
        }),
      };
      return builder;
    },
    getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/AKfake/exec' }),
  };

  const ContentService = {
    MimeType: { JSON: 'application/json' },
    createTextOutput: (s) => ({ setMimeType: () => ({ getContent: () => s, text: s }) }),
  };

  const Logger = { log: () => {} };

  return { SpreadsheetApp, PropertiesService, CacheService, LockService, UrlFetchApp,
    Utilities, ScriptApp, ContentService, Logger, sheets, sent, github, triggers, propStore,
    setNow: (iso) => { fakeNow = new Date(iso); }, getNow: () => fakeNow };
}

const GS = fs.readFileSync(new URL('../apps-script/bridge.gs', import.meta.url), 'utf8');
const EXPORTS = ['doGet', 'doPost', 'hourlyTick', 'watchdog', 'setupAll', 'applySchedule_',
  'loadModel_', 'saveModel_', 'settings_', 'menuText_', 'listText_', 'normalizeDomain_',
  'opAddDomains_', 'opRemoveDomain_', 'opAddCompany_', 'opRemoveCompany_', 'opRenameCompany_',
  'opMoveDomain_', 'opReplaceDomain_', 'undo_', 'sysWrite_', 'splitForTelegram_'];

function load(env, propsInit) {
  const g = new Function(
    'SpreadsheetApp', 'PropertiesService', 'CacheService', 'LockService', 'UrlFetchApp',
    'Utilities', 'ScriptApp', 'ContentService', 'Logger', 'Date',
    `${GS}\nreturn { ${EXPORTS.join(', ')} };`
  )(env.SpreadsheetApp, env.PropertiesService, env.CacheService, env.LockService, env.UrlFetchApp,
    env.Utilities, env.ScriptApp, env.ContentService, env.Logger,
    class FakeDate extends Date {
      constructor(...a) { if (a.length === 0) super(env.getNow().getTime()); else super(...a); }
      static now() { return env.getNow().getTime(); }
    });
  for (const [k, v] of Object.entries(propsInit || {})) env.propStore.set(k, v);
  return g;
}

const BASE_PROPS = {
  ACCESS_TOKEN: 'tok', BOT_TOKEN: '111:AAA', ALLOWED_CHAT_IDS: '-1001',
  GITHUB_TOKEN: 'ghx', GITHUB_REPO: 'me/domain-access-check',
};

function fresh(seed) {
  const env = makeEnv();
  const B = load(env, BASE_PROPS);
  if (seed) B.saveModel_(seed);
  env.sent.length = 0;
  env.github.length = 0;
  return { env, B };
}

const SEED = [
  { name: '에그벳', domains: ['egg-1.com', 'egg-5.com'] },
  { name: '야옹이', domains: ['ya-1.com'] },
];

function post(B, update, params) {
  return B.doPost({
    parameter: Object.assign({ token: 'tok', action: 'tg' }, params || {}),
    postData: { contents: JSON.stringify(update) },
  });
}
const msg = (text, chat = '-1001') => ({ channel_post: { chat: { id: chat }, message_id: 1, text, author_signature: '김담당' } });
const cbq = (data, chat = '-1001') => ({ callback_query: { id: 'c1', data, from: { id: 7, first_name: '박담당' }, message: { chat: { id: chat }, message_id: 9 } } });
const lastText = (env) => {
  for (let i = env.sent.length - 1; i >= 0; i--) {
    if (env.sent[i].method === 'sendMessage' || env.sent[i].method === 'editMessageText') return env.sent[i].body.text;
  }
  return '';
};

// ═══════════════════════════════════════════════════════════
// 1. 시트 모델 읽기/쓰기
// ═══════════════════════════════════════════════════════════
{
  const { B } = fresh(SEED);
  t('모델 저장·복원', () => assert.deepEqual(B.loadModel_(), SEED));
  t('빈 시트도 안전', () => { const f = fresh(); assert.deepEqual(f.B.loadModel_(), []); });
  t('접속점검 탭 1행=업체명', () => {
    const f = fresh(SEED);
    const v = f.env.sheets.get('접속점검').rows;
    assert.deepEqual(v[0], ['에그벳', '야옹이']);
    assert.equal(v[1][0], 'egg-1.com');
  });
  t('열 길이가 달라도 정상', () => {
    const f = fresh([{ name: 'A', domains: ['a1.com', 'a2.com', 'a3.com'] }, { name: 'B', domains: ['b1.com'] }]);
    assert.equal(f.B.loadModel_()[1].domains.length, 1);
  });
}

// ═══════════════════════════════════════════════════════════
// 2. 도메인 추가
// ═══════════════════════════════════════════════════════════
{
  const { env, B } = fresh(SEED);
  post(B, msg('추가 에그벳 https://WWW.Egg-9.com/promo egg-1.com 이건메모'));
  const model = B.loadModel_();
  t('추가: 정규화되어 들어감', () => assert.equal(model[0].domains.indexOf('egg-9.com') !== -1, true));
  t('추가: 중복은 건너뜀', () => assert.equal(model[0].domains.filter((d) => d === 'egg-1.com').length, 1));
  t('추가: 답장에 결과 표시', () => assert.equal(/egg-9\.com/.test(lastText(env)), true));
  t('추가: 이미 있음 안내', () => assert.equal(/이미 있음/.test(lastText(env)), true));
  t('추가: 주소 아님 안내', () => assert.equal(/주소 형식이 아님/.test(lastText(env)), true));
  t('추가: 이력 기록됨', () => {
    const log = env.sheets.get('이력').rows;
    assert.equal(log.some((r) => String(r[2]).indexOf('도메인 추가') !== -1), true);
  });
  t('추가: 이력에 작성자 서명', () => {
    const log = env.sheets.get('이력').rows;
    assert.equal(log.some((r) => r[1] === '김담당'), true);
  });
}
{
  const { B } = fresh(SEED);
  post(B, msg('추가 새업체 new-1.com'));
  t('없는 업체는 새로 만들어 추가', () => {
    const m = B.loadModel_();
    assert.equal(m.length, 3);
    assert.deepEqual(m[2], { name: '새업체', domains: ['new-1.com'] });
  });
}
{
  const many = [];
  for (let i = 0; i < 15; i++) many.push({ name: '업체' + i, domains: ['d' + i + '.com'] });
  const { env, B } = fresh(many);
  post(B, msg('업체추가 열여섯번째'));
  t('업체 15곳 초과 거부', () => {
    assert.equal(B.loadModel_().length, 15);
    assert.equal(/최대 15곳/.test(lastText(env)), true);
  });
}

// ═══════════════════════════════════════════════════════════
// 3. 삭제 + 확인 + 되돌리기
// ═══════════════════════════════════════════════════════════
{
  const { env, B } = fresh(SEED);
  post(B, msg('삭제 egg-5.com'));
  t('글 명령 삭제', () => assert.deepEqual(B.loadModel_()[0].domains, ['egg-1.com']));
  t('삭제 후 되돌리기 안내', () => assert.equal(/되돌리기/.test(lastText(env)), true));

  post(B, cbq('undo'));
  post(B, cbq('undook'));
  t('되돌리기로 복구됨', () => assert.deepEqual(B.loadModel_()[0].domains, ['egg-1.com', 'egg-5.com']));

  post(B, cbq('undo'));
  post(B, cbq('undook'));
  t('되돌리기의 되돌리기', () => assert.deepEqual(B.loadModel_()[0].domains, ['egg-1.com']));
}
{
  const { env, B } = fresh(SEED);
  post(B, msg('삭제 없는주소.com'));
  t('없는 주소 삭제 시 안내', () => assert.equal(/등록되지 않은/.test(lastText(env)), true));
  t('없는 주소 삭제로 데이터 안 바뀜', () => assert.deepEqual(B.loadModel_(), SEED));
}
{
  const dup = [{ name: 'A', domains: ['same.com'] }, { name: 'B', domains: ['same.com'] }];
  const { env, B } = fresh(dup);
  post(B, msg('삭제 same.com'));
  t('두 업체에 같은 주소면 업체 지정 요구', () => assert.equal(/여러 업체에 있습니다/.test(lastText(env)), true));
  post(B, msg('삭제 same.com B'));
  t('업체 지정하면 그 업체에서만 삭제', () => {
    const m = B.loadModel_();
    assert.deepEqual(m[0].domains, ['same.com']);
    assert.deepEqual(m[1].domains, []);
  });
}
{
  const { env, B } = fresh(SEED);
  post(B, cbq('del'));
  post(B, cbq('d:0'));
  post(B, cbq('dx:0:1'));
  t('버튼 삭제: 확인 단계 표시', () => assert.equal(/삭제할까요/.test(lastText(env)), true));
  t('버튼 삭제: 확인 전엔 안 지워짐', () => assert.equal(B.loadModel_()[0].domains.length, 2));
  post(B, cbq('dok'));
  t('버튼 삭제: 확인 후 지워짐', () => assert.deepEqual(B.loadModel_()[0].domains, ['egg-1.com']));
  t('버튼 삭제: 누가 눌렀는지 이력에 남음', () => {
    const log = env.sheets.get('이력').rows;
    assert.equal(log.some((r) => r[1] === '박담당'), true);
  });
}
{
  const { env, B } = fresh(SEED);
  post(B, cbq('dok'));   // 상태 없이 확인 버튼만
  t('만료된 확인 버튼은 안전하게 거부', () => {
    assert.equal(/취소되었습니다/.test(lastText(env)), true);
    assert.deepEqual(B.loadModel_(), SEED);
  });
}

// ═══════════════════════════════════════════════════════════
// 4. 업체 관리
// ═══════════════════════════════════════════════════════════
{
  const { env, B } = fresh(SEED);
  post(B, msg('이름변경 에그벳 에그벳2'));
  t('업체 이름 변경', () => assert.equal(B.loadModel_()[0].name, '에그벳2'));
  post(B, msg('이름변경 없는업체 x'));
  t('없는 업체 이름변경 안내', () => assert.equal(/그런 업체가 없습니다/.test(lastText(env)), true));
  post(B, msg('이름변경 에그벳2 야옹이'));
  t('중복 이름 거부', () => assert.equal(B.loadModel_()[0].name, '에그벳2'));
}
{
  const { env, B } = fresh(SEED);
  post(B, msg('업체삭제 에그벳'));
  t('업체 삭제는 확인을 먼저 묻는다', () => {
    assert.equal(/삭제할까요/.test(lastText(env)), true);
    assert.equal(B.loadModel_().length, 2);
  });
  post(B, cbq('codelok'));
  t('확인 후 업체와 도메인 함께 삭제', () => {
    const m = B.loadModel_();
    assert.equal(m.length, 1);
    assert.equal(m[0].name, '야옹이');
  });
}
{
  const { B } = fresh(SEED);
  post(B, msg('이동 ya-1.com 에그벳'));
  t('업체 간 이동', () => {
    const m = B.loadModel_();
    assert.equal(m[0].domains.indexOf('ya-1.com') !== -1, true);
    assert.equal(m[1].domains.length, 0);
  });
}
{
  const { B } = fresh(SEED);
  post(B, msg('변경 egg-1.com https://new-egg.com/x'));
  t('주소 갈아끼우기(정규화 포함)', () => assert.deepEqual(B.loadModel_()[0].domains, ['new-egg.com', 'egg-5.com']));
}

// ═══════════════════════════════════════════════════════════
// 5. 대화형 추가 (버튼 → 업체 선택 → 주소 입력)
// ═══════════════════════════════════════════════════════════
{
  const { env, B } = fresh(SEED);
  post(B, cbq('add'));
  t('업체 선택 버튼 제공', () => {
    const kb = env.sent[env.sent.length - 1].body.reply_markup.inline_keyboard;
    assert.equal(JSON.stringify(kb).indexOf('에그벳') !== -1, true);
  });
  post(B, cbq('a:0'));
  t('주소 입력 안내', () => assert.equal(/추가할 주소를 보내주세요/.test(lastText(env)), true));
  post(B, msg('egg-77.com\negg-88.com'));
  t('줄바꿈으로 여러 개 추가', () => {
    const d = B.loadModel_()[0].domains;
    assert.equal(d.indexOf('egg-77.com') !== -1 && d.indexOf('egg-88.com') !== -1, true);
  });
}
{
  const { env, B } = fresh(SEED);
  post(B, msg('egg-99.com'));               // 주소만 덜렁
  t('주소만 보내면 어디에 넣을지 물어봄', () => assert.equal(/어느 업체에 추가할까요/.test(lastText(env)), true));
  post(B, cbq('a:1'));
  t('고른 업체에 들어감', () => assert.equal(B.loadModel_()[1].domains.indexOf('egg-99.com') !== -1, true));
}
{
  const { env, B } = fresh(SEED);
  post(B, cbq('add'));
  post(B, cbq('a:0'));
  post(B, msg('취소'));
  t('취소하면 아무것도 안 바뀜', () => {
    assert.deepEqual(B.loadModel_(), SEED);
    assert.equal(/취소/.test(lastText(env)), true);
  });
}

// ═══════════════════════════════════════════════════════════
// 6. 설정 (점검시각·알림·일시중지)
// ═══════════════════════════════════════════════════════════
{
  const { env, B } = fresh(SEED);
  post(B, msg('점검시각 7 13 19'));
  t('점검 시각 변경', () => assert.deepEqual(B.settings_().hours, [7, 13, 19]));
  t('점검 시각 변경 안내', () => assert.equal(/07시 · 13시 · 19시/.test(lastText(env)), true));
  post(B, msg('점검시각 abc'));
  t('잘못된 시각은 거부(기존 유지)', () => assert.deepEqual(B.settings_().hours, [7, 13, 19]));
  post(B, msg('점검시각 1 2 3 4 5 6 7'));
  t('하루 6번 초과 거부', () => assert.deepEqual(B.settings_().hours, [7, 13, 19]));
  post(B, msg('점검시각 9 9 21'));
  t('중복 시각은 하나로', () => assert.deepEqual(B.settings_().hours, [9, 21]));

  post(B, msg('알림 문제만'));
  t('알림 수준 변경', () => assert.equal(B.settings_().notify, 'problem'));
  post(B, cbq('cfgn'));
  t('버튼으로 알림 수준 토글', () => assert.equal(B.settings_().notify, 'all'));
  post(B, msg('일시중지'));
  t('일시중지', () => assert.equal(B.settings_().paused, true));
  post(B, cbq('cfgp'));
  t('버튼으로 재개', () => assert.equal(B.settings_().paused, false));
}

// ═══════════════════════════════════════════════════════════
// 7. 점검 실행 · 스케줄 · 감시
// ═══════════════════════════════════════════════════════════
{
  const { env, B } = fresh(SEED);
  post(B, msg('점검'));
  t('점검 명령이 GitHub을 깨움', () => assert.equal(env.github.length, 1));
  t('수동 실행 표시', () => assert.equal(env.github[0].body.inputs.mode, 'manual'));
  t('감시 트리거 설치됨', () => assert.equal(env.triggers.some((x) => x.getHandlerFunction() === 'watchdog'), true));

  env.sent.length = 0;
  B.watchdog();
  t('무응답이면 채널에 경고', () => assert.equal(/결과가 오지 않았습니다/.test(lastText(env)), true));
  t('감시 트리거는 스스로 정리', () => assert.equal(env.triggers.some((x) => x.getHandlerFunction() === 'watchdog'), false));
}
{
  const { env, B } = fresh(SEED);
  env.propStore.set('CHECK_HOURS', '9,21');
  env.setNow('2026-08-28T09:05:00+09:00');
  B.hourlyTick();
  t('정해진 시각이면 자동 점검', () => assert.equal(env.github.length, 1));
  t('자동 실행 표시', () => assert.equal(env.github[0].body.inputs.mode, 'auto'));
  B.hourlyTick();
  t('같은 시각 중복 실행 안 함', () => assert.equal(env.github.length, 1));

  env.setNow('2026-08-28T14:05:00+09:00');
  B.hourlyTick();
  t('설정 시각이 아니면 실행 안 함', () => assert.equal(env.github.length, 1));

  env.setNow('2026-08-28T21:05:00+09:00');
  B.hourlyTick();
  t('두 번째 시각에 실행', () => assert.equal(env.github.length, 2));

  env.propStore.set('PAUSED', 'yes');
  env.setNow('2026-08-29T09:05:00+09:00');
  B.hourlyTick();
  t('일시중지 중엔 자동 실행 안 함', () => assert.equal(env.github.length, 2));
}
{
  const { env, B } = fresh(SEED);
  B.applySchedule_();
  t('매시간 트리거 1개만 유지', () => {
    B.applySchedule_();
    assert.equal(env.triggers.filter((x) => x.getHandlerFunction() === 'hourlyTick').length, 1);
  });
}

// ═══════════════════════════════════════════════════════════
// 8. 웹앱 (GitHub ↔ 브리지)
// ═══════════════════════════════════════════════════════════
{
  const { B } = fresh(SEED);
  const ok = JSON.parse(B.doGet({ parameter: { token: 'tok', action: 'read' } }).text);
  t('read 성공', () => assert.equal(ok.ok, true));
  t('read 가 1행 업체명 포함', () => assert.deepEqual(ok.values[0], ['에그벳', '야옹이']));
  t('read 가 설정도 함께 전달', () => assert.deepEqual(ok.settings.hours, [9, 21]));

  const bad = JSON.parse(B.doGet({ parameter: { token: 'wrong', action: 'read' } }).text);
  t('토큰 틀리면 거부', () => assert.equal(bad.ok, false));
  const none = JSON.parse(B.doGet({ parameter: {} }).text);
  t('토큰 없으면 거부', () => assert.equal(none.ok, false));

  // ★ 2026-09-04 사고: 한국 VPN 경유 시 질의문자열이 붙은 GET 이 404 로 잘렸다.
  //   그래서 read 를 POST + 본문 토큰으로도 받을 수 있어야 한다(URL 에 비밀값도 안 남는다).
  const pr = JSON.parse(B.doPost({
    parameter: {},
    postData: { contents: JSON.stringify({ token: 'tok', action: 'read' }) },
  }).text);
  t('POST read 성공(본문 토큰)', () => assert.equal(pr.ok, true));
  t('POST read 가 GET read 와 같은 값', () => assert.deepEqual(pr.values, ok.values));
  t('POST read 도 설정 전달', () => assert.deepEqual(pr.settings.hours, [9, 21]));

  const prBad = JSON.parse(B.doPost({
    parameter: {},
    postData: { contents: JSON.stringify({ token: 'wrong', action: 'read' }) },
  }).text);
  t('POST 토큰 틀리면 거부', () => assert.equal(prBad.ok, false));

  const prNone = JSON.parse(B.doPost({ parameter: {}, postData: { contents: '{}' } }).text);
  t('POST 토큰 없으면 거부', () => assert.equal(prNone.ok, false));

  const prPing = JSON.parse(B.doPost({
    parameter: {},
    postData: { contents: JSON.stringify({ token: 'tok', action: 'ping' }) },
  }).text);
  t('POST ping 응답', () => assert.equal(prPing.pong, true));
}
{
  const { env, B } = fresh(SEED);
  const rows = [['업체', '도메인', '상태', 'HTTP', '최종 접속주소', '응답(ms)', '점검시각', '비고'],
    ['에그벳', 'egg-1.com', '✅ 정상', 200, 'https://egg-1.com/', 120, '2026-08-28 21:00', '정상']];
  const r = JSON.parse(B.doPost({
    parameter: { token: 'tok', action: 'write' },
    postData: { contents: JSON.stringify({ rows, meta: { nowKst: '2026-08-28 21:00', summary: '총 1개 모두 정상 ✅', report: '리포트' } }) },
  }).text);
  t('write 성공', () => assert.equal(r.ok, true));
  const rBody = JSON.parse(B.doPost({
    parameter: {},
    postData: { contents: JSON.stringify({ token: 'tok', action: 'write', rows, meta: { nowKst: '2026-08-28 21:00', summary: '총 1개 모두 정상 ✅', report: '리포트' } }) },
  }).text);
  t('write 도 본문 토큰으로 동작', () => assert.equal(rBody.ok, true));
  t('결과 탭 기록됨', () => assert.equal(env.sheets.get('결과').rows[1][1], 'egg-1.com'));
  t('시스템 탭 갱신됨', () => {
    const sys = env.sheets.get('시스템').rows.map((x) => x.join('|')).join('\n');
    assert.equal(/모두 정상/.test(sys), true);
  });
  post(B, msg('상태'));
  t('상태 명령이 마지막 리포트를 보여줌', () => assert.equal(/리포트/.test(lastText(env)), true));
}
{
  const { env, B } = fresh(SEED);
  post(B, msg('점검'));
  B.doPost({ parameter: {}, postData: { contents: JSON.stringify({ token: 'tok', action: 'fail', error: 'VPN 실패' }) } });
  t('실패 보고 시 감시 트리거 해제', () => assert.equal(env.triggers.some((x) => x.getHandlerFunction() === 'watchdog'), false));
  t('실패가 시스템 탭에 남음', () => {
    const sys = env.sheets.get('시스템').rows.map((x) => x.join('|')).join('\n');
    assert.equal(/VPN 실패/.test(sys), true);
  });
}

// ═══════════════════════════════════════════════════════════
// 9. 권한·보안
// ═══════════════════════════════════════════════════════════
{
  const { env, B } = fresh(SEED);
  post(B, msg('삭제 egg-1.com', '-9999'));
  t('허용 안 된 채널의 명령 무시', () => {
    assert.deepEqual(B.loadModel_(), SEED);
    assert.equal(env.sent.length, 0);
  });
}
{
  const env = makeEnv();
  const B = load(env, Object.assign({}, BASE_PROPS, { ALLOWED_CHAT_IDS: '' }));
  B.saveModel_(SEED);
  env.sent.length = 0;
  post(B, msg('삭제 egg-1.com'));
  t('허용 채널 미설정이면 조작 전면 거부', () => assert.deepEqual(B.loadModel_(), SEED));
}
{
  const env = makeEnv();
  const B = load(env, Object.assign({}, BASE_PROPS, { WEBHOOK_SECRET: 's3cr3t' }));
  B.saveModel_(SEED);
  env.sent.length = 0;
  post(B, msg('삭제 egg-1.com'));                          // 비밀헤더 없음
  t('비밀값 틀리면 무시', () => assert.deepEqual(B.loadModel_(), SEED));
  post(B, msg('삭제 egg-1.com'), { s: 's3cr3t' });
  t('비밀값 맞으면 처리', () => assert.equal(B.loadModel_()[0].domains.length, 1));
}
{
  const { env, B } = fresh(SEED);
  post(B, msg('오늘 회식 어디서 해요?'));
  t('잡담은 조용히 무시', () => assert.equal(env.sent.length, 0));
}

// ═══════════════════════════════════════════════════════════
// 9-2. 담당자 여러 명 — 입력이 섞이는 사고 방지
// ═══════════════════════════════════════════════════════════
{
  const { env, B } = fresh(SEED);
  // 박담당이 '추가' 절차 시작
  post(B, cbq('add'));
  post(B, cbq('a:0'));
  // 그 사이 최담당이 '삭제' 절차 시작 → 막혀야 한다
  post(B, { callback_query: { id: 'c2', data: 'del', from: { id: 8, first_name: '최담당' }, message: { chat: { id: '-1001' }, message_id: 9 } } });
  t('다른 담당자 작업 중이면 새 절차 차단', () => assert.equal(/작업 중입니다/.test(lastText(env)), true));
  // 박담당이 보낸 주소는 원래 의도대로 '추가'로 들어가야 한다
  post(B, msg('egg-safe.com'));
  t('먼저 시작한 사람의 입력이 지켜짐', () => assert.equal(B.loadModel_()[0].domains.indexOf('egg-safe.com') !== -1, true));
  t('삭제되지 않음', () => assert.equal(B.loadModel_()[0].domains.length, 3));
}
{
  const { env, B } = fresh(SEED);
  post(B, cbq('add'));
  post(B, cbq('a:0'));
  post(B, cbq('add'));   // 같은 사람은 다시 시작 가능
  t('같은 담당자는 막지 않음', () => assert.equal(/작업 중입니다/.test(lastText(env)), false));
}
{
  const { env, B } = fresh(SEED);
  const upd = { update_id: 555, channel_post: { chat: { id: '-1001' }, message_id: 1, text: '삭제 egg-5.com' } };
  post(B, upd);
  post(B, upd);          // 텔레그램 재전송 흉내
  t('같은 알림 두 번 와도 한 번만 실행', () => assert.deepEqual(B.loadModel_()[0].domains, ['egg-1.com']));
  t('중복 알림엔 답장도 한 번', () => assert.equal(env.sent.filter((s) => s.method === 'sendMessage').length, 1));
}
{
  const { B } = fresh(SEED);
  post(B, { edited_channel_post: { chat: { id: '-1001' }, message_id: 1, text: '삭제 egg-5.com' } });
  t('수정된 글은 명령으로 실행하지 않음', () => assert.deepEqual(B.loadModel_(), SEED));
}
{
  const many = [];
  for (let i = 0; i < 60; i++) many.push('d' + i + '.com');
  const { env, B } = fresh([{ name: 'A', domains: many }]);
  post(B, cbq('del'));
  post(B, cbq('d:0'));
  t('주소 40개 초과 시 안내 표시', () => assert.equal(/앞 40개만/.test(lastText(env)), true));
  t('버튼은 41개 이하(40 + 메뉴로)', () => {
    const kb = env.sent[env.sent.length - 1].body.reply_markup.inline_keyboard;
    assert.equal(kb.length <= 41, true);
  });
}

// ═══════════════════════════════════════════════════════════
// 10. 화면·분할
// ═══════════════════════════════════════════════════════════
{
  const { env, B } = fresh(SEED);
  post(B, msg('메뉴'));
  t('메뉴에 현황 표시', () => assert.equal(/업체 2곳 · 도메인 3개/.test(lastText(env)), true));
  t('메뉴에 버튼 8개', () => {
    const kb = env.sent[env.sent.length - 1].body.reply_markup.inline_keyboard;
    assert.equal(kb.reduce((n, r) => n + r.length, 0), 8);
  });
  post(B, msg('목록'));
  t('목록에 업체·도메인', () => assert.equal(/〔에그벳〕/.test(lastText(env)) && /egg-1\.com/.test(lastText(env)), true));
  post(B, msg('도움말'));
  t('도움말 표시', () => assert.equal(/사용법/.test(lastText(env)), true));
}
{
  const big = [];
  for (let i = 0; i < 15; i++) {
    const ds = [];
    for (let j = 0; j < 30; j++) ds.push('company' + i + '-domain' + j + '-longname.example.com');
    big.push({ name: '업체이름' + i, domains: ds });
  }
  const { env, B } = fresh(big);
  post(B, msg('목록'));
  const texts = env.sent.filter((s) => s.method === 'sendMessage').map((s) => s.body.text);
  t('긴 목록은 나눠서 발송', () => assert.equal(texts.length > 1, true));
  t('조각마다 4096자 이하', () => assert.equal(texts.every((x) => x.length <= 4096), true));
  t('조각마다 인용태그 짝 맞음', () => assert.equal(texts.every(
    (x) => (x.match(/<blockquote>/g) || []).length === (x.match(/<\/blockquote>/g) || []).length), true));
  t('450개 도메인도 처리됨', () => assert.equal(B.loadModel_().reduce((n, c) => n + c.domains.length, 0), 450));
}
{
  const { env, B } = fresh([{ name: 'A<b>&', domains: ['a.com'] }]);
  post(B, msg('목록'));
  t('업체명 HTML 이스케이프', () => assert.equal(/A&lt;b&gt;&amp;/.test(lastText(env)), true));
}

// ═══════════════════════════════════════════════════════════
// 11. 설치
// ═══════════════════════════════════════════════════════════
{
  const { env, B } = fresh();
  B.setupAll();
  t('setupAll 이 탭 4개 생성', () => {
    for (const n of ['접속점검', '결과', '이력', '시스템']) assert.equal(env.sheets.has(n), true, n + ' 없음');
  });
  t('setupAll 이 스케줄 설치', () => assert.equal(env.triggers.some((x) => x.getHandlerFunction() === 'hourlyTick'), true));
  t('setupAll 이 웹훅 등록', () => assert.equal(env.sent.some((s) => s.method === 'setWebhook'), true));
  t('웹훅 URL 에 토큰 포함', () => {
    const s = env.sent.find((x) => x.method === 'setWebhook');
    assert.equal(/token=tok/.test(s.body.url) && /action=tg/.test(s.body.url), true);
  });
  t('웹훅이 버튼(callback_query)도 수신', () => {
    const s = env.sent.find((x) => x.method === 'setWebhook');
    assert.equal(s.body.allowed_updates.indexOf('callback_query') !== -1, true);
  });
}

// ═══════════════════════════════════════════════════════════
// 12. 검증에서 지적된 결함 재현 방지
// ═══════════════════════════════════════════════════════════

// (1) 업체가 0곳일 때 [➕ 도메인 추가] — 셋업 첫 단계에서 막히던 문제
{
  const { env, B } = fresh();
  post(B, cbq('add'));
  t('업체 0곳: 업체 이름을 먼저 물어봄', () => assert.equal(/업체 이름을 보내주세요/.test(lastText(env)), true));
  post(B, msg('에그벳'));
  t('업체 0곳: 만든 뒤 곧바로 주소를 물어봄', () => assert.equal(/추가할 주소를 보내주세요/.test(lastText(env)), true));
  post(B, msg('egg-1.com\negg-2.com'));
  t('업체 0곳: 주소가 실제로 들어감', () => {
    const m = B.loadModel_();
    assert.equal(m.length, 1);
    assert.deepEqual(m[0].domains, ['egg-1.com', 'egg-2.com']);
  });
}

// (2) 여러 줄 주소 붙여넣기 — 예전엔 무반응
{
  const { env, B } = fresh(SEED);
  post(B, msg('new-1.com\nnew-2.com\nhttps://www.new-3.com/x'));
  t('여러 줄 붙여넣기: 어느 업체인지 물어봄', () => assert.equal(/주소 3개를 어느 업체에/.test(lastText(env)), true));
  post(B, cbq('a:0'));
  t('여러 줄 붙여넣기: 고른 업체에 전부 들어감', () => {
    const d = B.loadModel_()[0].domains;
    assert.equal(['new-1.com', 'new-2.com', 'new-3.com'].every((x) => d.indexOf(x) !== -1), true);
  });
}
{
  const { env, B } = fresh();
  post(B, msg('a.com\nb.com'));
  t('업체 0곳 + 여러 줄: 업체 이름을 물어봄', () => assert.equal(/업체 이름을 보내주세요/.test(lastText(env)), true));
  post(B, msg('새업체'));
  t('업체 0곳 + 여러 줄: 만들면서 함께 들어감', () => assert.deepEqual(B.loadModel_()[0].domains, ['a.com', 'b.com']));
}

// (3) 구글시트 수식 주입
{
  const { env, B } = fresh(SEED);
  post(B, msg('업체추가 =EVIL()'));
  t('수식으로 시작하는 업체명 거부', () => {
    assert.equal(B.loadModel_().length, 2);
    assert.equal(/시작할 수 없습니다/.test(lastText(env)), true);
  });
  post(B, msg('추가 =EVIL() a.com'));
  t('추가 경로로도 수식 업체명 거부', () => assert.equal(B.loadModel_().length, 2));
  B.doPost({
    parameter: { token: 'tok', action: 'write' },
    postData: { contents: JSON.stringify({ rows: [['업체', '도메인'], ['=HYPERLINK("http://evil")', '=IMAGE("http://evil")']], meta: {} }) },
  });
  t('결과 탭에 들어온 수식은 글자로 고정', () => {
    const r = env.sheets.get('결과').rows[1];
    assert.equal(String(r[0]).charAt(0), "'");
    assert.equal(String(r[1]).charAt(0), "'");
  });
  B.doPost({
    parameter: { token: 'tok', action: 'write' },
    postData: { contents: JSON.stringify({ rows: [['업체']], meta: { summary: '=EVIL()' } }) },
  });
  t('시스템 탭 요약도 글자로 고정', () => {
    const sys = env.sheets.get('시스템').rows.find((r) => String(r[1]).indexOf('EVIL') !== -1);
    assert.equal(String(sys[1]).charAt(0), "'");
  });
}

// (4) HTML 이 깨져 화면이 영구 먹통이 되던 문제
{
  const { env, B } = fresh(SEED);
  post(B, msg('업체추가 A<b'));
  t('꺾쇠 들어간 업체명 거부', () => {
    assert.equal(/쓸 수 없습니다/.test(lastText(env)), true);
    assert.equal(B.loadModel_().length, 2);
  });
}
{
  const { env, B } = fresh([{ name: 'A<b>&', domains: ['a.com'] }]);
  post(B, cbq('co'));
  t('업체 관리 화면도 이스케이프됨', () => assert.equal(/A&lt;b&gt;&amp;/.test(lastText(env)), true));
}
{
  const { env, B } = fresh(SEED);
  env.propStore.set('LAST_RESULT_SUMMARY', '<b>깨짐');
  env.propStore.set('LAST_RESULT_AT', '<i>x');
  post(B, msg('메뉴'));
  t('메뉴의 마지막 결과도 이스케이프됨', () => assert.equal(/&lt;b&gt;깨짐/.test(lastText(env)), true));
}
{
  // 텔레그램이 서식 오류를 돌려주면 → 평문으로라도 반드시 전달
  const env = makeEnv();
  const realFetch = env.UrlFetchApp.fetch;
  let first = true;
  env.UrlFetchApp.fetch = function (url, opts) {
    if (url.indexOf('api.telegram.org') !== -1 && first) {
      first = false;
      const body = opts && opts.payload ? JSON.parse(opts.payload) : {};
      env.sent.push({ method: url.split('/').pop(), body, failed: true });
      return { getResponseCode: () => 400, getContentText: () => JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }) };
    }
    return realFetch(url, opts);
  };
  const B = load(env, BASE_PROPS);
  B.saveModel_(SEED);
  env.sent.length = 0;
  post(B, msg('메뉴'));
  t('서식 오류 시 평문으로 재발송', () => {
    const ok = env.sent.filter((s) => !s.failed && s.method === 'sendMessage');
    assert.equal(ok.length >= 1, true);
    assert.equal(ok[ok.length - 1].body.parse_mode, undefined);
    assert.equal(/<blockquote>/.test(ok[ok.length - 1].body.text), false);
  });
  t('서식 오류가 시스템 탭에 남음', () => assert.equal(/텔레그램 서식 오류/.test(env.propStore.get('LAST_ERROR') || ''), true));
}

// (5) '점검시각 9시 21시' → 자정 점검이 몰래 추가되던 문제
{
  const { B } = fresh(SEED);
  post(B, msg('점검시각 9시 21시'));
  t("'9시 21시' 가 자정을 만들지 않음", () => assert.deepEqual(B.settings_().hours, [9, 21]));
  post(B, msg('점검시각 07시,19시'));
  t("'07시,19시' 도 정확히", () => assert.deepEqual(B.settings_().hours, [7, 19]));
  post(B, msg('점검시각 시'));
  t("숫자가 하나도 없으면 거부", () => assert.deepEqual(B.settings_().hours, [7, 19]));
}

// (6) 오래된 확인 버튼이 엉뚱한 대상을 지우던 문제
{
  const { env, B } = fresh(SEED);
  post(B, cbq('del'));
  post(B, cbq('d:0'));
  post(B, { callback_query: { id: 'c1', data: 'dx:0:1', from: { id: 7, first_name: '박담당' }, message: { chat: { id: '-1001' }, message_id: 100 } } });
  // 취소하고 다른 대상으로 새 확인을 만든 뒤, 예전 메시지의 버튼을 누른다
  post(B, msg('취소'));
  post(B, { callback_query: { id: 'c2', data: 'del', from: { id: 7, first_name: '박담당' }, message: { chat: { id: '-1001' }, message_id: 200 } } });
  post(B, { callback_query: { id: 'c3', data: 'd:1', from: { id: 7, first_name: '박담당' }, message: { chat: { id: '-1001' }, message_id: 200 } } });
  post(B, { callback_query: { id: 'c4', data: 'dx:1:0', from: { id: 7, first_name: '박담당' }, message: { chat: { id: '-1001' }, message_id: 200 } } });
  post(B, { callback_query: { id: 'c5', data: 'dok', from: { id: 7, first_name: '박담당' }, message: { chat: { id: '-1001' }, message_id: 100 } } });
  t('지난 확인 버튼은 거부됨', () => assert.equal(/지난 확인 버튼/.test(lastText(env)), true));
  t('아무것도 지워지지 않음', () => assert.deepEqual(B.loadModel_(), SEED));
}

// (7) 확인 대기 중 다른 말을 쓰면 무반응이던 문제
{
  const { env, B } = fresh(SEED);
  post(B, cbq('del'));
  post(B, cbq('d:0'));
  post(B, cbq('dx:0:1'));
  post(B, msg('메뉴'));
  t('확인 대기 중 다른 말 → 취소 안내가 나옴', () => assert.equal(/취소했습니다/.test(lastText(env)), true));
  t('확인 대기 중 다른 말 → 삭제되지 않음', () => assert.deepEqual(B.loadModel_(), SEED));
}
{
  const { env, B } = fresh(SEED);
  post(B, cbq('add'));
  post(B, cbq('a:0'));
  post(B, msg('메뉴'));
  t('주소 입력 대기 중 이상한 말 → 안내가 나옴', () => assert.equal(env.sent.length > 0, true));
}

// (8) 텔레그램 글로 업체 삭제할 때 동시작업 잠금이 안 걸리던 문제
{
  const { env, B } = fresh(SEED);
  post(B, msg('업체삭제 에그벳'));
  post(B, { callback_query: { id: 'z', data: 'del', from: { id: 8, first_name: '최담당' }, message: { chat: { id: '-1001' }, message_id: 9 } } });
  t('글로 시작한 확인 중에도 다른 사람 차단', () => assert.equal(/작업 중입니다/.test(lastText(env)), true));
}

// (9) 매시간 트리거가 어긋나 점검 회차가 통째로 빠지던 문제
{
  const { env, B } = fresh(SEED);
  env.propStore.set('CHECK_HOURS', '9,21');
  env.setNow('2026-08-28T08:56:00+09:00');
  B.hourlyTick();
  t('08:56 에는 실행 안 함', () => assert.equal(env.github.length, 0));
  env.setNow('2026-08-28T10:02:00+09:00');
  B.hourlyTick();
  t('10:02 에 09시 회차를 보정 실행', () => assert.equal(env.github.length, 1));
  B.hourlyTick();
  t('보정 실행은 한 번만', () => assert.equal(env.github.length, 1));
  env.setNow('2026-08-28T13:00:00+09:00');
  B.hourlyTick();
  t('3시간 넘게 지난 회차는 다시 안 함', () => assert.equal(env.github.length, 1));
}

// (10) 리포트가 아주 길어도 결과 탭 기록이 멈추지 않아야 한다
{
  const { env, B } = fresh(SEED);
  let bigReport = '🌐 접속점검 결과\n🕒 x\n';
  for (let i = 0; i < 400; i++) bigReport += `\n\n<blockquote>〔업체${i}〕\n❌ domain-${i}-아주긴한글도메인이름.example.com — 접속실패(타임아웃)</blockquote>`;
  const rows = [['업체', '도메인', '상태', 'HTTP', '최종 접속주소', '응답(ms)', '점검시각', '비고'],
    ['에그벳', 'egg-1.com', '❌ 이상', '', '', 15000, 'x', '접속실패(타임아웃)']];
  const r = JSON.parse(B.doPost({
    parameter: { token: 'tok', action: 'write' },
    postData: { contents: JSON.stringify({ rows, meta: { nowKst: 'x', summary: '총 1 · ❌1', report: bigReport } }) },
  }).text);
  t('아주 긴 리포트여도 write 성공', () => assert.equal(r.ok, true));
  t('아주 긴 리포트여도 결과 탭 기록됨', () => assert.equal(env.sheets.get('결과').rows[1][1], 'egg-1.com'));
  t('보관된 리포트가 9KB 이내', () => {
    const kept = env.propStore.get('LAST_REPORT') || '';
    assert.equal(Buffer.byteLength(kept, 'utf8') <= 9000, true, `${Buffer.byteLength(kept, 'utf8')} bytes`);
  });
  t('보관된 리포트의 인용태그 짝이 맞음', () => {
    const kept = env.propStore.get('LAST_REPORT') || '';
    assert.equal((kept.match(/<blockquote>/g) || []).length, (kept.match(/<\/blockquote>/g) || []).length);
  });
  env.sent.length = 0;
  post(B, msg('상태'));
  t('상태 명령이 깨지지 않고 나옴', () => {
    const texts = env.sent.filter((s) => s.method === 'sendMessage').map((s) => s.body.text);
    assert.equal(texts.length >= 1, true);
    assert.equal(texts.some((x) => /접속점검 결과/.test(x)), true);
    assert.equal(texts.every((x) => (x.match(/<blockquote>/g) || []).length === (x.match(/<\/blockquote>/g) || []).length), true);
  });
}

// (11) 형식 오류 항목이 결과 탭에 남는다
{
  const { env, B } = fresh(SEED);
  B.doPost({
    parameter: { token: 'tok', action: 'write' },
    postData: { contents: JSON.stringify({
      rows: [['업체', '도메인', '상태', 'HTTP', '최종 접속주소', '응답(ms)', '점검시각', '비고']],
      meta: { skipped: ['A3 exa_mple.com (도메인 아님)'] },
    }) },
  });
  t('점검 못 한 항목이 결과 탭에 표시됨', () => {
    const flat = env.sheets.get('결과').rows.map((r) => r.join('|')).join('\n');
    assert.equal(/점검하지 못한 항목/.test(flat) && /exa_mple\.com/.test(flat), true);
  });
}

// (12) P열 이후의 사람 메모는 건드리지 않는다
{
  const { env, B } = fresh(SEED);
  const sh = env.sheets.get('접속점검');
  sh.rows[0][15] = '운영 메모';
  sh.rows[1] = sh.rows[1] || [];
  sh.rows[1][15] = '건드리면 안 됨';
  post(B, msg('추가 에그벳 keep.com'));
  t('P열 메모 보존', () => {
    assert.equal(env.sheets.get('접속점검').rows[0][15], '운영 메모');
    assert.equal(env.sheets.get('접속점검').rows[1][15], '건드리면 안 됨');
  });
  t('그래도 도메인은 정상 추가', () => assert.equal(B.loadModel_()[0].domains.indexOf('keep.com') !== -1, true));
}

// (13) 삭제로 업체가 줄어도 옛 열이 남지 않는다
{
  const { B } = fresh([{ name: 'A', domains: ['a.com'] }, { name: 'B', domains: ['b.com'] }, { name: 'C', domains: ['c.com'] }]);
  post(B, msg('업체삭제 B'));
  post(B, cbq('codelok'));
  t('가운데 업체 삭제 후 목록이 정확', () => assert.deepEqual(B.loadModel_().map((c) => c.name), ['A', 'C']));
  t('삭제 후 도메인도 정확', () => assert.deepEqual(B.loadModel_().map((c) => c.domains), [['a.com'], ['c.com']]));
}

// (14) 되돌릴 게 없을 때 버튼
{
  const { env, B } = fresh(SEED);
  post(B, cbq('undo'));
  t('되돌릴 것 없으면 버튼도 안내', () => assert.equal(/되돌릴 내용이 없습니다/.test(lastText(env)), true));
}

// (15) 40개 초과 안내 문구가 실제 명령과 일치
{
  const many = [];
  for (let i = 0; i < 60; i++) many.push('d' + i + '.com');
  const { env, B } = fresh([{ name: 'A', domains: many }]);
  post(B, cbq('del'));
  post(B, cbq('d:0'));
  t('안내 문구가 실제 명령 형태', () => assert.equal(/삭제 example\.com/.test(lastText(env)), true));
}

// (16) 도메인 규칙이 core.js 와 같은지(앱스스크립트 쪽에서도 확인)
{
  const { B } = fresh();
  t('bridge 도 메모를 도메인으로 보지 않음', () => {
    assert.equal(B.normalizeDomain_('확인.필요'), null);
    assert.equal(B.normalizeDomain_('😀.kr'), null);
    assert.equal(B.normalizeDomain_('한국.kr'), '한국.kr');
  });
}

// ═══════════════════════════════════════════════════════════
// 13. 문서 ↔ 코드 대조 — 설명서에 적힌 대로 실제로 동작하는가
//     (문서와 코드가 어긋나면 비개발자는 그 자리에서 막힌다)
// ═══════════════════════════════════════════════════════════
{
  const MANUAL = fs.readFileSync(new URL('../사용법-담당자용.md', import.meta.url), 'utf8');
  const README = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const SETUP = fs.readFileSync(new URL('../SETUP.md', import.meta.url), 'utf8');
  const GSRC = fs.readFileSync(new URL('../apps-script/bridge.gs', import.meta.url), 'utf8');

  // (a) 설명서의 글 명령이 전부 실제로 먹히는가
  const COMMANDS = [
    ['점검', /점검을 시작합니다|실행 요청 실패/],
    ['목록', /등록된 도메인/],
    ['상태', /점검 기록이 없습니다|접속점검 결과/],
    ['추가 에그벳 zz1.com', /추가|이미 있음/],
    ['삭제 zz1.com', /삭제됨|등록되지 않은/],
    ['변경 egg-1.com zz2.com', /→|등록되지 않은/],
    ['이동 ya-1.com 에그벳', /→|그런 업체가 없습니다/],
    ['업체추가 테스트업체', /추가됨|이미 있는/],
    ['업체삭제 테스트업체', /삭제할까요|그런 업체가 없습니다/],
    ['이름변경 야옹이 야옹이2', /→|그런 업체가 없습니다/],
    ['점검시각 9 21', /점검 시각을/],
    ['알림 문제만', /알림 수준을/],
    ['알림 항상', /알림 수준을/],
    ['일시중지', /멈췄습니다/],
    ['재개', /다시 켰습니다/],
    ['되돌리기', /되돌릴|되돌릴까요/],
    ['메뉴', /접속점검 관리/],
    ['도움말', /사용법/],
    ['설정', /현재 설정/],
    ['취소', /취소/],
  ];
  for (const [cmd, expect] of COMMANDS) {
    const { env, B } = fresh(SEED);
    post(B, msg(cmd));
    t(`문서 명령 동작: "${cmd}"`, () => {
      assert.equal(env.sent.length > 0, true, '아무 반응이 없음');
      assert.equal(expect.test(lastText(env)), true, `응답: ${lastText(env).slice(0, 60)}`);
    });
  }

  // 설명서에 적힌 명령이 실제 코드에도 있는지(문서에만 있는 유령 명령 방지)
  const manualCmds = (MANUAL.match(/^(점검|목록|상태|추가|삭제|변경|이동|업체추가|업체삭제|이름변경|점검시각|알림|일시중지|재개|되돌리기|메뉴|취소)\b/gm) || []);
  t('설명서의 명령이 코드에도 전부 있음', () => {
    const missing = [...new Set(manualCmds)].filter((c) => GSRC.indexOf(c) === -1);
    assert.deepEqual(missing, []);
  });

  // (b) 설명서에 적힌 버튼 글자가 실제 버튼과 같은가
  const { env: e2, B: B2 } = fresh(SEED);
  post(B2, msg('메뉴'));
  const mainLabels = JSON.stringify(e2.sent[e2.sent.length - 1].body.reply_markup);
  for (const label of ['🔍 지금 점검', '📋 목록 보기', '➕ 도메인 추가', '🗑 도메인 삭제',
    '🏢 업체 관리', '⚙️ 설정', '↩️ 되돌리기', '❓ 도움말']) {
    t(`문서 버튼 존재: ${label}`, () => {
      assert.equal(mainLabels.indexOf(label) !== -1, true);
      assert.equal(MANUAL.indexOf(label) !== -1, true, '설명서에 없음');
    });
  }
  post(B2, cbq('cfg'));
  const cfgLabels = JSON.stringify(e2.sent[e2.sent.length - 1].body.reply_markup);
  for (const label of ['🕘 점검 시각 바꾸기', '자동 점검 일시중지']) {
    t(`설정 버튼 글자 일치: ${label}`, () => {
      assert.equal(cfgLabels.indexOf(label) !== -1, true, '버튼에 없음');
      assert.equal(MANUAL.indexOf(label) !== -1, true, '설명서에 없음');
    });
  }

  // (c) 문서에 적힌 숫자가 코드 상수와 같은가
  const constOf = (name) => Number(new RegExp(`var\\s+${name}\\s*=\\s*(\\d+)`).exec(GSRC)[1]);
  t('한도 숫자 일치: 업체 15곳', () => {
    assert.equal(constOf('MAX_COMPANIES'), 15);
    assert.equal(/업체 15곳|최대 15곳|15곳/.test(README), true);
  });
  t('한도 숫자 일치: 업체당 200개', () => {
    assert.equal(constOf('MAX_DOMAINS_PER_CO'), 200);
    assert.equal(/200개/.test(README), true);
  });
  t('한도 숫자 일치: 이력 500건', () => {
    assert.equal(constOf('LOG_KEEP'), 500);
    assert.equal(/500건/.test(SETUP), true);
  });
  t('숫자 일치: 감시 시간', () => {
    const w = constOf('WATCHDOG_MIN');
    assert.equal(new RegExp(`${w}분`).test(MANUAL), true, `설명서에 ${w}분 없음`);
    assert.equal(new RegExp(`${w}분`).test(README), true, `README에 ${w}분 없음`);
    assert.equal(new RegExp(`${w}분`).test(SETUP), true, `SETUP에 ${w}분 없음`);
  });
  t('숫자 일치: 분할 기준', () => {
    const lim = constOf('TG_LIMIT');
    assert.equal(README.indexOf(lim.toLocaleString('en-US')) !== -1 || README.indexOf(String(lim)) !== -1, true);
  });
  t('숫자 일치: 상태 만료 5분', () => {
    assert.equal(constOf('STATE_TTL'), 300);
    assert.equal(/5분/.test(MANUAL), true);
  });

  // (d) 설명서가 약속한 속성 이름이 코드에 다 있는가 (오타 = 셋업 실패)
  t('SETUP 의 속성 이름이 코드에 존재', () => {
    const names = [...new Set((SETUP.match(/`([A-Z][A-Z0-9_]{3,})`/g) || []).map((x) => x.slice(1, -1)))];
    const ignore = ['KR', 'YYYY', 'MM', 'DD'];
    const missing = names.filter((n) => ignore.indexOf(n) === -1 && GSRC.indexOf(n) === -1
      && fs.readFileSync(new URL('../check.js', import.meta.url), 'utf8').indexOf(n) === -1
      && fs.readFileSync(new URL('../.github/workflows/check.yml', import.meta.url), 'utf8').indexOf(n) === -1);
    assert.deepEqual(missing, []);
  });
  t('SETUP 이 안내한 실행 함수가 코드에 존재', () => {
    const fns = ['setupAll', 'setupWebhook', 'getWebhookInfo', 'deleteWebhook', 'testRead', 'testChannel', 'applySchedule_'];
    const missing = fns.filter((f) => !new RegExp(`function\\s+${f}\\s*\\(`).test(GSRC) || SETUP.indexOf(f) === -1);
    assert.deepEqual(missing, []);
  });
}

// ═══════════════════════════════════════════════════════════
const total = pass + fail;
if (fail) {
  console.error(`\n❌ bridge 실동작 검증 실패 ${fail}건 / 전체 ${total}건\n`);
  for (const f of failures) console.error('  · ' + f);
  process.exit(1);
}
console.log(`✅ bridge 실동작 검증 ${pass}/${total} 통과`);
