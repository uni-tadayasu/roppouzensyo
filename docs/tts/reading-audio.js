const musicURL = new URL('../assets/reading-bgm.mp3', import.meta.url);
// Inline silent MP3 makes the old WebKit media channel immediately available offline.
const mediaCarrier = 'data:audio/mpeg;base64,//MQxAAAAANIAAAAAExBTUUzLjEwMFVVVVX/8xLEDQAAA0gAAAAAVVVVVVVVVVVVVVVVVVX/8xDEGwAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMQoAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxDUAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDEQgAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMRPAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxFwAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDEaQAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEsR2AAADSAAAAABVVVVVVVVVVVVVVVVVVf/zEMSEAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxJEAAANIAAAAAFVVVVVVVVVVVVVVVVU=';
const releaseDelay = 200;
const duckFactor = 0.33;

let context;
let musicGain;
let musicBuffer;
let musicLoad;
let musicSource;
let musicOffset = 0;
let musicStart = 0;
let stopTimer;
let playing = false;
let speechActive = false;
let bgmEnabled = false;
let bgmVolume = 0.22;
let playbackSession;
let previousSessionType;
let silencePlayer;
let audioAttempt = 0;

function requestMediaPlayback() {
  try {
    const session = navigator.audioSession;
    if (session && 'type' in session) {
      const previous = session.type;
      session.type = 'playback';
      if (session.type === 'playback') {
        playbackSession = session;
        previousSessionType = previous;
        return;
      }
    }
  } catch {
    // Older WebKit builds may not expose a writable audio session.
  }
  const appleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!appleMobile) return;
  silencePlayer ||= new Audio(mediaCarrier);
  silencePlayer.loop = true;
  // Start a media-category channel before Web Audio starts, in the same tap.
  silencePlayer.play()?.catch(() => {});
}

function releaseMediaPlayback() {
  silencePlayer?.pause();
  try {
    if (playbackSession?.type === 'playback') playbackSession.type = previousSessionType;
  } catch {
    // The OS may have already released the session.
  }
  playbackSession = undefined;
  previousSessionType = undefined;
}

function targetGain() {
  if (!playing || !bgmEnabled) return 0;
  return bgmVolume * (speechActive ? duckFactor : 1);
}

function rampMusic(seconds) {
  if (!musicGain) return;
  const level = musicGain.gain;
  const now = context.currentTime;
  if (typeof level.cancelAndHoldAtTime === 'function') {
    level.cancelAndHoldAtTime(now);
  } else {
    const value = level.value;
    level.cancelScheduledValues(now);
    level.setValueAtTime(value, now);
  }
  level.linearRampToValueAtTime(targetGain(), now + seconds);
}

function stopMusic() {
  if (!musicSource) return;
  if (musicBuffer) musicOffset = (musicOffset + context.currentTime - musicStart) % musicBuffer.duration;
  musicSource.stop();
  musicSource.disconnect();
  musicSource = undefined;
}

function beginMusic() {
  if (!playing || !bgmEnabled || bgmVolume === 0 || !context || musicSource) return;
  if (!musicBuffer) {
    musicLoad ||= fetch(musicURL).then(response => {
      if (!response.ok) throw new Error('BGMを読み込めませんでした。');
      return response.arrayBuffer();
    }).then(bytes => {
      // 24 kHz stereo limits decoded memory on phones while preserving the mix.
      const Decoder = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      let decoder = context;
      if (Decoder) {
        try {
          decoder = new Decoder(2, 1, 24000);
        } catch {
          // Use the playback context when a separate decoding rate is unavailable.
        }
      }
      return decoder.decodeAudioData(bytes);
    }).then(buffer => {
      musicBuffer = buffer;
      beginMusic();
    }).catch(() => {
      musicLoad = undefined;
      // Narration remains available when the optional audio track is not cached.
    });
    return;
  }
  if (!musicGain) {
    musicGain = context.createGain();
    musicGain.gain.value = 0;
    musicGain.connect(context.destination);
  }
  musicSource = context.createBufferSource();
  musicSource.buffer = musicBuffer;
  musicSource.loop = true;
  musicSource.connect(musicGain);
  musicStart = context.currentTime;
  musicSource.start(0, musicOffset);
  rampMusic(0.28);
}

export function setReadingBgm({ enabled, volume }) {
  bgmEnabled = enabled === true;
  if (Number.isFinite(volume)) bgmVolume = Math.max(0, Math.min(1, volume));
  beginMusic();
  rampMusic(0.15);
}

export function setReadingSpeechActive(active) {
  if (speechActive === active) return;
  speechActive = active;
  rampMusic(active ? 0.14 : 0.36);
}

export async function startReadingAudio() {
  const attempt = ++audioAttempt;
  if (stopTimer !== undefined) {
    clearTimeout(stopTimer);
    stopTimer = undefined;
  }
  if (!playing && !playbackSession && (!silencePlayer || silencePlayer.paused)) requestMediaPlayback();
  playing = true;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) throw new Error('このブラウザーはWeb音声に対応していません。');
    context ||= new AudioContext();
    const resume = context.resume();
    beginMusic();
    rampMusic(0.22);
    await resume;
    if (context.state !== 'running') throw new Error('ブラウザーが音声再生を停止しています。');
    return context;
  } catch (error) {
    // An unsuccessful start must not retain the OS media session or leave
    // optional music playing. A newer start owns its own cleanup.
    if (attempt === audioAttempt) {
      playing = false;
      speechActive = false;
      stopMusic();
      releaseMediaPlayback();
      if (context?.state === 'running') context.suspend().catch(() => {});
    }
    throw error;
  }
}

export function stopReadingAudio() {
  audioAttempt += 1;
  if (!playing) return;
  playing = false;
  speechActive = false;
  rampMusic(0.17);
  stopTimer = setTimeout(() => {
    stopTimer = undefined;
    stopMusic();
    releaseMediaPlayback();
    if (context?.state === 'running') context.suspend().catch(() => {});
  }, releaseDelay);
}
