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
  const started = Date.now();
  // 도메인 하나가 붙잡을 수 있는 전체 시간 상한(재시도까지 합쳐서)
  const deadline = started + posNum(opts.maxTotalMs, timeoutMs * 2);

  // 순서가 중요하다: https → http → https 재시도.
  // https 를 두 번 먼저 하면 시간 상한에 걸려 http 를 아예 못 해본다(=http 전용 사이트를 놓친다).
  const attempts = [`https://${domain}/`, `http://${domain}/`];
  for (let i = 0; i < retries; i++) attempts.push(`https://${domain}/`);
  let lastErr = null;

  for (const url of attempts) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;                          // 전체 시간 초과 → 더 시도하지 않음
    try {
      const res = await fetchOnce(url, { timeoutMs: Math.min(timeoutMs, remaining), fetchImpl });
      const ms = Date.now() - started;
      const finalUrl = res.url || url;
      const judged = judgeStatus(res.status);
      // 본문은 안 쓰므로 즉시 버린다(소켓 반환 — 도메인이 많을 때 연결이 쌓이는 것 방지)
      try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch { /* ignore */ }

      const finalHost = hostOf(finalUrl);
      const movedTo = (finalHost && !sameSite(finalHost, domain)) ? finalHost : '';

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
