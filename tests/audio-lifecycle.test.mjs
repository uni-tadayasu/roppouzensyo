import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Load the small browser modules with controlled Web Audio/Worker dependencies.
// No audio hardware or network connection is needed for these race regressions.
function loadModule(relative, dependencies, exports) {
  const url = new URL(`../docs/${relative}`, import.meta.url);
  const source = readFileSync(url, 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace(/\bexport /g, '')
    .replace(/import\.meta\.url/g, JSON.stringify(url.href));
  return new Function(...Object.keys(dependencies), `${source}\nreturn {${exports.join(',')}};`)(...Object.values(dependencies));
}
function timers() {
  let sequence = 0;
  const pending = new Map();
  return {
    pending,
    setTimeout(fn, delay) { const id = ++sequence; pending.set(id, {fn, delay}); return id; },
    clearTimeout(id) { pending.delete(id); },
    fire(delay) {
      const pair = [...pending].find(([, timer]) => timer.delay === delay);
      assert.ok(pair, `a ${delay}ms timeout is registered`);
      pending.delete(pair[0]); pair[1].fn();
    },
  };
}
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
function parameter() {
  return {value: 1, cancelScheduledValues() {}, setValueAtTime(value) {this.value = value;},
    linearRampToValueAtTime(value) {this.value = value;}, setTargetAtTime(value) {this.value = value;}};
}
function context() {
  const buffers = [];
  const gains = [];
  return {
    currentTime: 0, state: 'running', destination: {}, buffers, gains,
    resume() {this.state = 'running'; return Promise.resolve();},
    suspend() {this.state = 'suspended'; return Promise.resolve();},
    createGain() { const gain = {gain: parameter(), connect() {}}; gains.push(gain); return gain; },
    createBuffer(channels, length) {return {getChannelData: () => new Float32Array(length)};},
    createBufferSource() {
      const source = {playbackRate: parameter(), connect() {}, disconnect() {},
        start() {if (!this.loop) queueMicrotask(() => this.onended?.());}, stop() {this.onended?.();}};
      buffers.push(source); return source;
    },
    decodeAudioData: async () => ({duration: 4}),
  };
}
function localVoice(workerBehavior, audio = context(), audioStart = () => Promise.resolve(audio)) {
  const clock = timers();
  const workers = [];
  class Worker {
    constructor() { workers.push(this); }
    postMessage(message) {
      queueMicrotask(() => workerBehavior(this, message, workers.length));
    }
    terminate() {this.terminated = true;}
  }
  const module = loadModule('tts/voice.js', {
    URL, Intl, Worker, window: {Worker, WebAssembly: {}, DecompressionStream: {}},
    startReadingAudio: audioStart, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  }, ['playLocalVoice', 'setLocalVoiceOptions', 'stopLocalVoice']);
  return {...module, clock, workers, audio};
}
function success(worker, message) {
  worker.onmessage({data: {id: message.id, ok: true,
    result: message.method === 'synthesize' ? {pcm: [20, -20], sampleRate: 48000} : undefined}});
}

test('a failed worker configuration is discarded and the next playback recovers', async () => {
  const voice = localVoice((worker, message, count) => {
    if (count === 1) worker.onmessage({data: {id: message.id, ok: false, error: 'dictionary unavailable'}});
    else success(worker, message);
  });
  await assert.rejects(voice.playLocalVoice('第一条。'), /dictionary unavailable/);
  assert.equal(voice.workers[0].terminated, true);
  await voice.playLocalVoice('第二条。');
  assert.equal(voice.workers.length, 2);
  // A delayed event from the terminated worker cannot kill its replacement.
  voice.workers[0].onerror();
  await voice.playLocalVoice('第三条。');
  assert.equal(voice.workers.length, 2);
  assert.notEqual(voice.workers[1].terminated, true);
  assert.equal(voice.clock.pending.size, 0);
});

test('a stalled synthesis times out, releases the queue, and permits retry', async () => {
  const voice = localVoice((worker, message, count) => {
    if (count > 1 || message.method === 'configure') success(worker, message);
  });
  const result = voice.playLocalVoice('第一条。');
  const rejection = assert.rejects(result, /時間内/);
  await flush();
  voice.clock.fire(45000);
  await rejection;
  await voice.playLocalVoice('第二条。');
  assert.equal(voice.workers.length, 2);
  assert.equal(voice.clock.pending.size, 0);
});

test('volume and speed changes during audio startup are preserved', async () => {
  const audio = context();
  let resume;
  const voice = localVoice(success, audio, () => new Promise(resolve => {resume = resolve;}));
  const done = voice.playLocalVoice('第一条。', {rate: 1, volume: 1});
  voice.setLocalVoiceOptions({rate: 2, volume: 0.25});
  resume(audio);
  await done;
  assert.equal(audio.gains[0].gain.value, 0.25);
  assert.equal(audio.buffers[0].playbackRate.value, 2 / 1.5);
});

function readingAudio(audio, options = {}) {
  const clock = timers();
  const session = {type: 'ambient'};
  const module = loadModule('tts/reading-audio.js', {
    URL, navigator: {audioSession: session},
    window: {AudioContext: class {constructor() {return audio;}}},
    fetch: options.fetch || (() => Promise.reject(new Error('unused'))),
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  }, ['startReadingAudio', 'stopReadingAudio', 'setReadingBgm', 'setReadingSpeechActive']);
  return {...module, clock, session};
}
test('a failed Web Audio start restores the original system audio session', async () => {
  const audio = context();
  audio.resume = () => Promise.reject(new Error('blocked'));
  const reading = readingAudio(audio);
  await assert.rejects(reading.startReadingAudio(), /blocked/);
  assert.equal(reading.session.type, 'ambient');
  audio.resume = () => {audio.state = 'running'; return Promise.resolve();};
  await reading.startReadingAudio();
  assert.equal(reading.session.type, 'playback');
  reading.stopReadingAudio(); reading.clock.fire(200);
  assert.equal(reading.session.type, 'ambient');
});

test('an older failed start does not release a newer playback session', async () => {
  const audio = context();
  const resumptions = [];
  audio.resume = () => new Promise((resolve, reject) => resumptions.push({resolve, reject}));
  const reading = readingAudio(audio);
  const first = reading.startReadingAudio();
  const rejection = assert.rejects(first, /old/);
  const second = reading.startReadingAudio();
  resumptions[0].reject(new Error('old')); await rejection;
  assert.equal(reading.session.type, 'playback');
  resumptions[1].resolve(); await second;
  reading.stopReadingAudio(); reading.clock.fire(200);
  assert.equal(reading.session.type, 'ambient');
});

test('BGM finishing its download after stop never starts a stale loop', async () => {
  const audio = context();
  let downloaded;
  const reading = readingAudio(audio, {fetch: () => new Promise(resolve => {downloaded = resolve;})});
  reading.setReadingBgm({enabled: true, volume: 0.22});
  await reading.startReadingAudio();
  reading.stopReadingAudio(); reading.clock.fire(200);
  downloaded({ok: true, arrayBuffer: async () => new ArrayBuffer(1)});
  await flush();
  assert.equal(audio.buffers.length, 0);
  assert.equal(reading.session.type, 'ambient');
});

test('non-finite BGM volume does not reach AudioParam', async () => {
  const audio = context();
  const reading = readingAudio(audio, {fetch: async () => ({ok: true, arrayBuffer: async () => new ArrayBuffer(1)})});
  reading.setReadingBgm({enabled: true, volume: 0.25});
  await reading.startReadingAudio(); await flush();
  reading.setReadingBgm({enabled: true, volume: Number.NaN});
  reading.setReadingSpeechActive(true);
  assert.equal(audio.gains[0].gain.value, 0.25 * 0.33);
});
