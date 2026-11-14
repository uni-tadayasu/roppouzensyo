import { playLocalVoice, stopLocalVoice } from './tts/voice.js';

const japanese = /^ja(?:[-_]|$)/i;
const maleNames = /(?:masculine|male|otoya|ichiro|keita|daichi|naoki|一郎|圭太|大智|男性)/i;
const femaleNames = /(?:feminine|female|kyoko|kagura|haruka|ayumi|nanami|sayaka|misaki|nozomi|春香|七海|女性)/i;
const bundled = new Map([
  ['local-female', { gender: 'female', label: '女性・内蔵' }],
  ['local-male', { gender: 'male', label: '男性・内蔵' }],
]);

export function setupSpeech({ select, rate, stop, report }) {
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

  function cancel(announce = false) {
    generation += 1;
    engine?.cancel();
    stopLocalVoice();
    active = null;
    stop.disabled = true;
    if (announce) report('読み上げを停止しました。');
  }

  function speak(text) {
    if (!String(text).trim()) return;
    const builtIn = bundled.get(select.value);
    if (builtIn) {
      cancel();
      const session = generation;
      stop.disabled = false;
      report('内蔵音声を準備しています…');
      playLocalVoice(text, {
        gender: builtIn.gender, rate: Number(rate?.value) || 1,
        onStatus(status) {
          if (session === generation) report(status === 'playing' ? `${builtIn.label}で読み上げています。` : '内蔵音声を準備しています…');
        },
      }).then(() => {
        if (session !== generation) return;
        stop.disabled = true;
        report('読み上げが終わりました。');
      }).catch(() => {
        if (session !== generation) return;
        stop.disabled = true;
        report('内蔵音声を開始できませんでした。対応するブラウザーで開き、オフライン保存の完了後にお試しください。');
      });
      return;
    }
    const voice = voices.find(item => item.voiceURI === select.value);
    if (!voice) {
      report('端末の音声設定から、ダウンロードできる日本語音声を追加してください。');
      return;
    }
    const phrases = String(text).trim().split(/(?<=[。！？\n])/u).map(part => part.trim()).filter(Boolean)
      .flatMap(part => part.length > 440 ? (part.match(/.{1,360}(?:[、，；：\s]|$)|.{1,360}/gu) || [part]) : [part]);
    if (!phrases.length) return;
    cancel();
    engine.resume();
    const session = generation;
    let index = 0;
    stop.disabled = false;
    report(`${voice.name}で読み上げています。`);

    function next() {
      if (session !== generation) return;
      if (index >= phrases.length) {
        active = null;
        stop.disabled = true;
        report('読み上げが終わりました。');
        return;
      }
      const utterance = new SpeechSynthesisUtterance(phrases[index++]);
      utterance.voice = voice;
      utterance.lang = voice.lang;
      utterance.rate = Number(rate?.value) || 1;
      utterance.onend = next;
      utterance.onerror = event => {
        if (session !== generation || ['interrupted', 'canceled'].includes(event.error)) return;
        cancel();
        report('読み上げを開始できませんでした。日本語音声の設定を確認してください。');
      };
      active = utterance;
      try {
        engine.speak(active);
      } catch {
        cancel();
        report('このブラウザーで読み上げを開始できませんでした。');
      }
    }
    next();
  }

  engine?.addEventListener('voiceschanged', populate);
  stop.addEventListener('click', () => cancel(true));
  cancel();
  populate();
  return { speak, cancel };
}
