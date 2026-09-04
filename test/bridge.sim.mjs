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
      getDisplayValues() { envRef.sheetReads = (envRef.sheetReads || 0) + 1; return api.getValues().map((row) => row.map((v) => (v === null || v === undefined ? '' : String(v)))); },
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
      // 실제 코드는 한 번에 통째로 읽어 캐시한다(요청당 1회) — 시뮬도 같은 길을 탄다
      getProperties: () => Object.fromEntries(propStore),
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

  const envRef = {};                       // 아래에서 만든 env 를 가리킨다(테스트가 응답을 바꿔 끼울 수 있게)
  const UrlFetchApp = {
    // ★ 실제 코드가 '보내기 + 옛 버튼 떼기'를 동시에 보내는 경로. 시뮬도 같은 길을 타야 한다.
    fetchAll(reqs) {
      return reqs.map((r) => UrlFetchApp.fetch(r.url, r));
    },
    fetch(url, opts) {
      const body = opts && opts.payload ? JSON.parse(opts.payload) : {};
      if (url.indexOf('api.telegram.org') !== -1) {
        // getUpdates 는 질의문자열이 붙는다 — 메서드 이름만 떼어낸다.
        const method = url.split('/').pop().split('?')[0];
        sent.push({ method, body });
        // 테스트가 응답을 갈아끼울 수 있게(폴링 검증용). 기본은 성공.
        const custom = envRef.tgReply ? envRef.tgReply(method, url, body) : null;
        const out = custom || { ok: true, result: { message_id: 1000 + sent.length } };
        body.__mid = out.result && out.result.message_id;
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(out) };
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
          everyMinutes: () => ({ create: () => { triggers.push(tr); return tr; } }),
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

  const built = { SpreadsheetApp, PropertiesService, CacheService, LockService, UrlFetchApp,
    Utilities, ScriptApp, ContentService, Logger, sheets, sent, github, triggers, propStore,
    props: propStore,
    setNow: (iso) => { fakeNow = new Date(iso); }, getNow: () => fakeNow };
  Object.assign(envRef, built);          // 가짜 fetch 가 env.tgReply 를 볼 수 있게 연결
  return envRef;
}

const GS = fs.readFileSync(new URL('../apps-script/bridge.gs', import.meta.url), 'utf8');
const EXPORTS = ['doGet', 'doPost', 'hourlyTick', 'watchdog', 'setupAll', 'applySchedule_', 'pollUpdates', 'processUpdate_',
  'setupEdge', 'setupPolling', 'mode_',
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
  { name: '누드티비', domains: ['egg-1.com', 'egg-5.com'] },
  { name: '파트너사', domains: ['ya-1.com'] },
];

function post(B, update, params) {
  return B.doPost({
    parameter: Object.assign({ token: 'tok', action: 'tg' }, params || {}),
    postData: { contents: JSON.stringify(update) },
  });
}
const msg = (text, chat = '-1001') => ({ channel_post: { chat: { id: chat }, message_id: 1, text, author_signature: '김담당' } });
const cbq = (data, chat = '-1001', messageId = 9) => ({ callback_query: { id: 'c1', data, from: { id: 7, first_name: '박담당' }, message: { chat: { id: chat }, message_id: messageId } } });
/** 마지막으로 봇이 보낸 메시지의 번호 — 담당자가 실제로 누르는 그 메시지다 */
const lastMid = (env) => {
  for (let i = env.sent.length - 1; i >= 0; i--) {
    if (env.sent[i].method === 'sendMessage') return env.sent[i].body.__mid;
  }
  return 9;
};
/** 방금 온 메시지의 버튼을 누른다(실제 사용 방식) */
const cbqLast = (env, data, chat = '-1001') => cbq(data, chat, lastMid(env));
// ★ 깃허브로 나간 요청 중 '점검'만 센다 — 대기조 깨우기가 섞이면 숫자가 어긋난다.
const checkRuns = (env) => env.github.filter((g) => /check\.yml/.test(g.url));
const relayRuns = (env) => env.github.filter((g) => /relay\.yml/.test(g.url));
// ★ 버튼 응답이 '새 메시지 + 옛 버튼 떼기' 두 번 호출이 되었으므로,
//   "마지막으로 나간 것"이 곧 "마지막 화면"이 아니다. 실제 메시지만 골라낸다.
const lastSent = (env) => {
  for (let i = env.sent.length - 1; i >= 0; i--) if (env.sent[i].method === 'sendMessage') return env.sent[i];
  return null;
};
const lastText = (env) => {
  for (let i = env.sent.length - 1; i >= 0; i--) {
    // 2026-09-04부터 버튼 응답도 '새 메시지'다(editMessageText 는 더 쓰지 않는다).
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
    assert.deepEqual(v[0], ['누드티비', '파트너사']);
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
  post(B, msg('추가 누드티비 https://WWW.Egg-9.com/promo egg-1.com 이건메모'));
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
  post(B, cbqLast(env, 'dx:0:1'));
  t('버튼 삭제: 확인 단계 표시', () => assert.equal(/삭제할까요/.test(lastText(env)), true));
  t('버튼 삭제: 확인 전엔 안 지워짐', () => assert.equal(B.loadModel_()[0].domains.length, 2));
  post(B, cbqLast(env, 'dok'));
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
  post(B, msg('이름변경 누드티비 누드티비2'));
  t('업체 이름 변경', () => assert.equal(B.loadModel_()[0].name, '누드티비2'));
  post(B, msg('이름변경 없는업체 x'));
  t('없는 업체 이름변경 안내', () => assert.equal(/그런 업체가 없습니다/.test(lastText(env)), true));
  post(B, msg('이름변경 누드티비2 파트너사'));
  t('중복 이름 거부', () => assert.equal(B.loadModel_()[0].name, '누드티비2'));
}
{
  const { env, B } = fresh(SEED);
  post(B, msg('업체삭제 누드티비'));
  t('업체 삭제는 확인을 먼저 묻는다', () => {
    assert.equal(/삭제할까요/.test(lastText(env)), true);
    assert.equal(B.loadModel_().length, 2);
  });
  post(B, cbqLast(env, 'codelok'));
  t('확인 후 업체와 도메인 함께 삭제', () => {
    const m = B.loadModel_();
    assert.equal(m.length, 1);
    assert.equal(m[0].name, '파트너사');
  });
}
{
  const { B } = fresh(SEED);
  post(B, msg('이동 ya-1.com 누드티비'));
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
    const kb = lastSent(env).body.reply_markup.inline_keyboard;
    assert.equal(JSON.stringify(kb).indexOf('누드티비') !== -1, true);
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
  t('점검 명령이 GitHub을 깨움', () => assert.equal(checkRuns(env).length, 1));
  t('수동 실행 표시', () => assert.equal(checkRuns(env)[0].body.inputs.mode, 'manual'));
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
  t('정해진 시각이면 자동 점검', () => assert.equal(checkRuns(env).length, 1));
  t('자동 실행 표시', () => assert.equal(checkRuns(env)[0].body.inputs.mode, 'auto'));
  B.hourlyTick();
  t('같은 시각 중복 실행 안 함', () => assert.equal(checkRuns(env).length, 1));

  env.setNow('2026-08-28T14:05:00+09:00');
  B.hourlyTick();
  t('설정 시각이 아니면 실행 안 함', () => assert.equal(checkRuns(env).length, 1));

  env.setNow('2026-08-28T21:05:00+09:00');
  B.hourlyTick();
  t('두 번째 시각에 실행', () => assert.equal(checkRuns(env).length, 2));

  env.propStore.set('PAUSED', 'yes');
  env.setNow('2026-08-29T09:05:00+09:00');
  B.hourlyTick();
  t('일시중지 중엔 자동 실행 안 함', () => assert.equal(checkRuns(env).length, 2));
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
  t('read 가 1행 업체명 포함', () => assert.deepEqual(ok.values[0], ['누드티비', '파트너사']));
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
    ['누드티비', 'egg-1.com', '✅ 정상', 200, 'https://egg-1.com/', 120, '2026-08-28 21:00', '정상']];
  const r = JSON.parse(B.doPost({
    parameter: { token: 'tok', action: 'write' },
    postData: { contents: JSON.stringify({ rows, meta: { nowKst: '2026-08-28 21:00', summary: '총 1개 모두 정상 ✅', report: '리포트' } }) },
  }).text);
  t('write 성공', () => assert.equal(r.ok, true));
  // ★ 결과 뒤에 조작 패널이 새 메시지로 따라와야 한다(버튼이 위로 밀려 안 보이는 문제)
  t('결과 뒤에 관리 패널을 새 메시지로 발송', () => {
    const sends = env.sent.filter((x) => x.method === 'sendMessage');
    const last = sends[sends.length - 1];
    assert.equal(/접속점검 관리/.test(last.body.text), true);
    assert.equal(!!(last.body.reply_markup && last.body.reply_markup.inline_keyboard), true);
  });
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
  t('주소 39개 초과 시 안내 표시', () => assert.equal(/앞 39개만/.test(lastText(env)), true));
  t('버튼은 41개 이하(40 + 메뉴로)', () => {
    const kb = lastSent(env).body.reply_markup.inline_keyboard;
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
    const kb = lastSent(env).body.reply_markup.inline_keyboard;
    assert.equal(kb.reduce((n, r) => n + r.length, 0), 8);
  });
  post(B, msg('목록'));
  t('목록에 업체·도메인', () => assert.equal(/〔누드티비〕/.test(lastText(env)) && /egg-1\.com/.test(lastText(env)), true));
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
  t('setupAll 이 점검 스케줄 설치', () => assert.equal(env.triggers.some((x) => x.getHandlerFunction() === 'hourlyTick'), true));
  // ★ 2026-09-04: 웹훅은 앱스스크립트의 302 응답 때문에 텔레그램이 '실패'로 보고 명령이 밀린다.
  //   그래서 웹훅을 떼고 1분 폴링으로 받는다.
  t('setupAll 이 명령 수신(폴링) 스케줄 설치', () => assert.equal(env.triggers.some((x) => x.getHandlerFunction() === 'pollUpdates'), true));
  t('setupAll 이 웹훅을 떼어냄', () => assert.equal(env.sent.some((s) => s.method === 'deleteWebhook'), true));
  t('setupAll 이 웹훅을 걸지 않음', () => assert.equal(env.sent.some((s) => s.method === 'setWebhook'), false));
}

// 11-1. 폴링으로 명령 받기
{
  const { env, B } = fresh(SEED);
  env.tgReply = (method) => (method === 'getUpdates'
    ? { ok: true, result: [{ update_id: 101, channel_post: { chat: { id: -1001 }, text: '목록' } }] }
    : { ok: true, result: {} });
  B.pollUpdates();
  t('폴링이 글 명령을 처리', () => assert.equal(/등록된 도메인/.test(lastText(env)), true));
  t('폴링이 처리한 지점을 기록', () => assert.equal(env.props.get('TG_OFFSET'), '102'));

  // 같은 명령이 또 와도 두 번 실행하지 않는다
  const before = env.sent.filter((x) => x.method === 'sendMessage').length;
  B.pollUpdates();
  t('같은 명령 재수신 시 중복 실행 안 함', () => assert.equal(env.sent.filter((x) => x.method === 'sendMessage').length, before));
}

// 11-2. 웹훅이 걸려 있으면 폴링이 스스로 떼어낸다(409 회복)
{
  const { env, B } = fresh(SEED);
  let calls = 0;
  env.tgReply = (method) => {
    if (method === 'getUpdates') {
      calls += 1;
      return { ok: false, description: "Conflict: can't use getUpdates method while webhook is active" };
    }
    return { ok: true, result: {} };
  };
  B.pollUpdates();
  t('폴링이 막히면 웹훅을 떼어냄', () => assert.equal(env.sent.some((s) => s.method === 'deleteWebhook'), true));
}

// ═══════════════════════════════════════════════════════════
// 11-3. 버튼 응답이 '새 메시지'로 온다 (2026-09-04 에이든 지시)
//   왜: 제자리에서 고쳐 쓰면, 그 메시지가 화면 위로 밀렸을 때 아래에는
//       아무 변화가 없어 "눌러도 반응이 없다"로 보인다.
// ═══════════════════════════════════════════════════════════
{
  const { env, B } = fresh(SEED);
  post(B, cbq('list'));
  t('버튼 응답이 새 메시지로 온다', () => {
    assert.equal(env.sent.some((x) => x.method === 'sendMessage' && /등록된 도메인/.test(x.body.text)), true);
  });
  t('버튼 응답에 제자리 수정(editMessageText)을 쓰지 않는다', () => {
    assert.equal(env.sent.some((x) => x.method === 'editMessageText'), false);
  });
  t('누른 옛 메시지의 버튼은 떼어낸다', () => {
    const strip = env.sent.find((x) => x.method === 'editMessageReplyMarkup');
    assert.equal(!!strip, true);
    assert.equal(strip.body.message_id, 9);
    assert.deepEqual(strip.body.reply_markup.inline_keyboard, []);
  });
}

// ★ 2026-09-05 실측 사고 재현 방지 — 삭제가 통째로 막혔다.
//   버튼 응답을 '새 메시지'로 바꾸면서, 확인 메시지 번호를 '누른 옛 메시지 번호'로
//   저장해 담당자가 실제로 누르는 새 메시지와 항상 어긋났다.
//   증상: [예, 삭제] 를 눌러도 매번 "지난 확인 버튼입니다. 새로 시작해 주세요."
{
  const { env, B } = fresh(SEED);
  post(B, cbqLast(env, 'del'));
  post(B, cbqLast(env, 'd:0'));
  post(B, cbqLast(env, 'dx:0:1'));
  t('삭제 확인을 묻는다', () => assert.equal(/삭제할까요/.test(lastText(env)), true));
  post(B, cbqLast(env, 'dok'));
  t('방금 온 확인 버튼은 반드시 통한다', () => assert.equal(/지난 확인 버튼/.test(lastText(env)), false));
  t('실제로 지워진다', () => assert.deepEqual(B.loadModel_()[0].domains, ['egg-1.com']));
}
{
  // 업체 관리 → 삭제도 같은 경로
  const { env, B } = fresh(SEED);
  post(B, cbqLast(env, 'cod'));
  post(B, cbqLast(env, 'codp:1'));
  post(B, cbqLast(env, 'codelok'));
  t('업체 삭제도 방금 온 확인 버튼으로 통한다', () => assert.equal(/지난 확인 버튼/.test(lastText(env)), false));
  t('업체가 실제로 지워진다', () => assert.deepEqual(B.loadModel_().map((c) => c.name), ['누드티비']));
}

// ═══════════════════════════════════════════════════════════
// 11-3-2. 반응 속도 — 시트 읽기 줄이기 (2026-09-05: 한 건 7~19초였다)
// ═══════════════════════════════════════════════════════════
{
  const { env, B } = fresh(SEED);
  env.sheetReads = 0;
  post(B, cbqLast(env, 'list'));
  const first = env.sheetReads;
  env.sheetReads = 0;
  post(B, cbqLast(env, 'list'));
  t('같은 조회를 되풀이해도 시트를 다시 읽지 않는다', () => assert.equal(env.sheetReads, 0));
  t('첫 조회는 시트를 읽는다', () => assert.equal(first > 0, true));

  // 고친 직후에는 반드시 새 값이 보여야 한다(캐시가 옛 값을 물고 있으면 안 된다)
  post(B, msg('추가 누드티비 new-one.com'));
  t('추가하면 즉시 새 목록이 보인다', () => {
    post(B, cbqLast(env, 'list'));
    assert.equal(/new-one\.com/.test(lastText(env)), true);
  });
  t('모델에도 실제로 들어가 있다', () => assert.equal(B.loadModel_()[0].domains.indexOf('new-one.com') !== -1, true));
}
{
  // 되돌리기는 시트를 직접 되돌린다 — 캐시가 옛 값을 물고 있으면 '되돌렸는데 그대로'가 된다
  const { env, B } = fresh(SEED);
  post(B, msg('삭제 egg-5.com'));
  B.loadModel_();                       // 캐시를 일부러 채운다
  post(B, msg('되돌리기'));
  post(B, cbqLast(env, 'undook'));
  t('되돌린 뒤 캐시가 아니라 실제 시트가 보인다', () => assert.deepEqual(B.loadModel_(), SEED));
}
{
  // 보내기와 옛 버튼 떼기를 '한 번에' 보내도 둘 다 실제로 나가야 한다
  const { env, B } = fresh(SEED);
  post(B, cbq('list', '-1001', 4321));
  t('한 번에 보내도 새 메시지가 나간다', () => assert.equal(env.sent.some((x) => x.method === 'sendMessage' && /등록된 도메인/.test(x.body.text)), true));
  t('한 번에 보내도 옛 버튼은 떼어진다', () => {
    const strip = env.sent.find((x) => x.method === 'editMessageReplyMarkup');
    assert.equal(!!strip, true);
    assert.equal(strip.body.message_id, 4321);
  });
}

// ═══════════════════════════════════════════════════════════
// 11-3-4. 즉답 — 대기조가 먼저 답하면 구글은 다시 답하지 않는다
// ═══════════════════════════════════════════════════════════
{
  const { env, B } = fresh(SEED);
  JSON.parse(B.doPost({ parameter: {}, postData: { contents: JSON.stringify({ token: 'tok', action: 'relay-hello', relayId: 'RA' }) } }).text);
  env.sent.length = 0;
  B.doPost({ parameter: {}, postData: { contents: JSON.stringify({
    token: 'tok', action: 'relay-update', relayId: 'RA', preAnswered: true,
    update: { callback_query: { id: 'cb9', data: 'list', from: { id: 7, first_name: '박담당' }, message: { chat: { id: '-1001' }, message_id: 77 } } },
  }) } });
  t('대기조가 먼저 답했으면 구글은 버튼 응답을 다시 보내지 않는다', () => {
    assert.equal(env.sent.some((x) => x.method === 'answerCallbackQuery'), false);
  });
  t('그래도 화면은 정상으로 나간다', () => assert.equal(/등록된 도메인/.test(lastText(env)), true));
}
{
  const { env, B } = fresh(SEED);
  post(B, cbq('list'));
  t('아무도 먼저 답하지 않았으면 구글이 버튼 응답을 보낸다', () => {
    assert.equal(env.sent.some((x) => x.method === 'answerCallbackQuery'), true);
  });
}

// ═══════════════════════════════════════════════════════════
// 11-3-5. 즉답기(웹훅) 모드 — 클라우드플레어 워커가 받아 넘긴다
// ═══════════════════════════════════════════════════════════
const edge = (B, update, preAnswered) => JSON.parse(B.doPost({
  parameter: {},
  postData: { contents: JSON.stringify({ token: 'tok', action: 'edge', update, preAnswered: !!preAnswered }) },
}).text);

{
  const { env, B } = fresh(SEED);
  const r = edge(B, { channel_post: { chat: { id: -1001 }, message_id: 5, text: '목록' } });
  t('즉답기가 넘긴 글 명령을 처리', () => assert.equal(r.result, 'ok'));
  t('즉답기가 넘긴 명령이 실제로 답을 보냄', () => assert.equal(/등록된 도메인/.test(lastText(env)), true));
}
{
  const { env, B } = fresh(SEED);
  edge(B, { callback_query: { id: 'e1', data: 'list', from: { id: 7, first_name: '박담당' }, message: { chat: { id: '-1001' }, message_id: 55 } } }, true);
  t('즉답기가 먼저 답했으면 구글은 버튼 응답을 안 보냄', () => assert.equal(env.sent.some((x) => x.method === 'answerCallbackQuery'), false));
  t('그래도 화면은 정상으로 나감', () => assert.equal(/등록된 도메인/.test(lastText(env)), true));
}
{
  // ★ 가장 위험한 회귀: 웹훅 모드인데 1분 폴링이 살아 있으면
  //   409 자동복구가 '우리 웹훅'을 지워버려 시스템이 통째로 먹통이 된다.
  const { env, B } = fresh(SEED);
  env.propStore.set('MODE', 'webhook');
  let polled = 0;
  env.tgReply = (method) => {
    if (method === 'getUpdates') { polled += 1; return { ok: true, result: [] }; }
    return { ok: true, result: {} };
  };
  B.pollUpdates();
  t('웹훅 모드면 폴링이 텔레그램을 건드리지 않는다', () => assert.equal(polled, 0));
  t('웹훅 모드면 폴링이 웹훅을 지우지 않는다', () => assert.equal(env.sent.some((x) => x.method === 'deleteWebhook'), false));
  t('웹훅 모드면 대기조를 깨우지 않는다', () => assert.equal(relayRuns(env).length, 0));
}
{
  const { env, B } = fresh(SEED);
  env.propStore.set('MODE', 'webhook');
  post(B, msg('ㅁ'));
  t('웹훅 모드면 패널이 즉시 반응이라고 알려준다', () => assert.equal(/즉시 반응/.test(lastText(env)), true));
}
{
  // 되돌리기 — 1분이면 예전 방식으로 복귀해야 한다
  const { env, B } = fresh(SEED);
  env.propStore.set('MODE', 'webhook');
  B.setupPolling();
  t('setupPolling 이 웹훅을 떼어냄', () => assert.equal(env.sent.some((x) => x.method === 'deleteWebhook'), true));
  t('setupPolling 이 폴링 스케줄을 되살림', () => assert.equal(env.triggers.some((x) => x.getHandlerFunction() === 'pollUpdates'), true));
  let polled = 0;
  env.tgReply = (method) => { if (method === 'getUpdates') { polled += 1; return { ok: true, result: [] }; } return { ok: true, result: {} }; };
  B.pollUpdates();
  t('되돌린 뒤 폴링이 다시 동작', () => assert.equal(polled, 1));
}
{
  // 즉답기 전환은 필요한 값이 없으면 조용히 잘못 켜지지 않고 분명히 실패해야 한다
  const { B } = fresh(SEED);
  t('워커 주소가 없으면 전환을 거부', () => {
    let threw = false;
    try { B.setupEdge(); } catch (e) { threw = /WORKER_URL/.test(String(e.message || e)); }
    assert.equal(threw, true);
  });
}

// ═══════════════════════════════════════════════════════════
// 11-3-6. 속성 하나로 설치 함수 실행 (편집기 함수 선택이 어긋나는 문제 우회)
// ═══════════════════════════════════════════════════════════
{
  const { env, B } = fresh(SEED);
  env.propStore.set('WORKER_URL', 'https://w.example.workers.dev');
  env.propStore.set('WEBHOOK_SECRET', 'sec');
  env.propStore.set('PENDING_SETUP', 'edge');
  B.pollUpdates();
  t('속성으로 즉답기 전환이 실행됨', () => assert.equal(env.propStore.get('MODE'), 'webhook'));
  t('텔레그램 웹훅이 워커 주소로 등록됨', () => {
    const w = env.sent.find((x) => x.method === 'setWebhook');
    assert.equal(!!w, true);
    assert.equal(w.body.url, 'https://w.example.workers.dev/tg');
    assert.equal(w.body.secret_token, 'sec');
  });
  t('실행 후 값을 지워 두 번 돌지 않음', () => assert.equal(env.propStore.get('PENDING_SETUP'), '-'));
  t('결과가 기록됨', () => assert.equal(/edge 실행 완료/.test(env.propStore.get('PENDING_SETUP_RESULT')), true));
}
{
  // 되돌리기도 같은 경로로 가능해야 한다
  const { env, B } = fresh(SEED);
  env.propStore.set('MODE', 'webhook');
  env.propStore.set('PENDING_SETUP', 'poll');
  B.pollUpdates();
  t('속성으로 예전 방식 복귀가 실행됨', () => assert.equal(env.propStore.get('MODE'), 'poll'));
  t('복귀 시 웹훅을 떼어냄', () => assert.equal(env.sent.some((x) => x.method === 'deleteWebhook'), true));
}
{
  // 실패해도 1분마다 무한 반복되면 안 된다
  const { env, B } = fresh(SEED);
  env.propStore.set('PENDING_SETUP', 'edge');    // WORKER_URL 없음 → 실패해야 함
  B.pollUpdates();
  t('실패해도 값이 지워져 반복되지 않음', () => assert.equal(env.propStore.get('PENDING_SETUP'), '-'));
  t('실패 이유가 기록됨', () => assert.equal(/WORKER_URL/.test(env.propStore.get('PENDING_SETUP_RESULT')), true));
}

// ═══════════════════════════════════════════════════════════
// 11-3-3. 자동 예열 — '첫 조작만 느린' 문제를 없앤다
// ═══════════════════════════════════════════════════════════
{
  const { env, B } = fresh(SEED);
  env.setNow('2026-08-28T14:00:00+09:00');       // 업무시간
  B.pollUpdates();
  t('업무시간에는 대기조를 미리 깨운다', () => assert.equal(relayRuns(env).length, 1));
}
{
  const { env, B } = fresh(SEED);
  env.setNow('2026-08-28T05:00:00+09:00');       // 새벽 5시 = 예열 시간 밖
  B.pollUpdates();
  t('새벽에는 미리 깨우지 않는다', () => assert.equal(relayRuns(env).length, 0));
}
{
  const { env, B } = fresh(SEED);
  env.propStore.set('RELAY_PREHEAT', 'no');
  env.setNow('2026-08-28T14:00:00+09:00');
  B.pollUpdates();
  t('예열을 꺼두면 미리 깨우지 않는다', () => assert.equal(relayRuns(env).length, 0));
}
{
  const { env, B } = fresh(SEED);
  env.setNow('2026-08-28T14:00:00+09:00');
  const hello = JSON.parse(B.doPost({ parameter: {}, postData: { contents: JSON.stringify({ token: 'tok', action: 'relay-hello', relayId: 'RP' }) } }).text);
  assert.equal(hello.ok, true);
  env.github.length = 0;
  B.pollUpdates();
  t('이미 깨어 있으면 또 깨우지 않는다', () => assert.equal(relayRuns(env).length, 0));
}
{
  // 패널이 지금 빠른 상태인지 알려준다(버튼을 누른 뒤에는 알려줄 방법이 없으므로 미리 알린다)
  const { env, B } = fresh(SEED);
  post(B, msg('ㅁ'));
  t('자는 중이면 패널이 미리 알려준다', () => assert.equal(/쉬는 중|최대 1분/.test(lastText(env)), true));
  JSON.parse(B.doPost({ parameter: {}, postData: { contents: JSON.stringify({ token: 'tok', action: 'relay-hello', relayId: 'RQ' }) } }).text);
  post(B, msg('메뉴'));
  t('깨어 있으면 빠르다고 알려준다', () => assert.equal(/지금은 빠릅니다/.test(lastText(env)), true));
}

// ═══════════════════════════════════════════════════════════
// 11-4. 패널을 쉽게 부르기
// ═══════════════════════════════════════════════════════════
{
  const { env, B } = fresh(SEED);
  post(B, msg('ㅁ'));
  t("'ㅁ' 한 글자로 패널이 나온다", () => assert.equal(/접속점검 관리/.test(lastText(env)), true));
  post(B, msg('패널'));
  t("'패널' 로도 나온다", () => assert.equal(/접속점검 관리/.test(lastText(env)), true));
  post(B, msg('/menu'));
  t("'/menu' 로도 나온다", () => assert.equal(/접속점검 관리/.test(lastText(env)), true));
  t('패널에 다시 부르는 법이 적혀 있다', () => assert.equal(/ㅁ/.test(lastText(env)), true));
}
{
  const { env, B } = fresh(SEED);
  B.setupAll();
  t('설치가 / 명령 메뉴를 등록', () => {
    const c = env.sent.find((x) => x.method === 'setMyCommands');
    assert.equal(!!c, true);
    assert.deepEqual(c.body.commands.map((x) => x.command), ['menu', 'check', 'list', 'help']);
  });
  t('설치가 안내문을 채널에 고정', () => assert.equal(env.sent.some((x) => x.method === 'pinChatMessage'), true));
}

// ═══════════════════════════════════════════════════════════
// 11-5. 깨우기형 대기조 — 첫 조작에만 깨우고, 살아 있는 동안은 폴링이 물러난다
// ═══════════════════════════════════════════════════════════
const relayApi = (B, action, body) => JSON.parse(B.doPost({
  parameter: {},
  postData: { contents: JSON.stringify(Object.assign({ token: 'tok', action }, body || {})) },
}).text);

{
  const { env, B } = fresh(SEED);
  post(B, msg('목록'));
  t('첫 조작이 대기조를 깨움', () => assert.equal(relayRuns(env).length, 1));
  t('대기조에 조용해지면 끌 시간을 넘김', () => assert.equal(relayRuns(env)[0].body.inputs.minutes, '20'));

  post(B, msg('상태'));
  t('연달아 온 조작은 다시 깨우지 않음(1분 쿨다운)', () => assert.equal(relayRuns(env).length, 1));
}
{
  // 허용되지 않은 채널의 글로는 깃허브를 깨울 수 없어야 한다(외부인이 실행을 유발하는 사고 방지)
  const { env, B } = fresh(SEED);
  post(B, msg('목록', '-999'));
  t('허용 안 된 채널은 대기조를 못 깨움', () => assert.equal(relayRuns(env).length, 0));
}
{
  const { env, B } = fresh(SEED);
  const hello = relayApi(B, 'relay-hello', { relayId: 'R1' });
  t('대기조 시작 시 이어받을 지점을 알려줌', () => {
    assert.equal(hello.ok, true);
    assert.equal(hello.offset, 0);
    assert.equal(hello.idleMinutes, 20);
  });
  t('두 번째 대기조는 스스로 물러남', () => assert.equal(relayApi(B, 'relay-hello', { relayId: 'R2' }).alreadyAlive, true));
  // ★ 2026-09-05 실측 사고: 첫 응답이 느려 대기조가 30초 만에 포기했는데 구글은 뒤늦게 실행 →
  //   '살아있음'만 켜진 채 대기조는 없는 상태가 됐다. 같은 번호로 다시 인사하면 내 자리로 인정해야 한다.
  t('같은 대기조가 다시 인사하면 자기 자리로 인정', () => {
    const again = relayApi(B, 'relay-hello', { relayId: 'R1' });
    assert.equal(again.alreadyAlive, undefined);
    assert.equal(again.ok, true);
  });
  t('지난 대기조의 신호는 무시(수명 연장 방지)', () => {
    const r = relayApi(B, 'relay-ping', { relayId: 'R2', offset: 999 });
    assert.equal(r.ok, false);
    assert.notEqual(env.props.get('TG_OFFSET'), '999');
  });

  // 대기조가 살아 있으면 앱스스크립트 폴링은 텔레그램을 건드리지 않는다
  let polled = 0;
  env.tgReply = (method) => {
    if (method === 'getUpdates') { polled += 1; return { ok: true, result: [] }; }
    return { ok: true, result: {} };
  };
  B.pollUpdates();
  t('대기조가 살아 있으면 1분 폴링이 물러남', () => assert.equal(polled, 0));

  // 대기조가 명령을 넘기면 그대로 처리되고, 처리 지점이 기록된다
  const r = relayApi(B, 'relay-update', {
    relayId: 'R1',
    update: { update_id: 501, channel_post: { chat: { id: -1001 }, message_id: 3, text: '목록' } },
    offset: 502,
  });
  t('대기조가 넘긴 명령을 처리', () => assert.equal(r.result, 'ok'));
  t('대기조가 넘긴 명령이 실제로 답을 보냄', () => assert.equal(/등록된 도메인/.test(lastText(env)), true));
  t('처리 지점이 기록됨', () => assert.equal(env.props.get('TG_OFFSET'), '502'));

  // 대기조가 꺼지면 즉시 1분 방식으로 복귀한다
  relayApi(B, 'relay-bye', { relayId: 'R1', offset: 502 });
  B.pollUpdates();
  t('대기조 종료 후 1분 폴링이 복귀', () => assert.equal(polled, 1));
}
{
  // 하트비트가 끊기면(대기조가 죽으면) 90초 뒤 자동으로 1분 방식이 돌아온다
  const { env, B } = fresh(SEED);
  relayApi(B, 'relay-hello', { relayId: 'RX' });
  let polled = 0;
  env.tgReply = (method) => {
    if (method === 'getUpdates') { polled += 1; return { ok: true, result: [] }; }
    return { ok: true, result: {} };
  };
  B.pollUpdates();
  t('하트비트가 살아 있는 동안은 물러남', () => assert.equal(polled, 0));
  env.setNow('2026-08-28T12:02:00+09:00');     // 2분 뒤 = 하트비트 만료
  B.pollUpdates();
  t('하트비트가 끊기면 자동 복귀', () => assert.equal(polled, 1));
}

// ═══════════════════════════════════════════════════════════
// 12. 검증에서 지적된 결함 재현 방지
// ═══════════════════════════════════════════════════════════

// (1) 업체가 0곳일 때 [➕ 도메인 추가] — 셋업 첫 단계에서 막히던 문제
{
  const { env, B } = fresh();
  post(B, cbq('add'));
  t('업체 0곳: 업체 이름을 먼저 물어봄', () => assert.equal(/업체 이름을 보내주세요/.test(lastText(env)), true));
  post(B, msg('누드티비'));
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
  post(B, cbqLast(env, 'dx:0:1'));
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
  post(B, msg('업체삭제 누드티비'));
  post(B, { callback_query: { id: 'z', data: 'del', from: { id: 8, first_name: '최담당' }, message: { chat: { id: '-1001' }, message_id: 9 } } });
  t('글로 시작한 확인 중에도 다른 사람 차단', () => assert.equal(/작업 중입니다/.test(lastText(env)), true));
}

// (9) 매시간 트리거가 어긋나 점검 회차가 통째로 빠지던 문제
{
  const { env, B } = fresh(SEED);
  env.propStore.set('CHECK_HOURS', '9,21');
  env.setNow('2026-08-28T08:56:00+09:00');
  B.hourlyTick();
  t('08:56 에는 실행 안 함', () => assert.equal(checkRuns(env).length, 0));
  env.setNow('2026-08-28T10:02:00+09:00');
  B.hourlyTick();
  t('10:02 에 09시 회차를 보정 실행', () => assert.equal(checkRuns(env).length, 1));
  B.hourlyTick();
  t('보정 실행은 한 번만', () => assert.equal(checkRuns(env).length, 1));
  env.setNow('2026-08-28T13:00:00+09:00');
  B.hourlyTick();
  t('3시간 넘게 지난 회차는 다시 안 함', () => assert.equal(checkRuns(env).length, 1));
}

// (10) 리포트가 아주 길어도 결과 탭 기록이 멈추지 않아야 한다
{
  const { env, B } = fresh(SEED);
  let bigReport = '🌐 접속점검 결과\n🕒 x\n';
  for (let i = 0; i < 400; i++) bigReport += `\n\n<blockquote>〔업체${i}〕\n❌ domain-${i}-아주긴한글도메인이름.example.com — 접속실패(타임아웃)</blockquote>`;
  const rows = [['업체', '도메인', '상태', 'HTTP', '최종 접속주소', '응답(ms)', '점검시각', '비고'],
    ['누드티비', 'egg-1.com', '❌ 이상', '', '', 15000, 'x', '접속실패(타임아웃)']];
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
  post(B, msg('추가 누드티비 keep.com'));
  t('P열 메모 보존', () => {
    assert.equal(env.sheets.get('접속점검').rows[0][15], '운영 메모');
    assert.equal(env.sheets.get('접속점검').rows[1][15], '건드리면 안 됨');
  });
  t('그래도 도메인은 정상 추가', () => assert.equal(B.loadModel_()[0].domains.indexOf('keep.com') !== -1, true));
}

// (13) 삭제로 업체가 줄어도 옛 열이 남지 않는다
{
  const { env, B } = fresh([{ name: 'A', domains: ['a.com'] }, { name: 'B', domains: ['b.com'] }, { name: 'C', domains: ['c.com'] }]);
  post(B, msg('업체삭제 B'));
  post(B, cbqLast(env, 'codelok'));
  t('가운데 업체 삭제 후 목록이 정확', () => assert.deepEqual(B.loadModel_().map((c) => c.name), ['A', 'C']));
  t('삭제 후 도메인도 정확', () => assert.deepEqual(B.loadModel_().map((c) => c.domains), [['a.com'], ['c.com']]));
}

// (14) 되돌릴 게 없을 때 버튼
{
  const { env, B } = fresh(SEED);
  post(B, cbq('undo'));
  t('되돌릴 것 없으면 버튼도 안내', () => assert.equal(/되돌릴 내용이 없습니다/.test(lastText(env)), true));
}

// (15) 39개 초과 안내 문구가 실제 동작하는 명령인지 — 문구만 맞추고 끝내지 않는다
{
  const many = [];
  for (let i = 0; i < 60; i++) many.push('d' + i + '.com');
  const { env, B } = fresh([{ name: 'A', domains: many }]);
  post(B, cbq('del'));
  post(B, cbq('d:0'));
  const guide = lastText(env);
  t('안내 문구가 실제 명령 형태', () => assert.equal(/삭제 a\.com b\.com/.test(guide), true));
  t('안내 문구에 [여러 개 한 번에] 를 알려준다', () => assert.equal(/여러 개 한 번에/.test(guide), true));
  // 안내대로 따라 해서 진짜 지워지는지
  post(B, msg('삭제 d0.com d1.com'));
  t('안내대로 여러 개를 한 번에 지울 수 있다', () => {
    const d = B.loadModel_()[0].domains;
    assert.equal(d.indexOf('d0.com'), -1);
    assert.equal(d.indexOf('d1.com'), -1);
    assert.equal(d.length, 58);
  });
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
// 12-2. 여러 업체 × 여러 도메인 한 번에 (2026-09-05 에이든 지시)
// ═══════════════════════════════════════════════════════════
{
  const { env, B } = fresh(SEED);
  post(B, msg('짱구계열\nzz1.com\nzz2.com\n\n짱구2계열\nzz3.com'));
  t('붙여넣기 한 번으로 업체 2곳 + 주소 3개', () => {
    const m = B.loadModel_();
    assert.deepEqual(m.map((c) => c.name), ['누드티비', '파트너사', '짱구계열', '짱구2계열']);
    assert.deepEqual(m[2].domains, ['zz1.com', 'zz2.com']);
    assert.deepEqual(m[3].domains, ['zz3.com']);
  });
  t('새로 만든 업체를 분명히 알려준다', () => {
    const txt = lastText(env);
    assert.equal(/새 업체/.test(txt), true);
    assert.equal(/짱구계열/.test(txt), true);
  });
  t('되돌리기 한 번으로 대량등록 전체가 사라진다', () => {
    post(B, cbq('undo'));
    post(B, cbqLast(env, 'undook'));
    assert.deepEqual(B.loadModel_(), SEED);
  });
}
{
  const { env, B } = fresh(SEED);
  post(B, msg('누드티비 zz1.com 파트너사 zz2.com zz3.com'));
  t('한 줄에 옆으로 나열해도 업체별로 갈라 넣는다', () => {
    const m = B.loadModel_();
    assert.deepEqual(m[0].domains, ['egg-1.com', 'egg-5.com', 'zz1.com']);
    assert.deepEqual(m[1].domains, ['ya-1.com', 'zz2.com', 'zz3.com']);
    assert.equal(m.length, 2, '있는 업체를 또 만들면 안 된다');
  });
}
{
  const { env, B } = fresh(SEED);
  post(B, msg('추가 누드티비 zz1.com\n새업체 zz2.com'));
  t('글 명령 추가에서도 업체가 여러 곳이면 나눠 넣는다', () => {
    const m = B.loadModel_();
    assert.deepEqual(m[0].domains, ['egg-1.com', 'egg-5.com', 'zz1.com']);
    assert.deepEqual(m[2], { name: '새업체', domains: ['zz2.com'] });
  });
}
{
  const { env, B } = fresh(SEED);
  post(B, cbq('add'));
  post(B, cbqLast(env, 'a:0'));
  post(B, msg('가업체\nzz1.com\n\n나업체\nzz2.com'));
  t('주소 입력 단계에서 업체별 묶음을 붙여넣으면 그대로 나눠 넣는다', () => {
    const m = B.loadModel_();
    assert.deepEqual(m.map((c) => c.name), ['누드티비', '파트너사', '가업체', '나업체']);
    assert.deepEqual(m[0].domains, ['egg-1.com', 'egg-5.com'], '고른 업체엔 아무것도 안 들어가야 한다');
  });
  t('고른 업체 대신 넣었다는 사실을 알려준다', () => assert.equal(/대신/.test(lastText(env)), true));
}
{
  // 대량 작업의 이력은 한 줄, 백업도 한 번
  const { env, B } = fresh(SEED);
  post(B, msg('가업체\nzz1.com\nzz2.com\n\n나업체\nzz3.com'));
  t('여러 업체 등록도 이력 한 줄', () => {
    const rows = (env.sheets.get('이력') || { rows: [] }).rows.filter((r) => r[2] === '도메인 추가');
    assert.equal(rows.length, 1);
    assert.equal(/가업체/.test(rows[0][3]) && /나업체/.test(rows[0][3]), true);
  });
}
{
  // 채널 잡담 보호 — 업체 하나 + 주소 하나짜리 말은 여전히 무시한다
  const { env, B } = fresh(SEED);
  env.sent.length = 0;
  post(B, msg('오늘 egg-9.com 확인해줘'));
  t('잡담 속 주소 하나로는 업체를 만들지 않는다', () => {
    assert.equal(env.sent.length, 0);
    assert.deepEqual(B.loadModel_(), SEED);
  });
}
{
  const many = [];
  for (let i = 0; i < 15; i++) many.push({ name: '업체' + i, domains: [] });
  const { env, B } = fresh(many);
  post(B, msg('열여섯번째\nzz1.com'));
  t('업체 한도를 넘으면 그 묶음만 건너뛰고 알려준다', () => {
    assert.equal(B.loadModel_().length, 15);
  });
}

// ═══════════════════════════════════════════════════════════
// 12-3. 메뉴 패널 문구 — '그때 결과'가 '지금 개수'로 읽히던 오해
// ═══════════════════════════════════════════════════════════
{
  const { env, B } = fresh(SEED);
  env.propStore.set('LAST_RESULT_AT', '2026-08-28 11:00');
  env.propStore.set('LAST_RESULT_SUMMARY', '등록된 도메인 없음');
  post(B, msg('메뉴'));
  const txt = lastText(env);
  t('지금 개수와 점검 결과가 구분되게 보인다', () => {
    assert.equal(/도메인 3개/.test(txt), true, '지금 등록 개수가 그대로 보여야 한다');
    assert.equal(/그때 결과 · 등록된 도메인 없음/.test(txt), true);
  });
  t('목록을 고친 뒤 점검 안 했으면 알려준다', () =>
    assert.equal(/아직 점검하지 않았습니다/.test(txt), true));
}
{
  const { env, B } = fresh(SEED);
  env.propStore.set('LAST_RESULT_AT', '2099-01-01 00:00');
  env.propStore.set('LAST_RESULT_SUMMARY', '✅ 정상 2');
  post(B, msg('메뉴'));
  t('점검이 최신이면 재촉하지 않는다', () =>
    assert.equal(/아직 점검하지 않았습니다/.test(lastText(env)), false));
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
    ['추가 누드티비 zz1.com', /추가|이미 있음/],
    ['삭제 zz1.com', /삭제됨|등록되지 않은/],
    ['변경 egg-1.com zz2.com', /→|등록되지 않은/],
    ['이동 ya-1.com 누드티비', /→|그런 업체가 없습니다/],
    ['업체추가 테스트업체', /추가됨|이미 있는/],
    ['업체삭제 테스트업체', /삭제할까요|그런 업체가 없습니다/],
    ['이름변경 파트너사 파트너사2', /→|그런 업체가 없습니다/],
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
    // ★ 설명서 '여러 개를 한 번에' 표에 적힌 그대로 — 문서만 고치고 코드가 안 따라오는 일 방지
    ['추가 누드티비 zz1.com zz2.com zz3.com', /3개 추가/],
    ['삭제 egg-1.com egg-5.com', /2개 삭제/],
    ['이동 egg-1.com egg-5.com 파트너사', /2개 이동/],
    ['변경\negg-1.com zz8.com\negg-5.com zz9.com', /2개 변경/],
    ['업체추가 가업체\n나업체', /2곳 추가/],
    ['업체삭제 누드티비\n파트너사', /2곳을 도메인/],
    ['이름변경 누드티비 누드티비2\n파트너사 파트너사2', /2개 변경/],
    ['누드티비\nzz1.com\nzz2.com', /2개 추가/],
    ['zz1.com zz2.com', /어느 업체에/],
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
  const mainLabels = JSON.stringify(lastSent(e2).body.reply_markup);
  for (const label of ['🔍 지금 점검', '📋 목록 보기', '➕ 도메인 추가', '🗑 도메인 삭제',
    '🏢 업체 관리', '⚙️ 설정', '↩️ 되돌리기', '❓ 도움말']) {
    t(`문서 버튼 존재: ${label}`, () => {
      assert.equal(mainLabels.indexOf(label) !== -1, true);
      assert.equal(MANUAL.indexOf(label) !== -1, true, '설명서에 없음');
    });
  }
  post(B2, cbq('cfg'));
  const cfgLabels = JSON.stringify(lastSent(e2).body.reply_markup);
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
    const fns = ['setupAll', 'pollUpdates', 'getWebhookInfo', 'deleteWebhook', 'testRead', 'testChannel', 'applySchedule_', 'setupCommands', 'pinGuide', 'setupEdge', 'setupPolling'];
    const missing = fns.filter((f) => !new RegExp(`function\\s+${f}\\s*\\(`).test(GSRC) || SETUP.indexOf(f) === -1);
    assert.deepEqual(missing, []);
  });
}

// ═══════════════════════════════════════════════════════════
// 15. 대기조 — 설정과 코드가 어긋나면 '조용히 안 도는' 사고가 난다
// ═══════════════════════════════════════════════════════════
{
  const RELAY_JS = fs.readFileSync(new URL('../relay.js', import.meta.url), 'utf8');
  const WORKER_JS = fs.readFileSync(new URL('../worker/worker.js', import.meta.url), 'utf8');
  const RELAY_YML = fs.readFileSync(new URL('../.github/workflows/relay.yml', import.meta.url), 'utf8');
  const CHECK_YML = fs.readFileSync(new URL('../.github/workflows/check.yml', import.meta.url), 'utf8');
  const GS2 = fs.readFileSync(new URL('../apps-script/bridge.gs', import.meta.url), 'utf8');

  t('앱스스크립트가 깨우는 파일명이 실제 파일과 같다', () => {
    assert.equal(/RELAY_FILE', 'relay\.yml'/.test(GS2), true);
  });
  t('대기조 워크플로가 relay.js 를 실행', () => assert.equal(/node relay\.js/.test(RELAY_YML), true));
  t('대기조에 필요한 값 3개를 모두 넘김', () => {
    for (const k of ['BRIDGE_URL', 'BRIDGE_TOKEN', 'BOT_TOKEN']) {
      assert.equal(new RegExp(`\\n\\s+${k}:`).test(RELAY_YML), true, `${k} 없음`);
    }
  });
  // ★ 같은 concurrency 그룹을 쓰면 대기조가 도는 동안 '지금 점검'이 줄서서 멈춘다.
  t('대기조와 점검이 서로를 막지 않음(그룹 분리)', () => {
    const g = (y) => (y.match(/group:\s*(\S+)/) || [])[1];
    assert.notEqual(g(RELAY_YML), undefined);
    assert.notEqual(g(RELAY_YML), g(CHECK_YML));
  });
  // ★ relay.js 가 스스로 끝나는 시간보다 워크플로 제한이 짧으면 매번 '실패'로 끝난다.
  // ★ 하트비트는 302(넘김)만 받아도 성공으로 본다 — 임시주소 404 로 죽던 사고(2026-09-05) 차단
  t('하트비트는 넘김(302)만 받아도 성공으로 본다', () => {
    assert.equal(/redirect: 'manual'/.test(RELAY_JS), true);
    assert.equal(/res\.status >= 200 && res\.status < 400/.test(RELAY_JS), true);
  });
  // ★ 2026-09-05 실측: 넘김(302)을 fetch 에게 맡기면 본문이 사라진 채 doGet 으로 들어가
  //   {"ok":false,"error":"unauthorized"} 가 돌아오고, 대기조가 이를 '거절'로 오해해 종료했다.
  t('넘김을 직접 판단한다(fetch 에게 맡기지 않는다)', () => {
    assert.equal(/redirect: 'manual'/.test(RELAY_JS), true);
    assert.equal(/loc\.indexOf\('\/exec'\)/.test(RELAY_JS), true);
  });
  t("본문이 사라져 생긴 'unauthorized' 는 답으로 인정하지 않는다", () => {
    assert.equal(/unauthorized\/i\.test/.test(RELAY_JS), true);
  });
  // ★ 즉답기(워커)도 같은 302 함정을 피해야 한다 — 같은 사고를 두 번 겪지 않게 고정한다
  t('즉답기도 넘김을 직접 판단한다', () => {
    assert.equal(/redirect: 'manual'/.test(WORKER_JS), true);
    assert.equal(/loc\.indexOf\('\/exec'\)/.test(WORKER_JS), true);
    assert.equal(/unauthorized\/i\.test/.test(WORKER_JS), true);
  });
  t('즉답기가 텔레그램에 즉시 200 을 돌려준다', () => {
    assert.equal(/ctx\.waitUntil\(handleUpdate/.test(WORKER_JS), true);
    assert.equal(/new Response\('ok', \{ status: 200 \}\)/.test(WORKER_JS), true);
  });
  t('즉답기가 구글보다 먼저 버튼에 답한다', () => {
    const at = WORKER_JS.indexOf("'answerCallbackQuery'");
    const fwd = WORKER_JS.indexOf("action: 'edge'");
    assert.equal(at !== -1 && at < fwd, true);
  });
  t('즉답기는 텔레그램이 보낸 것만 받는다', () => {
    assert.equal(/X-Telegram-Bot-Api-Secret-Token/.test(WORKER_JS), true);
    assert.equal(/!env\.WEBHOOK_SECRET \|\|/.test(WORKER_JS), true, '암호가 없으면 아예 거부해야 한다');
  });
  t('즉답기 로그에 비밀값·내용이 남지 않는다', () => {
    const logs = WORKER_JS.match(/console\.log\(([^;]*)\)/g) || [];
    const leaky = logs.filter((l) => /update|\.text|chat|JSON\.stringify|TOKEN/.test(l));
    assert.deepEqual(leaky, []);
  });
  t('브리지가 GET 에 잠금값을 요구한다(사라진 본문이 통과하지 못하게)', () => {
    const at = GS2.indexOf('function doGet');
    assert.equal(/authorized_\(e\)/.test(GS2.slice(at, at + 300)), true);
  });
  // ★ 즉답 — 구글에 넘기기 '전에' 버튼에 먼저 답해야 체감이 빨라진다
  t('대기조가 구글보다 먼저 버튼에 답한다', () => {
    const at = RELAY_JS.indexOf('answerNow(u.callback_query.id)');
    const fwd = RELAY_JS.indexOf("bridge('relay-update'");
    assert.equal(at !== -1 && at < fwd, true, '즉답이 전달보다 먼저여야 한다');
  });
  t('즉답 사실을 구글에 알려 중복 응답을 막는다', () => {
    assert.equal(/preAnswered: pre/.test(RELAY_JS), true);
    assert.equal(/if \(PRE_ANSWERED\) return;/.test(GS2), true);
  });
  t('즉답은 기다리지 않고 쏘아 보낸다(처리를 늦추지 않게)', () => {
    assert.equal(/await answerNow/.test(RELAY_JS), false);
  });
  // ★ 2026-09-05 실측 사고 — 점검이 "시트 브리지 read 오류: unauthorized" 로 통째로 실패.
  //   POST 는 성공했는데(doPost 4.4초) 302 임시 답 주소에서 답을 못 받아 대체 GET 으로 넘어갔고,
  //   그 GET 이 한국 VPN 을 지나며 잘려 잠금값 없이 doGet 이 실행됐다.
  {
    const CHECK_JS = fs.readFileSync(new URL('../check.js', import.meta.url), 'utf8');
    t('점검도 넘김을 자동으로 따라가지 않는다(본문이 사라지는 길)', () => {
      assert.equal(/redirect: 'manual'/.test(CHECK_JS), true);
      assert.equal(/loc\.includes\('\/exec'\)/.test(CHECK_JS), true);
    });
    t('점검도 한 번 삐끗하면 다시 시도한다', () => {
      assert.equal(/BRIDGE_TRIES\s*=\s*[2-9]/.test(CHECK_JS), true);
      assert.equal(/for \(let i = 1; i <= BRIDGE_TRIES/.test(CHECK_JS), true);
    });
    t('본문이 사라진 unauthorized 를 다시 시도로 본다', () => {
      assert.equal(/unauthorized\/i\.test/.test(CHECK_JS), true);
    });
    t('점검이 잠금값을 URL 에 붙이지 않는다(비밀값 노출·차단 경로 제거)', () => {
      assert.equal(/token=\$\{encodeURIComponent/.test(CHECK_JS), false);
      assert.equal(/function bridgeUrl\(/.test(CHECK_JS), false);
    });
    t('세 번 다 실패하면 어디를 봐야 하는지 알려준다', () => {
      assert.equal(/SHEET_BRIDGE_TOKEN 과 앱스스크립트 ACCESS_TOKEN/.test(CHECK_JS), true);
    });
  }
  // ★ 에이든 지시(2026-09-05) — '잠시만요!' 팝업 문구는 즉답기·대기조가 같아야 한다
  t("즉답 팝업 문구가 '⏳ 잠시만요!' 로 같다", () => {
    const w = (WORKER_JS.match(/text: '([^']*잠시만요[^']*)'/) || [])[1];
    const r = (RELAY_JS.match(/text: '([^']*잠시만요[^']*)'/) || [])[1];
    assert.equal(w, '⏳ 잠시만요!');
    assert.equal(r, '⏳ 잠시만요!');
  });
  // ★ 설치 함수는 편집기 선택 상자를 못 믿어 속성으로 실행한다 — 문서와 코드가 같은 값이어야 한다
  t('설명서의 PENDING_SETUP 값이 코드에 다 있다', () => {
    const SETUP_MD = fs.readFileSync(new URL('../SETUP.md', import.meta.url), 'utf8');
    const doc = (SETUP_MD.match(/`PENDING_SETUP` \| `(\w+)`|〃 \| `(\w+)`/g) || [])
      .map((x) => (x.match(/`(\w+)`$/) || [])[1]).filter(Boolean);
    assert.equal(doc.length >= 4, true, '설명서에 값 목록이 없다');
    const at = GS2.indexOf('function runPendingSetup_');
    const body = GS2.slice(at, at + 900);
    for (const v of doc) assert.equal(body.indexOf("'" + v + "'") !== -1, true, v + ' 를 코드가 모른다');
  });
  t('대기조가 한 번 깨면 충분히 오래 살아 있다', () => {
    const idle = Number((RELAY_JS.match(/IDLE_MINUTES \|\| (\d+)/) || [])[1]);
    assert.equal(idle >= 20, true, `조용해지면 끄는 시간 ${idle}분은 너무 짧다`);
  });
  t('워크플로 제한이 자체 종료 시간보다 길다', () => {
    const limit = Number((RELAY_YML.match(/timeout-minutes:\s*(\d+)/) || [])[1]);
    const self = Number((RELAY_JS.match(/HARD_STOP_MS\s*=\s*(\d+)/) || [])[1]);
    assert.equal(limit > self, true, `${limit}분 <= ${self}분`);
  });
  // ★ 저장소가 공개다 — 실행 기록에 메시지 내용·주소·chat_id 가 남으면 안 된다.
  t('대기조 로그에 메시지 내용을 찍지 않음', () => {
    const logs = RELAY_JS.match(/console\.log\(([^;]*)\)/g) || [];
    const leaky = logs.filter((l) => /\bu\b|\.text|chat|update\.|JSON\.stringify|list\[/.test(l));
    assert.deepEqual(leaky, []);
  });
  t('대기조가 토큰을 로그에 남기지 않게 가림', () => {
    assert.equal(/BOT_TOKEN\)\.join\('\*\*\*'\)/.test(RELAY_JS), true);
    assert.equal(/BRIDGE_TOKEN\)\.join\('\*\*\*'\)/.test(RELAY_JS), true);
  });
  t('대기조는 브리지를 POST 로 부른다(한국 경유 GET 404 사고 재발 방지)', () => {
    assert.equal(/method: 'POST'/.test(RELAY_JS), true);
  });
  // ★ 배포 직후 첫 응답 지연으로 대기조가 헛되이 물러나던 사고(2026-09-05) 재발 방지
  t('대기조가 고유번호를 붙여 보낸다', () => assert.equal(/relayId: RELAY_ID/.test(RELAY_JS), true));
  t('대기조가 첫 인사를 여러 번 시도한다', () => assert.equal(/attempt <= 3/.test(RELAY_JS), true));
  // ★ 2026-09-05 실측 사고: 브리지가 이따금 HTTP 404 를 돌려주는데(302 임시주소 문제),
  //   그걸 실패로 보고 대기조를 통째로 종료해 몇 분 만에 죽었다 → 반응이 10~20초로 되돌아갔다.
  t('브리지 호출은 한 번 삐끗해도 다시 시도한다', () => {
    assert.equal(/BRIDGE_TRIES\s*=\s*[2-9]/.test(RELAY_JS), true);
    assert.equal(/for \(var i = 1; i <= BRIDGE_TRIES/.test(RELAY_JS), true);
  });
  t('하트비트 한 번 실패로 대기조가 죽지 않는다', () => {
    assert.equal(/pingFails \+= 1/.test(RELAY_JS), true);
    assert.equal(/pingFails >= PING_FAIL_LIMIT/.test(RELAY_JS), true);
  });
  t("'살아있음' 표시가 하트비트 주기보다 충분히 길되 너무 길지 않다", () => {
    const alive = Number((GS2.match(/RELAY_ALIVE_MS\s*=\s*(\d+)/) || [])[1]);
    const poll = Number((RELAY_JS.match(/LONG_POLL_S\s*=\s*(\d+)/) || [])[1]) * 1000;
    assert.equal(alive > poll * 2, true, `${alive}ms 는 하트비트 주기 ${poll}ms 에 비해 너무 짧다`);
    assert.equal(alive <= 60000, true, `${alive}ms 는 너무 길다 — 죽은 뒤 공백이 길어진다`);
  });
  t('브리지가 고유번호로 주인을 가린다', () => assert.equal(/function relayOwner_/.test(GS2), true));
  // ★ 반응 속도 — 설정값을 요청마다 통째로 한 번만 읽는다(2026-09-05)
  t('새 요청마다 설정값 기억을 비운다', () => {
    for (const fn of ['function doPost', 'function doGet', 'function pollUpdates', 'function hourlyTick', 'function watchdog']) {
      const at = GS2.indexOf(fn);
      assert.notEqual(at, -1, fn + ' 없음');
      assert.equal(/PROP_MEMO = null/.test(GS2.slice(at, at + 400)), true, fn + ' 에 기억 비우기 없음');
    }
  });
  // ★ 빈 값 속성은 앱스스크립트 설정 화면을 잠근다(다른 속성까지 저장 불가)
  t('속성에 빈 값을 저장하지 않는다', () => {
    assert.equal(/setProp_\('RELAY_ID', ''\)/.test(GS2), false);
  });
  t('고치면 목록 캐시를 반드시 버린다', () => {
    for (const fn of ['function saveModel_', 'function undo_']) {
      const at = GS2.indexOf(fn);
      assert.equal(/invalidateModel_\(\)/.test(GS2.slice(at, at + 400)), true, fn + ' 에 캐시 버리기 없음');
    }
  });
}

// ═══════════════════════════════════════════════════════════
// 12. 대량 입력 — 옆으로 나열하든 한 줄에 하나씩이든 (2026-09-05 에이든 지시)
//   ★ 예전엔 조각 하나만 주소가 아니어도 메시지 전체를 조용히 버렸다.
//     "붙여넣었는데 아무 반응이 없다"의 진짜 원인 — 그 회귀를 여기서 막는다.
// ═══════════════════════════════════════════════════════════
{
  const { env, B } = fresh(SEED);
  post(B, msg('n1.com n2.com n3.com'));
  t('옆으로 나열: 어느 업체에 넣을지 묻는다', () => assert.equal(/주소 3개를 어느 업체에/.test(lastText(env)), true));
  post(B, cbqLast(env, 'a:0'));
  t('옆으로 나열: 고른 업체에 3개 다 들어간다', () =>
    assert.deepEqual(B.loadModel_()[0].domains, ['egg-1.com', 'egg-5.com', 'n1.com', 'n2.com', 'n3.com']));
}
{
  const { env, B } = fresh(SEED);
  post(B, msg('n1.com\nn2.com\nn3.com'));
  post(B, cbqLast(env, 'a:1'));
  t('한 줄에 하나씩: 그대로 다 들어간다', () =>
    assert.deepEqual(B.loadModel_()[1].domains, ['ya-1.com', 'n1.com', 'n2.com', 'n3.com']));
}
{
  const { env, B } = fresh(SEED);
  post(B, msg('누드티비\nn1.com\nn2.com'));
  t('맨 윗줄이 업체 이름이면 곧바로 그 업체에 넣는다', () =>
    assert.deepEqual(B.loadModel_()[0].domains, ['egg-1.com', 'egg-5.com', 'n1.com', 'n2.com']));
  t('물어보지 않고 바로 결과를 준다', () => assert.equal(/2개 추가/.test(lastText(env)), true));
}
{
  // ★ 회귀 방지 — 오타 하나 때문에 전부 사라지던 사고
  const { env, B } = fresh(SEED);
  post(B, msg('n1.com bb..com n2.com'));
  t('오타가 섞여도 조용히 사라지지 않는다', () => assert.equal(/어느 업체에/.test(lastText(env)), true));
  post(B, cbqLast(env, 'a:0'));
  const after = B.loadModel_()[0].domains;
  t('오타는 건너뛰고 나머지는 등록된다', () => {
    assert.equal(after.indexOf('n1.com') !== -1, true);
    assert.equal(after.indexOf('n2.com') !== -1, true);
    assert.equal(after.length, 4);
  });
  t('건너뛴 것을 알려준다', () => assert.equal(/형식이 아님/.test(lastText(env)), true));
}
{
  const { env, B } = fresh(SEED);
  post(B, msg('추가 누드티비 n1.com n2.com n3.com'));
  t('글 명령 한 줄로 여러 개 추가', () => assert.equal(B.loadModel_()[0].domains.length, 5));
  post(B, msg('추가 파트너사\nn4.com\nn5.com'));
  t('글 명령 + 줄바꿈 목록으로 여러 개 추가', () => assert.equal(B.loadModel_()[1].domains.length, 3));
}
{
  const { env, B } = fresh([{ name: '우리 회사', domains: ['a.com'] }]);
  post(B, msg('추가 우리 회사 z1.com z2.com'));
  t('업체 이름에 띄어쓰기가 있어도 알아듣는다', () => {
    const m = B.loadModel_();
    assert.equal(m.length, 1);
    assert.deepEqual(m[0].domains, ['a.com', 'z1.com', 'z2.com']);
  });
}
{
  const { env, B } = fresh(SEED);
  post(B, msg('삭제 egg-1.com egg-5.com'));
  t('글 명령으로 여러 개 한 번에 삭제', () => assert.deepEqual(B.loadModel_()[0].domains, []));
  t('대량 삭제도 되돌리기를 안내한다', () => assert.equal(/되돌리기/.test(lastText(env)), true));
  post(B, cbq('undo'));
  post(B, cbqLast(env, 'undook'));
  t('대량 삭제를 한 번에 되돌린다(백업도 한 번만)', () =>
    assert.deepEqual(B.loadModel_()[0].domains, ['egg-1.com', 'egg-5.com']));
}
{
  const dup = [{ name: 'A', domains: ['same.com', 'a1.com'] }, { name: 'B', domains: ['same.com'] }];
  const { env, B } = fresh(dup);
  post(B, msg('삭제 same.com a1.com A'));
  t('대량 삭제에 업체를 지정하면 그 업체에서만 지운다', () => {
    const m = B.loadModel_();
    assert.deepEqual(m[0].domains, []);
    assert.deepEqual(m[1].domains, ['same.com']);
  });
}
{
  const dup = [{ name: 'A', domains: ['same.com'] }, { name: 'B', domains: ['same.com', 'b1.com'] }];
  const { env, B } = fresh(dup);
  post(B, msg('삭제 same.com b1.com'));
  t('여러 업체에 있는 주소는 지우지 않고 알려준다', () => {
    const m = B.loadModel_();
    assert.deepEqual(m[0].domains, ['same.com']);
    assert.deepEqual(m[1].domains, ['same.com']);
    assert.equal(/여러 업체에 있음/.test(lastText(env)), true);
  });
}
{
  // 버튼만으로 여러 개 삭제 — 담당자는 버튼으로만 조작한다
  const { env, B } = fresh([{ name: 'A', domains: ['a1.com', 'a2.com', 'a3.com', 'a4.com'] }]);
  post(B, cbq('del'));
  post(B, cbqLast(env, 'd:0'));
  t('업체 화면에 [여러 개 한 번에] 버튼이 있다', () => {
    const kb = lastSent(env).body.reply_markup.inline_keyboard;
    assert.equal(JSON.stringify(kb).indexOf('"dm:0"') !== -1, true);
  });
  post(B, cbqLast(env, 'dm:0'));
  t('버튼 대량삭제: 주소를 물어본다', () => assert.equal(/지울 주소를 보내주세요/.test(lastText(env)), true));
  post(B, msg('a1.com a3.com'));
  t('버튼 대량삭제: 지우기 전에 확인을 묻는다', () => {
    assert.equal(/2개를 지울까요/.test(lastText(env)), true);
    assert.equal(B.loadModel_()[0].domains.length, 4);
  });
  post(B, cbqLast(env, 'dmok'));
  t('버튼 대량삭제: 확인 후 지워진다', () => assert.deepEqual(B.loadModel_()[0].domains, ['a2.com', 'a4.com']));
}
{
  // 지난 확인 버튼(위로 스크롤해 누른 것)이 엉뚱하게 지우지 않는다
  const { env, B } = fresh([{ name: 'A', domains: ['a1.com', 'a2.com'] }]);
  post(B, cbq('del'));
  post(B, cbqLast(env, 'd:0'));
  post(B, cbqLast(env, 'dm:0'));
  post(B, msg('a1.com'));
  post(B, cbq('dmok', '-1001', 9));   // 옛 메시지의 버튼
  t('지난 확인 버튼은 대량삭제도 막는다', () => {
    assert.equal(/지난 확인 버튼/.test(lastText(env)), true);
    assert.equal(B.loadModel_()[0].domains.length, 2);
  });
}
{
  const { env, B } = fresh([{ name: 'A', domains: ['a1.com', 'a2.com'] }, { name: 'B', domains: [] }]);
  post(B, msg('이동 a1.com a2.com B'));
  t('여러 개를 한 번에 다른 업체로 옮긴다', () => {
    const m = B.loadModel_();
    assert.deepEqual(m[0].domains, []);
    assert.deepEqual(m[1].domains, ['a1.com', 'a2.com']);
  });
}
{
  const { env, B } = fresh([{ name: 'A', domains: ['a1.com', 'a2.com'] }]);
  post(B, msg('변경\na1.com x1.com\na2.com x2.com'));
  t('여러 짝을 한 번에 갈아끼운다', () => assert.deepEqual(B.loadModel_()[0].domains, ['x1.com', 'x2.com']));
  post(B, msg('변경 x1.com'));
  t('짝이 안 맞으면 어떻게 쓰는지 알려준다', () => assert.equal(/짝<\/b>으로|짝/.test(lastText(env)), true));
}
{
  const { env, B } = fresh(SEED);
  post(B, msg('업체추가 가업체\n나업체\n다업체'));
  t('업체를 한 줄에 하나씩 여러 곳 추가', () => assert.deepEqual(B.loadModel_().map((c) => c.name), ['누드티비', '파트너사', '가업체', '나업체', '다업체']));
  t('업체 대량추가 결과를 줄줄이 알려준다', () => assert.equal(/3곳 추가/.test(lastText(env)), true));
}
{
  const { env, B } = fresh([{ name: 'A', domains: ['a.com'] }, { name: 'B', domains: ['b.com'] }, { name: 'C', domains: ['c.com'] }]);
  post(B, msg('업체삭제 A\nC'));
  t('업체 대량삭제도 확인을 먼저 묻는다', () => {
    assert.equal(/2곳을 도메인 2개와 함께 삭제할까요/.test(lastText(env)), true);
    assert.equal(B.loadModel_().length, 3);
  });
  post(B, cbqLast(env, 'codelok'));
  t('확인 한 번으로 여러 업체가 지워진다', () => assert.deepEqual(B.loadModel_().map((c) => c.name), ['B']));
}
{
  const { env, B } = fresh([{ name: 'A', domains: [] }, { name: 'B', domains: [] }]);
  post(B, msg('이름변경 A 에이\nB 비이'));
  t('업체 이름을 여러 개 한 번에 바꾼다', () => assert.deepEqual(B.loadModel_().map((c) => c.name), ['에이', '비이']));
}
{
  // 대량 작업이 이력을 폭주시키지 않는다(한 줄로 남는다)
  const { env, B } = fresh(SEED);
  const addLogs = () => ((env.sheets.get('이력') || { rows: [] }).rows).filter((r) => r[2] === '도메인 추가');
  post(B, msg('추가 누드티비 n1.com n2.com n3.com n4.com n5.com'));
  t('대량 추가의 이력은 한 줄', () => assert.equal(addLogs().length, 1));
  t('대량 추가 이력에 무엇을 넣었는지 다 남는다', () => assert.equal(/n1\.com, n2\.com, n3\.com, n4\.com, n5\.com/.test(addLogs()[0][3]), true));
}
{
  // 채널 잡담에 끼어들지 않는다 — 대량 지원 때문에 수다에 반응하면 안 된다
  const { env, B } = fresh(SEED);
  env.sent.length = 0;
  post(B, msg('오늘 점심 뭐 먹지'));
  t('잡담에는 아무 말도 하지 않는다', () => assert.equal(env.sent.length, 0));
  post(B, msg('egg-9.com 확인해줘'));
  t('주소 하나 + 잡담도 조용히 넘긴다', () => assert.equal(env.sent.length, 0));
}
{
  const { env, B } = fresh(SEED);
  post(B, cbq('add'));
  post(B, cbqLast(env, 'a:0'));
  post(B, msg('n1.com n2.com\nn3.com,n4.com'));
  t('주소 입력 단계에서 띄어쓰기·줄바꿈·쉼표 섞여도 다 받는다', () =>
    assert.equal(B.loadModel_()[0].domains.length, 6));
}
{
  const { env, B } = fresh(SEED);
  post(B, cbq('co'));
  post(B, cbqLast(env, 'coa'));
  post(B, msg('가업체\n나업체'));
  t('업체 이름 입력 단계에서도 여러 줄이면 여러 곳을 만든다', () =>
    assert.deepEqual(B.loadModel_().map((c) => c.name), ['누드티비', '파트너사', '가업체', '나업체']));
}
{
  const { env, B } = fresh(SEED);
  post(B, cbq('add'));
  post(B, cbqLast(env, 'an'));
  post(B, msg('새업체\nn1.com\nn2.com'));
  t('새 업체 이름 + 주소를 한 번에 붙여넣어도 끝까지 간다', () => {
    const m = B.loadModel_();
    assert.equal(m.length, 3);
    assert.deepEqual(m[2], { name: '새업체', domains: ['n1.com', 'n2.com'] });
  });
}
{
  // 한도(업체당 200개)를 넘겨도 앞부분은 살아남고, 넘친 것만 알려준다
  const full = [];
  for (let i = 0; i < 199; i++) full.push('f' + i + '.com');
  const { env, B } = fresh([{ name: 'A', domains: full }]);
  post(B, msg('추가 A over1.com over2.com over3.com'));
  t('한도를 넘겨도 통째로 실패하지 않는다', () => assert.equal(B.loadModel_()[0].domains.length, 200));
  t('한도 때문에 못 넣은 것을 알려준다', () => assert.equal(/최대 200개까지/.test(lastText(env)), true));
}
{
  const many = [];
  for (let i = 0; i < 100; i++) many.push('m' + i + '.com');
  const { env, B } = fresh(SEED);
  post(B, msg('추가 누드티비 ' + many.join(' ')));
  t('수백 개를 넣어도 다 등록된다', () => assert.equal(B.loadModel_()[0].domains.length, 102));
  t('답이 끝없이 길어지지 않게 줄인다', () => assert.equal(/외 70개/.test(lastText(env)), true));
}

// ═══════════════════════════════════════════════════════════
const total = pass + fail;
if (fail) {
  console.error(`\n❌ bridge 실동작 검증 실패 ${fail}건 / 전체 ${total}건\n`);
  for (const f of failures) console.error('  · ' + f);
  process.exit(1);
}
console.log(`✅ bridge 실동작 검증 ${pass}/${total} 통과`);
