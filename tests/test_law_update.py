"""Reject source shapes that would silently omit part of an updated statute."""
import copy
import importlib.util
from pathlib import Path
import unittest

PATH = Path(__file__).resolve().parents[1] / 'scripts/update-laws.py'
SPEC = importlib.util.spec_from_file_location('update_laws', PATH)
LAWS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAWS)


def element(tag, *children, **attributes):
    return {'tag': tag, 'attr': attributes, 'children': list(children)}


class LawUpdateTests(unittest.TestCase):
    def setUp(self):
        paragraph = element('Paragraph', element('ParagraphNum', '１'),
                            element('ParagraphSentence', element('Sentence', '試験用の条文。')), Num='1')
        article = element('Article', element('ArticleTitle', '第一条'), paragraph, Num='1')
        self.body = element('LawBody', element('LawTitle', '民法'), element('TOC'),
                            element('MainProvision', article))
        self.data = {
            'law_info': {'law_id': '129AC0000000089', 'law_num': '明治二十九年法律第八十九号'},
            'revision_info': {
                'law_title': '民法', 'current_revision_status': 'CurrentEnforced',
                'law_revision_id': '129AC0000000089_20000101_000000000000000',
                'amendment_enforcement_date': '2000-01-01', 'updated': '2000-01-01T00:00:00+09:00',
            },
            'law_full_text': element('Law', self.body),
        }

    def transform(self):
        return LAWS.transform('civil', '129AC0000000089', '民法', self.data)

    def test_supported_body_and_toc_keep_original_text(self):
        metadata, law = self.transform()
        self.assertEqual(metadata['articles'], 1)
        self.assertEqual(law['articles'][0]['parts'][0]['text'], '試験用の条文。')

    def test_preamble_enactment_and_supplement_are_preserved(self):
        paragraph = copy.deepcopy(self.body['children'][-1]['children'][0]['children'][1])
        self.body['children'].extend([
            element('EnactStatement', '制定文。'), element('Preamble', paragraph),
            element('SupplProvision', element('SupplProvisionLabel', '附則'), paragraph),
        ])
        metadata, law = self.transform()
        self.assertEqual(metadata['articles'], 1)
        self.assertEqual(metadata['totalArticles'], 4)
        self.assertEqual([article['id'] for article in law['articles']],
                         ['enactment', 'preamble', '1', 's-original-text'])

    def test_appendices_and_unknown_elements_fail_closed(self):
        for tag in ('AppdxTable', 'AppdxNote', 'AppdxStyle', 'Appdx', 'AppdxFig', 'AppdxFormat', 'FutureElement'):
            with self.subTest(tag=tag):
                self.body['children'].append(element(tag, '重要な本文'))
                with self.assertRaisesRegex(ValueError, f'Unsupported LawBody elements.*{tag}'):
                    self.transform()
                self.body['children'].pop()

    def test_missing_required_structures_have_clear_errors(self):
        self.body['children'] = [element('LawTitle', '民法')]
        with self.assertRaisesRegex(ValueError, 'MainProvision is missing'):
            self.transform()
        self.data['law_full_text'] = element('Law')
        with self.assertRaisesRegex(ValueError, 'LawBody is missing'):
            self.transform()

    def test_wrong_revision_or_identity_remains_rejected(self):
        self.data['revision_info']['current_revision_status'] = 'NotYetEnforced'
        with self.assertRaisesRegex(ValueError, 'current enforced revision'):
            self.transform()
        self.data['revision_info']['current_revision_status'] = 'CurrentEnforced'
        self.data['law_info']['law_id'] = 'other'
        with self.assertRaisesRegex(ValueError, 'Unexpected law'):
            self.transform()


if __name__ == '__main__':
    unittest.main()
