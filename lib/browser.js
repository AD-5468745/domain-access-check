// 막힌 주소만 '진짜 브라우저'로 다시 확인한다 (2026-09-05 에이든 지시)
//
// ★ 왜 필요한가
//   제휴 사이트 상당수가 Cloudflare 방화벽으로 '사람 브라우저가 아닌 접속'을 막는다.
//   프로그램이 보내는 요청은 헤더를 아무리 브라우저처럼 꾸며도 TLS 지문·봇 점수로 걸러져
//   403 'Attention Required!' 를 받는다. 사이트는 멀쩡한데 전부 ⚠️ 로 찍히는 거짓 경보가 된다.
//   → 1차(빠른 방식)에서 '봇차단'으로 걸린 것만 진짜 크롬으로 다시 열어 사실을 확인한다.
//
// ★ 의존성은 선택이다
//   playwright 가 없으면 아무 일도 하지 않고 null 을 돌려준다(1차 판정이 그대로 남는다).
//   그래서 npm test 는 여전히 외부 의존성 0으로 돌아간다.
import { sameSite } from './core.js';
import { judgeStatus, looksBotBlocked, posNum } from './probe.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CHALLENGE_TITLE = /just a moment|attention required|잠시만 기다|checking your browser|please wait/i;

/** playwright 가 설치돼 있으면 chromium 을 띄운다. 없으면 null. */
export async function openBrowser(launchImpl) {
  try {
    const launch = launchImpl || (await import('playwright')).chromium.launch;
    const browser = await launch({
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',   // '자동화 중'이라는 표식을 지운다
        '--disable-dev-shm-usage',
      ],
    });
    return browser;
  } catch {
    return null;                       // 설치 안 됨 · 실행 불가 → 조용히 포기
  }
}

/** 브라우저 창 하나 만들기 — 한국 사람이 쓰는 크롬처럼 보이게 */
export async function newKoreanContext(browser) {
  return browser.newContext({
    userAgent: UA,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7' },
  });
}

/**
 * 주소 하나를 진짜 브라우저로 연다.
 * → { status, http, finalUrl, note, redirectTo } 또는 null(브라우저로도 판단 못 함)
 */
export async function recheckOne(ctx, entry, opts = {}) {
  const timeoutMs = posNum(opts.timeoutMs, 30000);
  const target = entry.domain;
  const host = entry.host || '';
  const page = await ctx.newPage();
  try {
    const res = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    // Cloudflare 의 '잠시만 기다려주세요' 화면이면 통과할 시간을 준다
    let title = '';
    try { title = await page.title(); } catch { title = ''; }
    if (CHALLENGE_TITLE.test(title)) {
      try { await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 15000) }); } catch { /* 그대로 진행 */ }
      try { title = await page.title(); } catch { /* 그대로 */ }
    }

    const http = res ? res.status() : null;
    const finalUrl = page.url() || target;
    let body = '';
    try { body = (await page.content()).slice(0, 4000); } catch { body = ''; }

    // 브라우저로도 막혔나
    const headers = res ? res.headers() : {};
    const fakeHeaders = { get: (k) => headers[String(k).toLowerCase()] || '' };
    if (http && looksBotBlocked(http, fakeHeaders, body + ' ' + title)) {
      return {
        status: 'blocked', http, finalUrl, redirectTo: '',
        note: `봇차단(${http}) — 서버까지 도달 확인(브라우저로도 방화벽 화면)`,
      };
    }

    const finalHost = hostOfUrl(finalUrl);
    const movedTo = (finalHost && host && !sameSite(finalHost, host)) ? finalHost : '';
    const judged = judgeStatus(http === null ? 200 : http);

    if (judged.status === 'up' && movedTo) {
      return { status: 'redir', http, finalUrl, redirectTo: movedTo, note: '주소확인(리다이렉트 감지) · 브라우저로 확인' };
    }
    return {
      status: judged.status, http, finalUrl, redirectTo: movedTo,
      note: judged.note + ' · 브라우저로 확인' + (movedTo ? ' · 다른 주소로 넘어감' : ''),
    };
  } catch {
    return null;                       // 브라우저로도 못 열었다 → 1차 판정을 그대로 둔다
  } finally {
    try { await page.close(); } catch { /* ignore */ }
  }
}

function hostOfUrl(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

/**
 * 1차에서 '봇차단'으로 걸린 것만 골라 브라우저로 다시 확인하고 결과를 덮어쓴다.
 * 브라우저를 못 쓰면 results 를 그대로 돌려준다.
 */
export async function recheckBlocked(results, opts = {}) {
  const list = (results || []).filter((r) => r && r.status === 'blocked');
  if (!list.length) return { results, used: false, rechecked: 0, recovered: 0 };

  const browser = await openBrowser(opts.launchImpl);
  if (!browser) return { results, used: false, rechecked: 0, recovered: 0 };

  let recovered = 0;
  try {
    const ctx = await newKoreanContext(browser);
    for (const r of list) {
      const got = await recheckOne(ctx, r, opts);
      if (!got) continue;
      if (got.status !== 'blocked') recovered++;
      Object.assign(r, got);
    }
    try { await ctx.close(); } catch { /* ignore */ }
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
  }
  return { results, used: true, rechecked: list.length, recovered };
}
