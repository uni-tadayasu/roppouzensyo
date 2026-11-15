import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Exercise the actual async route controller with controlled network responses.
// Browser smoke tests cover rendering the successful route into the real DOM.
const source = readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
const routeSource = source.slice(source.indexOf('function setRouteStatus('), source.indexOf('function markPartActive('));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function reader() {
  const nodes = new Map();
  const find = id => {
    if (!nodes.has(id)) nodes.set(id, {
      hidden: false, inert: false, textContent: '', attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      focus() { this.focused = true; },
    });
    return nodes.get(id);
  };
  const article = { id: '1', title: '第一条', parts: [] };
  const civil = { id: 'civil', title: '民法', articles: [article] };
  const state = {
    catalog: { laws: [{ id: 'constitution', title: '日本国憲法' }, civil] },
    law: civil, article, routeRequest: 0,
  };
  let route = { lawId: 'civil', articleId: '1', partId: '' };
  const requests = [];
  let recorded = 0;
  const dependencies = {
    state, find, document: { querySelector: () => find('grid') },
    currentRoute: () => route,
    getLaw: () => { const pending = deferred(); requests.push(pending); return pending.promise; },
    resolveArticle: law => law.articles[0],
    finishGesture() {}, recordReading() { recorded++; }, report() {},
    stopArticlePlayback() {}, console: { error() {} },
  };
  const showRoute = new Function(...Object.keys(dependencies), `${routeSource}\nreturn showRoute;`)(...Object.values(dependencies));
  return { showRoute, requests, civil, find, recorded: () => recorded,
    setRoute(lawId) { route = { ...route, lawId }; } };
}

test('a failed route hides stale law content and offers an accessible retry', async () => {
  const app = reader();
  app.setRoute('constitution');
  const loading = app.showRoute(true);
  assert.equal(app.find('grid').inert, true);
  app.requests[0].reject(new Error('offline'));
  await loading;
  assert.equal(app.find('grid').hidden, true);
  assert.equal(app.find('route-retry').hidden, false);
  assert.match(app.find('route-message').textContent, /日本国憲法を読み込めませんでした/);
  assert.equal(app.find('route-message').focused, true);
  assert.equal(app.recorded(), 0, 'failed routes must not overwrite reading progress');
});

test('retry restores the reader after its data becomes available', async () => {
  const app = reader();
  const first = app.showRoute();
  app.requests[0].reject(new Error('temporary failure'));
  await first;
  const retry = app.showRoute();
  app.requests[1].resolve(app.civil);
  await retry;
  assert.equal(app.find('grid').hidden, false);
  assert.equal(app.find('grid').inert, false);
  assert.equal(app.find('grid').attributes['aria-busy'], 'false');
  assert.equal(app.find('route-status').hidden, true);
  assert.equal(app.recorded(), 1);
});

test('a delayed failed navigation cannot hide a newer successful route', async () => {
  const app = reader();
  app.setRoute('constitution');
  const oldRoute = app.showRoute();
  app.setRoute('civil');
  const newRoute = app.showRoute();
  app.requests[1].resolve(app.civil);
  await newRoute;
  app.requests[0].reject(new Error('delayed failure'));
  await oldRoute;
  assert.equal(app.find('grid').hidden, false);
  assert.equal(app.find('grid').inert, false);
  assert.equal(app.find('route-status').hidden, true);
  assert.equal(app.recorded(), 1);
});
