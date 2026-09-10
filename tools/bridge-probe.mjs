// 브리지 '답 받아오기'만 실제 코드로 시험한다 (read 전용 — 시트를 바꾸지 않는다).
// ★ 답의 내용은 절대 찍지 않는다. 공개 로그이므로 크기(바이트)만 남긴다.
import { bridgeFetch } from '../check.js';

const URL_ = process.env.SHEET_BRIDGE_URL || '';
const TOK = process.env.SHEET_BRIDGE_TOKEN || '';
const N = Number(process.env.PROBE_TRIES || 8);
if (!URL_ || !TOK) { console.error('설정 없음'); process.exit(1); }

let ok = 0, bad = 0;
for (let i = 1; i <= N; i++) {
  const t0 = Date.now();
  try {
    const res = await bridgeFetch(URL_, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOK, action: 'read' }),
    }, 60000);
    const text = await res.text();
    let good = false;
    try { good = JSON.parse(text).ok === true; } catch { good = false; }
    if (good) ok++; else bad++;
    console.log(`  ${i}) ${res.status} · ${text.length}바이트 · ${Date.now() - t0}ms · ${good ? '정상' : '이상'}`);
  } catch (e) {
    bad++;
    console.log(`  ${i}) 실패: ${String(e.message).slice(0, 80)} · ${Date.now() - t0}ms`);
  }
  await new Promise((r) => setTimeout(r, 1500));
}
console.log(`결과: 성공 ${ok} / 실패 ${bad}`);
const sum = process.env.GITHUB_STEP_SUMMARY;
if (sum) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(sum, `## ${process.env.PROBE_TITLE || '실제 코드로 읽기'}\n- **성공 ${ok} / 실패 ${bad}** (${N}회)\n\n`);
}
process.exitCode = bad > 0 ? 1 : 0;
