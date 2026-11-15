/* Japanese speech synthesis runs locally in the Open JTalk worker. */
import { startReadingAudio } from './reading-audio.js';

const directory = new URL('./', import.meta.url);
const dictionary = new URL('open_jtalk_dic_utf_8-1.11.tar.gz', directory).href;
const voiceFiles = {
  female: 'mei_normal.htsvoice',
  male: 'nitech_jp_atr503_m001.htsvoice',
};
const blockLimit = 55;

let worker;
let nextRequest = 0;
let selectedVoice;
let pendingSynthesis = Promise.resolve();
let audioContext;
let gain;
let playback;
let playbackRate = 1;
let playbackVolume = 1;
let generation = 0;
const requests = new Map();

function failWorker(error = new Error('日本語音声エンジンを起動できませんでした。')) {
  worker?.terminate();
  worker = undefined;
  selectedVoice = undefined;
  for (const request of requests.values()) {
    clearTimeout(request.timer);
    request.reject(error instanceof Error ? error : new Error('日本語音声エンジンを起動できませんでした。'));
  }
  requests.clear();
}

function workerRequest(method, ...args) {
  if (!worker) {
    worker = new Worker(new URL('browser/worker.js', directory), { type: 'module' });
    const owner = worker;
    worker.onerror = () => { if (worker === owner) failWorker(); };
    worker.onmessageerror = () => { if (worker === owner) failWorker(); };
    worker.onmessage = ({ data }) => {
      if (worker !== owner) return;
      const request = requests.get(data.id);
      if (!request) return;
      if (!data.ok) {
        // A failed configure can leave the WASM module permanently rejected.
        // Recreate it on the next attempt instead of reusing that broken state.
        failWorker(new Error(data.error || '日本語音声の作成に失敗しました。'));
        return;
      }
      requests.delete(data.id);
      clearTimeout(request.timer);
      request.resolve(data.result);
    };
  }
  const id = ++nextRequest;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!requests.has(id)) return;
      failWorker(new Error('音声の準備が時間内に完了しませんでした。接続またはオフライン保存を確認し、もう一度お試しください。'));
    }, method === 'configure' ? 180000 : 45000);
    requests.set(id, { resolve, reject, timer });
    try {
      worker.postMessage({ id, method, args });
    } catch (error) {
      requests.delete(id);
      clearTimeout(timer);
      failWorker(error);
      reject(error);
    }
  });
}

function speechBlocks(text) {
  const sentences = String(text).replace(/[^\S\n]+/g, ' ').trim().match(/[^。！？\n]+[。！？]*|[。！？]+/gu) || [];
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('ja', { granularity: 'word' }) : null;
  const chunks = sentences.flatMap(sentence => {
    if (sentence.length <= blockLimit) return [sentence];
    const units = segmenter ? Array.from(segmenter.segment(sentence), unit => unit.segment) : Array.from(sentence);
    const blocks = [];
    let block = '';
    for (const unit of units) {
      if (block && block.length + unit.length > blockLimit) {
        blocks.push(block);
        block = '';
      }
      if (unit.length > blockLimit) {
        const characters = Array.from(unit);
        for (let start = 0; start < characters.length; start += blockLimit) {
          blocks.push(characters.slice(start, start + blockLimit).join(''));
        }
      } else {
        block += unit;
      }
    }
    if (block) blocks.push(block);
    return blocks;
  });
  return chunks.map(chunk => chunk.trim()).filter(chunk => /[\p{L}\p{N}]/u.test(chunk));
}

function synthesize(text, gender, current) {
  const job = pendingSynthesis.then(async () => {
    if (current !== generation) return null;
    const voice = voiceFiles[gender];
    if (selectedVoice !== voice) {
      await workerRequest('configure', {
        voiceUrl: new URL(voice, directory).href,
        dicArchiveUrl: dictionary,
      });
      selectedVoice = voice;
    }
    if (current !== generation) return null;
    // Use the engine's own timing where possible, then adjust the current buffer as the speed slider moves.
    const baseRate = Math.max(0.75, Math.min(1.5, playbackRate));
    const samples = await workerRequest('synthesize', text, { speed: baseRate });
    return { ...samples, baseRate };
  });
  pendingSynthesis = job.catch(() => {});
  return job;
}

function playSamples({ pcm, sampleRate, baseRate }) {
  if (!pcm.length) return Promise.resolve();
  const buffer = audioContext.createBuffer(1, pcm.length, sampleRate);
  const samples = buffer.getChannelData(0);
  for (let index = 0; index < pcm.length; index++) {
    samples[index] = Math.max(-1, Math.min(1, pcm[index] / 32768));
  }
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = playbackRate / baseRate;
  source.connect(gain);
  return new Promise(resolve => {
    source.onended = () => {
      if (playback?.source === source) playback = undefined;
      source.disconnect();
      resolve();
    };
    source.start();
    playback = { source, baseRate };
  });
}

export function setLocalVoiceOptions({ rate, volume } = {}) {
  if (Number.isFinite(rate)) playbackRate = Math.max(0.5, Math.min(2, rate));
  if (Number.isFinite(volume)) playbackVolume = Math.max(0, Math.min(1, volume));
  if (!audioContext) return;
  const now = audioContext.currentTime;
  if (gain) {
    const level = gain.gain;
    const previousLevel = level.value;
    level.cancelScheduledValues(now);
    level.setValueAtTime(previousLevel, now);
    level.linearRampToValueAtTime(playbackVolume, now + 0.012);
  }
  if (playback) {
    const parameter = playback.source.playbackRate;
    parameter.cancelScheduledValues(now);
    parameter.setTargetAtTime(playbackRate / playback.baseRate, now, 0.012);
  }
}

export function stopLocalVoice() {
  generation++;
  playback?.source.stop();
  playback = undefined;
}

export async function playLocalVoice(text, { gender = 'female', rate = 1, volume = 1, onStatus = () => {} } = {}) {
  stopLocalVoice();
  const current = generation;
  const chunks = speechBlocks(text);
  if (!chunks.length) return;
  if (!Object.hasOwn(voiceFiles, gender)) throw new Error('日本語の音声を選択してください。');
  if (!window.Worker || !window.WebAssembly || !window.DecompressionStream) {
    throw new Error('このブラウザーは内蔵音声に対応していません。利用できる端末音声に切り替えてください。');
  }
  setLocalVoiceOptions({ rate, volume });
  audioContext = await startReadingAudio();
  if (current !== generation) return;
  if (!gain) {
    gain = audioContext.createGain();
    gain.connect(audioContext.destination);
  }
  gain.gain.cancelScheduledValues(audioContext.currentTime);
  gain.gain.setValueAtTime(playbackVolume, audioContext.currentTime);
  onStatus('loading');
  let upcoming = synthesize(chunks[0], gender, current);
  try {
    for (let index = 0; index < chunks.length; index++) {
      const samples = await upcoming;
      if (current !== generation || !samples) return;
      if (index + 1 < chunks.length) {
        upcoming = synthesize(chunks[index + 1], gender, current);
        upcoming.catch(() => {});
      }
      if (index === 0) onStatus('playing');
      if (current !== generation) return;
      await playSamples(samples);
    }
  } catch (error) {
    if (current === generation) throw error;
  }
}
