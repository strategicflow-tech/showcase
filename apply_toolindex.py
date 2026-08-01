#!/usr/bin/env python3
"""
Apply ToolIndex cross-promotion to strategicflow-tech/showcase.
Three touches: footer (all SF-branded pages), addons.html (card), notes.html (field note).
"""
import re, os

ROOT = '/tmp/sf-showcase'
SENTINEL = 'utm_source=strategicflow_footer'

# ── Link text to insert ──────────────────────────────────────────────────────
URL = ('https://strategic-flow-audit.replit.app/directory'
       '?utm_source=strategicflow_footer')
TEXT = 'Also by us: ToolIndex — free SaaS directory, dofollow backlink'

# Type A: <div class="footer-links"> … </div> inside <footer>
LINK_A = f'\n    <a href="{URL}" class="footer-link">{TEXT}</a>'
# Type B: <ul class="footer-links"> … </ul> inside <footer>
LINK_B = f'\n  <li><a href="{URL}">{TEXT}</a></li>'
# Type C: <div class="footer-col"> (Tools column) — plain <a>
LINK_C = f'\n    <a href="{URL}">{TEXT}</a>'


def patch_type_a(html):
    """<div class="footer-links"> inside <footer> … </div></footer>"""
    pat = re.compile(
        r'(<div class="footer-links">)(.*?)(</div>\s*</footer>)',
        re.DOTALL
    )
    m = pat.search(html)
    if not m:
        return None
    return pat.sub(m.group(1) + m.group(2) + LINK_A + '\n  ' + m.group(3), html, count=1)


def patch_type_b(html):
    """<ul class="footer-links"> inside <footer> … </ul>"""
    # Only match <ul class="footer-links"> that is inside <footer>…</footer>
    footer_pat = re.compile(r'<footer>(.*?)</footer>', re.DOTALL)
    fm = footer_pat.search(html)
    if not fm:
        return None
    footer_content = fm.group(1)
    ul_pat = re.compile(r'(<ul class="footer-links">)(.*?)(</ul>)', re.DOTALL)
    um = ul_pat.search(footer_content)
    if not um:
        return None
    new_footer_content = ul_pat.sub(
        um.group(1) + um.group(2) + LINK_B + '\n  ' + um.group(3),
        footer_content, count=1
    )
    return html[:fm.start(1)] + new_footer_content + html[fm.end(1):]


def patch_type_c(html):
    """<a href="https://strategicflow.tech">Showcase</a> in footer-col Tools"""
    pat = re.compile(r'(<a href="https://strategicflow\.tech">Showcase</a>)(\s*</div>)')
    m = pat.search(html)
    if not m:
        return None
    return pat.sub(m.group(1) + LINK_C + m.group(2), html, count=1)


# ── Gather all HTML files (no blog/ subdirectory) ────────────────────────────
all_html = []
for root, dirs, files in os.walk(ROOT):
    dirs[:] = [d for d in dirs if d not in ('blog', '.git', 'node_modules')]
    for f in files:
        if f.endswith('.html'):
            all_html.append(os.path.join(root, f))
all_html.sort()

# ── Classify pages by footer type ────────────────────────────────────────────
type_a, type_b, type_c = [], [], []
no_sf_footer = []

for path in all_html:
    with open(path) as fh:
        html = fh.read()
    if SENTINEL in html:
        continue  # already done

    has_sf_footer = ('class="footer-logo"' in html or
                     'class="footer-brand"' in html or
                     'class="footer-col"' in html)
    if not has_sf_footer:
        no_sf_footer.append(os.path.basename(path))
        continue

    # Must be a real SF-branded footer: check for site footer patterns
    # Type A: <div class="footer-links"> used as site footer nav
    # Type B: <ul class="footer-links"> used as site footer nav
    # Type C: footer-col (addons-style)
    if 'class="footer-col"' in html:
        type_c.append(path)
    elif re.search(r'<footer>.*?<ul class="footer-links">', html, re.DOTALL):
        type_b.append(path)
    elif re.search(r'<footer>.*?<div class="footer-links">', html, re.DOTALL):
        type_a.append(path)
    else:
        no_sf_footer.append(os.path.basename(path) + ' (unknown footer type)')

print(f'Type A (div footer-links in footer): {len(type_a)}')
print(f'Type B (ul  footer-links in footer): {len(type_b)}')
print(f'Type C (footer-col):                 {len(type_c)}')
print(f'No/unknown SF footer:                {len(no_sf_footer)}')

stats = {'a': 0, 'b': 0, 'c': 0, 'fail': []}

for path in type_a:
    with open(path) as fh: html = fh.read()
    result = patch_type_a(html)
    if result:
        with open(path, 'w') as fh: fh.write(result)
        stats['a'] += 1
    else:
        stats['fail'].append(('A', path))

for path in type_b:
    with open(path) as fh: html = fh.read()
    result = patch_type_b(html)
    if result:
        with open(path, 'w') as fh: fh.write(result)
        stats['b'] += 1
    else:
        stats['fail'].append(('B', path))

for path in type_c:
    with open(path) as fh: html = fh.read()
    result = patch_type_c(html)
    if result:
        with open(path, 'w') as fh: fh.write(result)
        stats['c'] += 1
    else:
        stats['fail'].append(('C', path))

total = stats['a'] + stats['b'] + stats['c']
print(f'\nPatched: {total}  (A:{stats["a"]} B:{stats["b"]} C:{stats["c"]})')
if stats['fail']:
    print('FAILED:')
    for t, p in stats['fail']:
        print(f'  [{t}] {os.path.basename(p)}')

# ── addons.html — new addon-card ─────────────────────────────────────────────
ADDONS_CARD = '''
  <!-- ToolIndex cross-promotion -->
  <div class="addon-card" id="toolindex">
    <div class="addon-header">
      <div>
        <div class="addon-meta">
          <span class="addon-num">FREE</span>
          <span class="addon-delivery">No review queue</span>
        </div>
        <div class="addon-title">Get your SaaS discovered</div>
        <p class="addon-desc">Free dofollow backlink from a DR 86 directory. Instant listing, no review queue.</p>
        <a href="https://strategic-flow-audit.replit.app/directory?utm_source=strategicflow_addons" class="btn-primary" style="background:rgba(45,212,191,0.15);color:#2dd4bf;box-shadow:none;" target="_blank" rel="noopener">List it free →</a>
      </div>
    </div>
  </div>
'''

ADDONS_PATH = os.path.join(ROOT, 'addons.html')
with open(ADDONS_PATH) as fh:
    addons_html = fh.read()

if 'utm_source=strategicflow_addons' in addons_html:
    print('addons.html: already patched')
else:
    anchor = '<!-- COMING SOON -->'
    if anchor in addons_html:
        addons_html = addons_html.replace(anchor, ADDONS_CARD + '\n' + anchor, 1)
        with open(ADDONS_PATH, 'w') as fh:
            fh.write(addons_html)
        print('addons.html: card inserted before COMING SOON')
    else:
        print('addons.html: anchor not found')

# ── notes.html — new field note ──────────────────────────────────────────────
NOTES_CARD = '''
    <div class="note-card" id="toolindex-directory">
      <div class="note-label">Tools · Resources</div>
      <div class="note-title">We built a free directory for SaaS tools</div>
      <p class="note-text">ToolIndex is live — a free SaaS directory with a dofollow backlink from a DR 86 domain, instant approval, no review queue. If you\'re building something and want more eyes on it, list it free.</p>
      <a href="https://strategic-flow-audit.replit.app/directory?utm_source=strategicflow_notes" class="note-link">\u2192 List your tool free</a>
    </div>
'''

NOTES_PATH = os.path.join(ROOT, 'notes.html')
with open(NOTES_PATH) as fh:
    notes_html = fh.read()

if 'utm_source=strategicflow_notes' in notes_html:
    print('notes.html: already patched')
else:
    notes_list_start = notes_html.index('<div class="notes-list">')
    anchor = '\n  </div>\n</section>'
    insert_pos = notes_html.index(anchor, notes_list_start)
    notes_html = notes_html[:insert_pos] + NOTES_CARD + notes_html[insert_pos:]
    with open(NOTES_PATH, 'w') as fh:
        fh.write(notes_html)
    print('notes.html: field note inserted')

print('\nAll done.')
