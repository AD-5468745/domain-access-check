// 실제 접속 점검 — Node 20 내장 fetch만 사용(외부 의존성 0)
// 판정: ✅정상 / ⚠️제한(403·429·503) / ❌이상(타임아웃·DNS·차단·404 등) / 🔀주소확인(다른 도메인으로 리다이렉트)
import { sameSite } from './core.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const LIMITED = new Set([403, 429, 503]);

/** 네트워크 오류 → 사람이 읽는 이유
 *  ※ Node fetch 는 err.message 가 항상 'fetch failed' 라서, 진짜 원인은 err.cause 에 들어 있다.
 *    cause 를 안 보면 인증서 만료 같은 흔한 사고가 전부 '알수없음'으로 나온다. */
export function describeNetworkError(err) {
  const name = err?.name || '';
  const cause = err?.cause || {};
  const code = cause.code || err?.code || '';
  const msg = String(cause.message || err?.message || '');
  const both = `${code} ${msg}`;

  if (name === 'AbortError' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_CONNECT_TIMEOUT'
    || code === 'ETIMEDOUT' || /timeout/i.test(both)) return '접속실패(타임아웃)';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '접속실패(주소를 찾을 수 없음)';
  if (code === 'ECONNREFUSED') return '접속실패(연결 거부)';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'EPIPE') return '접속실패(연결 끊김)';
  if (code === 'ERR_TOO_MANY_REDIRECTS' || /redirect count/i.test(both)) return '접속실패(리다이렉트 반복)';
  if (/^CERT_|^DEPTH_ZERO|^SELF_SIGNED|^UNABLE_TO_(VERIFY|GET)|^ERR_TLS|^ERR_SSL|^EPROTO$/.test(code)
    || /certificate|self.signed|SSL|TLS|알수없는 인증/i.test(both)) return '접속실패(보안인증서 오류)';
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return '접속실패(경로 없음)';
  if (code === 'ERR_INVALID_URL') return '접속실패(주소 형식 오류)';
  return `접속실패(${code || msg.slice(0, 60) || '알수없음'})`;
}

/**
 * '사람 브라우저가 아니면 막는' 방화벽에 걸린 응답인가.
 * ★ 2026-09-05 실측: 제휴 사이트들이 Cloudflare 로 403 'Attention Required!' 를 돌려준다.
 *   브라우저와 똑같은 헤더를 다 붙여도 막힌다(TLS 지문·봇 점수로 거른다).
 *   이걸 '제한'으로 찍으면 멀쩡한 사이트가 전부 경보가 되므로 따로 가른다.
 */
/**
 * ★ 한국에서 '진짜로 차단된' 신호.
 *   방송통신심의위원회 차단은 warning.or.kr 안내 페이지로 넘기거나 연결을 끊는다.
 *   이건 사이트 방화벽(봇차단)과 정반대의 사건이므로 절대 섞으면 안 된다(2026-09-05).
 */
const KOREA_BLOCK_HOST = /(^|\.)warning\.or\.kr$/i;
const KOREA_BLOCK_TEXT = /warning\.or\.kr|불법[·・ ]?유해정보|불법유해정보 차단|방송통신심의위원회/i;

export function looksKoreaBlocked(finalUrl, bodyText) {
  let host = '';
  try { host = new URL(String(finalUrl)).hostname; } catch { host = ''; }
  if (host && KOREA_BLOCK_HOST.test(host)) return true;
  return KOREA_BLOCK_TEXT.test(String(bodyText || ''));
}

const BOT_BLOCK_STATUS = new Set([403, 429, 503]);
const BOT_BLOCK_TEXT = /attention required|just a moment|checking your browser|cf-error|cloudflare|access denied|incapsula|perimeterx|datadome|akamai/i;

export function looksBotBlocked(httpStatus, headers, bodyText) {
  if (!BOT_BLOCK_STATUS.has(httpStatus)) return false;
  const get = (k) => {
    try { return String((headers && headers.get && headers.get(k)) || ''); } catch { return ''; }
  };
  if (get('cf-ray')) return true;
  const server = get('server').toLowerCase();
  if (server.includes('cloudflare') || server.includes('akamai')) return true;
  if (get('x-iinfo') || get('x-datadome')) return true;
  return BOT_BLOCK_TEXT.test(String(bodyText || ''));
}

/** HTTP 응답 코드 → 판정 */
export function judgeStatus(httpStatus) {
  if (LIMITED.has(httpStatus)) return { status: 'warn', note: `제한응답(${httpStatus})` };
  if (httpStatus === 451) return { status: 'down', note: '차단(451 법적 차단)' };
  if (httpStatus === 404) return { status: 'down', note: '접속실패(404 없는 페이지)' };
  if (httpStatus >= 500) return { status: 'down', note: `접속실패(서버오류 ${httpStatus})` };
  if (httpStatus >= 400) return { status: 'down', note: `접속실패(HTTP ${httpStatus})` };
  return { status: 'up', note: '정상' };
}

/** 숫자가 아니거나 0 이하면 기본값 — 환경변수 오타로 전 도메인이 '이상'으로 찍히는 사고 방지 */
export function posNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

async function fetchOnce(url, { timeoutMs, fetchImpl }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 도메인 하나 점검.
 * → { company, domain, status, http, finalUrl, ms, note, redirectTo }
 */
export async function checkOne(entry, opts = {}) {
  const timeoutMs = posNum(opts.timeoutMs, 15000);      // 잘못된 값이 와도 기본값으로 (NaN 방지)
  const { fetchImpl = globalThis.fetch, retries = 1 } = opts;
  const domain = typeof entry === 'string' ? entry : entry.domain;
  const company = typeof entry === 'string' ? '' : (entry.company || '');
  // 비교·리다이렉트 판정에 쓸 주소(호스트) 부분. 없으면 적힌 것에서 뽑는다.
  const entryHost = (typeof entry === 'object' && entry && entry.host) ? entry.host : hostOf(
    /^https?:\/\//i.test(String(domain)) ? String(domain) : 'https://' + String(domain));
  const started = Date.now();
  // 도메인 하나가 붙잡을 수 있는 전체 시간 상한(재시도까지 합쳐서)
  const deadline = started + posNum(opts.maxTotalMs, timeoutMs * 2);

  // ★ 담당자가 적은 그대로 접속한다(2026-09-05 에이든 지시).
  //   http:// 라고 적었으면 http 로만, https:// 라고 적었으면 https 로만 —
  //   스킴을 몰래 바꾸면 '내가 넣은 주소'를 점검한 게 아니다. 경로·?code= 도 그대로 붙인다.
  //   스킴을 안 적었을 때만 예전처럼 https → http 순으로 찾아본다.
  const written = String(domain);
  const schemeM = /^(https?):\/\//i.exec(written);
  const bare = schemeM ? written.slice(schemeM[0].length) : written;
  const tail = /[/?#]/.test(bare) ? '' : '/';       // 경로가 없을 때만 끝에 / 를 붙인다
  const attempts = schemeM
    ? [`${schemeM[1].toLowerCase()}://${bare}${tail}`]
    : [`https://${bare}${tail}`, `http://${bare}${tail}`];
  const first = attempts[0];
  for (let i = 0; i < retries; i++) attempts.push(first);   // 재시도는 '같은 주소'로만
  let lastErr = null;

  for (const url of attempts) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;                          // 전체 시간 초과 → 더 시도하지 않음
    try {
      const res = await fetchOnce(url, { timeoutMs: Math.min(timeoutMs, remaining), fetchImpl });
      const ms = Date.now() - started;
      const finalUrl = res.url || url;
      const judged = judgeStatus(res.status);
      // 막힌 응답일 때만 본문 앞부분을 읽는다 — 방화벽 차단 페이지인지 가리기 위해서다.
      let peek = '';
      if (BOT_BLOCK_STATUS.has(res.status)) {
        try { peek = (await res.text()).slice(0, 4000); } catch { peek = ''; }
      } else {
        // 본문은 안 쓰므로 즉시 버린다(소켓 반환 — 도메인이 많을 때 연결이 쌓이는 것 방지)
        try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch { /* ignore */ }
      }
      // 한국 심의 차단이 최우선 — 이것만이 '한국에서 안 열린다'는 진짜 신호다
      if (looksKoreaBlocked(finalUrl, peek)) {
        return {
          company, domain, status: 'down', http: res.status, finalUrl, ms,
          note: '한국에서 차단됨(심의 차단 안내 페이지)', redirectTo: hostOf(finalUrl),
        };
      }
      if (looksBotBlocked(res.status, res.headers, peek)) {
        return {
          company, domain, status: 'blocked', http: res.status, finalUrl, ms,
          note: `봇차단(${res.status}) — 서버까지 도달 확인(사이트 살아있음)`, redirectTo: '',
        };
      }

      const finalHost = hostOf(finalUrl);
      if (looksKoreaBlocked(finalUrl, '')) {
        return {
          company, domain, status: 'down', http: res.status, finalUrl, ms,
          note: '한국에서 차단됨(심의 차단 안내 페이지)', redirectTo: finalHost,
        };
      }
      const movedTo = (finalHost && entryHost && !sameSite(finalHost, entryHost)) ? finalHost : '';

      if (judged.status === 'up' && movedTo) {
        return {
          company, domain, status: 'redir', http: res.status, finalUrl, ms,
          note: '주소확인(리다이렉트 감지)', redirectTo: movedTo,
        };
      }
      // 다른 주소로 넘어간 뒤 제한·이상이 난 경우에도 '어디로 넘어갔는지'는 알려준다
      return {
        company, domain, status: judged.status, http: res.status, finalUrl, ms,
        note: judged.note + (movedTo ? ' · 다른 주소로 넘어감' : ''), redirectTo: movedTo,
      };
    } catch (e) {
      lastErr = e;                                      // 타임아웃·일시적 오류 → 다음 시도
    }
  }

  return {
    company, domain, status: 'down', http: null, finalUrl: '', ms: Date.now() - started,
    note: describeNetworkError(lastErr), redirectTo: '',
  };
}

/** 동시 실행 개수를 제한하며 전부 점검(입력 순서 유지) */
export async function checkMany(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const concurrency = Math.max(1, Math.min(50, posNum(opts.concurrency, 5)));
  const results = new Array(list.length);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= list.length) return;
      try {
        results[i] = await checkOne(list[i], opts);
      } catch (e) {
        const entry = list[i] || {};
        results[i] = {
          company: entry.company || '', domain: entry.domain || String(entry), status: 'down',
          http: null, finalUrl: '', ms: 0, note: describeNetworkError(e), redirectTo: '',
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, list.length || 1) }, worker));
  return results;
}
