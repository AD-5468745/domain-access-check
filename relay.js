#!/usr/bin/env node
/**
 * 대기조 (relay) — 버튼 반응을 0~59초에서 1~3초로 줄이는 '빠른 응답조'.
 * ═══════════════════════════════════════════════════════════════════
 *
 * 왜 필요한가
 *   구글 앱스스크립트는 트리거 최소 간격이 1분이라, 혼자서는 절대 1분보다 빨라질 수 없다.
 *   텔레그램 웹훅은 앱스스크립트가 302(넘김)를 돌려주기 때문에 못 쓴다(2026-09-04 실측).
 *   그래서 담당자가 '첫 조작'을 하면 앱스스크립트가 이 워크플로를 깨우고,
 *   이 대기조가 살아 있는 동안 명령을 초 단위로 받아 넘긴다.
 *
 * 언제 끝나나
 *   채널이 IDLE_MINUTES(기본 10분)간 조용하면 스스로 종료 → 다시 1분 방식으로 돌아간다.
 *   24시간 켜두지 않는다(실제로 쓰는 시간에만 돈다).
 *
 * 죽어도 되는 장치
 *   대기조가 죽으면 하트비트가 끊기고, 90초 안에 앱스스크립트 1분 폴링이 자동 복귀한다.
 *   즉 이 파일은 '속도'만 담당하고, 기능은 하나도 담당하지 않는다.
 *
 * 보안 (저장소가 공개이므로 특히 중요)
 *   로그에 메시지 내용·도메인·업체명·chat_id·토큰을 절대 찍지 않는다. 건수만 남긴다.
 */

const BRIDGE_URL = process.env.BRIDGE_URL || '';
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';
const BOT_TOKEN = process.env.BOT_TOKEN || '';

// ★ 2026-09-05: 10분이면 담당자가 잠깐 다른 일을 하는 사이에 꺼져, 다음 첫 조작이 또 느렸다.
//   실제 사용은 '한동안 붙어서 여러 번 조작'이므로 넉넉히 잡는다(공개 저장소라 요금 0).
const IDLE_MS = Math.max(1, Number(process.env.IDLE_MINUTES || 20)) * 60 * 1000;
const HARD_STOP_MS = 55 * 60 * 1000;   // 워크플로 제한(60분)보다 먼저 스스로 끝낸다
const LONG_POLL_S = 20;                // 텔레그램에 '새 명령 생길 때까지' 귀 대고 있는 시간
const BRIDGE_TRIES = 3;                // 브리지 한 번 호출에 허용하는 재시도 횟수
const PING_FAIL_LIMIT = 5;             // 하트비트가 이만큼 연달아 실패하면 물러난다
const ALLOWED = ['message', 'channel_post', 'callback_query'];

// ★ 이 대기조의 고유번호.
//   배포 직후처럼 브리지 첫 응답이 느리면 아래에서 인사를 다시 시도하는데,
//   번호가 없으면 '이미 다른 대기조가 있다'며 스스로 물러나 버린다(2026-09-05 실측).
const RELAY_ID = globalThis.crypto.randomUUID();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 어떤 오류 메시지에도 비밀값이 섞이지 않게 한다 */
function safeMsg(e) {
  let m = String((e && e.message) || e || '알 수 없는 오류');
  if (BOT_TOKEN) m = m.split(BOT_TOKEN).join('***');
  if (BRIDGE_TOKEN) m = m.split(BRIDGE_TOKEN).join('***');
  return m.replace(/https?:\/\/\S+/g, '(주소생략)').slice(0, 200);
}

async function fetchJson(url, opts, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, Object.assign({ signal: ac.signal, redirect: 'follow' }, opts || {}));
    const text = await res.text();
    try { return JSON.parse(text); } catch (e) { throw new Error('응답이 JSON 이 아님 (HTTP ' + res.status + ')'); }
  } finally { clearTimeout(timer); }
}

/**
 * 구글 앱스스크립트 브리지 호출 — 반드시 POST(한국 경유 GET 이 막히는 사례가 있었다).
 *
 * ★ 2026-09-05 실측: 이 호출이 이따금 HTTP 404 를 돌려준다.
 *   앱스스크립트 웹앱은 POST 를 받으면 302로 다른 주소를 가리키고 본문은 거기서 내주는데,
 *   그 임시 주소가 가끔 404 로 뜬다. 중요한 건 '스크립트는 이미 실행됐다'는 점이다.
 *   예전 코드는 이걸 실패로 보고 대기조를 통째로 종료해 버렸고, 그래서
 *   대기조가 몇 분 만에 죽고 다시 1분 방식으로 떨어졌다(= 반응이 10~20초씩 걸린 진짜 원인).
 *   브리지는 같은 명령을 두 번 받아도 한 번만 처리하므로(seenUpdate_), 마음 놓고 다시 시도한다.
 */
/**
 * ★ 2026-09-05 실측으로 밝혀진 핵심 문제.
 *
 *   앱스스크립트 웹앱에 POST 하면 스크립트를 실행한 뒤 302(넘김)로 '답이 있는 임시 주소'를 알려준다.
 *   Node 의 fetch 에게 알아서 따라가라고 맡겨두면(redirect:'follow') 두 가지 사고가 난다.
 *     ① 임시 주소가 404 로 뜬다 → 대기조가 실패로 보고 죽는다
 *     ② 넘김 주소가 다시 /exec 을 가리키면, 규칙상 POST 가 GET 으로 바뀌면서 본문(=잠금값)이
 *        사라진 채 doGet 으로 들어가 {"ok":false,"error":"unauthorized"} 를 돌려준다.
 *        대기조는 이걸 '브리지가 시작을 거절했다'로 오해하고 그대로 종료했다.
 *
 *   그래서 넘김을 fetch 에게 맡기지 않고 직접 판단한다.
 *   답이 이상하면 '답이 아니다'라고 보고 다시 시도한다(브리지는 같은 명령을 두 번 받아도 한 번만 처리).
 */
async function bridgeOnce(action, payload, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 45000);
  try {
    const res = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ token: BRIDGE_TOKEN, action, relayId: RELAY_ID }, payload || {})),
      redirect: 'manual',
      signal: ac.signal,
    });

    let body = null;
    if (res.status >= 200 && res.status < 300) {
      body = JSON.parse(await res.text());
    } else if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') || '';
      if (!loc) throw new Error('넘김 주소가 없음');
      if (loc.indexOf('/exec') !== -1) throw new Error('넘김이 제자리로 돌아옴(본문이 사라진다)');
      const res2 = await fetch(loc, { redirect: 'follow', signal: ac.signal });
      const text2 = await res2.text();
      try { body = JSON.parse(text2); }
      catch (e) { throw new Error('답이 JSON 이 아님 (HTTP ' + res2.status + ')'); }
    } else {
      throw new Error('HTTP ' + res.status);
    }

    // 잠금값은 분명히 맞다. 'unauthorized' 가 왔다면 본문이 중간에 사라진 것이다 → 답으로 인정하지 않는다.
    if (body && body.ok === false && /unauthorized/i.test(String(body.error || ''))) {
      throw new Error('본문이 중간에 사라짐(재시도 대상)');
    }
    return body;
  } finally { clearTimeout(timer); }
}

/**
 * ★ 하트비트는 '답'이 필요 없다 — 신호만 닿으면 된다.
 *   앱스스크립트는 POST 를 받아 스크립트를 실행한 뒤 302로 임시 주소를 알려주는데,
 *   그 임시 주소를 따라가다 404 가 나는 게 문제였다(2026-09-05).
 *   따라가지 않고 302 자체를 '닿았다'로 인정하면 그 실패 자체가 사라진다.
 */
async function bridgePing(offset) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  try {
    const res = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: BRIDGE_TOKEN, action: 'relay-ping', relayId: RELAY_ID, offset }),
      redirect: 'manual',
      signal: ac.signal,
    });
    // 302(넘김) = 스크립트가 이미 돌았다는 뜻. 200 도 물론 정상.
    if (res.status >= 200 && res.status < 400) return { ok: true, viaRedirect: res.status >= 300 };
    throw new Error('HTTP ' + res.status);
  } finally { clearTimeout(timer); }
}

async function bridge(action, payload, timeoutMs) {
  var last = null;
  for (var i = 1; i <= BRIDGE_TRIES; i++) {
    try { return await bridgeOnce(action, payload, timeoutMs); }
    catch (e) {
      last = e;
      if (i < BRIDGE_TRIES) await sleep(700 * i);
    }
  }
  throw last || new Error('브리지 호출 실패');
}

/** 텔레그램에 길게 귀 대고 있기. 회복 불가능한 상황이면 null 을 돌려준다. */
async function getUpdates(offset) {
  const url = 'https://api.telegram.org/bot' + BOT_TOKEN + '/getUpdates'
    + '?timeout=' + LONG_POLL_S + '&limit=30'
    + '&allowed_updates=' + encodeURIComponent(JSON.stringify(ALLOWED))
    + (offset ? '&offset=' + offset : '');
  const body = await fetchJson(url, {}, (LONG_POLL_S + 10) * 1000);
  if (body && body.ok) return body.result || [];
  const desc = String((body && body.description) || '알 수 없음');
  if (/webhook is active/i.test(desc)) {
    console.log('텔레그램 웹훅이 걸려 있어 대기조를 쓸 수 없습니다 — 종료합니다.');
    return null;
  }
  throw new Error('텔레그램 수신 실패: ' + desc.slice(0, 120));
}

async function main() {
  if (!BRIDGE_URL || !BRIDGE_TOKEN || !BOT_TOKEN) {
    console.log('필요한 값이 없습니다 (BRIDGE_URL / BRIDGE_TOKEN / BOT_TOKEN) — 종료합니다.');
    return;
  }

  // 배포 직후 등에는 브리지 첫 응답이 느릴 수 있다 → 같은 고유번호로 여러 번 인사한다.
  let hello = null;
  for (let attempt = 1; attempt <= 3 && !hello; attempt++) {
    try { hello = await bridge('relay-hello', {}, 45000); }
    catch (e) {
      console.log('브리지 인사 ' + attempt + '차 실패: ' + safeMsg(e));
      if (attempt < 3) await sleep(2000);
    }
  }
  if (!hello) { console.log('브리지에 연결하지 못했습니다 — 1분 방식에 맡기고 종료합니다.'); return; }
  if (!hello.ok) { console.log('브리지가 시작을 거절했습니다 — 종료합니다.'); return; }
  if (hello.alreadyAlive) { console.log('이미 다른 대기조가 돌고 있습니다 — 종료합니다.'); return; }

  let offset = Number(hello.offset || 0) || 0;
  let lastActivity = Date.now();
  const started = Date.now();
  let forwarded = 0, failures = 0, pingFails = 0;

  console.log('대기조 시작 — 조용하면 ' + Math.round(IDLE_MS / 60000) + '분 뒤 자동 종료');

  while (true) {
    if (Date.now() - lastActivity > IDLE_MS) { console.log('채널이 조용해졌습니다 — 정상 종료'); break; }
    if (Date.now() - started > HARD_STOP_MS) { console.log('최대 가동시간 도달 — 정상 종료'); break; }

    let list;
    try { list = await getUpdates(offset); }
    catch (e) {
      failures++;
      console.log('수신 오류(' + failures + '회) — 3초 뒤 다시 시도: ' + safeMsg(e));
      if (failures >= 5) { console.log('연속 실패 — 1분 방식에 넘기고 종료합니다.'); break; }
      await sleep(3000);
      continue;
    }
    if (list === null) break;
    failures = 0;

    if (!list.length) {
      let beat = null;
      try { beat = await bridgePing(offset); pingFails = 0; }
      catch (e) {
        // ★ 한 번 삐끗했다고 물러나지 않는다. 응답을 못 받았을 뿐 신호는 닿았을 수 있다.
        pingFails += 1;
        console.log('하트비트 실패 ' + pingFails + '회 — 계속 대기합니다: ' + safeMsg(e));
        if (pingFails >= PING_FAIL_LIMIT) { console.log('하트비트가 계속 실패 — 1분 방식에 넘기고 종료합니다.'); break; }
        continue;
      }
      // 브리지가 '지난 대기조'로 판정하면 새 대기조가 자리를 넘겨받은 것이다 — 조용히 비켜준다.
      if (beat && beat.ok === false) { console.log('다른 대기조에게 자리를 넘기고 종료합니다.'); return; }
      continue;
    }

    let broke = false;
    for (const u of list) {
      let ok = false;
      try {
        const r = await bridge('relay-update', { update: u, offset: u.update_id + 1 });
        ok = !!(r && r.ok);
      } catch (e) { ok = false; }
      if (!ok) {
        // ★ 여기서 offset 을 올리면 그 명령은 영영 사라진다.
        //   올리지 않고 물러나면 1분 방식이 같은 자리에서 다시 가져간다.
        console.log('브리지 전달 실패 — 명령을 남겨두고 1분 방식에 넘깁니다.');
        broke = true;
        break;
      }
      offset = u.update_id + 1;
      forwarded++;
    }
    console.log('명령 ' + list.length + '건 처리');
    lastActivity = Date.now();
    if (broke) break;
  }

  try { await bridge('relay-bye', { offset }); }
  catch (e) { console.log('종료 신고 실패(90초 뒤 자동 복귀됩니다): ' + safeMsg(e)); }
  console.log('대기조 종료 — 총 ' + forwarded + '건 전달');
}

main().catch((e) => { console.log('대기조 오류: ' + safeMsg(e)); process.exit(0); });
