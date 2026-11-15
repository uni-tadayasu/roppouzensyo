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


class TableExtractionTests(unittest.TestCase):
    def cell(self, value, **attributes):
        return element('TableColumn', element('Sentence', value), **attributes)

    def parts(self, *rows):
        table = element('TableStruct', element('Table', *rows))
        original = copy.deepcopy(table)
        result = LAWS.table_parts(table, '1.t1', 1)
        self.assertEqual(table, original, 'Extraction must not alter source data')
        return result

    def test_rowspan_keeps_shared_target_article_on_later_rows(self):
        # Criminal Procedure 483-2 / 494-4 share the first column across rows.
        parts = self.parts(
            element('TableRow', self.cell('適用条文', rowspan='2'), self.cell('裁判所は'), self.cell('判決をした裁判所は')),
            element('TableRow', self.cell('裁判所の'), self.cell('その裁判所の')),
        )
        self.assertEqual(parts[1]['text'], '適用条文　｜　裁判所の　｜　その裁判所の')
        self.assertEqual(parts[1]['reading'], '適用条文。裁判所の。その裁判所の')
        self.assertEqual(parts[1]['id'], '1.t1.2')

    def test_rowspan_in_later_column_keeps_shared_condition(self):
        # Civil Procedure 3-3 shares the jurisdiction condition for イ〜ニ.
        parts = self.parts(
            element('TableRow', self.cell('七 社団に関する訴え'), self.cell('日本国内にあるとき。', rowspan='3')),
            element('TableRow', self.cell('イ 社員に対する訴え')),
            element('TableRow', self.cell('ロ 役員に対する訴え')),
            element('TableRow', self.cell('八 不法行為'), self.cell('不法行為があった地')),
        )
        self.assertEqual(parts[1]['text'], 'イ 社員に対する訴え　｜　日本国内にあるとき。')
        self.assertEqual(parts[2]['text'], 'ロ 役員に対する訴え　｜　日本国内にあるとき。')
        self.assertEqual(parts[3]['text'], '八 不法行為　｜　不法行為があった地')

    def test_colspan_is_read_once_and_ruby_reading_is_preserved(self):
        ruby = element('Ruby', '法律', element('Rt', 'ほうりつ'))
        parts = self.parts(
            element('TableHeaderRow', element('TableHeaderColumn', '共通見出し', colspan='2')),
            element('TableRow', self.cell(ruby, rowspan='2'), self.cell('甲')),
            element('TableRow', self.cell('乙')),
        )
        self.assertEqual(parts[0]['text'], '共通見出し')
        self.assertEqual(parts[2]['text'], '法律　｜　乙')
        self.assertEqual(parts[2]['reading'], 'ほうりつ。乙')

    def test_border_joined_empty_cells_keep_shared_replacement(self):
        borders = {'BorderLeft': 'solid', 'BorderRight': 'solid'}
        parts = self.parts(
            element('TableRow', self.cell('甲'), self.cell('共通の読替え', BorderBottom='none', **borders)),
            element('TableRow', self.cell('乙'), self.cell('', BorderTop='none', BorderBottom='none', **borders)),
            element('TableRow', self.cell('丙'), self.cell('', BorderTop='none', BorderBottom='solid', **borders)),
            element('TableRow', self.cell('丁'), self.cell('', BorderTop='solid', **borders)),
        )
        self.assertEqual(parts[1]['text'], '乙　｜　共通の読替え')
        self.assertEqual(parts[2]['reading'], '丙。共通の読替え')
        self.assertEqual(parts[3]['text'], '丁　｜　')

    def test_unbordered_blank_cells_are_not_inferred_to_be_shared(self):
        borders = {name: 'none' for name in ('BorderTop', 'BorderBottom', 'BorderLeft', 'BorderRight')}
        parts = self.parts(
            element('TableRow', self.cell('甲'), self.cell('前の値', **borders)),
            element('TableRow', self.cell('乙'), self.cell('', **borders)),
        )
        self.assertEqual(parts[1]['text'], '乙　｜　')

    def test_malformed_spans_and_ragged_rows_fail_closed(self):
        for attribute in ('rowspan', 'colspan'):
            for value in ('0', '-1', '1.5', 'invalid'):
                with self.subTest(attribute=attribute, value=value):
                    with self.assertRaisesRegex(ValueError, 'Invalid table'):
                        self.parts(element('TableRow', self.cell('本文', **{attribute: value})))
        with self.assertRaisesRegex(ValueError, 'beyond the final row'):
            self.parts(element('TableRow', self.cell('本文', rowspan='2')))
        with self.assertRaisesRegex(ValueError, 'Inconsistent table column count'):
            self.parts(element('TableRow', self.cell('甲'), self.cell('乙')),
                       element('TableRow', self.cell('丙')))
        with self.assertRaisesRegex(ValueError, 'Overlapping table cells'):
            self.parts(element('TableRow', self.cell('甲'), self.cell('乙', rowspan='2')),
                       element('TableRow', self.cell('丙', colspan='2')))


if __name__ == '__main__':
    unittest.main()
