// 순수 로직 — 네트워크 없음(테스트 대상)
//  · normalizeDomain : 글자 한 덩이 → 주소(호스트) 부분만 / 아니면 null
//  · normalizeTarget : 글자 한 덩이 → { target: 적은 그대로, host: 주소 부분 } / 아니면 null
//  · parseSheet      : '접속점검' A1:O 2차원 배열 → 업체별 도메인 목록
//  · roundLabel      : 회차 이름(1차/2차/수동)
//  · buildSheetRows  : 결과 → '결과' 탭 표
//  · buildTelegramReport : 결과 → 텔레그램 메시지(HTML 인용블록)

// ── 상태 표기 ────────────────────────────────────────────────
export const STATUS = {
  up:    { icon: '✅', label: '정상' },
  warn:  { icon: '⚠️', label: '제한' },
  down:  { icon: '❌', label: '이상' },
  redir: { icon: '🔀', label: '주소확인' },
  // ★ 사이트의 방화벽(Cloudflare 등)이 '사람 브라우저가 아닌 접속'을 막은 상태.
  //   ※ 이건 문제가 아니라 '정상 도달'의 증거다 —
  //     한국에서 진짜 차단되면 응답 자체가 없다(타임아웃·연결끊김·주소못찾음).
  //     방화벽이 답을 줬다는 건 한국에서 그 서버까지 잘 닿았다는 뜻이다(2026-09-05 실측).
  //   ★ 담당자 화면에는 그냥 '정상'으로 보인다(에이든 지시 2026-09-05) —
  //     사람은 잠깐 기다리거나 한 번 누르면 들어가므로 담당자가 할 일이 없다.
  //     내부적으로만 blocked 로 남겨 브라우저 재확인 대상을 고르고, 시트 비고에 이유를 적는다.
  blocked: { icon: '✅', label: '정상' },
};
export const STATUS_ORDER = ['down', 'warn', 'redir', 'blocked', 'up'];

export function statusCell(status) {
  const s = STATUS[status] || STATUS.down;
  return `${s.icon} ${s.label}`;
}

// ── 도메인 정규화 ────────────────────────────────────────────
const COL_LETTERS = 'ABCDEFGHIJKLMNO';

function isIPv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255 && String(Number(p)) === p);
}

/**
 * 셀 한 칸의 글자를 점검 가능한 도메인으로 정리한다.
 * 'https://WWW.Example.com/a?b=1' → 'example.com'
 * 도메인이 아니면 null.
 *
 * ★ 이 함수의 알고리즘은 apps-script/bridge.gs 의 normalizeDomain_ 과 **완전히 같아야 한다.**
 *   (앱스스크립트에는 URL 객체가 없어 정규식만 사용한다. test/check.test.mjs 가 두 구현을 대조 검증한다.)
 */
export function normalizeDomain(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // 앞뒤 따옴표·괄호·쉼표·구두점 정리
  s = s.replace(/^[\s"'`<([]+/, '').replace(/[\s"'`>)\],.;]+$/, '');
  if (!s) return null;
  if (/\s/.test(s)) return null;                       // 중간 공백 → 문장/메모

  s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');  // http:// https:// 등 제거
  s = s.split('/')[0].split('?')[0].split('#')[0];     // 경로·쿼리·해시 제거
  s = s.replace(/^[^@]*@/, '');                        // 아이디@ 제거
  s = s.replace(/:\d+$/, '');                          // 포트 제거
  s = s.toLowerCase().replace(/\.+$/, '');             // 끝 점 제거
  if (s.indexOf('www.') === 0) s = s.slice(4);

  if (!s || s.length > 253) return null;
  if (s.indexOf('.') === -1) return null;              // 점이 없으면 도메인 아님
  if (isIPv4(s)) return s;
  if (s.indexOf(':') !== -1 || s.indexOf('[') !== -1) return null;  // IPv6 제외

  const labels = s.split('.');
  if (labels.length < 2) return null;
  for (const l of labels) {
    if (!l || l.length > 63) return null;
    if (l.charAt(0) === '-' || l.charAt(l.length - 1) === '-') return null;
    // 영숫자·하이픈 + 실제 문자체계(라틴확장·키릴·일본어·한자·한글)만.
    // 이모지·전각숫자·제로폭공백·대시류는 제외 → '확인.필요' 같은 메모가 도메인으로 오인되지 않는다.
    if (!/^[a-z0-9à-ÿЀ-ӿ぀-ヿ㐀-鿿가-힣-]+$/.test(l)) return null;
  }
  const tld = labels[labels.length - 1];
  // TLD는 영문 2글자 이상 또는 퓨니코드만. 한글 TLD는 실제로 xn-- 로 등록되므로 원문 한글 TLD는 제외.
  if (!/^([a-z]{2,}|xn--[a-z0-9-]+)$/.test(tld)) return null;
  return s;
}


/**
 * 담당자가 넣은 주소를 **적은 그대로** 지킨다.
 *   'https://ptt-852.com/?code=NDTV' → { target: 'https://ptt-852.com/?code=NDTV', host: 'ptt-852.com' }
 *   'example.com'                    → { target: 'example.com', host: 'example.com' }
 *   주소가 아니면 null.
 *
 * ★ 왜 normalizeDomain 으로 자르면 안 되나 (2026-09-05 에이든 지시)
 *   제휴 링크는 `?code=NDTV` 가 핵심이다. 그걸 잘라내면 다른 링크가 되어
 *   "내가 넣은 주소가 아닌 것"을 점검하게 된다. 그래서
 *     저장·점검·표시 = target(적은 그대로)
 *     비교·리다이렉트 판정 = host(주소 부분만)
 *   두 가지를 나눠 쓴다.
 *
 * ★ http·https 만 허용한다. javascript: · data: 같은 것은 주소가 아니다.
 */
export function normalizeTarget(raw) {
  if (raw === null || raw === undefined) return null;
  var s = String(raw).trim();
  if (!s) return null;

  s = s.replace(/^[\s"'`<([]+/, '');
  // 쿼리·해시가 있으면 끝의 점·쉼표를 함부로 떼지 않는다 — 코드 값의 일부일 수 있다.
  s = /[?#]/.test(s) ? s.replace(/[\s"'`>\]]+$/, '') : s.replace(/[\s"'`>)\],.;]+$/, '');
  if (!s) return null;
  if (/\s/.test(s)) return null;
  if (s.length > 500) return null;

  var scheme = '';
  var m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(s);
  if (m) {
    scheme = m[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') return null;
  }
  var rest = m ? s.slice(m[0].length) : s;
  rest = rest.replace(/^[^@/?#]*@/, '');
  var hostPart = rest.split('/')[0].split('?')[0].split('#')[0];
  var host = normalizeDomain(hostPart);
  if (!host) return null;
  return { target: s, host: host };
}

/** 저장된 문자열에서 주소(호스트) 부분만. 비교·리다이렉트 판정용. */
export function targetHost(raw) {
  var t = normalizeTarget(raw);
  return t ? t.host : '';
}

/** 저장할 문자열(적은 그대로). 주소가 아니면 null. */
export function targetOf(raw) {
  var t = normalizeTarget(raw);
  return t ? t.target : null;
}

// 같은 사이트인지 비교할 때 쓰는 대표도메인(등록 가능 도메인 근사)
// ※ 이 목록이 부족하면 '다른 사이트로 넘어갔는데 정상으로 보이는' 미탐지가 생긴다.
//    (예: old.pages.dev → new.pages.dev 를 같은 사이트로 착각)
const TWO_LEVEL_SUFFIX = new Set([
  // 한국 — 일반 + 지역 도메인 전체
  'co.kr', 'ne.kr', 'or.kr', 're.kr', 'pe.kr', 'go.kr', 'ac.kr', 'hs.kr', 'ms.kr', 'es.kr',
  'sc.kr', 'kg.kr', 'mil.kr',
  'seoul.kr', 'busan.kr', 'daegu.kr', 'incheon.kr', 'gwangju.kr', 'daejeon.kr', 'ulsan.kr',
  'gyeonggi.kr', 'gangwon.kr', 'chungbuk.kr', 'chungnam.kr', 'jeonbuk.kr', 'jeonnam.kr',
  'gyeongbuk.kr', 'gyeongnam.kr', 'jeju.kr',
  // 그 밖의 국가
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'com.tw', 'com.hk', 'com.sg', 'com.au', 'net.au', 'org.au',
  'com.br', 'com.mx', 'com.tr', 'com.vn', 'com.ph', 'co.id', 'co.th', 'com.my',
  'co.in', 'co.nz', 'co.za', 'com.ru', 'com.ua', 'co.il',
  // 호스팅 서비스 — 제휴 사이트가 실제로 옮겨다니는 곳
  'pages.dev', 'workers.dev', 'github.io', 'netlify.app', 'vercel.app', 'web.app',
  'firebaseapp.com', 'blogspot.com', 'wixsite.com', 'weebly.com', 'herokuapp.com',
  'cloudfront.net', 'amazonaws.com', 'r2.dev', 'onrender.com', 'glitch.me',
  'tistory.com', 'cafe24.com', 'mycafe24.com', 'gabia.io',
]);

export function registrableDomain(host) {
  if (!host) return '';
  const h = String(host).toLowerCase().replace(/\.+$/, '');
  if (isIPv4(h)) return h;
  const labels = h.split('.');
  if (labels.length <= 2) return h;
  const last2 = labels.slice(-2).join('.');
  if (TWO_LEVEL_SUFFIX.has(last2) && labels.length >= 3) return labels.slice(-3).join('.');
  return last2;
}

/** 두 호스트가 '같은 사이트'인가 (www./서브도메인 차이는 같은 것으로 본다) */
export function sameSite(a, b) {
  const ra = registrableDomain(a);
  const rb = registrableDomain(b);
  return !!ra && ra === rb;
}

// ── 시트 파싱 ────────────────────────────────────────────────
/**
 * values: '접속점검!A1:O' 2차원 배열. 1행 = 업체명, 열 하나 = 업체 하나, 2행부터 세로로 주소.
 * → { domains: [{company, domain, cell}], skipped: [{company, raw, cell, reason}] }
 */
export function parseSheet(values) {
  const grid = Array.isArray(values) ? values : [];
  const domains = [];
  const skipped = [];
  if (grid.length < 2) return { domains, skipped };

  const header = grid[0] || [];
  const maxCols = Math.min(
    COL_LETTERS.length,
    grid.reduce((m, row) => Math.max(m, Array.isArray(row) ? row.length : 0), 0)
  );

  for (let c = 0; c < maxCols; c++) {
    const rawName = String(header[c] ?? '').trim();
    const company = rawName || `${COL_LETTERS[c]}열`;
    const seen = new Set();

    for (let r = 1; r < grid.length; r++) {
      const row = grid[r] || [];
      const raw = row[c];
      const cell = `${COL_LETTERS[c]}${r + 1}`;
      const text = String(raw ?? '').trim();
      if (!text) continue;                               // 빈칸 = 조용히 건너뜀

      // ★ 적은 그대로 저장·점검한다(제휴 링크의 ?code= 가 잘리면 다른 링크가 된다)
      const t = normalizeTarget(text);
      if (!t) {
        skipped.push({ company, raw: text, cell, reason: '도메인 아님' });
        continue;
      }
      // 저장은 적은 그대로, 중복 판정만 대소문자를 무시한다(같은 링크를 두 번 적는 실수 방지)
      const key = t.target.toLowerCase();
      if (seen.has(key)) {
        skipped.push({ company, raw: text, cell, reason: '업체 내 중복' });
        continue;
      }
      seen.add(key);
      domains.push({ company, domain: t.target, host: t.host, cell });
    }
  }
  return { domains, skipped };
}

// ── 회차 이름 ────────────────────────────────────────────────
export function roundLabel({ manual = false, kstHour = 0 } = {}) {
  if (manual) return '수동';
  return kstHour < 15 ? '1차(자동)' : '2차(자동)';
}

// ── '결과' 탭 표 ─────────────────────────────────────────────
export const SHEET_HEADER = ['업체', '도메인', '상태', 'HTTP', '최종 접속주소', '응답(ms)', '점검시각', '비고'];

export function buildSheetRows(results, nowKst) {
  const rows = [SHEET_HEADER];
  for (const r of results || []) {
    let note = r.note || '';
    if (r.status === 'redir' && r.redirectTo) note = `${note} → ${r.redirectTo}`;
    rows.push([
      r.company ?? '',
      r.domain ?? '',
      statusCell(r.status),
      r.http === null || r.http === undefined ? '' : r.http,
      r.finalUrl || '',
      r.ms === null || r.ms === undefined ? '' : r.ms,
      nowKst || '',
      note,
    ]);
  }
  return rows;
}

// ── 텔레그램 리포트 ──────────────────────────────────────────
export function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function quote(lines) {
  return `<blockquote>${lines.join('\n')}</blockquote>`;
}

export function countByStatus(results) {
  const c = { total: 0, up: 0, warn: 0, down: 0, redir: 0, blocked: 0 };
  for (const r of results || []) {
    c.total++;
    if (c[r.status] === undefined) c.down++;
    else c[r.status]++;
  }
  return c;
}

/** 문제 항목을 업체별로 묶는다(시트 등장 순서 유지, 업체 내부는 이상→제한→주소확인 순) */
export function groupProblems(results) {
  const order = [];
  const map = new Map();
  for (const r of results || []) {
    if (r.status === 'up') continue;
    if (r.status === 'blocked') continue;   // 도달은 됐다 — 경보로 올리지 않는다
    if (!map.has(r.company)) { map.set(r.company, []); order.push(r.company); }
    map.get(r.company).push(r);
  }
  return order.map((company) => ({
    company,
    items: map.get(company).slice().sort(
      (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
    ),
  }));
}

export function buildTelegramReport(results, { nowKst = '', round = '수동', skipped = [] } = {}) {
  const c = countByStatus(results);
  const parts = [];
  // 형식이 잘못돼 점검조차 안 된 항목 — 알려주지 않으면 "감시되고 있다"고 착각한다
  const bad = (skipped || []).filter((s) => s && s.reason === '도메인 아님');

  parts.push(`🌐 접속점검 결과 · ${escapeHtml(round)}\n🕒 ${escapeHtml(nowKst)} KST`);

  const reached = c.up + c.blocked;          // 서버까지 닿은 것 = 정상

  if (c.total === 0) {
    parts.push(quote(['점검할 도메인이 없습니다.']));
  } else if (reached === c.total) {
    parts.push(quote([`총 ${c.total}개 모두 정상 ✅`]));
  } else {
    parts.push(quote([
      `총 ${c.total}개`,
      `✅ 정상 ${reached} · ⚠️ 제한 ${c.warn} · ❌ 이상 ${c.down} · 🔀 주소확인 ${c.redir}`,
    ]));
    parts.push('⚠️ 확인 필요');
    for (const g of groupProblems(results)) {
      const lines = [`〔${escapeHtml(g.company)}〕`];
      for (const r of g.items) {
        const icon = (STATUS[r.status] || STATUS.down).icon;
        let line = `${icon} ${escapeHtml(r.domain)} — ${escapeHtml(r.note || '')}`;
        if (r.status === 'redir' && r.redirectTo) line += ` → ${escapeHtml(r.redirectTo)}`;
        lines.push(line);
      }
      parts.push(quote(lines));
    }
  }

  if (bad.length) {
    const lines = [`점검하지 못한 항목 ${bad.length}개 (주소 형식이 아님)`];
    for (const s of bad.slice(0, 15)) lines.push(`· ${escapeHtml(s.cell || '')} ${escapeHtml(s.raw || '')}`);
    if (bad.length > 15) lines.push(`· 외 ${bad.length - 15}개`);
    lines.push('→ 채널에서 고쳐주세요. 이 항목들은 감시되지 않습니다.');
    parts.push('⚠️ 확인 필요 (입력 오류)');
    parts.push(quote(lines));
  }

  return { text: parts.join('\n\n'), parseMode: 'HTML', skippedBad: bad.length, ...c };
}
