"""Release-integrity regressions. Run: python3 -m unittest discover -s tests."""
import hashlib
import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

MODULE_PATH = Path(__file__).resolve().parents[1] / 'scripts/validate-site.py'
SPEC = importlib.util.spec_from_file_location('validate_site', MODULE_PATH)
SITE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SITE)


class ReleaseValidationTests(unittest.TestCase):
    def setUp(self):
        self.folder = TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.extra_core = set()
        for name in SITE.REQUIRED_FILES:
            self.write(name, '<!doctype html><html lang="ja"><body></body></html>' if name.endswith('.html') else '')
        laws = []
        for slug, (official_id, title) in SITE.LAWS.items():
            metadata = {
                'id': slug, 'title': title, 'officialId': official_id,
                'source': f'https://laws.e-gov.go.jp/law/{official_id}',
                'revision': official_id + '_20000101_000000000000000',
                'number': '法令番号', 'enforced': '2000-01-01',
                'sourceUpdated': '2000-01-01T00:00:00+09:00',
                'articles': 1, 'totalArticles': 1,
            }
            laws.append(metadata)
            article = {'id': '1', 'title': '第一条', 'supplementary': False,
                       'parts': [{'id': '1', 'text': 'テスト用の原文です。'}]}
            self.json(f'data/{slug}.json', {**metadata, 'articles': [article]})
        self.json('data/catalog.json', {'updated': '2000-01-01', 'laws': laws})
        self.manifest()

    def write(self, name, value):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value, encoding='utf-8')

    def json(self, name, value):
        self.write(name, json.dumps(value, ensure_ascii=False))

    def read_json(self, name):
        return json.loads((self.root / name).read_text(encoding='utf-8'))

    def manifest(self, extra=None):
        entries = []
        for path in sorted(self.root.rglob('*')):
            if not path.is_file() or path.name == 'offline-manifest.json':
                continue
            data = path.read_bytes()
            name = path.relative_to(self.root).as_posix()
            entries.append({'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                            'core': name in SITE.REQUIRED_CORE or name in self.extra_core})
        if extra:
            entries.extend(extra)
        revision = hashlib.sha256(json.dumps(entries, sort_keys=True).encode()).hexdigest()[:24]
        self.json('offline-manifest.json', {'date': '2000-01-01', 'revision': revision, 'files': entries})

    def errors(self):
        return SITE.Validator(self.root).run()

    def assertError(self, fragment):
        errors = self.errors()
        self.assertTrue(any(fragment in error for error in errors), (fragment, errors))

    def test_valid_release(self):
        self.assertEqual(self.errors(), [])

    def test_tampering_is_rejected_even_when_size_matches(self):
        self.write('styles.css', 'p{}')
        self.manifest()
        self.write('styles.css', 'a{}')
        self.assertError('SHA-256 mismatch')

    def test_manifest_paths_cannot_escape_or_use_url_encoding(self):
        for value in ('.', 'a\x00b', '../secret', '/secret', 'a/../secret', 'a//b', 'https://example.com/a', '%2e%2e/secret', 'a\\b', 'a?query'):
            with self.subTest(value=value):
                self.assertFalse(SITE.safe_manifest_path(value))
        self.manifest([{'path': '../secret', 'core': False, 'bytes': 1, 'sha256': 'x'}])
        self.assertError('unsafe or invalid path')

    def test_duplicate_manifest_entry(self):
        entry = self.read_json('offline-manifest.json')['files'][0]
        self.manifest([entry])
        self.assertError('duplicate path')

    def test_missing_required_and_unlisted_resources(self):
        (self.root / 'tts/openjtalk-wasm.wasm').unlink()
        self.manifest()
        self.assertError('required release resource is absent')
        self.write('new-resource.txt', 'not in manifest')
        self.assertError('file is not included in offline manifest')

    def test_duplicate_article_and_part_ids(self):
        law = self.read_json('data/civil.json')
        law['articles'][0]['parts'].append(dict(law['articles'][0]['parts'][0]))
        law['articles'].append(dict(law['articles'][0]))
        self.json('data/civil.json', law)
        self.manifest()
        self.assertError('duplicate article ID')
        self.assertError('duplicate part ID')
        self.assertError('total article count differs')

    def test_spoofed_source_is_rejected(self):
        law = self.read_json('data/civil.json')
        law['source'] = 'https://laws.e-gov.go.jp.attacker.example/law/129AC0000000089'
        self.json('data/civil.json', law)
        self.manifest()
        self.assertError('source does not match the expected e-Gov law identity')

    def test_html_css_and_fragment_references(self):
        self.write('index.html', '<html><body id="body"><a href="#missing">x</a><img src="absent.png"><img src="/outside.png"></body></html>')
        self.write('styles.css', 'body{background:url("missing.webp")}')
        self.manifest()
        self.assertError('missing fragment')
        self.assertError('missing local reference: absent.png')
        self.assertError('root-relative URL breaks project Pages paths')
        self.assertError('missing local reference: missing.webp')

    def test_relative_links_external_urls_and_existing_fragments_pass(self):
        self.write('index.html', '<html><body id="body"><a href="?law=civil#body">x</a><a href="https://example.com/">external</a></body></html>')
        self.write('read/civil.html', '<html><body><a href="../?law=civil#body">reader</a></body></html>')
        self.manifest()
        self.assertEqual(self.errors(), [])

    def test_imported_core_modules_must_be_core(self):
        self.write('app.js', "import { read } from './reader-state.mjs';\n")
        self.write('reader-state.mjs', 'export const read = () => {};')
        self.manifest()
        self.assertError('imported core module reader-state.mjs is not cached as core')
        self.extra_core.add('reader-state.mjs')
        self.manifest()
        self.assertEqual(self.errors(), [])

    def test_bad_manifest_revision(self):
        manifest = self.read_json('offline-manifest.json')
        manifest['revision'] = 'stale'
        self.json('offline-manifest.json', manifest)
        self.assertError('revision does not match')


if __name__ == '__main__':
    unittest.main()
