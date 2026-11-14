import { playLocalVoice, setLocalVoiceOptions, stopLocalVoice } from './tts/voice.js';
import { setReadingSpeechActive, startReadingAudio, stopReadingAudio } from './tts/reading-audio.js';

const japanese = /^ja(?:[-_]|$)/i;
const maleNames = /(?:masculine|male|otoya|ichiro|keita|daichi|naoki|一郎|圭太|大智|男性)/i;
const femaleNames = /(?:feminine|female|kyoko|kagura|haruka|ayumi|nanami|sayaka|misaki|nozomi|春香|七海|女性)/i;
const bundled = new Map([
  ['local-female', { gender: 'female', label: '女性・内蔵' }],
  ['local-male', { gender: 'male', label: '男性・内蔵' }],
]);

export function setupSpeech({ select, rate, volume, stop, report, onStop }) {
  const engine = window.speechSynthesis;
  let voices = [];
  let active = null;
  let generation = 0;

  function populate() {
    const oldChoice = select.value;
    voices = (engine?.getVoices() ?? []).filter(voice => japanese.test(voice.lang) && voice.localService);
    select.replaceChildren(...[...bundled].map(([id, voice]) => {
      const option = new Option(voice.label, id);
      option.title = 'オフライン対応';
      return option;
    }));
    for (const voice of voices) {
      const gender = femaleNames.test(voice.name) ? '女性' : maleNames.test(voice.name) ? '男性' : '';
      select.add(new Option(gender ? `${voice.name}（${gender}）` : voice.name, voice.voiceURI));
    }
    if (bundled.has(oldChoice) || voices.some(voice => voice.voiceURI === oldChoice)) {
      select.value = oldChoice;
    }
    select.disabled = false;
  }

  function cancel(announce = false, keepAudio = false) {
    generation += 1;
    engine?.cancel();
    stopLocalVoice();
    active = null;
    if (!keepAudio) stopReadingAudio();
    stop.disabled = true;
    if (announce) report('読み上げを停止しました。');
  }

  function settings() {
    const speed = Number(rate?.value || 1);
    const level = Number(volume?.value ?? 100);
    return {
      rate: Number.isFinite(speed) ? Math.max(0.5, Math.min(2, speed)) : 1,
      volume: Number.isFinite(level) ? Math.max(0, Math.min(100, level)) / 100 : 1,
    };
  }

  function syncSettings() {
    setLocalVoiceOptions(settings());
  }

  function speak(text, { onComplete, onError } = {}) {
    const content = String(text).trim();
    if (!content) return;
    cancel(false, true);
    const session = generation;
    stop.disabled = false;

    async function complete() {
      if (session !== generation) return;
      active = null;
      stop.disabled = true;
      report('読み上げが終わりました。');
      try {
        await onComplete?.();
      } finally {
        if (session === generation) stopReadingAudio();
      }
    }

    function fail(message, error = new Error(message)) {
      if (session !== generation) return;
      cancel();
      report(message);
      onError?.(error);
    }

    const builtIn = bundled.get(select.value);
    if (builtIn) {
      report('内蔵音声を準備しています…');
      playLocalVoice(content, {
        gender: builtIn.gender, ...settings(),
        onStatus(status) {
          if (session !== generation) return;
          if (status === 'playing') setReadingSpeechActive(true);
          report(status === 'playing' ? `${builtIn.label}で読み上げています。` : '内蔵音声を準備しています…');
        },
      }).then(complete).catch(error => fail('内蔵音声を開始できませんでした。対応するブラウザーで開き、オフライン保存の完了後にお試しください。', error));
      return;
    }
    const voice = voices.find(item => item.voiceURI === select.value);
    if (!voice) {
      fail('端末の音声設定から、ダウンロードできる日本語音声を追加してください。');
      return;
    }
    const phrases = content.split(/(?<=[。！？\n])/u).map(part => part.trim()).filter(Boolean)
      .flatMap(part => part.length > 440 ? (part.match(/.{1,360}(?:[、，；：\s]|$)|.{1,360}/gu) || [part]) : [part]);
    let index = 0;
    setReadingSpeechActive(true);
    startReadingAudio().catch(() => {});
    report(`${voice.name}で読み上げています。`);

    function next() {
      if (session !== generation) return;
      if (index >= phrases.length) {
        complete().catch(error => fail('読み上げを続けられませんでした。', error));
        return;
      }
      try {
        const utterance = new SpeechSynthesisUtterance(phrases[index++]);
        utterance.voice = voice;
        utterance.lang = voice.lang;
        const current = settings();
        utterance.rate = current.rate;
        utterance.volume = current.volume;
        utterance.onend = next;
        utterance.onerror = event => fail('読み上げを続けられませんでした。日本語音声の設定を確認してください。', new Error(event.error));
        active = utterance;
        engine.speak(active);
      } catch (error) {
        fail('このブラウザーで読み上げを開始できませんでした。', error);
      }
    }
    try {
      engine.resume();
      next();
    } catch (error) {
      fail('このブラウザーで読み上げを開始できませんでした。', error);
    }
  }

  engine?.addEventListener('voiceschanged', populate);
  for (const control of [rate, volume]) {
    control?.addEventListener('input', syncSettings);
    control?.addEventListener('change', syncSettings);
  }
  stop.addEventListener('click', () => {
    cancel(true);
    onStop?.();
  });
  cancel();
  populate();
  return { speak, cancel };
}
