#!/usr/bin/env python3
"""Build readable static editions, web metadata and an offline integrity manifest."""
import argparse
import hashlib
import html
import json
import re
import shutil
from pathlib import Path
from urllib.parse import quote, urlparse
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
ES = html.escape
CORE = {
    'index.html', 'styles.css', 'app.js', 'speech.js', 'offline.js', 'coverage.html',
    'manifest.webmanifest', 'assets/icon.svg', 'assets/favicon.ico',
    'assets/icon-192.png', 'assets/icon-512.png', 'assets/icon-maskable.png',
    'data/catalog.json', 'data/editorial.json', 'edition.css', 'tts/voice.js', 'tts/reading-audio.js',
}


def strip_ending(value):
    return value.rstrip('/') + '/' if value else ''


def read_html(law, base):
    title, number = map(ES, (law['title'], law['number']))
    law_id = ES(law['id'])
    href = f'../?law={law_id}'
    description = f'{title}（{number}）の条文全文。条・項・号ごとに確認できます。出典はe-Gov法令検索。'
    canonical = f'{base}read/{law_id}.html' if base else ''
    canonical_tag = f'<link rel="canonical" href="{ES(canonical)}">' if canonical else ''
    image = f'{base}assets/og.png' if base else '../assets/og.png'
    sections = []
    nav = []
    last_chapter = None
    main_heading = {'preamble': '前文', 'enactment': '制定文'}
    for article in law['articles']:
        article_id = ES(article['id'])
        article_title = ES(article['title'] or main_heading.get(article['id'], '附則'))
        caption = ES(article.get('caption', ''))
        chapter = article.get('chapter', '')
        if chapter != last_chapter:
            if chapter:
                nav.append(f'<h3>{ES(chapter)}</h3>')
            last_chapter = chapter
        nav.append(f'<a href="#a-{article_id}">{article_title}</a>')
        parts = []
        for part in article['parts']:
            part_id = ES(part['id'])
            part_label = ES(part.get('label', ''))
            label = f'<strong>{part_label}</strong> ' if part_label else ''
            text = ES(part['text'])
            part_url = f'{href}&amp;article={article_id}&amp;part={quote(part["id"])}'
            parts.append(f'<p id="a-{article_id}-p-{part_id}">{label}{text} <a class="edition-part" href="{part_url}" aria-label="{article_title} {part_label}をリーダーで開く">↗</a></p>')
        sections.append(f'<section id="a-{article_id}"><h2>{article_title} {caption}</h2><a class="edition-link" href="{href}&amp;article={article_id}">条文リーダーで開く</a>{"".join(parts)}</section>')
    nav_html = "".join(nav)
    sections_html = "".join(sections)
    return f'''<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} 全条文｜六法書架</title>
<meta name="description" content="{description}">
{canonical_tag}
<meta property="og:type" content="article">
<meta property="og:title" content="{title} 全条文｜六法書架">
<meta property="og:description" content="{description}">
<meta property="og:image" content="{ES(image)}">
<link rel="icon" href="../assets/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="../edition.css">
</head>
<body>
<header class="edition-header"><a href="../">六法書架</a><span>全文版</span></header>
<main>
  <h1>{title}</h1>
  <p>{number} · <a href="{ES(law['source'])}">e-Gov原典</a></p>
  <p><a class="edition-link" href="{href}">マーカー・読み上げ付きリーダーを開く</a></p>
  <details><summary>目次</summary><nav aria-label="条文目次">{nav_html}</nav></details>
  {sections_html}
</main>
<footer><a href="../">六法書架トップ</a> · <a href="../coverage.html">収録範囲と出典</a></footer>
</body>
</html>
'''


def build(output, site_url):
    input_folder = ROOT / 'docs'
    if output != input_folder:
        if output.exists():
            raise SystemExit(f'出力先は存在しない場所を指定してください。 {output}')
        shutil.copytree(input_folder, output, ignore=shutil.ignore_patterns('__pycache__'))
    base = strip_ending(site_url)
    if base:
        parsed = urlparse(base)
        if parsed.scheme not in ('https', 'http') or not parsed.netloc or parsed.query or parsed.fragment:
            raise SystemExit('--site-url には公開サイトの完全なURLを指定してください。')

    catalog = json.loads((output / 'data/catalog.json').read_text(encoding='utf-8'))
    edition_folder = output / 'read'
    edition_folder.mkdir(exist_ok=True)
    for item in catalog['laws']:
        law_path = f'data/{item["id"]}.json'
        CORE.add(law_path)
        law = json.loads((output / law_path).read_text(encoding='utf-8'))
        (edition_folder / f'{item["id"]}.html').write_text(read_html(law, base), encoding='utf-8')

    index = output / 'index.html'
    page = index.read_text(encoding='utf-8')
    index_start = '<!-- SEO_PUBLIC_URL -->'
    index_end = '<!-- /SEO_PUBLIC_URL -->'
    page = re.sub(f'{re.escape(index_start)}.*?{re.escape(index_end)}\n?', '', page, flags=re.S)
    page = re.sub(r'(<meta property="og:image" content=")[^"]*(">)',
                  lambda m: m[1] + ES(base + 'assets/og.png' if base else 'assets/og.png') + m[2], page)
    if base:
        block = f'{index_start}\n<link rel="canonical" href="{ES(base)}">\n<meta property="og:url" content="{ES(base)}">\n{index_end}\n'
        page = page.replace('</head>', block + '</head>', 1)
        sitemap = ET.Element('urlset', {'xmlns': 'http://www.sitemaps.org/schemas/sitemap/0.9'})
        for path in ['', 'coverage.html', *(f'read/{law["id"]}.html' for law in catalog['laws'])]:
            item = ET.SubElement(sitemap, 'url')
            ET.SubElement(item, 'loc').text = base + path
            ET.SubElement(item, 'lastmod').text = catalog['updated']
        ET.ElementTree(sitemap).write(output / 'sitemap.xml', encoding='utf-8', xml_declaration=True)
        if urlparse(base).path == '/':
            (output / 'robots.txt').write_text(f'User-agent: *\nAllow: /\nSitemap: {base}sitemap.xml\n', encoding='utf-8')
    index.write_text(page, encoding='utf-8')

    files = []
    for path in sorted(output.rglob('*')):
        if not path.is_file() or path.name in ('offline-manifest.json', '.nojekyll') or path.name.startswith('.'):
            continue
        name = path.relative_to(output).as_posix()
        data = path.read_bytes()
        files.append({'path': name, 'sha256': hashlib.sha256(data).hexdigest(),
                      'bytes': len(data), 'core': name in CORE})
    revision = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()[:24]
    manifest = {'date': catalog['updated'], 'revision': revision, 'files': files}
    (output / 'offline-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')) + '\n',
                                                encoding='utf-8')
    print(f'Created {len(catalog["laws"])} statutory editions and manifest {revision} ({len(files)} files).')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=ROOT / 'docs')
    parser.add_argument('--site-url', default='')
    args = parser.parse_args()
    build(args.output.resolve(), args.site_url)
