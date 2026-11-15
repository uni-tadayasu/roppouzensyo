const scope = self.registration.scope;
const prefix = 'roppo:' + scope + ':';
const metadataCache = prefix + 'metadata';
const manifestURL = new URL('offline-manifest.json', scope).href;
const stateURL = new URL('__offline_state__', scope).href;
let activeState;
let operation = Promise.resolve();

function enqueue(action) {
  const result = operation.then(action);
  operation = result.catch(() => {});
  return result;
}

function errorMessage(error) {
  if (error?.name === 'QuotaExceededError' || /quota.*exceed|exceed.*quota/i.test(error?.message || '')) {
    const preserved = activeState ? '保存済みの版は引き続き利用できます。' : '';
    return 'ブラウザの保存容量が不足したため、オフライン保存を完了できませんでした。' + preserved +
      '端末の空き容量を増やすか、通常モードの別ブラウザで再試行してください。';
  }
  return error?.message || '処理に失敗しました。';
}

async function state() {
  if (activeState !== undefined) return activeState;
  const cache = await caches.open(metadataCache);
  const saved = await cache.match(stateURL);
  activeState = saved ? await saved.json() : null;
  return activeState;
}

async function currentManifest() {
  const response = await timedFetch(manifestURL, {cache: 'no-store'});
  if (!response.ok) throw new Error('公開データの版を確認できませんでした。');
  const manifest = await response.json();
  if (typeof manifest.revision !== 'string' || !/^[a-zA-Z0-9-]+$/.test(manifest.revision) || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error('公開データの一覧を読み込めませんでした。');
  }
  const paths = new Set();
  for (const file of manifest.files) {
    const url = typeof file.path === 'string' && new URL(file.path, scope);
    if (!url || !url.href.startsWith(scope) || url.search || url.hash ||
        file.path.startsWith('/') || file.path.split('/').some((part) => !part || part === '.' || part === '..') ||
        !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || paths.has(url.href)) {
      throw new Error('保存対象の一覧が正しくありません。更新を中止しました。');
    }
    paths.add(url.href);
  }
  return manifest;
}

async function timedFetch(url, options) {
  const controller = new AbortController();
  let timer;
  const keepAlive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), 90000);
  };
  keepAlive();
  try {
    const response = await fetch(url, {...options, signal: controller.signal});
    if (!response.ok) return response;
    // An idle timeout allows a large voice dictionary to finish on a slow connection.
    const body = response.clone();
    const reader = body.body?.getReader();
    if (reader) {
      for (;;) {
        const {done} = await reader.read();
        if (done) break;
        keepAlive();
      }
    } else await body.arrayBuffer();
    return response;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('通信が止まりました。接続を確認して再試行してください。保存済みの版は引き続き利用できます。');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function verifiedResponse(file, url) {
  const response = await timedFetch(url, {cache: 'reload', redirect: 'error'});
  if (!response.ok || response.redirected) throw new Error('取得できませんでした。 ' + file.path);
  const bytes = await response.clone().arrayBuffer();
  if (bytes.byteLength !== file.bytes) throw new Error('配信中のファイルが更新されています。少し待って再試行してください。');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (hex !== file.sha256) throw new Error('配信中のファイルが更新されています。少し待って再試行してください。');
  return response;
}

async function stage(manifest, full, send = () => {}) {
  const prior = await state();
  const priorCache = prior ? await caches.open(prior.cache) : null;
  const files = manifest.files.filter((file) => full || file.core);
  if (prior?.revision === manifest.revision && (prior.full || !full)) {
    const intact = await Promise.all(files.map((file) => priorCache.match(new URL(file.path, scope).href)));
    if (intact.every(Boolean)) return prior;
  }
  // Never overwrite the active snapshot, including repairs of an identical revision.
  const nonce = Array.from(crypto.getRandomValues(new Uint32Array(4)), (number) => number.toString(16)).join('-');
  const name = prefix + manifest.revision + (full ? ':full:' : ':base:') + nonce;
  const target = await caches.open(name);
  const reusable = prior ? new Map(Object.entries(prior.hashes || {})) : new Map();
  let done = 0;
  const heartbeat = setInterval(() => send({kind: 'progress', done, total: files.length}), 20000);
  try {
    // Limit parallel requests and retain an earlier complete snapshot if any transfer fails.
    for (let offset = 0; offset < files.length; offset += 5) {
      const results = await Promise.allSettled(files.slice(offset, offset + 5).map(async (file) => {
        const url = new URL(file.path, scope).href;
        if (!url.startsWith(scope)) throw new Error('保存対象のパスが正しくありません。');
        const cached = reusable.get(file.path) === file.sha256 && await priorCache?.match(url);
        await target.put(url, cached || await verifiedResponse(file, url));
        done += 1;
        if (done === files.length || done % 5 === 0) send({kind: 'progress', done, total: files.length});
      }));
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
    }
    const next = {
      revision: manifest.revision, date: manifest.date, full, cache: name,
      files: files.length, hashes: Object.fromEntries(files.map((file) => [file.path, file.sha256]))
    };
    const metadata = await caches.open(metadataCache);
    await metadata.put(stateURL, new Response(JSON.stringify(next), {headers: {'Content-Type':'application/json'}}));
    activeState = next;
    return next;
  } catch (error) {
    await caches.delete(name);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  if (!event.ports[0] || !['status', 'prepare', 'save', 'update'].includes(event.data?.kind)) return;
    const send = (message) => {
      // Closing a tab or timing out its MessagePort must not roll back a valid download.
      try { event.ports[0].postMessage(message); } catch {}
    };
  event.waitUntil(enqueue(async () => {
    const prior = await state();
    const kind = event.data.kind;
    const next = kind === 'status' || (kind === 'prepare' && prior)
      ? prior
      : await stage(await currentManifest(), kind === 'save' || Boolean(prior?.full), send);
    send({
      kind: 'result', full: Boolean(next?.full), date: next?.date || '',
      revision: next?.revision || '',
      changed: Boolean(prior && next && prior.revision !== next.revision)
    });
    // Keep one previous cache available to any requests already using that snapshot.
    const keep = new Set([metadataCache, next?.cache, prior?.cache]);
    await Promise.all((await caches.keys()).filter((name) => name.startsWith(prefix) && !keep.has(name)).map((name) => caches.delete(name)));
  }).catch((error) => send({kind: 'error', message: errorMessage(error)})));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || !url.href.startsWith(scope) || url.href === manifestURL) return;
  event.respondWith((async () => {
    const current = await state();
    const cache = current ? await caches.open(current.cache) : null;
    const key = new URL(url);
    key.search = '';
    if (key.pathname.endsWith('/')) key.pathname += 'index.html';
    const saved = await cache?.match(key.href);
    if (saved) return saved;
    try {
      return await fetch(event.request);
    } catch {
      return new Response('オフラインです。オンライン時に六法書架の「オフライン保存」を完了してください。',{
        status: 503, headers: {'Content-Type': 'text/plain; charset=utf-8'}
      });
    }
  })());
});
