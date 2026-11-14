/* Japanese speech synthesis runs locally in the Open JTalk worker. */
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
let playback;
let generation = 0;
const requests = new Map();

function failWorker() {
  worker?.terminate();
  worker = undefined;
  selectedVoice = undefined;
  for (const request of requests.values()) {
    request.reject(new Error('日本語音声エンジンを起動できませんでした。'));
  }
  requests.clear();
}

function workerRequest(method, ...args) {
  if (!worker) {
    worker = new Worker(new URL('browser/worker.js', directory), { type: 'module' });
    worker.onerror = failWorker;
    worker.onmessageerror = failWorker;
    worker.onmessage = ({ data }) => {
      const request = requests.get(data.id);
      if (!request) return;
      requests.delete(data.id);
      if (data.ok) request.resolve(data.result);
      else request.reject(new Error(data.error));
    };
  }
  const id = ++nextRequest;
  return new Promise((resolve, reject) => {
    requests.set(id, { resolve, reject });
    try {
      worker.postMessage({ id, method, args });
    } catch (error) {
      requests.delete(id);
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

function synthesize(text, gender, speed, current) {
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
    return workerRequest('synthesize', text, { speed });
  });
  pendingSynthesis = job.catch(() => {});
  return job;
}

function playSamples({ pcm, sampleRate }) {
  if (!pcm.length) return Promise.resolve();
  const buffer = audioContext.createBuffer(1, pcm.length, sampleRate);
  const samples = buffer.getChannelData(0);
  for (let index = 0; index < pcm.length; index++) {
    samples[index] = Math.max(-1, Math.min(1, pcm[index] / 32768));
  }
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  playback = source;
  return new Promise(resolve => {
    source.onended = () => {
      if (playback === source) playback = undefined;
      source.disconnect();
      resolve();
    };
    source.start();
  });
}

export function stopLocalVoice() {
  generation++;
  playback?.stop();
  playback = undefined;
}

export async function playLocalVoice(text, { gender = 'female', rate = 1, onStatus = () => {} } = {}) {
  stopLocalVoice();
  const current = generation;
  const chunks = speechBlocks(text);
  if (!chunks.length) return;
  if (!Object.hasOwn(voiceFiles, gender)) throw new Error('日本語の音声を選択してください。');
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio || !window.Worker || !window.WebAssembly || !window.DecompressionStream) {
    throw new Error('このブラウザーは内蔵音声に対応していません。利用できる端末音声に切り替えてください。');
  }
  audioContext ||= new Audio();
  if (audioContext.state !== 'running') await audioContext.resume();
  if (current !== generation) return;
  onStatus('loading');
  const speed = Math.max(0.75, Math.min(1.5, Number(rate) || 1));
  let upcoming = synthesize(chunks[0], gender, speed, current);
  try {
    for (let index = 0; index < chunks.length; index++) {
      const samples = await upcoming;
      if (current !== generation || !samples) return;
      if (index + 1 < chunks.length) {
        upcoming = synthesize(chunks[index + 1], gender, speed, current);
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
