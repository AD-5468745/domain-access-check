// 사용법-담당자용.html → 누드TV-접속점검-사용법.pdf  (워터마크는 HTML 안에 있다)
//   npm i --no-save playwright && npx playwright install chromium
//   node tools/manual-pdf.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = process.argv[2] || path.join(here, '..', '사용법-담당자용.html');
const out = process.argv[3] || path.join(here, '..', '누드TV-접속점검-사용법.pdf');

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto('file://' + path.resolve(src), { waitUntil: 'networkidle' });
await page.pdf({
  path: out, format: 'A4', printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  // 쪽번호만 넣는다 — 이 자리에는 한글 글꼴이 안 먹는 경우가 있어 숫자만 쓴다
  footerTemplate: '<div style="width:100%;font-size:8px;color:#7d998e;padding:0 14mm;text-align:right;font-family:sans-serif;">'
    + '<span class="pageNumber"></span> / <span class="totalPages"></span></div>',
  margin: { top: '16mm', bottom: '14mm', left: '14mm', right: '14mm' },
});
await browser.close();
console.log('만들었습니다:', out);
