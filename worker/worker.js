/**
 * 접속점검 — 즉답기 (Cloudflare Worker)
 * ═══════════════════════════════════════════════════════════════════
 *
 * 하는 일 (딱 두 가지)
 *   ① 텔레그램이 이 주소를 직접 두드리면 0.05초 안에 "받았다"를 돌려준다.
 *   ② 버튼이면 먼저 '⏳ 잠시만요'로 답해 주고(체감 0.1초),
 *      그다음 구글 앱스스크립트(두뇌)에 넘겨 실제 처리를 시킨다.
 *
 * 왜 필요한가
 *   앱스스크립트 웹앱은 답으로 302(넘김)를 돌려주는데, 텔레그램은 302를 실패로 본다.
 *   그래서 텔레그램이 앱스스크립트를 직접 두드릴 수 없었고, 지금까지는
 *   깃허브 대기조가 '가지러 가는' 방식이었다(첫 조작 지연·대기조 생존 문제).
 *   이 워커가 그 사이에서 200을 즉시 돌려주면 그 문제들이 통째로 사라진다.
 *
 * 두뇌는 그대로다
 *   판단·데이터는 전부 앱스스크립트가 한다. 이 파일은 '문지기'일 뿐이다.
 *   워커가 죽어도 setupPolling() 한 번이면 예전 방식으로 즉시 되돌아간다.
 *
 * 필요한 값 (워커 설정 → Variables and Secrets)
 *   BRIDGE_URL      앱스스크립트 웹앱 주소 (…/exec)
 *   BRIDGE_TOKEN    앱스스크립트 ACCESS_TOKEN 과 같은 값
 *   BOT_TOKEN       텔레그램 봇 토큰
 *   WEBHOOK_SECRET  텔레그램이 보낸 것이 맞는지 확인하는 암호(아무 문자열)
 *
 * 보안: 로그에 메시지 내용·토큰·chat_id 를 남기지 않는다.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 살아있는지 확인용 (비밀값 없음)
    if (request.method === 'GET') {
      return json({ ok: true, name: '접속점검 즉답기', ready: !!(env.BRIDGE_URL && env.BRIDGE_TOKEN && env.BOT_TOKEN) });
    }

    if (request.method !== 'POST' || url.pathname !== '/tg') {
      return new Response('not found', { status: 404 });
    }

    // ★ 텔레그램이 보낸 것이 맞는지 확인한다. 주소를 알아낸 누군가가 아무 명령이나
    //   밀어 넣지 못하게 하는 유일한 장치이므로, 값이 없으면 아예 받지 않는다.
    if (!env.WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
      return new Response('forbidden', { status: 403 });
    }

    let update = null;
    try { update = await request.json(); } catch (e) { update = null; }

    // ★ 텔레그램에는 무조건 즉시 200. 여기서 오래 끌면 텔레그램이 재시도하며 줄이 밀린다.
    if (update) ctx.waitUntil(handleUpdate(update, env));
    return new Response('ok', { status: 200 });
  },
};

function json(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** 오류 문구에 비밀값이 섞이지 않게 한다 */
function safeMsg(e, env) {
  let m = String((e && e.message) || e || '알 수 없는 오류');
  for (const v of [env.BOT_TOKEN, env.BRIDGE_TOKEN, env.WEBHOOK_SECRET]) {
    if (v) m = m.split(v).join('***');
  }
  return m.replace(/https?:\/\/\S+/g, '(주소생략)').slice(0, 200);
}

async function handleUpdate(update, env) {
  let preAnswered = false;

  // 버튼이면 구글에 넘기기 '전에' 먼저 답한다 — 이게 '즉시 반응'의 정체다.
  const cb = update.callback_query;
  if (cb && cb.id) {
    preAnswered = true;
    telegram(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: '⏳ 잠시만요', cache_time: 0 })
      .catch(() => {});
  }

  try {
    await bridge(env, { action: 'edge', update, preAnswered });
  } catch (e) {
    console.log('두뇌 전달 실패: ' + safeMsg(e, env));
  }
}

function telegram(env, method, payload) {
  return fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/**
 * ★ 앱스스크립트 호출 — 넘김(302)을 브라우저에게 맡기지 않는다.
 *   맡기면 ① 임시 주소가 404 로 뜨거나 ② POST 가 GET 으로 바뀌며 본문(잠금값)이 사라져
 *   'unauthorized' 가 돌아온다. 둘 다 2026-09-05 에 실제로 겪은 사고다.
 *   두뇌는 같은 명령을 두 번 받아도 한 번만 처리하므로(seenUpdate_) 재시도가 안전하다.
 */
async function bridgeOnce(env, body) {
  const res = await fetch(env.BRIDGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ token: env.BRIDGE_TOKEN }, body)),
    redirect: 'manual',
  });

  if (res.status >= 200 && res.status < 300) return await res.json();

  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') || '';
    if (!loc) throw new Error('넘김 주소가 없음');
    if (loc.indexOf('/exec') !== -1) throw new Error('넘김이 제자리로 돌아옴(본문이 사라진다)');
    const res2 = await fetch(loc, { redirect: 'follow' });
    const text2 = await res2.text();
    let parsed = null;
    try { parsed = JSON.parse(text2); }
    catch (e) { throw new Error('답이 JSON 이 아님 (HTTP ' + res2.status + ')'); }
    if (parsed && parsed.ok === false && /unauthorized/i.test(String(parsed.error || ''))) {
      throw new Error('본문이 중간에 사라짐(재시도 대상)');
    }
    return parsed;
  }

  throw new Error('HTTP ' + res.status);
}

async function bridge(env, body) {
  let last = null;
  for (let i = 1; i <= 3; i++) {
    try { return await bridgeOnce(env, body); }
    catch (e) {
      last = e;
      if (i < 3) await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
  throw last || new Error('두뇌 호출 실패');
}
