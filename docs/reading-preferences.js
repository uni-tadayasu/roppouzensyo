const STORAGE_KEY = 'roppo-display-preferences-v1';
const size = document.getElementById('reader-font-size');
const font = document.getElementById('reader-font');
const focusButton = document.getElementById('focus-reading');
const dock = document.getElementById('focus-dock');
const exit = document.getElementById('exit-focus');

function applyPreferences(preferences = {}) {
  size.value = ['standard', 'large', 'largest'].includes(preferences.size) ? preferences.size : 'standard';
  font.value = preferences.font === 'sans' ? 'sans' : 'serif';
  document.documentElement.dataset.readerSize = size.value;
  document.documentElement.dataset.readerFont = font.value;
}

function savePreferences() {
  const preferences = { size: size.value, font: font.value };
  applyPreferences(preferences);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch { /* Keep usable in restricted storage. */ }
}

function setFocus(active) {
  document.body.classList.toggle('reading-focus', active);
  focusButton.setAttribute('aria-pressed', String(active));
  focusButton.textContent = active ? '通常表示に戻る' : '集中して読む';
  dock.hidden = !active;
  document.getElementById('article-heading').focus({ preventScroll: true });
  document.querySelector('.reader-panel').scrollIntoView({ block: 'start' });
}

if (size && font && focusButton && dock && exit) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch { /* Use defaults. */ }
  applyPreferences(saved);
  size.addEventListener('change', savePreferences);
  font.addEventListener('change', savePreferences);
  focusButton.addEventListener('click', () => setFocus(!document.body.classList.contains('reading-focus')));
  exit.addEventListener('click', () => setFocus(false));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !document.querySelector('dialog[open]') && document.body.classList.contains('reading-focus')) setFocus(false);
  });
}
