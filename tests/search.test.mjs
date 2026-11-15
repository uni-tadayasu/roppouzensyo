import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateMarks, readStudyState } from '../docs/reader-state.mjs';

// Exercise the application's actual search and reference resolver without starting the DOM UI.
const source = readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/^start\(\);\s*$/m, '');
const dependencies = {
  document: { getElementById: () => null },
  location: { href: 'https://example.test/roppouzensyo/' },
  localStorage: { getItem: () => null },
  validateMarks, readStudyState, setupSpeech: () => ({}),
};
const { state, searchData, parseReference } = new Function(...Object.keys(dependencies),
  `${source}\nreturn { state, searchData, parseReference };`)(...Object.values(dependencies));
const catalog = JSON.parse(readFileSync(new URL('../docs/data/catalog.json', import.meta.url), 'utf8'));
const laws = catalog.laws.map(law => JSON.parse(readFileSync(new URL(`../docs/data/${law.id}.json`, import.meta.url), 'utf8')));
state.catalog = catalog;
state.law = laws.find(law => law.id === 'civil');
const search = query => searchData(query, laws);
const routes = query => search(query).map(result => `${result.law.id}:${result.article.id}:${result.part?.id || ''}`);

test('article references accept Arabic, full-width, kanji and branch forms', () => {
  for (const query of ['民法第709条', '民法７０９条', '民法 第七百九条', '民法709']) {
    assert.deepEqual(routes(query), ['civil:709:']);
  }
  for (const query of ['民法398-2', '民法３９８条の２', '民法第三百九十八条の二']) {
    assert.deepEqual(routes(query), ['civil:398_2:']);
  }
  assert.deepEqual(parseReference('００１'), { article: '1', part: '' });
  assert.deepEqual(parseReference('０３９８-０２'), { article: '398_2', part: '' });
});

test('a reference and keywords search the specified article instead of missing Arabic article numbers', () => {
  for (const query of ['民法 709条 不法行為', '民法 第７０９条 故意 過失', '民法 第 七百九 条 故意']) {
    const results = search(query);
    assert.equal(results.length, 1, query);
    assert.equal(results[0].article.id, '709');
    assert.equal(results[0].law.id, 'civil');
  }
  assert.equal(search('民法 709条 根抵当').length, 0);
  assert.deepEqual(routes('民法 398-2 極度額'), ['civil:398_2:1']);
});

test('paragraph references constrain keyword matches and retain the exact destination', () => {
  assert.deepEqual(routes('民法 94条 2項 善意'), ['civil:94:2']);
  assert.deepEqual(routes('民法 第九十四条 第二項 善意 第三者'), ['civil:94:2']);
  assert.deepEqual(routes('民法 94条 1項 善意'), []);
  assert.deepEqual(routes('民法 94条 99項 善意'), []);
  assert.deepEqual(routes('民法 99999条 故意'), []);
});

test('paragraph searches include their items while item searches exclude sibling items', () => {
  assert.deepEqual(routes('憲法 7条 1項 国会'), ['constitution:7:1']);
  assert.ok(search('憲法 7条 1項 国会')[0].sample.includes('国会'));
  assert.deepEqual(routes('憲法 第七条 第二号 国会'), ['constitution:7:1.2']);
  assert.deepEqual(routes('憲法 7条 1項 1号 国会'), []);
});

test('law aliases and unqualified references preserve scope and active-law priority', () => {
  assert.deepEqual(routes('民訴 2条'), ['civil-procedure:2:']);
  const results = search('1条');
  assert.equal(results[0].law.id, 'civil');
  assert.equal(new Set(results.map(result => result.law.id)).size, 6);
  assert.ok(search('民法').every(result => result.law.id === 'civil'));
  assert.ok(search('民法 信義 誠実').some(result => result.article.id === '1'));
});

test('repealed article ranges resolve without inventing a different article', () => {
  const range = laws.flatMap(law => law.articles.map(article => ({ law, article })))
    .find(({ article }) => /^\d+-\d+$/u.test(article.id));
  assert.ok(range);
  const start = range.article.id.split('-')[0];
  const results = search(`${range.law.title} ${start}条`);
  assert.equal(results.length, 1);
  assert.equal(results[0].article.id, range.article.id);
});
