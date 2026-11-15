#!/usr/bin/env python3
"""Validate the built static release without network access or third-party packages.

This validates packaging, links, and source metadata, not legal interpretation or
whether a snapshot is the newest revision available from e-Gov.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import date
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path, PurePosixPath
import re
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
LAWS = {
    'constitution': ('321CONSTITUTION', '日本国憲法'),
    'civil': ('129AC0000000089', '民法'),
    'commercial': ('132AC0000000048', '商法'),
    'criminal': ('140AC0000000045', '刑法'),
    'civil-procedure': ('408AC0000000109', '民事訴訟法'),
    'criminal-procedure': ('323AC0000000131', '刑事訴訟法'),
}
REQUIRED_CORE = {
    'index.html', 'app.js', 'styles.css', 'speech.js', 'offline.js',
    'manifest.webmanifest', 'data/catalog.json', 'data/editorial.json',
    'tts/voice.js', 'tts/reading-audio.js',
    *(f'data/{law}.json' for law in LAWS),
}
REQUIRED_FILES = REQUIRED_CORE | {
    'sw.js', 'assets/reading-bgm.mp3', 'tts/browser/worker.js',
    'tts/openjtalk-wasm.wasm', 'tts/open_jtalk_dic_utf_8-1.11.tar.gz',
    'tts/mei_normal.htsvoice', 'tts/nitech_jp_atr503_m001.htsvoice',
    'data/cases/index.json', *(f'read/{law}.html' for law in LAWS),
}
SAFE_ID = re.compile(r'^[a-zA-Z0-9_.-]+$')
JS_IMPORT = re.compile(r'''(?:\b(?:import|export)\s+(?:[^;\n]*?\s+from\s+)?|\bimport\s*\(\s*)["'](\.{1,2}/[^"']+)["']''')
CSS_URL = re.compile(r'''url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)''', re.I)


class Document(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ids = set()
        self.duplicates = set()
        self.references = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        identity = attributes.get('id')
        if identity:
            if identity in self.ids:
                self.duplicates.add(identity)
            self.ids.add(identity)
        for attribute in ('href', 'src', 'poster'):
            value = attributes.get(attribute)
            if value:
                self.references.append(value)
        # This project's srcsets contain ordinary local paths (no data URLs).
        srcset = attributes.get('srcset', '')
        if srcset and 'data:' not in srcset:
            self.references.extend(item.strip().split()[0] for item in srcset.split(',') if item.strip())

    handle_startendtag = handle_starttag


def safe_manifest_path(value):
    if not isinstance(value, str) or not value or any(ord(char) < 32 for char in value) or '\\' in value or '?' in value or '#' in value or '%' in value:
        return False
    path = PurePosixPath(value)
    return bool(path.parts) and not path.is_absolute() and str(path) == value and all(part not in ('.', '..') for part in path.parts) and ':' not in value


class Validator:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.errors = []
        self.entries = {}
        self.documents = {}
        self.article_count = 0
        self.law_articles = {}
        self.case_count = 0

    def error(self, message):
        self.errors.append(message)

    def read_json(self, path):
        try:
            return json.loads((self.root / path).read_text(encoding='utf-8'))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            self.error(f'{path}: cannot read JSON ({error})')
            return None

    def inside(self, path):
        return path.resolve().is_relative_to(self.root)

    def manifest(self):
        manifest = self.read_json('offline-manifest.json')
        if not isinstance(manifest, dict) or not isinstance(manifest.get('files'), list):
            self.error('offline-manifest.json: expected an object with a files array')
            return
        files = manifest['files']
        revision = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()[:24]
        if manifest.get('revision') != revision:
            self.error('offline-manifest.json: revision does not match its file list')
        for entry in files:
            if not isinstance(entry, dict) or not safe_manifest_path(entry.get('path')):
                self.error(f'offline-manifest.json: unsafe or invalid path {entry!r}')
                continue
            name = entry['path']
            if name in self.entries:
                self.error(f'offline-manifest.json: duplicate path {name}')
            self.entries[name] = entry
            if not isinstance(entry.get('core'), bool):
                self.error(f'{name}: core flag must be a boolean')
            path = self.root / name
            if not self.inside(path) or not path.is_file():
                self.error(f'{name}: missing file or path escapes release')
                continue
            try:
                content = path.read_bytes()
            except OSError as error:
                self.error(f'{name}: cannot read file ({error})')
                continue
            if type(entry.get('bytes')) is not int or entry['bytes'] != len(content):
                self.error(f'{name}: byte count mismatch')
            if entry.get('sha256') != hashlib.sha256(content).hexdigest():
                self.error(f'{name}: SHA-256 mismatch')
        for name in sorted(REQUIRED_FILES):
            if name not in self.entries:
                self.error(f'{name}: required release resource is absent')
        for name in sorted(REQUIRED_CORE):
            if self.entries.get(name, {}).get('core') is not True:
                self.error(f'{name}: required core resource is not included in offline manifest')
        # A file omitted from the manifest would appear online but disappear offline.
        for path in sorted(self.root.rglob('*')):
            if not path.is_file() or path.name in ('.nojekyll', 'offline-manifest.json') or any(part.startswith('.') for part in path.relative_to(self.root).parts):
                continue
            name = path.relative_to(self.root).as_posix()
            if name not in self.entries:
                self.error(f'{name}: file is not included in offline manifest')

    def laws(self):
        catalog = self.read_json('data/catalog.json')
        if not isinstance(catalog, dict) or not isinstance(catalog.get('laws'), list):
            self.error('data/catalog.json: expected a laws array')
            return
        try:
            date.fromisoformat(catalog['updated'])
        except (KeyError, ValueError, TypeError):
            self.error('data/catalog.json: updated must be an ISO date')
        ids = [item.get('id') for item in catalog['laws'] if isinstance(item, dict) and isinstance(item.get('id'), str)]
        if len(ids) != len(LAWS) or set(ids) != set(LAWS):
            self.error('data/catalog.json: must include each of the six supported laws exactly once')
        for metadata in catalog['laws']:
            if not isinstance(metadata, dict) or not isinstance(metadata.get('id'), str) or metadata['id'] not in LAWS:
                continue
            slug = metadata['id']
            name = f'data/{slug}.json'
            law = self.read_json(name)
            if not isinstance(law, dict) or not isinstance(law.get('articles'), list):
                self.error(f'{name}: expected articles array')
                continue
            official_id, title = LAWS[slug]
            expected = {'id': slug, 'officialId': official_id, 'title': title,
                        'source': f'https://laws.e-gov.go.jp/law/{official_id}'}
            for key, value in expected.items():
                if law.get(key) != value or metadata.get(key) != value:
                    self.error(f'{name}: {key} does not match the expected e-Gov law identity')
            if not isinstance(law.get('revision'), str) or not law['revision'].startswith(official_id + '_'):
                self.error(f'{name}: invalid official revision identifier')
            for key in ('number', 'revision', 'enforced', 'sourceUpdated', 'totalArticles'):
                if law.get(key) != metadata.get(key):
                    self.error(f'{name}: {key} differs from catalog')
            articles = law['articles']
            if not articles or len(articles) != metadata.get('totalArticles'):
                self.error(f'{name}: total article count differs from catalog')
            seen = set()
            main_count = 0
            for article in articles:
                if not isinstance(article, dict):
                    self.error(f'{name}: invalid article object')
                    continue
                identity = article.get('id')
                if not isinstance(identity, str) or not SAFE_ID.fullmatch(identity):
                    self.error(f'{name}: invalid article ID {identity!r}')
                    continue
                if identity in seen:
                    self.error(f'{name}: duplicate article ID {identity}')
                seen.add(identity)
                if not article.get('supplementary') and identity not in ('preamble', 'enactment'):
                    main_count += 1
                parts = article.get('parts')
                if not isinstance(parts, list) or not parts:
                    self.error(f'{name} article {identity}: missing parts')
                    continue
                part_ids = set()
                for part in parts:
                    if not isinstance(part, dict):
                        self.error(f'{name} article {identity}: invalid part object')
                        continue
                    part_id = part.get('id')
                    if not isinstance(part_id, str) or not SAFE_ID.fullmatch(part_id):
                        self.error(f'{name} article {identity}: invalid part ID {part_id!r}')
                        continue
                    if part_id in part_ids:
                        self.error(f'{name} article {identity}: duplicate part ID {part_id}')
                    part_ids.add(part_id)
                    if not isinstance(part.get('text'), str) or not part['text'].strip():
                        self.error(f'{name} article {identity} part {part_id}: empty text')
            if '1' not in seen or main_count != metadata.get('articles'):
                self.error(f'{name}: main article count differs from catalog or first article is absent')
            self.article_count += len(articles)
            self.law_articles[slug] = seen

    def cases(self):
        """Check the dynamic references that HTML/link validation cannot see."""
        index_name = 'data/cases/index.json'
        index = self.read_json(index_name)
        if not isinstance(index, dict) or not isinstance(index.get('shards'), dict):
            self.error(f'{index_name}: expected a shards object')
            return
        mappings = {}
        shard_names = set()
        for law, articles in index['shards'].items():
            if law not in LAWS or not isinstance(articles, dict):
                self.error(f'{index_name}: invalid law mapping {law!r}')
                continue
            for article, filename in articles.items():
                if article not in self.law_articles.get(law, set()):
                    self.error(f'{index_name}: unknown article {law}/{article}')
                if not isinstance(filename, str) or not re.fullmatch(r'[a-zA-Z0-9_-]+\.json', filename) or filename == 'index.json':
                    self.error(f'{index_name}: invalid shard filename {filename!r}')
                    continue
                mappings[(law, article)] = filename
                shard_names.add(filename)
        identities = {}
        expected = defaultdict(set)
        available = defaultdict(set)
        for filename in sorted(shard_names):
            source = f'data/cases/{filename}'
            path = self.root / source
            if not self.inside(path):
                self.error(f'{source}: shard escapes release')
                continue
            shard = self.read_json(source)
            if not isinstance(shard, dict) or not isinstance(shard.get('cases'), list):
                self.error(f'{source}: expected a cases array')
                continue
            seen = set()
            for case in shard['cases']:
                if not isinstance(case, dict) or not isinstance(case.get('id'), str) or not SAFE_ID.fullmatch(case['id']):
                    self.error(f'{source}: invalid case object or ID')
                    continue
                identity = case['id']
                if identity in seen:
                    self.error(f'{source}: duplicate case ID {identity}')
                seen.add(identity)
                digest = hashlib.sha256(json.dumps(case, ensure_ascii=False, sort_keys=True).encode()).digest()
                if identity in identities and identities[identity] != digest:
                    self.error(f'{source}: inconsistent copies of case {identity}')
                identities[identity] = digest
                for field in ('title', 'court', 'date', 'summary', 'summaryKind', 'source'):
                    if not isinstance(case.get(field), str) or not case[field].strip():
                        self.error(f'{source} case {identity}: missing {field}')
                try:
                    date.fromisoformat(case.get('date'))
                except (ValueError, TypeError):
                    self.error(f'{source} case {identity}: date must be an ISO date')
                links = case.get('articles')
                if not isinstance(links, list) or not links:
                    self.error(f'{source} case {identity}: missing article references')
                    continue
                relations = set()
                for link in links:
                    if not isinstance(link, dict) or not isinstance(link.get('law'), str) or not isinstance(link.get('id'), str):
                        self.error(f'{source} case {identity}: invalid article reference')
                        continue
                    pair = (link['law'], link['id'])
                    if pair in relations:
                        self.error(f'{source} case {identity}: duplicate article reference {pair}')
                    relations.add(pair)
                    if pair[1] not in self.law_articles.get(pair[0], set()):
                        self.error(f'{source} case {identity}: unknown article {pair[0]}/{pair[1]}')
                    if not isinstance(link.get('relation'), str) or not link['relation'].strip():
                        self.error(f'{source} case {identity}: missing relation description')
                    expected[pair].add(identity)
                    if mappings.get(pair) == filename:
                        available[pair].add(identity)
        for pair in sorted(set(mappings) | set(expected)):
            if not expected[pair] or expected[pair] != available[pair]:
                self.error(f'{index_name}: incomplete case mapping for {pair[0]}/{pair[1]}')
        self.case_count = len(identities)
        if type(index.get('count')) is not int or index['count'] != self.case_count:
            self.error(f'{index_name}: unique case count differs from shards')

    def reference(self, source, value, *, check_fragment=True, require_core=False):
        try:
            parsed = urlsplit(value)
        except ValueError:
            self.error(f'{source}: invalid URL {value!r}')
            return
        if parsed.scheme or parsed.netloc:
            if parsed.scheme.lower() in ('javascript', 'vbscript'):
                self.error(f'{source}: unsafe URL scheme {value!r}')
            return
        if parsed.path.startswith('/'):
            self.error(f'{source}: root-relative URL breaks project Pages paths: {value}')
            return
        path = (self.root / source).parent / unquote(parsed.path) if parsed.path else self.root / source
        path = path.resolve()
        if not self.inside(path):
            self.error(f'{source}: reference escapes release: {value}')
            return
        if path.is_dir():
            path /= 'index.html'
        if not path.is_file():
            self.error(f'{source}: missing local reference: {value}')
            return
        target = path.relative_to(self.root).as_posix()
        if require_core and self.entries.get(target, {}).get('core') is not True:
            self.error(f'{source}: imported core module {target} is not cached as core')
        if check_fragment and parsed.fragment and target in self.documents:
            fragment = unquote(parsed.fragment)
            if fragment not in self.documents[target].ids:
                self.error(f'{source}: missing fragment in {value}')

    def references(self):
        for path in sorted(self.root.rglob('*.html')):
            if not self.inside(path):
                self.error(f'{path.name}: symlink escapes release')
                continue
            document = Document()
            source = path.relative_to(self.root).as_posix()
            try:
                document.feed(path.read_text(encoding='utf-8'))
            except (OSError, UnicodeError) as error:
                self.error(f'{source}: cannot parse HTML ({error})')
                continue
            self.documents[source] = document
            for identity in sorted(document.duplicates):
                self.error(f'{source}: duplicate HTML ID {identity}')
        for source, document in self.documents.items():
            for value in document.references:
                self.reference(source, value)
        for path in sorted(self.root.rglob('*')):
            if path.suffix not in ('.css', '.js', '.mjs') or not self.inside(path):
                continue
            source = path.relative_to(self.root).as_posix()
            try:
                content = path.read_text(encoding='utf-8')
            except (OSError, UnicodeError) as error:
                self.error(f'{source}: cannot read source ({error})')
                continue
            if path.suffix == '.css':
                for match in CSS_URL.finditer(content):
                    self.reference(source, next(value for value in match.groups() if value is not None), check_fragment=False)
            else:
                core = self.entries.get(source, {}).get('core') is True
                for match in JS_IMPORT.finditer(content):
                    self.reference(source, match[1], check_fragment=False, require_core=core)

    def run(self):
        self.manifest()
        self.laws()
        self.cases()
        self.references()
        return self.errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', nargs='?', type=Path, default=ROOT / 'docs')
    options = parser.parse_args()
    validator = Validator(options.directory)
    errors = validator.run()
    if errors:
        for error in errors:
            print(f'ERROR: {error}')
        raise SystemExit(1)
    print(f'Validated {len(validator.entries)} release files, {len(LAWS)} laws, {validator.article_count} provisions and {validator.case_count} cases.')


if __name__ == '__main__':
    main()
