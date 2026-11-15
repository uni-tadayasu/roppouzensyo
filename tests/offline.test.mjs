import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash, webcrypto} from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../docs/sw.js', import.meta.url), 'utf8');
const scope = 'https://example.test/roppouzensyo/';
const hash = (text) => createHash('sha256').update(text).digest('hex');
const descriptor = (path, body, core = true) => ({path, core, bytes: Buffer.byteLength(body), sha256: hash(body)});

function harness() {
  const stores = new Map();
  const handlers = {};
  const resources = new Map();
  const requests = [];
  let manifest;
  let online = true;
  let writeFailure;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async match(key) {return entries.get(String(key))?.clone();},
        async put(key, value) {
          if (writeFailure?.matches(name, String(key))) throw writeFailure.error;
          entries.set(String(key), value.clone());
        }
      };
    },
    async keys() {return [...stores.keys()];},
    async delete(name) {return stores.delete(name);}
  };
  const context = vm.createContext({
    self: {registration: {scope}, clients: {async claim() {}}, async skipWaiting() {},
      addEventListener(name, callback) {handlers[name] = callback;}},
    caches, crypto: webcrypto, Response, Request, URL, Blob, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval,
    async fetch(input) {
      const url = typeof input === 'string' ? input : input.url;
      requests.push(url);
      if (!online) throw new TypeError('offline');
      if (url === scope + 'offline-manifest.json') return Response.json(manifest);
      return resources.has(url) ? new Response(resources.get(url)) : new Response('missing', {status: 404});
    }
  });
  vm.runInContext(source, context);
  return {
    stores, resources, requests,
    offline() {online = false;},
    failWrites(error, matches) {writeFailure = {error, matches};},
    release(revision, files) {
      manifest = {revision, date: '2026-11-15', files: files.map(([path, body, core]) => descriptor(path, body, core))};
      for (const [path, body] of files) resources.set(scope + path, body);
      return manifest;
    },
    async message(kind) {
      const messages = [];
      let completion;
      handlers.message({data: {kind}, ports: [{postMessage(value) {messages.push(value);}}],
        waitUntil(value) {completion = value;}});
      await completion;
      return messages.at(-1);
    },
    async read(path) {
      let response;
      handlers.fetch({request: new Request(scope + path), respondWith(value) {response = value;}});
      return response;
    }
  };
}

test('a full snapshot serves article URLs and voice assets without a connection', async () => {
  const app = harness();
  app.release('one', [['index.html', 'reader'], ['data/law.json', 'law'], ['tts/voice.bin', 'voice', false]]);
  assert.equal((await app.message('save')).full, true);
  app.offline();
  assert.equal(await (await app.read('?law=civil&article=709')).text(), 'reader');
  assert.equal(await (await app.read('tts/voice.bin')).text(), 'voice');
  assert.equal((await app.read('missing.json')).status, 503);
});

test('a failed update keeps the prior snapshot; a retry only downloads changed files', async () => {
  const app = harness();
  app.release('one', [['index.html', 'old'], ['styles.css', 'unchanged']]);
  await app.message('save');
  app.release('two', [['index.html', 'new'], ['styles.css', 'unchanged']]);
  app.resources.set(scope + 'index.html', 'bad');
  assert.equal((await app.message('update')).kind, 'error');
  assert.equal(await (await app.read('')).text(), 'old');
  assert.equal((await app.message('status')).revision, 'one');
  app.resources.set(scope + 'index.html', 'new');
  app.requests.length = 0;
  assert.equal((await app.message('update')).changed, true);
  assert.deepEqual(app.requests, [scope + 'offline-manifest.json', scope + 'index.html']);
  assert.equal(await (await app.read('')).text(), 'new');
});

test('a missing file in the same revision is repaired without destroying the saved snapshot', async () => {
  const app = harness();
  app.release('one', [['index.html', 'reader'], ['styles.css', 'style']]);
  await app.message('save');
  const cache = [...app.stores.entries()].find(([name]) => name.includes(':full:'))[1];
  cache.delete(scope + 'styles.css');
  app.resources.delete(scope + 'styles.css');
  assert.equal((await app.message('save')).kind, 'error');
  assert.equal(await (await app.read('')).text(), 'reader');
  app.resources.set(scope + 'styles.css', 'style');
  app.requests.length = 0;
  assert.equal((await app.message('save')).full, true);
  assert.deepEqual(app.requests, [scope + 'offline-manifest.json', scope + 'styles.css']);
  app.offline();
  assert.equal(await (await app.read('styles.css')).text(), 'style');
});

test('quota failures explain storage limits in Japanese and retain the complete prior snapshot', async () => {
  for (const error of [new DOMException('Quota exceeded.', 'QuotaExceededError'), new Error('Quota exceeded.')]) {
    for (const failedPath of ['tts/voice.bin', '__offline_state__']) {
      const app = harness();
      app.release('one', [['index.html', 'reader'], ['tts/voice.bin', 'voice', false]]);
      assert.equal((await app.message('prepare')).full, false);
      const originalCaches = [...app.stores.keys()];
      app.failWrites(error, (_name, key) => key === scope + failedPath);
      const result = await app.message('save');
      assert.equal(result.kind, 'error');
      assert.match(result.message, /保存容量が不足/);
      assert.match(result.message, /保存済みの版は引き続き利用できます/);
      assert.doesNotMatch(result.message, /Quota/);
      assert.deepEqual([...app.stores.keys()], originalCaches, 'only the incomplete target is removed');
      assert.equal((await app.message('status')).full, false);
      app.offline();
      assert.equal(await (await app.read('')).text(), 'reader');
      assert.equal((await app.read('tts/voice.bin')).status, 503);
    }
  }
});

test('invalid manifests cannot replace a good snapshot or fetch untrusted paths', async () => {
  for (const invalid of [
    {path: '../outside.js'}, {path: 'https://untrusted.test/file'}, {path: 'index.html?q=other'},
    {sha256: 'not-a-hash'}, {bytes: -1}
  ]) {
    const app = harness();
    app.release('one', [['index.html', 'reader']]);
    await app.message('save');
    const manifest = app.release('two', [['index.html', 'new']]);
    Object.assign(manifest.files[0], invalid);
    app.requests.length = 0;
    assert.equal((await app.message('update')).kind, 'error');
    assert.deepEqual(app.requests, [scope + 'offline-manifest.json']);
    assert.equal(await (await app.read('')).text(), 'reader');
  }
});

test('saving a new release reloads the already-open reader', async () => {
  const offlineSource = (await readFile(new URL('../docs/offline.js', import.meta.url), 'utf8'))
    .replace('import.meta.url', JSON.stringify(scope + 'offline.js'));
  const elements = new Map(['#offline-save', '#check-update', '#offline-status'].map((id) => [id, {
    disabled: false, textContent: '', events: {}, addEventListener(name, callback) {this.events[name] = callback;}
  }]));
  let reloads = 0;
  const timers = new Map();
  let nextTimer = 0;
  class Channel {
    constructor() {
      this.port1 = {close() {}, onmessage: null};
      this.port2 = {postMessage: (data) => queueMicrotask(() => this.port1.onmessage({data}))};
    }
  }
  const active = {postMessage({kind}, [port]) {port.postMessage({kind: 'result', full: true, changed: kind === 'save'});}};
  const context = vm.createContext({
    document: {querySelector(id) {return elements.get(id);}}, URL, MessageChannel: Channel,
    window: {isSecureContext: true, location: {reload() {reloads++;}}},
    navigator: {onLine: true, serviceWorker: {async register() {}, ready: Promise.resolve({active})}},
    setTimeout(callback) {timers.set(++nextTimer, callback); return nextTimer;},
    clearTimeout(id) {timers.delete(id);}
  });
  vm.runInContext(offlineSource, context);
  await new Promise((resolve) => setImmediate(resolve));
  elements.get('#offline-save').events.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reloads, 1);
  assert.equal(timers.size, 0);
  assert.match(elements.get('#offline-status').textContent, /再読み込み/);
});
