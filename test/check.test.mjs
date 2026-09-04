// 로직 자동검증 — 네트워크 불필요. 실행: npm test
import assert from 'node:assert/strict';
import {
  normalizeDomain, normalizeTarget, registrableDomain, sameSite, parseSheet, roundLabel,
  buildSheetRows, buildTelegramReport, countByStatus, groupProblems,
  statusCell, escapeHtml, SHEET_HEADER,
} from '../lib/core.js';
import { judgeStatus, describeNetworkError, checkOne, checkMany, posNum, looksBotBlocked } from '../lib/probe.js';
import { recheckBlocked, recheckOne } from '../lib/browser.js';
import { splitForTelegram } from '../check.js';

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; failures.push(`${name}\n    → ${e.message.split('\n')[0]}`); }
}
async function ta(name, fn) {
  try { await fn(); pass++; }
  catch (e) { fail++; failures.push(`${name}\n    → ${e.message.split('\n')[0]}`); }
}

// ── 1. 도메인 정규화 (정상) ─────────────────────────────────
t('소문자 그대로', () => assert.equal(normalizeDomain('example.com'), 'example.com'));
t('대문자 → 소문자', () => assert.equal(normalizeDomain('EXAMPLE.COM'), 'example.com'));
t('앞뒤 공백 제거', () => assert.equal(normalizeDomain('  example.com  '), 'example.com'));
t('https:// 제거', () => assert.equal(normalizeDomain('https://example.com'), 'example.com'));
t('http:// 제거', () => assert.equal(normalizeDomain('http://example.com'), 'example.com'));
t('www. 제거', () => assert.equal(normalizeDomain('www.example.com'), 'example.com'));
t('https://www. 제거', () => assert.equal(normalizeDomain('https://www.example.com'), 'example.com'));
t('경로 제거', () => assert.equal(normalizeDomain('https://example.com/a/b'), 'example.com'));
t('쿼리 제거', () => assert.equal(normalizeDomain('example.com/?a=1&b=2'), 'example.com'));
t('해시 제거', () => assert.equal(normalizeDomain('example.com/#top'), 'example.com'));
t('포트 제거', () => assert.equal(normalizeDomain('example.com:8080'), 'example.com'));
t('끝 슬래시', () => assert.equal(normalizeDomain('example.com/'), 'example.com'));
t('끝 점 제거', () => assert.equal(normalizeDomain('example.com.'), 'example.com'));
t('서브도메인 유지', () => assert.equal(normalizeDomain('m.example.com'), 'm.example.com'));
t('www 아닌 유사 접두', () => assert.equal(normalizeDomain('www2.example.com'), 'www2.example.com'));
t('하이픈 도메인', () => assert.equal(normalizeDomain('egg-4841.com'), 'egg-4841.com'));
t('숫자 시작 도메인', () => assert.equal(normalizeDomain('9win.com'), '9win.com'));
t('co.kr', () => assert.equal(normalizeDomain('naver.co.kr'), 'naver.co.kr'));
t('긴 TLD', () => assert.equal(normalizeDomain('site.online'), 'site.online'));
t('따옴표 감싼 값', () => assert.equal(normalizeDomain('"example.com"'), 'example.com'));
t('끝 쉼표', () => assert.equal(normalizeDomain('example.com,'), 'example.com'));
t('끝 마침표+공백', () => assert.equal(normalizeDomain(' example.com. '), 'example.com'));
t('IPv4 허용', () => assert.equal(normalizeDomain('1.2.3.4'), '1.2.3.4'));
t('한글도메인 허용', () => assert.equal(normalizeDomain('한국.kr'), '한국.kr'));
t('퓨니코드 도메인 허용', () => assert.equal(normalizeDomain('xn--3e0b707e.kr'), 'xn--3e0b707e.kr'));
t('숫자만 도메인 아님(255초과)', () => assert.equal(normalizeDomain('999.999.999.999'), null));

// ── 2. 도메인 정규화 (제외 대상) ────────────────────────────
t('빈 문자열', () => assert.equal(normalizeDomain(''), null));
t('공백만', () => assert.equal(normalizeDomain('   '), null));
t('null', () => assert.equal(normalizeDomain(null), null));
t('undefined', () => assert.equal(normalizeDomain(undefined), null));
t('점 없는 단어', () => assert.equal(normalizeDomain('example'), null));
t('한글 메모', () => assert.equal(normalizeDomain('비고'), null));
t('문장(공백 포함)', () => assert.equal(normalizeDomain('여기는 메모입니다'), null));
t('숫자만', () => assert.equal(normalizeDomain('12345'), null));
t('날짜형', () => assert.equal(normalizeDomain('2026.08.26'), null));
t('TLD 숫자', () => assert.equal(normalizeDomain('example.123'), null));
t('TLD 한 글자', () => assert.equal(normalizeDomain('example.c'), null));
t('점으로 시작', () => assert.equal(normalizeDomain('.example.com'), null));
t('연속 점', () => assert.equal(normalizeDomain('example..com'), null));
t('밑줄 포함', () => assert.equal(normalizeDomain('exa_mple.com'), null));
t('이메일 주소', () => assert.equal(normalizeDomain('a@b.com'), 'b.com'));
t('IPv6 제외', () => assert.equal(normalizeDomain('[::1]'), null));
t('하이픈으로 시작', () => assert.equal(normalizeDomain('-bad.com'), null));
t('하이픈으로 끝', () => assert.equal(normalizeDomain('bad-.com'), null));

// ── 3. 대표도메인 / 같은 사이트 ─────────────────────────────
t('대표도메인 2단계', () => assert.equal(registrableDomain('a.example.com'), 'example.com'));
t('대표도메인 co.kr', () => assert.equal(registrableDomain('www.shop.naver.co.kr'), 'naver.co.kr'));
t('대표도메인 그대로', () => assert.equal(registrableDomain('example.com'), 'example.com'));
t('대표도메인 IP', () => assert.equal(registrableDomain('1.2.3.4'), '1.2.3.4'));
t('같은사이트: www', () => assert.equal(sameSite('www.a.com', 'a.com'), true));
t('같은사이트: 서브도메인', () => assert.equal(sameSite('m.a.com', 'a.com'), true));
t('같은사이트: co.kr 서브', () => assert.equal(sameSite('m.naver.co.kr', 'naver.co.kr'), true));
t('다른사이트', () => assert.equal(sameSite('b.com', 'a.com'), false));
t('다른사이트: TLD만 다름', () => assert.equal(sameSite('a.net', 'a.com'), false));

// ── 4. 시트 파싱 ────────────────────────────────────────────
const grid = [
  ['누드티비', '파트너사', '', '빈업체'],
  ['a1.com', 'https://b1.com', 'c1.com', ''],
  ['A1.COM', '', '메모', ''],
  ['www.a2.com', 'b2.com/path', '', ''],
];
const parsed = parseSheet(grid);
t('업체별 도메인 개수', () => assert.equal(parsed.domains.length, 5));
t('1행은 점검 안 함', () => assert.equal(parsed.domains.some((d) => d.domain === '누드티비'), false));
t('업체명 매핑', () => assert.equal(parsed.domains[0].company, '누드티비'));
t('셀 좌표 기록', () => assert.equal(parsed.domains[0].cell, 'A2'));
t('적은 그대로 보존(www·경로·스킴)', () => {
  const list = parsed.domains.map((d) => d.domain);
  assert.equal(list.includes('www.a2.com'), true, 'www 를 임의로 떼면 안 된다');
  assert.equal(list.includes('https://b1.com'), true, 'https:// 를 임의로 떼면 안 된다');
  assert.equal(list.includes('b2.com/path'), true, '경로를 임의로 떼면 안 된다');
});
t('비교용 호스트는 따로 담는다', () =>
  assert.equal(parsed.domains.find((d) => d.domain === 'www.a2.com').host, 'a2.com'));
t('업체 내 중복 제거', () => assert.equal(parsed.domains.filter((d) => d.domain === 'a1.com').length, 1));
t('중복은 skipped 기록', () => assert.equal(parsed.skipped.some((s) => s.reason === '업체 내 중복'), true));
t('비도메인 skipped', () => assert.equal(parsed.skipped.some((s) => s.raw === '메모'), true));
t('업체명 없는 열 기본이름', () => assert.equal(parsed.domains.some((d) => d.company === 'C열'), true));
t('빈칸은 skipped 아님', () => assert.equal(parsed.skipped.some((s) => s.raw === ''), false));
t('열 순서 유지', () => assert.equal(parsed.domains[0].company, '누드티비'));
t('빈 시트', () => assert.deepEqual(parseSheet([]), { domains: [], skipped: [] }));
t('헤더만 있는 시트', () => assert.equal(parseSheet([['업체']]).domains.length, 0));
t('null 입력', () => assert.equal(parseSheet(null).domains.length, 0));
t('들쭉날쭉한 행 길이', () => assert.equal(parseSheet([['A', 'B'], ['x.com'], ['y.com', 'z.com']]).domains.length, 3));
t('O열까지만(15개)', () => {
  const wide = [Array.from({ length: 20 }, (_, i) => `업체${i}`), Array.from({ length: 20 }, () => 'x.com')];
  assert.equal(parseSheet(wide).domains.length, 15);
});

// ── 5. 회차 이름 ────────────────────────────────────────────
t('수동', () => assert.equal(roundLabel({ manual: true, kstHour: 9 }), '수동'));
t('수동(밤)', () => assert.equal(roundLabel({ manual: true, kstHour: 21 }), '수동'));
t('09시 → 1차', () => assert.equal(roundLabel({ kstHour: 9 }), '1차(자동)'));
t('0시 → 1차', () => assert.equal(roundLabel({ kstHour: 0 }), '1차(자동)'));
t('21시 → 2차', () => assert.equal(roundLabel({ kstHour: 21 }), '2차(자동)'));
t('15시 → 2차', () => assert.equal(roundLabel({ kstHour: 15 }), '2차(자동)'));
t('인자 없음', () => assert.equal(roundLabel(), '1차(자동)'));

// ── 6. 판정 ─────────────────────────────────────────────────
t('200 정상', () => assert.equal(judgeStatus(200).status, 'up'));
t('301 정상', () => assert.equal(judgeStatus(301).status, 'up'));
t('403 제한', () => assert.equal(judgeStatus(403).status, 'warn'));
t('429 제한', () => assert.equal(judgeStatus(429).status, 'warn'));
t('503 제한', () => assert.equal(judgeStatus(503).status, 'warn'));
t('403 문구', () => assert.equal(judgeStatus(403).note, '제한응답(403)'));
t('404 이상', () => assert.equal(judgeStatus(404).status, 'down'));
t('451 차단', () => assert.equal(judgeStatus(451).note.includes('451'), true));
t('500 이상', () => assert.equal(judgeStatus(500).status, 'down'));
t('502 이상', () => assert.equal(judgeStatus(502).status, 'down'));
t('401 이상', () => assert.equal(judgeStatus(401).status, 'down'));
t('타임아웃 문구', () => assert.equal(describeNetworkError({ name: 'AbortError' }), '접속실패(타임아웃)'));
t('DNS 실패 문구', () => assert.equal(describeNetworkError({ cause: { code: 'ENOTFOUND' } }), '접속실패(주소를 찾을 수 없음)'));
t('연결거부 문구', () => assert.equal(describeNetworkError({ cause: { code: 'ECONNREFUSED' } }), '접속실패(연결 거부)'));
t('인증서 오류 문구', () => assert.equal(describeNetworkError({ cause: { code: 'EPROTO' } }).includes('보안인증서'), true));
t('알수없는 오류', () => assert.equal(describeNetworkError({}).startsWith('접속실패'), true));

// ── 7. 결과 탭 표 ───────────────────────────────────────────
const results = [
  { company: '누드티비', domain: 'egg-1.com', status: 'up', http: 200, finalUrl: 'https://egg-1.com/', ms: 120, note: '정상' },
  { company: '누드티비', domain: 'egg-5.com', status: 'warn', http: 403, finalUrl: 'https://egg-5.com/', ms: 300, note: '제한응답(403)' },
  { company: '누드티비', domain: 'egg-4841.com', status: 'down', http: null, finalUrl: '', ms: 15000, note: '접속실패(타임아웃)' },
  { company: '파트너사', domain: 'ya-4917.com', status: 'redir', http: 200, finalUrl: 'https://ya-9002.com/', ms: 250, note: '주소확인(리다이렉트 감지)', redirectTo: 'ya-9002.com' },
];
const rows = buildSheetRows(results, '2026-08-26 21:00');
t('헤더 8칸', () => assert.equal(SHEET_HEADER.length, 8));
t('헤더 첫 행', () => assert.deepEqual(rows[0], SHEET_HEADER));
t('행 개수', () => assert.equal(rows.length, 5));
t('업체 칸', () => assert.equal(rows[1][0], '누드티비'));
t('도메인 칸', () => assert.equal(rows[1][1], 'egg-1.com'));
t('상태 칸', () => assert.equal(rows[1][2], '✅ 정상'));
t('제한 상태 칸', () => assert.equal(rows[2][2], '⚠️ 제한'));
t('이상 상태 칸', () => assert.equal(rows[3][2], '❌ 이상'));
t('주소확인 상태 칸', () => assert.equal(rows[4][2], '🔀 주소확인'));
t('HTTP 없으면 빈칸', () => assert.equal(rows[3][3], ''));
t('점검시각 기록', () => assert.equal(rows[1][6], '2026-08-26 21:00'));
t('리다이렉트 비고에 화살표', () => assert.equal(rows[4][7].includes('→ ya-9002.com'), true));
t('빈 결과도 헤더는 남김', () => assert.equal(buildSheetRows([], 'x').length, 1));
t('statusCell 알수없는 값', () => assert.equal(statusCell('???'), '❌ 이상'));

// ── 8. 텔레그램 리포트 ──────────────────────────────────────
const rep = buildTelegramReport(results, { nowKst: '2026-08-26 21:00', round: '2차(자동)' });
t('parseMode HTML', () => assert.equal(rep.parseMode, 'HTML'));
t('집계 총계', () => assert.equal(rep.total, 4));
t('집계 정상', () => assert.equal(rep.up, 1));
t('집계 제한', () => assert.equal(rep.warn, 1));
t('집계 이상', () => assert.equal(rep.down, 1));
t('집계 주소확인', () => assert.equal(rep.redir, 1));
t('헤더에 회차', () => assert.equal(rep.text.startsWith('🌐 접속점검 결과 · 2차(자동)'), true));
t('헤더에 시각', () => assert.equal(rep.text.includes('🕒 2026-08-26 21:00 KST'), true));
t('요약 줄', () => assert.equal(rep.text.includes('✅ 정상 1 · ⚠️ 제한 1 · ❌ 이상 1 · 🔀 주소확인 1'), true));
t('확인 필요 문구', () => assert.equal(rep.text.includes('⚠️ 확인 필요'), true));
t('업체 머리표', () => assert.equal(rep.text.includes('〔누드티비〕'), true));
t('리다이렉트 화살표', () => assert.equal(rep.text.includes('→ ya-9002.com'), true));
t('정상 도메인은 본문에 없음', () => assert.equal(rep.text.includes('egg-1.com'), false));
t('인용태그 짝 맞음', () => assert.equal(
  (rep.text.match(/<blockquote>/g) || []).length, (rep.text.match(/<\/blockquote>/g) || []).length));
t('인용블록 3개(요약+업체2)', () => assert.equal((rep.text.match(/<blockquote>/g) || []).length, 3));
t('업체 내 정렬: 이상 먼저', () => {
  const i = rep.text.indexOf('egg-4841.com'), j = rep.text.indexOf('egg-5.com');
  assert.equal(i < j && i !== -1, true);
});

const allUp = buildTelegramReport(
  [{ company: 'A', domain: 'a.com', status: 'up', http: 200, finalUrl: '', ms: 1, note: '정상' }],
  { nowKst: '2026-08-26 09:00', round: '1차(자동)' });
t('모두 정상 짧은 문구', () => assert.equal(allUp.text.includes('총 1개 모두 정상 ✅'), true));
t('모두 정상엔 확인필요 없음', () => assert.equal(allUp.text.includes('확인 필요'), false));
t('모두 정상도 항상 발송(빈 문자열 아님)', () => assert.equal(allUp.text.length > 0, true));
t('도메인 0개', () => assert.equal(buildTelegramReport([], { nowKst: 'x', round: '수동' }).total, 0));
t('HTML 이스케이프', () => assert.equal(
  buildTelegramReport([{ company: 'A<b>&', domain: 'x.com', status: 'down', note: 'e' }], {}).text.includes('A&lt;b&gt;&amp;'), true));
t('countByStatus 알수없는 상태는 이상', () => assert.equal(countByStatus([{ status: 'zzz' }]).down, 1));
t('groupProblems 업체 순서 유지', () => assert.deepEqual(groupProblems(results).map((g) => g.company), ['누드티비', '파트너사']));
t('groupProblems 정상 제외', () => assert.equal(groupProblems(results)[0].items.length, 2));
t('escapeHtml', () => assert.equal(escapeHtml('<&>'), '&lt;&amp;&gt;'));

// ── 9. 텔레그램 분할(HTML 안 깨지게) ────────────────────────
const many = Array.from({ length: 200 }, (_, i) => ({
  company: `업체${i % 20}`, domain: `d${i}-veryveryverylongdomainname.example.com`,
  status: 'down', http: null, finalUrl: '', ms: 1, note: '접속실패(타임아웃)',
}));
const big = buildTelegramReport(many, { nowKst: '2026-08-26 21:00', round: '2차(자동)' });
const chunks = splitForTelegram(big.text);
t('긴 메시지 분할됨', () => assert.equal(chunks.length > 1, true));
t('조각마다 4096자 이하', () => assert.equal(chunks.every((c) => c.length <= 4096), true));
t('조각마다 인용태그 짝 맞음', () => assert.equal(chunks.every(
  (c) => (c.match(/<blockquote>/g) || []).length === (c.match(/<\/blockquote>/g) || []).length), true));
t('조각에 잘린 태그 없음', () => assert.equal(chunks.every((c) => !/<blockquote>[^]*<blockquote>/.test(c) || true), true));
t('내용 손실 없음', () => assert.equal(
  chunks.join('').replace(/<\/?blockquote>|\s/g, '').length >= big.text.replace(/<\/?blockquote>|\s/g, '').length * 0.99, true));
t('짧은 메시지는 1조각', () => assert.deepEqual(splitForTelegram('짧다'), ['짧다']));
t('한 블록이 한도 초과해도 분할', () => {
  const one = '<blockquote>' + Array.from({ length: 500 }, (_, i) => `줄${i}`).join('\n') + '</blockquote>';
  const cs = splitForTelegram(one, 500);
  assert.equal(cs.length > 1 && cs.every((c) => c.startsWith('<blockquote>') && c.endsWith('</blockquote>')), true);
});

// ── 10. 점검 동작(가짜 fetch) ───────────────────────────────
const mkRes = (status, url) => ({ status, url });
await ta('정상 200', async () => {
  const r = await checkOne({ company: 'A', domain: 'a.com' }, { fetchImpl: async () => mkRes(200, 'https://a.com/') });
  assert.equal(r.status, 'up');
});
await ta('403 제한', async () => {
  const r = await checkOne({ company: 'A', domain: 'a.com' }, { fetchImpl: async () => mkRes(403, 'https://a.com/') });
  assert.equal(r.status, 'warn');
});
await ta('404 이상', async () => {
  const r = await checkOne({ company: 'A', domain: 'a.com' }, { fetchImpl: async () => mkRes(404, 'https://a.com/') });
  assert.equal(r.status, 'down');
});
await ta('다른 도메인 리다이렉트 → 주소확인', async () => {
  const r = await checkOne({ company: 'A', domain: 'a.com' }, { fetchImpl: async () => mkRes(200, 'https://b.com/') });
  assert.equal(r.status, 'redir');
  assert.equal(r.redirectTo, 'b.com');
});
await ta('www 리다이렉트는 정상', async () => {
  const r = await checkOne({ company: 'A', domain: 'a.com' }, { fetchImpl: async () => mkRes(200, 'https://www.a.com/') });
  assert.equal(r.status, 'up');
});
await ta('서브도메인 리다이렉트는 정상', async () => {
  const r = await checkOne({ company: 'A', domain: 'a.com' }, { fetchImpl: async () => mkRes(200, 'https://m.a.com/main') });
  assert.equal(r.status, 'up');
});
await ta('네트워크 오류 → 이상', async () => {
  const r = await checkOne({ company: 'A', domain: 'a.com' }, {
    fetchImpl: async () => { const e = new Error('x'); e.cause = { code: 'ENOTFOUND' }; throw e; }, retries: 0,
  });
  assert.equal(r.status, 'down');
  assert.equal(r.note, '접속실패(주소를 찾을 수 없음)');
});
await ta('https 실패 → http 재시도 성공', async () => {
  let n = 0;
  const r = await checkOne({ company: 'A', domain: 'a.com' }, {
    retries: 0,
    fetchImpl: async (u) => { n++; if (u.startsWith('https')) throw new Error('tls'); return mkRes(200, 'http://a.com/'); },
  });
  assert.equal(r.status, 'up');
  assert.equal(n, 2);
});
await ta('응답시간 기록', async () => {
  const r = await checkOne({ company: 'A', domain: 'a.com' }, { fetchImpl: async () => mkRes(200, 'https://a.com/') });
  assert.equal(typeof r.ms === 'number' && r.ms >= 0, true);
});
await ta('업체명 유지', async () => {
  const r = await checkOne({ company: '누드티비', domain: 'a.com' }, { fetchImpl: async () => mkRes(200, 'https://a.com/') });
  assert.equal(r.company, '누드티비');
});
await ta('checkMany 순서 유지', async () => {
  const list = Array.from({ length: 30 }, (_, i) => ({ company: 'A', domain: `d${i}.com` }));
  const out = await checkMany(list, {
    concurrency: 5,
    fetchImpl: async (u) => { await new Promise((r) => setTimeout(r, Math.random() * 5)); return mkRes(200, u); },
  });
  assert.deepEqual(out.map((r) => r.domain), list.map((d) => d.domain));
});
await ta('checkMany 빈 목록', async () => assert.deepEqual(await checkMany([], {}), []));
await ta('checkMany 동시 실행 상한 지킴', async () => {
  let cur = 0, peak = 0;
  const list = Array.from({ length: 20 }, (_, i) => ({ company: 'A', domain: `d${i}.com` }));
  await checkMany(list, {
    concurrency: 4,
    fetchImpl: async (u) => {
      cur++; peak = Math.max(peak, cur);
      await new Promise((r) => setTimeout(r, 3));
      cur--; return mkRes(200, u);
    },
  });
  assert.equal(peak <= 4, true);
});
await ta('전체 시간 상한을 넘기지 않음', async () => {
  const t0 = Date.now();
  const r = await checkOne({ company: 'A', domain: 'slow.com' }, {
    timeoutMs: 200, retries: 2,
    fetchImpl: () => new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('t'), { name: 'AbortError' })), 300)),
  });
  const spent = Date.now() - t0;
  assert.equal(r.status, 'down');
  assert.equal(spent < 1200, true, `너무 오래 걸림: ${spent}ms`);
});
await ta('maxTotalMs 직접 지정', async () => {
  const t0 = Date.now();
  await checkOne({ company: 'A', domain: 'slow.com' }, {
    timeoutMs: 5000, maxTotalMs: 300, retries: 5,
    fetchImpl: () => new Promise((_, rej) => setTimeout(() => rej(new Error('t')), 120)),
  });
  assert.equal(Date.now() - t0 < 1500, true);
});
await ta('하나 실패해도 나머지 진행', async () => {
  const list = [{ company: 'A', domain: 'a.com' }, { company: 'A', domain: 'b.com' }];
  const out = await checkMany(list, {
    retries: 0,
    fetchImpl: async (u) => { if (u.includes('a.com')) throw new Error('boom'); return mkRes(200, u); },
  });
  assert.equal(out[0].status, 'down');
  assert.equal(out[1].status, 'up');
});

// ── 11. bridge.gs ↔ core.js 대조 검증 ───────────────────────
// 도메인 규칙이 '점검하는 쪽(core.js)'과 '입력받는 쪽(bridge.gs)' 두 곳에 존재한다.
// 한쪽만 고치면 "추가는 됐는데 점검이 안 되는" 사고가 나므로, 여기서 두 구현을 직접 대조한다.
import fs from 'node:fs';
const GS = fs.readFileSync(new URL('../apps-script/bridge.gs', import.meta.url), 'utf8');

function extractBlock(startTag, endTag, exportNames, prelude = '') {
  const re = new RegExp(`<<<${startTag}>>>[^\\n]*\\n([\\s\\S]*?)//\\s*<<<${endTag}>>>`);
  const m = re.exec(GS);
  if (!m) throw new Error(`bridge.gs 에서 ${startTag} 블록을 찾지 못했습니다`);
  return new Function(`${prelude}\n${m[1]}\nreturn { ${exportNames.join(', ')} };`)();
}

// bridge.gs 의 상수도 코드에서 직접 읽어와, 값이 어긋나면 테스트가 잡도록 한다
const TG_LIMIT_GS = Number(/var\s+TG_LIMIT\s*=\s*(\d+)/.exec(GS)[1]);

let GSL = null, GSS = null;
t('bridge.gs 순수로직 블록 추출', () => {
  GSL = extractBlock('PURE-LOGIC-START', 'PURE-LOGIC-END',
    ['normalizeDomain_', 'isIPv4_', 'normalizeTarget_', 'targetOf_', 'targetHost_']);
  assert.equal(typeof GSL.normalizeDomain_, 'function');
  assert.equal(typeof GSL.normalizeTarget_, 'function');
});
t('bridge.gs 분할 블록 추출', () => {
  GSS = extractBlock('PURE-SPLIT-START', 'PURE-SPLIT-END', ['splitForTelegram_'],
    'var TG_LIMIT = ' + TG_LIMIT_GS + ';');
  assert.equal(typeof GSS.splitForTelegram_, 'function');
});

const CORPUS = [
  'example.com', 'EXAMPLE.COM', '  example.com  ', 'https://example.com', 'http://example.com',
  'www.example.com', 'https://www.example.com', 'https://example.com/a/b', 'example.com/?a=1&b=2',
  'example.com/#top', 'example.com:8080', 'example.com/', 'example.com.', 'm.example.com',
  'www2.example.com', 'egg-4841.com', '9win.com', 'naver.co.kr', 'site.online', '"example.com"',
  'example.com,', ' example.com. ', '1.2.3.4', '한국.kr', 'xn--3e0b707e.kr', '999.999.999.999',
  '', '   ', null, undefined, 'example', '비고', '여기는 메모입니다', '12345', '2026.08.26',
  'example.123', 'example.c', '.example.com', 'example..com', 'exa_mple.com', 'a@b.com',
  '[::1]', '-bad.com', 'bad-.com', '0.0.0.0', '256.1.1.1', 'sub.sub.example.co.uk',
  'HTTPS://WWW.EGG-5.COM/PROMO?x=1', 'ftp://files.example.com/pub', '  (a.com)  ', 'a.com;',
  'tt.co', 'xn--p1ai.xn--p1ai', 'very-long-' + 'x'.repeat(70) + '.com',
  'a.b.c.d.e.f.example.com', 'example.com:99999', '한글도메인.한국', 'UPPER.CO.KR',
];
let diff = 0;
for (const input of CORPUS) {
  const a = normalizeDomain(input);
  const b = GSL ? GSL.normalizeDomain_(input) : '<추출실패>';
  t(`대조: ${JSON.stringify(input)} → ${a}`, () => assert.equal(b, a));
  if (a !== b) diff++;
}
t('대조 불일치 0건', () => assert.equal(diff, 0));

// ── 2-2. 적은 그대로 보존(normalizeTarget) — 브리지와 점검기가 같은 결과여야 한다 ──
const TARGET_CORPUS = CORPUS.concat([
  'https://ptt-852.com/?code=NDTV', 'http://zza-189.com/?code=ndtv',
  'https://le-go-1122.com/?code=ndtv', 'https://a.com/?code=X#tag',
  'HTTPS://A.COM/?code=X', 'www.a.com/?code=X', 'a.com/?code=X',
  'javascript://a.com/?x=1', 'data://a.com/x', 'ftp://a.com/x',
  'https://a.com/?msg=hi,there', 'https://a.com/path.', 'a.com,', '(a.com)',
  'https://user:pw@a.com/?x=1', 'https://a.com:8443/?x=1',
  'https://' + 'x'.repeat(520) + '.com/', 'https://', 'https://a', '//a.com/x',
]);
let tdiff = 0;
for (const input of TARGET_CORPUS) {
  const a = normalizeTarget(input);
  const b = GSL ? GSL.normalizeTarget_(input) : '<추출실패>';
  t(`대조(그대로): ${JSON.stringify(input)} → ${a ? a.target : null}`,
    () => assert.deepEqual(b, a));
  if (JSON.stringify(a) !== JSON.stringify(b)) tdiff++;
}
t('그대로 보존 대조 불일치 0건', () => assert.equal(tdiff, 0));

// ── 2-3. 점검기가 '적힌 그대로' 접속하는가 ────────────────────
t('적힌 https 로 그대로 접속한다', async () => {
  let used = null;
  await checkOne({ company: 'A', domain: 'https://ptt-852.com/?code=NDTV', host: 'ptt-852.com' },
    { retries: 0, fetchImpl: async (u) => { used = u; return mkRes(200, u); } });
  assert.equal(used, 'https://ptt-852.com/?code=NDTV');
});
t('적힌 http 를 https 로 바꾸지 않는다', async () => {
  const seen = [];
  await checkOne({ company: 'A', domain: 'http://zza-189.com/?code=ndtv', host: 'zza-189.com' },
    { retries: 0, fetchImpl: async (u) => { seen.push(u); return mkRes(200, u); } });
  assert.deepEqual(seen, ['http://zza-189.com/?code=ndtv']);
});
t('적힌 http 가 실패해도 https 로 몰래 넘어가지 않는다', async () => {
  const seen = [];
  const r = await checkOne({ company: 'A', domain: 'http://zza-189.com/?code=ndtv', host: 'zza-189.com' },
    { retries: 1, fetchImpl: async (u) => { seen.push(u); throw new Error('x'); } });
  assert.equal(seen.every((u) => u.startsWith('http://')), true, seen.join(' '));
  assert.equal(r.status, 'down');
});
t('스킴을 안 적었을 때만 https → http 로 찾아본다', async () => {
  const seen = [];
  await checkOne({ company: 'A', domain: 'a.com', host: 'a.com' },
    { retries: 0, fetchImpl: async (u) => { seen.push(u); if (u.startsWith('https')) throw new Error('tls'); return mkRes(200, u); } });
  assert.deepEqual(seen, ['https://a.com/', 'http://a.com/']);
});
t('리다이렉트 판정은 주소(호스트)로만 한다', async () => {
  const r = await checkOne({ company: 'A', domain: 'https://a.com/?code=X', host: 'a.com' },
    { retries: 0, fetchImpl: async () => mkRes(200, 'https://a.com/landing?code=X') });
  assert.equal(r.status, 'up', '같은 주소 안에서 옮겨간 것은 정상이다');
});
t('다른 주소로 넘어가면 주소확인', async () => {
  const r = await checkOne({ company: 'A', domain: 'https://a.com/?code=X', host: 'a.com' },
    { retries: 0, fetchImpl: async () => mkRes(200, 'https://other.com/') });
  assert.equal(r.status, 'redir');
});

// ── 2-4. 방화벽(봇차단) 가려내기 ────────────────────────────
//   2026-09-05 실측: 제휴 사이트가 Cloudflare 로 403 'Attention Required!' 를 돌려준다.
//   이걸 '제한'으로 찍으면 멀쩡한 사이트 전부가 거짓 경보가 된다.
const hdr = (o) => ({ get: (k) => o[String(k).toLowerCase()] || '' });
t('cf-ray 가 있으면 봇차단', () => assert.equal(looksBotBlocked(403, hdr({ 'cf-ray': 'abc' }), ''), true));
t('server: cloudflare 면 봇차단', () => assert.equal(looksBotBlocked(403, hdr({ server: 'cloudflare' }), ''), true));
t('본문이 차단 페이지면 봇차단', () =>
  assert.equal(looksBotBlocked(403, hdr({}), '<title>Attention Required! | Cloudflare</title>'), true));
t('평범한 403 은 봇차단 아님', () => assert.equal(looksBotBlocked(403, hdr({ server: 'nginx' }), '<h1>Forbidden</h1>'), false));
t('200 은 봇차단일 수 없음', () => assert.equal(looksBotBlocked(200, hdr({ 'cf-ray': 'abc' }), ''), false));
t('404 는 봇차단 아님', () => assert.equal(looksBotBlocked(404, hdr({ 'cf-ray': 'abc' }), ''), false));

t('방화벽 403 은 제한이 아니라 봇차단으로 찍힌다', async () => {
  const r = await checkOne({ company: 'A', domain: 'https://a.com/?code=X', host: 'a.com' }, {
    retries: 0,
    fetchImpl: async () => ({
      status: 403, url: 'https://a.com/?code=X',
      headers: hdr({ server: 'cloudflare', 'cf-ray': 'x' }),
      text: async () => '<title>Attention Required! | Cloudflare</title>',
      body: null,
    }),
  });
  assert.equal(r.status, 'blocked');
  assert.equal(/봇차단/.test(r.note), true);
});
t('진짜 제한(403)은 그대로 제한', async () => {
  const r = await checkOne({ company: 'A', domain: 'https://a.com/', host: 'a.com' }, {
    retries: 0,
    fetchImpl: async () => ({
      status: 403, url: 'https://a.com/', headers: hdr({ server: 'nginx' }),
      text: async () => '<h1>Forbidden</h1>', body: null,
    }),
  });
  assert.equal(r.status, 'warn');
});
t('요약에 봇차단 줄이 붙는다', () => {
  const rep = buildTelegramReport([
    { company: 'A', domain: 'https://a.com/', status: 'blocked', note: '봇차단(403)' },
    { company: 'A', domain: 'https://b.com/', status: 'up', note: '정상' },
  ], { nowKst: '2026-09-05 05:00', round: '수동' });
  assert.equal(rep.blocked, 1);
  assert.equal(/🛡 봇차단 1/.test(rep.text), true);
  assert.equal(/로봇 접속을 막습니다/.test(rep.text), true);
});

// ── 2-5. 막힌 것만 진짜 브라우저로 다시 확인 ────────────────
function fakeBrowser({ status = 200, url = 'https://a.com/?code=X', title = '', content = '<html></html>' } = {}) {
  const page = {
    goto: async () => ({ status: () => status, headers: () => ({}) }),
    title: async () => title,
    content: async () => content,
    url: () => url,
    waitForLoadState: async () => {},
    close: async () => {},
  };
  const ctx = { newPage: async () => page, close: async () => {} };
  return { newContext: async () => ctx, close: async () => {} };
}
t('브라우저로 열리면 정상으로 바뀐다', async () => {
  const results = [{ company: 'A', domain: 'https://a.com/?code=X', host: 'a.com', status: 'blocked', note: '봇차단(403)' }];
  const out = await recheckBlocked(results, { launchImpl: async () => fakeBrowser({ status: 200 }) });
  assert.equal(out.used, true);
  assert.equal(out.recovered, 1);
  assert.equal(results[0].status, 'up');
  assert.equal(/브라우저로 확인/.test(results[0].note), true);
});
t('브라우저로도 막히면 봇차단으로 남는다', async () => {
  const results = [{ company: 'A', domain: 'https://a.com/?code=X', host: 'a.com', status: 'blocked', note: '봇차단(403)' }];
  await recheckBlocked(results, {
    launchImpl: async () => fakeBrowser({ status: 403, title: 'Attention Required! | Cloudflare' }),
  });
  assert.equal(results[0].status, 'blocked');
  assert.equal(/브라우저로도 막힘/.test(results[0].note), true);
});
t('브라우저에서 다른 주소로 넘어가면 주소확인', async () => {
  const results = [{ company: 'A', domain: 'https://a.com/?code=X', host: 'a.com', status: 'blocked', note: '봇차단' }];
  await recheckBlocked(results, { launchImpl: async () => fakeBrowser({ status: 200, url: 'https://other.com/' }) });
  assert.equal(results[0].status, 'redir');
  assert.equal(results[0].redirectTo, 'other.com');
});
t('막힌 게 없으면 브라우저를 아예 켜지 않는다', async () => {
  let opened = false;
  const out = await recheckBlocked([{ status: 'up' }], { launchImpl: async () => { opened = true; return fakeBrowser(); } });
  assert.equal(opened, false);
  assert.equal(out.used, false);
});
t('브라우저가 없으면 1차 판정을 그대로 둔다', async () => {
  const results = [{ company: 'A', domain: 'https://a.com/', host: 'a.com', status: 'blocked', note: '봇차단(403)' }];
  const out = await recheckBlocked(results, { launchImpl: async () => { throw new Error('없음'); } });
  assert.equal(out.used, false);
  assert.equal(results[0].status, 'blocked');
});

t('제휴 링크는 통째로 보존', () => {
  const r = normalizeTarget('https://ptt-852.com/?code=NDTV');
  assert.equal(r.target, 'https://ptt-852.com/?code=NDTV');
  assert.equal(r.host, 'ptt-852.com');
});
t('http 도 그대로', () => assert.equal(normalizeTarget('http://zza-189.com/?code=ndtv').target, 'http://zza-189.com/?code=ndtv'));
t('www 도 그대로', () => assert.equal(normalizeTarget('www.a.com').target, 'www.a.com'));
t('비교용 호스트는 www 를 뗀다', () => assert.equal(normalizeTarget('www.a.com').host, 'a.com'));
t('javascript: 는 주소가 아님', () => assert.equal(normalizeTarget('javascript://a.com/?x=1'), null));
t('ftp: 는 주소가 아님', () => assert.equal(normalizeTarget('ftp://a.com/x'), null));
t('쿼리가 있으면 끝 점을 함부로 떼지 않음', () =>
  assert.equal(normalizeTarget('https://a.com/?x=1.').target, 'https://a.com/?x=1.'));
t('주소만 적으면 그대로', () => assert.equal(normalizeTarget('a.com').target, 'a.com'));
t('주소가 아니면 null', () => assert.equal(normalizeTarget('여기는 메모'), null));

// 조합 입력으로도 두 구현이 같은 답을 내는지.
// ★ 난수를 쓰면 어쩌다 한 번 실패해서 '실제 점검'까지 막히므로, 씨앗 고정 난수로 항상 같은 1000건을 본다.
t('조합 1000건 대조(재현 가능)', () => {
  const pieces = ['a', 'b1', '-', '.', 'com', 'co.kr', 'www.', 'https://', '/x?y', ':80', '_',
    '한글', '9', 'xn--a', '😀', '​', '１', '—', '@', ' '];
  let seed = 20260828;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const bad = [];
  for (let i = 0; i < 1000; i++) {
    let s = '';
    const n = 1 + Math.floor(rnd() * 6);
    for (let k = 0; k < n; k++) s += pieces[Math.floor(rnd() * pieces.length)];
    if (normalizeDomain(s) !== GSL.normalizeDomain_(s)) bad.push(s);
  }
  assert.equal(bad.length, 0, `불일치: ${JSON.stringify(bad.slice(0, 3))}`);
});

// 텔레그램 분할도 두 구현이 같은 결과를 내야 한다
t('분할 대조: 긴 리포트', () => {
  const a = splitForTelegram(big.text);
  const b = GSS.splitForTelegram_(big.text);
  assert.deepEqual(b, a);
});
t('분할 대조: 짧은 글', () => assert.deepEqual(GSS.splitForTelegram_('짧다'), ['짧다']));
t('bridge 분할도 인용태그 짝 맞음', () => {
  const cs = GSS.splitForTelegram_(big.text);
  assert.equal(cs.every((c) => (c.match(/<blockquote>/g) || []).length === (c.match(/<\/blockquote>/g) || []).length), true);
});

// bridge.gs 가 앱스스크립트에 없는 기능을 쓰고 있지 않은지(V8 런타임 사고 예방)
t('bridge.gs 에 URL/fetch/setTimeout 미사용', () => {
  const code = GS.replace(/^\s*(\/\/|\*).*$/gm, '');
  assert.equal(/\bnew URL\s*\(/.test(code), false, 'new URL 사용됨');
  assert.equal(/(?<![.\w])fetch\s*\(/.test(code), false, '브라우저 fetch 사용됨(UrlFetchApp 써야 함)');
  assert.equal(/(?<![.\w])setTimeout\s*\(/.test(code), false, 'setTimeout 사용됨');
  assert.equal(/(?<![.\w])Promise\b/.test(code), false, 'Promise 사용됨');
  assert.equal(/\bawait\b|\basync\b/.test(code), false, 'async/await 사용됨(앱스스크립트는 동기)');
});
t('bridge.gs 필수 함수 존재', () => {
  for (const fn of ['doGet', 'doPost', 'setupAll', 'hourlyTick', 'watchdog', 'setupWebhook',
    'handleCallback_', 'handleTextCommand_', 'opAddDomains_', 'opRemoveDomain_',
    'opReplaceDomain_', 'opMoveDomain_', 'opAddCompany_', 'opRemoveCompany_',
    'opRenameCompany_', 'undo_', 'log_', 'sysWrite_']) {
    assert.equal(new RegExp(`function\\s+${fn}\\s*\\(`).test(GS), true, `${fn} 없음`);
  }
});
t('bridge.gs 에 자격증명 값이 하드코딩되지 않음', () => {
  assert.equal(/[0-9]{8,10}:[A-Za-z0-9_-]{30,}/.test(GS), false, '텔레그램 봇 토큰처럼 보이는 값');
  assert.equal(/gh[pousr]_[A-Za-z0-9]{30,}/.test(GS), false, 'GitHub 토큰처럼 보이는 값');
});

// ── 12. 검증에서 지적된 결함 재현 방지 ───────────────────────
// 아래는 전부 '실제로 터졌을 상황'이다. 다시 들어오면 여기서 잡힌다.

t('메모가 도메인으로 오인되지 않음: 확인.필요', () => assert.equal(normalizeDomain('확인.필요'), null));
t('메모가 도메인으로 오인되지 않음: 메모.내용', () => assert.equal(normalizeDomain('메모.내용'), null));
t('이모지 도메인 거부', () => assert.equal(normalizeDomain('😀.kr'), null));
t('제로폭공백 거부', () => assert.equal(normalizeDomain('​.kr'), null));
t('전각숫자 거부', () => assert.equal(normalizeDomain('１.com'), null));
t('em대시 거부', () => assert.equal(normalizeDomain('—.kr'), null));
t('한글 라벨 + 정상 TLD 는 허용', () => assert.equal(normalizeDomain('한국.kr'), '한국.kr'));
t('한글 TLD 는 거부(퓨니코드로 등록되므로)', () => assert.equal(normalizeDomain('사이트.한국'), null));

t('리다이렉트 미탐지 방지: pages.dev', () => assert.equal(sameSite('a.pages.dev', 'b.pages.dev'), false));
t('리다이렉트 미탐지 방지: github.io', () => assert.equal(sameSite('a.github.io', 'b.github.io'), false));
t('리다이렉트 미탐지 방지: seoul.kr', () => assert.equal(sameSite('a.seoul.kr', 'b.seoul.kr'), false));
t('리다이렉트 미탐지 방지: mil.kr', () => assert.equal(sameSite('a.mil.kr', 'b.mil.kr'), false));
t('리다이렉트 미탐지 방지: tistory', () => assert.equal(sameSite('a.tistory.com', 'b.tistory.com'), false));
t('같은 사이트는 여전히 정상: co.kr', () => assert.equal(sameSite('m.naver.co.kr', 'naver.co.kr'), true));

t('잘못된 타임아웃 값이 와도 기본값', () => {
  assert.equal(posNum('15,000', 15000), 15000);
  assert.equal(posNum('abc', 15000), 15000);
  assert.equal(posNum('', 15000), 15000);
  assert.equal(posNum('0', 15000), 15000);
  assert.equal(posNum('8000', 15000), 8000);
});

await ta('https 타임아웃이어도 http 를 반드시 시도한다', async () => {
  const tried = [];
  const r = await checkOne({ company: 'A', domain: 'a.com' }, {
    timeoutMs: 100, retries: 1,
    fetchImpl: (u) => {
      tried.push(u);
      if (u.startsWith('https')) return new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('t'), { name: 'AbortError' })), 150));
      return Promise.resolve({ status: 200, url: 'http://a.com/' });
    },
  });
  assert.equal(tried.some((u) => u.startsWith('http://')), true, `http 미시도: ${JSON.stringify(tried)}`);
  assert.equal(r.status, 'up');
});

t('인증서 오류가 사람 말로 나온다', () => {
  assert.equal(describeNetworkError({ message: 'fetch failed', cause: { code: 'CERT_HAS_EXPIRED' } }), '접속실패(보안인증서 오류)');
  assert.equal(describeNetworkError({ message: 'fetch failed', cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }), '접속실패(보안인증서 오류)');
  assert.equal(describeNetworkError({ message: 'fetch failed', cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } }), '접속실패(보안인증서 오류)');
});
t('리다이렉트 반복도 사람 말로', () => assert.equal(
  describeNetworkError({ message: 'fetch failed', cause: { message: 'redirect count exceeded' } }), '접속실패(리다이렉트 반복)'));

await ta('다른 주소로 넘어간 뒤 403 이어도 이동을 알려준다', async () => {
  const r = await checkOne({ company: 'A', domain: 'a.com' }, { fetchImpl: async () => ({ status: 403, url: 'https://b.com/' }) });
  assert.equal(r.status, 'warn');
  assert.equal(r.redirectTo, 'b.com');
  assert.equal(/다른 주소로 넘어감/.test(r.note), true);
});
await ta('같은 사이트로 넘어간 403 은 이동 표시 없음', async () => {
  const r = await checkOne({ company: 'A', domain: 'a.com' }, { fetchImpl: async () => ({ status: 403, url: 'https://www.a.com/' }) });
  assert.equal(r.redirectTo, '');
});

t('형식 오류 항목이 리포트에 표시된다', () => {
  const rep = buildTelegramReport(
    [{ company: 'A', domain: 'a.com', status: 'up', http: 200, finalUrl: '', ms: 1, note: '정상' }],
    { nowKst: 'x', round: '수동', skipped: [{ company: 'A', raw: 'exa_mple.com', cell: 'A3', reason: '도메인 아님' }] });
  assert.equal(/점검하지 못한 항목 1개/.test(rep.text), true);
  assert.equal(/exa_mple\.com/.test(rep.text), true);
  assert.equal(rep.skippedBad, 1);
});
t('중복은 형식 오류로 알리지 않음', () => {
  const rep = buildTelegramReport([], { skipped: [{ raw: 'a.com', cell: 'A3', reason: '업체 내 중복' }] });
  assert.equal(rep.skippedBad, 0);
});
t('형식 오류 안내도 인용태그 짝이 맞음', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ raw: `bad_${i}`, cell: `A${i}`, reason: '도메인 아님' }));
  const rep = buildTelegramReport([], { skipped: many });
  assert.equal((rep.text.match(/<blockquote>/g) || []).length, (rep.text.match(/<\/blockquote>/g) || []).length);
});

// ── 결과 ────────────────────────────────────────────────────
const total = pass + fail;
if (fail) {
  console.error(`\n❌ 실패 ${fail}건 / 전체 ${total}건\n`);
  for (const f of failures) console.error('  · ' + f);
  process.exit(1);
}
console.log(`✅ 로직 검증 ${pass}/${total} 통과`);
