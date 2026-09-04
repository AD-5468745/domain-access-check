// 접속점검 메인 — GitHub Actions(한국 IP)에서 실행
//   1) 한국 IP인지 확인(아니면 중단+경고 → 가짜 결과 방지)
//   2) 앱스스크립트 브리지로 '접속점검' A1:O 읽기 → 업체별 도메인 목록
//   3) 각 도메인 한국 IP로 접속 점검
//   4) 앱스스크립트 브리지로 '결과' 탭에 표 기록
//   5) 텔레그램으로 요약 발송
import { parseSheet, buildSheetRows, buildTelegramReport, roundLabel } from './lib/core.js';
import { checkMany, posNum } from './lib/probe.js';

// ── 설정(환경변수/시크릿) ──────────────────────────────────────
const CFG = {
  bridgeUrl: process.env.SHEET_BRIDGE_URL || '',     // 앱스스크립트 웹앱 URL
  bridgeToken: process.env.SHEET_BRIDGE_TOKEN || '', // 앱스스크립트 ACCESS_TOKEN 과 동일
  botToken: process.env.TELEGRAM_BOT_TOKEN || '',
  chatId: process.env.TELEGRAM_CHAT_ID || '',
  expectCountry: (process.env.EXPECT_COUNTRY || 'KR').toUpperCase(),
  ipCheckUrl: process.env.IP_CHECK_URL || 'https://ipinfo.io/country',
  timeoutMs: posNum(process.env.HTTP_TIMEOUT_MS, 15000),
  concurrency: posNum(process.env.CHECK_CONCURRENCY, 5),
  bridgeTimeoutMs: posNum(process.env.BRIDGE_TIMEOUT_MS, 60000),
  manual: process.env.RUN_MODE === 'manual',
};

// 비밀값이 오류 메시지를 타고 텔레그램·시트로 새어나가지 않게 가린다
function safeMsg(e) {
  let s = String((e && e.message) || e || '');
  s = s.replace(/token=[^&\s"']*/gi, 'token=***');
  if (CFG.bridgeToken) s = s.split(CFG.bridgeToken).join('***');
  if (CFG.botToken) s = s.split(CFG.botToken).join('***');
  return s.slice(0, 300);
}

// 모든 외부 호출에 시간 상한 — 안 걸어두면 앱스스크립트가 느릴 때 작업이 통째로 멈춘다
async function fetchWithTimeout(url, options = {}, timeoutMs = CFG.bridgeTimeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function assertConfig() {
  const missing = [];
  for (const k of ['bridgeUrl', 'bridgeToken', 'botToken', 'chatId']) {
    if (!CFG[k]) missing.push(k);
  }
  if (missing.length) {
    throw new Error('필수 시크릿 누락: ' + missing.join(', ') +
      ' (GitHub 저장소 Settings → Secrets 에 등록하세요)');
  }
}

function kstParts() {
  const d = new Date();
  const p = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  // hour '24' → 0 정규화
  const hour = (p.hour === '24' ? 0 : Number(p.hour));
  return { str: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`, hour };
}
function kstNow() { return kstParts().str; }

// 텔레그램 4096자 한도 → 분할.
// ★ 인용블록(<blockquote>) 중간에서 자르면 HTML이 깨져 발송 자체가 실패한다.
//    그래서 ①블록(빈 줄) 경계로 먼저 자르고 ②블록 하나가 한도를 넘을 때만
//    줄 단위로 쪼개되 조각마다 인용태그를 다시 씌운다.
function splitBlockByLines(block, limit) {
  const m = /^<blockquote>([\s\S]*)<\/blockquote>$/.exec(block);
  const body = m ? m[1] : block;
  const wrap = m ? (s) => `<blockquote>${s}</blockquote>` : (s) => s;
  const out = [];
  let buf = '';
  for (const line of body.split('\n')) {
    if (buf && wrap(buf + '\n' + line).length > limit) { out.push(wrap(buf)); buf = ''; }
    buf = buf ? buf + '\n' + line : line;
  }
  if (buf) out.push(wrap(buf));
  return out;
}

function splitForTelegram(text, limit = 3500) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let buf = '';
  const flush = () => { if (buf) { chunks.push(buf); buf = ''; } };

  for (const block of text.split('\n\n')) {
    if (block.length > limit) {
      flush();
      for (const piece of splitBlockByLines(block, limit)) chunks.push(piece);
      continue;
    }
    if (buf && (buf + '\n\n' + block).length > limit) flush();
    buf = buf ? buf + '\n\n' + block : block;
  }
  flush();
  return chunks;
}

async function sendOne(text, parseMode) {
  const url = `https://api.telegram.org/bot${CFG.botToken}/sendMessage`;
  const payload = { chat_id: CFG.chatId, text, disable_web_page_preview: true };
  if (parseMode) payload.parse_mode = parseMode;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, 30000);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[telegram] 발송 실패', res.status, body.slice(0, 300));
    // HTML 해석 실패(태그 문제)라면 서식 없이라도 반드시 전달한다 — 조용히 사라지는 게 최악
    if (parseMode && /can't parse entities|parse entities/i.test(body)) {
      const plain = text.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CFG.chatId, text: plain, disable_web_page_preview: true }),
      }, 30000).catch(() => {});
    }
    return false;
  }
  return true;
}

async function sendTelegram(text, parseMode) {
  if (!CFG.botToken || !CFG.chatId) return;
  const parts = splitForTelegram(text);
  for (let i = 0; i < parts.length; i++) {
    const prefix = parts.length > 1 ? `(${i + 1}/${parts.length})\n` : '';
    await sendOne(prefix + parts[i], parseMode);
  }
}

async function verifyKoreaIp() {
  try {
    const res = await fetchWithTimeout(CFG.ipCheckUrl, {}, 10000);
    if (!res.ok) return '';                       // 조회 서비스가 오류를 주면 '확인불가'로 처리
    const body = (await res.text()).trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(body.slice(0, 2)) || body.length > 4) return '';  // HTML 오류페이지 방어
    return body.slice(0, 2);
  } catch (e) {
    return '';
  }
}

// 앱스스크립트 브리지 URL(토큰 포함) — 질의문자열 방식(호환용 대체 경로)
function bridgeUrl(action) {
  const sep = CFG.bridgeUrl.includes('?') ? '&' : '?';
  return `${CFG.bridgeUrl}${sep}token=${encodeURIComponent(CFG.bridgeToken)}&action=${action}`;
}

/**
 * 브리지 호출은 POST + 본문에 토큰/동작을 담는다.
 * ★ 왜 GET 이 아닌가 — 한국 VPN 을 경유하면 `?token=...&action=read` 가 붙은 GET 이
 *   중간에서 404 로 잘렸다(2026-09-04 실측). 같은 계정의 다른 점검 시스템도
 *   같은 이유로 읽기·쓰기를 모두 POST 로 한다. 덤으로 URL 에 비밀값이 남지 않는다.
 */
async function bridgePost(action, payload, timeoutMs) {
  return fetchWithTimeout(CFG.bridgeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    redirect: 'follow',
    body: JSON.stringify({ token: CFG.bridgeToken, action, ...(payload || {}) }),
  }, timeoutMs);
}

// 시트 읽기(브리지 POST) → parseSheet + 담당자가 채널에서 바꾼 설정
async function readDomains() {
  let res;
  try {
    res = await bridgePost('read');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    // 대체 경로: 옛 배포(POST read 미지원)로도 돌아가게 GET 으로 한 번 더
    console.error('[sheet] POST read 실패 → GET 으로 재시도:', safeMsg(e));
    res = await fetchWithTimeout(bridgeUrl('read'), { redirect: 'follow' });
    if (!res.ok) throw new Error(`시트 브리지 read 실패(HTTP ${res.status})`);
  }
  const data = await res.json();
  if (!data.ok) throw new Error(`시트 브리지 read 오류: ${data.error || '알수없음'}`);
  return { ...parseSheet(data.values || []), settings: data.settings || {} };
}

// 결과 쓰기(브리지 POST) — 시트 '결과' 탭 + '시스템' 탭 갱신용 meta 동봉
async function writeResults(results, nowKst, meta) {
  const rows = buildSheetRows(results, nowKst);
  const res = await bridgePost('write', { rows, meta: meta || {} });
  if (!res.ok) throw new Error(`시트 브리지 write 실패(HTTP ${res.status})`);
  const data = await res.json().catch(() => ({ ok: false }));
  if (!data.ok) throw new Error(`시트 브리지 write 오류: ${data.error || '알수없음'}`);
}

// 실행 실패를 브리지에 알림 → '시스템' 탭에 남고 감시장치가 풀린다
async function reportFailure(message) {
  if (!CFG.bridgeUrl || !CFG.bridgeToken) return;
  try {
    await bridgePost('fail', { error: safeMsg(message) }, 20000);
  } catch { /* 실패 보고 실패는 무시 */ }
}

async function main() {
  assertConfig();
  const { str: nowKst, hour: kstHour } = kstParts();
  const round = roundLabel({ manual: CFG.manual, kstHour });

  // 1) 한국 IP 검증 — 아니면 중단(가짜 결과 방지)
  const country = await verifyKoreaIp();
  if (country !== CFG.expectCountry) {
    const msg = `⚠️ 접속점검 중단\n🕒 ${nowKst} KST\n출구 IP 국가 = ${country || '확인불가'} (기대: ${CFG.expectCountry}).\nVPN이 한국에 연결되지 않아 점검을 건너뜁니다.`;
    console.error(msg);
    await sendTelegram(msg);
    await reportFailure(`VPN 한국 연결 실패(출구 국가 ${country || '확인불가'})`);
    process.exitCode = 1;
    return;
  }
  console.log(`[ip] 출구 국가 = ${country} (OK)`);

  // 2) 시트 읽기(앱스스크립트 브리지)
  const { domains, skipped, settings } = await readDomains();
  console.log(`[sheet] 도메인 ${domains.length}개` + (skipped.length ? `, 건너뜀 ${skipped.length}` : ''));

  if (domains.length === 0) {
    await sendTelegram(`🌐 접속점검\n🕒 ${nowKst} KST\n등록된 도메인이 없습니다. 채널에서 [➕ 도메인 추가]로 넣어주세요.`);
    await writeResults([], nowKst, { nowKst, round, summary: '등록된 도메인 없음' }).catch(() => {});
    return;
  }

  // 3) 한국 IP로 접속 점검
  const results = await checkMany(domains, { timeoutMs: CFG.timeoutMs, concurrency: CFG.concurrency });

  // 3-1) 점검 도중 VPN이 끊겼는지 다시 확인 — 끊겼다면 이 결과는 한국 결과가 아니다(가짜 결과 방지)
  const countryAfter = await verifyKoreaIp();
  if (countryAfter !== CFG.expectCountry) {
    const msg = `⚠️ 접속점검 결과 폐기\n🕒 ${nowKst} KST\n점검 도중 VPN이 끊겼습니다(점검 후 출구 국가 = ${countryAfter || '확인불가'}).\n한국 결과가 아니므로 기록하지 않습니다. 다시 실행해 주세요.`;
    console.error(msg);
    await sendTelegram(msg);
    await reportFailure(`점검 중 VPN 끊김(점검 후 국가 ${countryAfter || '확인불가'})`);
    process.exitCode = 1;
    return;
  }

  // 4) 리포트 만들기
  const report = buildTelegramReport(results, { nowKst, round, skipped });
  const summary = report.up === report.total
    ? `총 ${report.total}개 모두 정상 ✅`
    : `총 ${report.total} · ✅${report.up} ⚠️${report.warn} ❌${report.down} 🔀${report.redir}`;

  // 5) 결과 기록(앱스스크립트 브리지) — '결과'·'시스템' 탭
  let wrote = true;
  try {
    await writeResults(results, nowKst, {
      nowKst, round, summary, country,
      report: report.text,
      skipped: skipped.slice(0, 30).map((s) => `${s.cell} ${s.raw} (${s.reason})`),
    });
    console.log(`[sheet] '결과' 탭 기록 완료`);
  } catch (e) {
    wrote = false;
    console.error('[sheet] 결과 기록 실패:', safeMsg(e));
  }

  // 6) 텔레그램 발송 — 담당자가 '문제만 받기'로 설정했고 전부 정상이면 생략
  const quiet = settings.notify === 'problem' && report.up === report.total && !skipped.length;
  if (quiet) {
    console.log('[telegram] 전부 정상 + 알림수준=문제만 → 발송 생략');
  } else {
    await sendTelegram(report.text, report.parseMode);
  }
  // 시트 기록만 실패했으면 그 사실을 반드시 알린다 — 안 그러면 15분 뒤 엉뚱한 경고만 온다
  if (!wrote) {
    await sendTelegram('⚠️ 위 결과를 시트에 기록하지 못했습니다.\n\n<blockquote>알림은 정상이지만 시트 `결과` 탭은 옛 내용입니다.\n운영자 확인이 필요합니다.</blockquote>', 'HTML');
  }
  console.log(`[done] 총 ${report.total} · 정상 ${report.up} · 제한 ${report.warn} · 이상 ${report.down} · 주소확인 ${report.redir}`);
}

// 직접 실행일 때만 main() — 경로에 한글·공백이 있으면 문자열 비교가 어긋나므로 URL 로 통일
const isMain = (() => {
  try { return import.meta.url === new URL(process.argv[1], 'file://').href; } catch { return false; }
})();
if (isMain) {
  main().catch(async (e) => {
    console.error('[fatal]', safeMsg(e));
    try { await sendTelegram(`❌ 접속점검 실행 오류\n${kstNow()} KST\n${safeMsg(e)}`); } catch { /* ignore */ }
    try { await reportFailure(e); } catch { /* ignore */ }
    process.exitCode = 1;
  });
}

export { CFG, kstNow, splitForTelegram, splitBlockByLines };
