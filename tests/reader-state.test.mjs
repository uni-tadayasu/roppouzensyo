import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMarks, findMarkRange, readStudyState, bookmarkKey, searchExcerpt } from '../docs/reader-state.mjs';

test('malformed storage cannot prevent the reader from starting', () => {
  for (const raw of ['', '{', 'null', '[]', '42']) {
    assert.deepEqual(readStudyState(raw), { bookmarks: [], last: null });
  }
});

test('bookmarks preserve valid paragraph links and discard unsafe or malformed routes', () => {
  const entry = { law: 'civil', article: '709', part: '1', label: '民法 第七百九条' };
  const entries = [entry, entry, { ...entry, law: '../civil' }, { ...entry, article: 709 },
    { ...entry, part: '1&law=criminal' }, { ...entry, article: 'supp-1-1', part: '1.2' }];
  const value = readStudyState(JSON.stringify({ bookmarks: entries, last: entry }));
  assert.equal(value.bookmarks.length, 2);
  assert.equal(bookmarkKey(value.bookmarks[0]), 'civil:709:1');
  assert.deepEqual(value.last, entry);
});

test('saved routes and display labels have bounded size', () => {
  const entries = Array.from({ length: 120 }, (_, index) => ({ law: 'civil', article: String(index + 1), label: 'あ'.repeat(250) }));
  const value = readStudyState(JSON.stringify({ bookmarks: entries }));
  assert.equal(value.bookmarks.length, 100);
  assert.equal(value.bookmarks[0].label.length, 200);
});

test('marker imports reject invalid offsets and inconsistent text lengths', () => {
  const mark = { key: 'civil:709:part:1', text: '権利', start: 4, end: 6, before: '故意に', after: 'を侵害' };
  assert.deepEqual(validateMarks([mark]), [mark]);
  assert.equal(validateMarks([null, { ...mark, start: -1 }, { ...mark, end: 5 }, { ...mark, start: 4.2 }, { ...mark, text: '' }]).length, 0);
});

test('markers relocate after text is inserted before an unambiguous marked passage', () => {
  const mark = { text: '権利', start: 2, end: 4, before: '他人', after: 'を' };
  const updated = '故意又は過失によって他人権利を侵害';
  assert.deepEqual(findMarkRange(mark, updated), [updated.indexOf('権利'), updated.indexOf('権利') + 2]);
});

test('markers do not silently attach to a repeated phrase after amendments', () => {
  const mark = { text: '権利', start: 20, end: 22, before: '旧文', after: '旧文' };
  assert.equal(findMarkRange(mark, '権利を守り、別の権利を守る'), null);
  assert.equal(findMarkRange(mark, '法益を守る'), null);
});

test('markers use surrounding text to recover the intended repeated phrase', () => {
  const mark = { text: '権利', start: 20, end: 22, before: '別の', after: 'を' };
  const updated = '権利を守り、別の権利を守る';
  assert.deepEqual(findMarkRange(mark, updated), [8, 10]);
});

test('search excerpts show a match beyond the old first 105 character window', () => {
  const text = '前文。'.repeat(80) + '所有権を取得する場合' + '。後文'.repeat(80);
  const excerpt = searchExcerpt(text, '所有権');
  assert.ok(excerpt.includes('所有権'));
  assert.ok(excerpt.startsWith('…'));
  assert.ok(excerpt.endsWith('…'));
  assert.ok(excerpt.length <= 107);
});

test('search excerpts map full-width normalization back to original source text', () => {
  const text = '前文'.repeat(80) + 'ＡＢＣ１２３の条件' + '後文'.repeat(80);
  const excerpt = searchExcerpt(text, 'abc123');
  assert.ok(excerpt.includes('ＡＢＣ１２３'));
});

test('search excerpts preserve supplementary Unicode characters at both edges', () => {
  const text = '𠮷'.repeat(100) + '権利' + '𠮷'.repeat(100);
  const excerpt = searchExcerpt(text, '権利');
  assert.ok(excerpt.includes('権利'));
  assert.equal(excerpt.replace(/𠮷|権利|…/gu, ''), '');
});
