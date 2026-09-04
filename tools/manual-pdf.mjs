// 사용법-담당자용.html → 누드TV-접속점검-사용법.pdf
//   머리글·꼬리글은 인쇄 여백에 그린다(본문을 가리지 않고 모든 쪽에 찍힌다)
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = process.argv[2] || path.join(here, '..', '사용법-담당자용.html');
const out = process.argv[3] || path.join(here, '..', '누드TV-접속점검-사용법.pdf');
const F = "'Noto Sans CJK KR','Noto Sans KR',sans-serif";

const header = `<div style="width:100%;font-family:${F};font-size:9px;padding:0 14mm;
  display:flex;align-items:center;border-bottom:1.6px solid #0FA36B;padding-bottom:4px;">
  <span style="width:9px;height:9px;border-radius:3px;background:#0FA36B;display:inline-block;margin-right:5px;"></span>
  <b style="color:#0B7A50;font-size:10.5px;letter-spacing:-.2px;">누드TV</b>
  <span style="margin-left:auto;color:#7d998e;">내부자료 · 무단 배포 금지</span></div>`;

const footer = `<div style="width:100%;font-family:${F};font-size:8px;color:#7d998e;padding:0 14mm;
  display:flex;align-items:center;border-top:1px solid #e3efe9;padding-top:4px;">
  <span>누드TV 접속점검 · 담당자용 사용법</span>
  <b style="margin-left:auto;color:#0B7A50;">다른 곳에 옮기거나 배포하지 마세요</b>
  <span style="margin-left:14px;"><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'],
});
const page = await browser.newPage();
await page.goto('file://' + path.resolve(src), { waitUntil: 'networkidle' });
await page.pdf({
  path: out, format: 'A4', printBackground: true,
  displayHeaderFooter: true, headerTemplate: header, footerTemplate: footer,
  margin: { top: '24mm', bottom: '20mm', left: '14mm', right: '14mm' },
});
await browser.close();
console.log('만들었습니다:', out);
