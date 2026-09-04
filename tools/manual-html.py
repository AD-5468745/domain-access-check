# -*- coding: utf-8 -*-
"""
사용법-담당자용.md  →  누드TV 워터마크가 들어간 인쇄용 HTML

  python3 tools/manual-html.py                 (기본 경로)
  python3 tools/manual-html.py 입력.md 출력.html

★ 워터마크는 본문 '뒤'에 깔린다(#wm 이 z-index:0, 본문이 z-index:1).
  position:fixed 라서 크롬이 인쇄할 때 모든 쪽에 똑같이 반복된다.

PDF 로 바꾸기 — 크롬(또는 playwright)이 있는 곳에서:
  node tools/manual-pdf.mjs
  # 또는 크롬만 있을 때
  chrome --headless --no-pdf-header-footer \
         --print-to-pdf="누드TV-접속점검-사용법.pdf" 사용법-담당자용.html

※ 한글이 깨지면 그 컴퓨터에 한글 글꼴(Noto Sans CJK KR)을 먼저 깔아야 한다.
"""
import io, re, html, os

import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '..', '사용법-담당자용.md')
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, '..', '사용법-담당자용.html')
md = io.open(SRC, encoding='utf-8').read()

def inline(s):
    s = html.escape(s)
    s = re.sub(r'`([^`]+)`', r'<code>\1</code>', s)
    s = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', s)
    return s

# ★ 어느 항목부터 새 쪽에서 시작할지 (에이든 지정 2026-09-05)
#   5·6·7 은 한 쪽에, 8·9 도 한 쪽에 모은다.
NEWPAGE = {1, 2, 3, 4, 5, 8}

out = []
lines = md.split('\n')
i = 0
in_code = False
code_buf = []
while i < len(lines):
    ln = lines[i]
    if ln.startswith('```'):
        if in_code:
            out.append('<pre>' + html.escape('\n'.join(code_buf)) + '</pre>')
            code_buf = []; in_code = False
        else:
            in_code = True
        i += 1; continue
    if in_code:
        code_buf.append(ln); i += 1; continue

    if ln.strip() == '---':
        out.append('<hr>'); i += 1; continue
    m = re.match(r'^(#{1,4})\s+(.*)$', ln)
    if m:
        lvl = len(m.group(1))
        txt = m.group(2)
        cls = ''
        if lvl == 2:
            num = re.match(r'^(\d+)\.', txt)
            cls = ' class="np"' if (num and int(num.group(1)) in NEWPAGE) else ' class="cont"'
        out.append('<h%d%s>%s</h%d>' % (lvl, cls, inline(txt), lvl)); i += 1; continue
    # 표
    if ln.startswith('|') and i + 1 < len(lines) and re.match(r'^\|[\s:\-|]+\|$', lines[i+1].strip()):
        head = [c.strip() for c in ln.strip().strip('|').split('|')]
        i += 2
        rows = []
        while i < len(lines) and lines[i].startswith('|'):
            rows.append([c.strip() for c in lines[i].strip().strip('|').split('|')])
            i += 1
        t = ['<table><thead><tr>'] + ['<th>%s</th>' % inline(c) for c in head] + ['</tr></thead><tbody>']
        for r in rows:
            t.append('<tr>' + ''.join('<td>%s</td>' % inline(c) for c in r) + '</tr>')
        t.append('</tbody></table>')
        out.append(''.join(t)); continue
    # 인용
    if ln.startswith('> '):
        buf = []
        while i < len(lines) and (lines[i].startswith('> ') or lines[i].strip() == '>'):
            buf.append(lines[i][2:] if len(lines[i]) > 2 else '')
            i += 1
        out.append('<blockquote>' + '<br>'.join(inline(b) for b in buf) + '</blockquote>'); continue
    # 목록
    if re.match(r'^(\d+\.|[-*])\s+', ln):
        ordered = bool(re.match(r'^\d+\.', ln))
        tag = 'ol' if ordered else 'ul'
        items = []
        while i < len(lines) and re.match(r'^(\d+\.|[-*])\s+', lines[i]):
            items.append(re.sub(r'^(\d+\.|[-*])\s+', '', lines[i]))
            i += 1
        out.append('<%s>' % tag + ''.join('<li>%s</li>' % inline(x) for x in items) + '</%s>' % tag)
        continue
    if ln.strip() == '':
        i += 1; continue
    para = [ln]
    i += 1
    while i < len(lines) and lines[i].strip() and not re.match(r'^(#{1,4}\s|\||```|>\s|---$|\d+\.\s|[-*]\s)', lines[i]):
        para.append(lines[i]); i += 1
    out.append('<p>' + '<br>'.join(inline(p) for p in para) + '</p>')

body = '\n'.join(out)

# ── 표지: 제목 + 머리말 + 목차 ────────────────────────────
titles = re.findall(r'<h2[^>]*>(.*?)</h2>', body)   # class 가 붙어도 잡히게
h1m = re.search(r'<h1>(.*?)</h1>', body)
title = h1m.group(1) if h1m else '접속점검 사용법'
lead = ''
lm = re.search(r'</h1>\s*<p>(.*?)</p>', body, re.S)
if lm:
    lead = lm.group(1)
    body = body.replace('<p>' + lead + '</p>', '', 1)
body = re.sub(r'<h1>.*?</h1>', '', body, count=1)

toc = ''.join('<li><b>%d</b><span>%s</span></li>' % (i + 1, re.sub(r'^\d+\.\s*', '', t))
              for i, t in enumerate(titles))
cover = (u'<div id="cover">'
         u'<div class="big">' + title + u'</div>'
         u'<div class="lead">' + lead + u'</div>'
         u'<div id="toc"><h4>\ubaa9\ucc28</h4><ol>' + toc + u'</ol></div>'
         u'<div class="seal">\ub204\ub4dcTV \ub0b4\ubd80\uc790\ub8cc\uc785\ub2c8\ub2e4. '
         u'\ub2e4\ub978 \uacf3\uc5d0 \uc62e\uae30\uac70\ub098 \ubc30\ud3ec\ud558\uc9c0 \ub9c8\uc138\uc694.</div>'
         u'</div>')
body = cover + body

# 워터마크 — 글자 '뒤'에 깔린다. 고정 요소라 모든 쪽에 똑같이 반복된다.
marks = []
for r in range(9):
    for c in range(5):
        marks.append('<span style="top:%dmm;left:%dmm">누드TV</span>' % (r * 36 - 10, c * 46 - 14))
wm = ''.join(marks)

CSS = u'''
@page { size: A4; margin: 16mm 14mm 18mm 14mm; }
* { box-sizing: border-box; }
html, body { margin:0; padding:0; }
body {
  font-family: "Noto Sans CJK KR", "Noto Sans KR", sans-serif;
  color:#16302a; font-size:10.8pt; line-height:1.75; -webkit-print-color-adjust:exact; print-color-adjust:exact;
}
/* ── 워터마크: 본문 '뒤'. 고정이라 모든 쪽에 반복된다 ── */
#wm { position:fixed; inset:0; z-index:0; pointer-events:none; overflow:hidden; }
#wm span {
  position:absolute; transform:rotate(-32deg); transform-origin:center;
  font-size:19pt; font-weight:800; letter-spacing:.06em;
  color:#0FA36B; opacity:.115; white-space:nowrap;
}
#wm b {
  position:absolute; left:0; top:118mm; width:210mm; text-align:center;
  transform:rotate(-32deg); font-size:44pt; font-weight:900; letter-spacing:.18em;
  color:#0FA36B; opacity:.105; white-space:nowrap;
}
#page { position:relative; z-index:1; }
/* ── 머리·꼬리 ── */
#cover { break-after:page; }
#cover .big { font-size:30pt; font-weight:900; letter-spacing:-.03em; color:#0B3D2C; margin:22mm 0 6px; }
#cover .lead { font-size:11.5pt; color:#3d5f54; line-height:1.8; margin-bottom:26px; }
#cover .lead strong { color:#0B7A50; }
#toc { border:1px solid #d9efe6; border-radius:10px; background:#fbfefc; padding:20px 24px; }
#toc h4 { margin:0 0 14px; font-size:11.5pt; font-weight:800; color:#0B7A50; letter-spacing:.04em; }
#toc ol { margin:0; padding-left:0; list-style:none; counter-reset:t; }
#toc li { display:flex; align-items:baseline; gap:12px; padding:8px 0; border-bottom:1px dotted #dcece5;
          font-size:13pt; font-weight:600; color:#1d4438; }
#toc li:last-child { border-bottom:0; }
#toc li b { min-width:26px; font-size:13.5pt; color:#0FA36B; font-weight:900; }
#cover .seal { margin-top:24px; padding:11px 15px; border-radius:9px; background:#eafaf3;
  border:1px solid #cdeade; color:#0B5B3E; font-size:9.6pt; font-weight:700; }
/* 머리글도 고정 — 모든 쪽에 브랜드가 찍힌다 */
#brand { position:fixed; top:-16mm; left:0; right:0; z-index:2; background:#fff;
  display:flex; align-items:center; gap:9px; padding-bottom:8px; border-bottom:2.5px solid #0FA36B; }
#brand .dot { width:22px; height:22px; border-radius:7px; background:linear-gradient(135deg,#25D69A,#0FA36B); }
#brand .nm { font-weight:900; font-size:12.5pt; letter-spacing:-.01em; color:#0B7A50; }
#brand .sub { margin-left:auto; font-size:8.6pt; color:#6b8b80; }
#page { }
#foot { position:fixed; left:0; right:0; bottom:-13mm; z-index:2; background:#fff;
  display:flex; font-size:8pt; color:#7d998e; border-top:1px solid #e3efe9; padding-top:5px; }
#foot .r { margin-left:auto; font-weight:700; color:#0B7A50; }
/* ── 본문 ── */
h1 { font-size:21pt; font-weight:900; letter-spacing:-.02em; margin:2px 0 6px; color:#0B3D2C; }
/* ★ 항목 하나당 한 쪽 — 크롬이 인쇄할 때 h2 앞에서 반드시 쪽을 넘긴다 */
h2 { font-size:15pt; font-weight:900; margin:0 0 14px; padding:0 0 9px;
     border-bottom:3px solid #25D69A; color:#0B3D2C; break-after:avoid; }
h2.np { break-before:page; }              /* 이 항목부터 새 쪽 */
h2.cont { break-before:auto; margin-top:26px; }  /* 앞 항목과 같은 쪽에 이어 붙는다 */
h2:first-of-type { break-before:auto; }
hr { display:none; }   /* 쪽이 나뉘므로 구분선이 필요 없다 */
h3 { font-size:11.2pt; font-weight:800; margin:15px 0 5px; color:#0B7A50; break-after:avoid; }
p { margin:7px 0; }
strong { font-weight:800; color:#0B3D2C; }
code { font-family:"Noto Sans CJK KR","DejaVu Sans Mono",monospace; font-size:9.2pt; background:#eafaf3; color:#0B7A50;
       padding:1px 5px; border-radius:4px; border:1px solid #d3f0e3; }
pre { font-family:"Noto Sans CJK KR","DejaVu Sans Mono",monospace; font-size:9pt; line-height:1.6;
      background:#f4fbf8; border:1px solid #d9efe6; border-left:4px solid #25D69A; border-radius:7px;
      padding:11px 13px; margin:9px 0; white-space:pre-wrap; word-break:break-all; break-inside:avoid; }
blockquote { margin:10px 0; padding:9px 13px; background:#fbfdf9; border:1px solid #e3efe9;
             border-left:4px solid #b9e6d3; border-radius:7px; font-size:9.7pt; color:#3d5f54; break-inside:avoid; }
ul, ol { margin:7px 0 7px 20px; padding:0; }
li { margin:3px 0; }
table { width:100%; border-collapse:collapse; margin:10px 0; font-size:9.6pt; break-inside:avoid; }
th { background:#eafaf3; color:#0B5B3E; font-weight:800; text-align:left; padding:7px 9px; border:1px solid #d3ece1; }
td { padding:7px 9px; border:1px solid #e2efe9; vertical-align:top; }
tbody tr:nth-child(even) td { background:#fafdfb; }
'''

HTML = (u'<!doctype html><html lang="ko"><head><meta charset="utf-8">'
        u'<title>\uc811\uc18d\uc810\uac80 \uc0ac\uc6a9\ubc95 \u00b7 \ub204\ub4dcTV</title>'
        u'<style>' + CSS + u'</style></head><body>'
        u'<div id="wm">' + wm + u'<b>\ub204\ub4dcTV \u00b7 \ub0b4\ubd80\uc790\ub8cc</b></div>'
        u'<div id="page">' + body + u'</div></body></html>')

io.open(OUT, 'w', encoding='utf-8').write(HTML)
print('만들었습니다:', OUT, '(%d자)' % len(HTML))
