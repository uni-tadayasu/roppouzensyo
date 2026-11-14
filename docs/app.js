import { setupSpeech } from './speech.js';

const find = id => document.getElementById(id);
const collate = new Intl.Collator('ja', { numeric: true });
const STORE = 'roppo-reader-marks-v1';
const CASE_BATCH = 20;
const defaultEditorial = { terms: [], summaries: {}, cases: [] };
const state = {
  catalog: null, editorial: defaultEditorial, caseIndex: null, caseShards: new Map(), currentCases: [],
  laws: new Map(), law: null, article: null,
  blocks: new Map(), terms: new Map(), termPattern: null, legalPattern: null, compoundPattern: null, readings: new Map(),
  readingPattern: null, marks: loadMarks(), marker: false,
  selection: [], excerpt: [], displayedTerm: '', gesture: null, routeRequest: 0,
};

function node(tag, className = '', value = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = value;
  return element;
}

function button(label, handler, className = 'text-action') {
  const control = node('button', className, label);
  control.type = 'button';
  control.addEventListener('click', handler);
  return control;
}

function link(href, label, className = '') {
  const element = node('a', className, label);
  element.href = href;
  return element;
}

function officialLink(href, label, className = '') {
  const safe = allowedSource(href);
  if (!safe) return node('span', className, label);
  const element = link(safe, label, className);
  element.target = '_blank';
  element.rel = 'noopener noreferrer';
  return element;
}

function allowedSource(href) {
  try {
    const url = new URL(href);
    if (url.protocol === 'https:' && /(?:^|\.)(?:e-gov\.go\.jp|courts\.go\.jp)$/u.test(url.hostname)) return url.href;
  } catch {
    return '';
  }
  return '';
}

function setupDialog(dialog) {
  if (!dialog) return;
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) {
      closeDialog(dialog);
    }
  });
}

function showDialog(dialog) {
  if (dialog.open) return;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeDialog(dialog) {
  if (typeof dialog.close === 'function' && dialog.open) dialog.close();
  else dialog.removeAttribute('open');
}

function report(message) {
  find('reading-feedback').textContent = message;
  const dialogs = document.querySelectorAll('dialog[open]');
  const feedback = dialogs[dialogs.length - 1]?.querySelector('.dialog-feedback');
  if (feedback) feedback.textContent = message;
}

const speech = setupSpeech({
  select: find('voice-select'), rate: find('voice-rate') || find('speed-select'),
  stop: find('stop-speech'), report,
});

function addDialogSpeechControls(dialog) {
  const holder = dialog.querySelector('.dialog-actions') || dialog.querySelector('.dialog-inner');
  if (!holder) return;
  const stop = button('読み上げを停止', () => speech.cancel(true));
  const status = node('p', 'dialog-feedback reading-feedback');
  status.setAttribute('role', 'status');
  holder.append(stop, status);
}

function escapeRegex(text) {
  return text.replace(/[.*+?^{}${}()|[\]\\]/g, '\\$&');
}

function patternOf(words) {
  const unique = [...new Set(words.filter(Boolean))];
  if (!unique.length) return null;
  return new RegExp(unique.sort((first, second) => second.length - first.length || collate.compare(first, second))
    .map(escapeRegex).join('|'), 'gu');
}

function reading(text) {
  if (!state.readingPattern) return text;
  return text.replace(state.readingPattern, term => state.readings.get(term) || term);
}

function spoken(text) {
  speech.speak(reading(text));
}

function loadMarks() {
  try {
    return validateMarks(JSON.parse(localStorage.getItem(STORE) || '[]'));
  } catch {
    return [];
  }
}

function validateMarks(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 10000).filter(item => item && typeof item.key === 'string' &&
    item.key.length <= 320 && typeof item.text === 'string' && item.text.length > 0 && item.text.length <= 250000 &&
    Number.isSafeInteger(item.start) && Number.isSafeInteger(item.end) && item.start >= 0 && item.end > item.start)
    .map(item => ({
      key: item.key, text: item.text, start: item.start, end: item.end,
      before: typeof item.before === 'string' ? item.before.slice(-16) : '',
      after: typeof item.after === 'string' ? item.after.slice(0, 16) : '',
    }));
}

function saveMarks() {
  try {
    localStorage.setItem(STORE, JSON.stringify(state.marks));
  } catch {
    report('端末にマーカーを保存できませんでした。この画面を離れる前にバックアップを作成してください。');
    return false;
  }
  return true;
}

function normalized(text) {
  return String(text).normalize('NFKC').toLowerCase().replace(/[\s・･]/gu, '');
}

const digitValues = new Map(Object.entries({
  '〇': 0, '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6,
  '七': 7, '八': 8, '九': 9, '壱': 1, '弐': 2, '参': 3,
}));
const unitValues = new Map(Object.entries({ '十': 10, '拾': 10, '百': 100, '千': 1000, '万': 10000 }));
const kanjiNumber = '[0-9０-９〇零一二三四五六七八九十百千万壱弐参拾]+';
const parseFullReference = new RegExp(`^第?(${kanjiNumber})条((?:[のノ]${kanjiNumber})*)(?:第?(${kanjiNumber})項)?(?:第?(${kanjiNumber})号)?$`, 'u');
const namedLaws = new Map([
  ['民事訴訟法', 'civil-procedure'], ['刑事訴訟法', 'criminal-procedure'], ['日本国憲法', 'constitution'],
  ['民法', 'civil'], ['商法', 'commercial'], ['刑法', 'criminal'], ['憲法', 'constitution'],
]);
const referencePattern = new RegExp(`(?:${[...namedLaws.keys()].join('|')})?第${kanjiNumber}条(?:[のノ]${kanjiNumber})*(?:第${kanjiNumber}項)?(?:第${kanjiNumber}号)?`, 'gu');

function numberValue(raw) {
  const text = raw.normalize('NFKC');
  if (/^\d+$/u.test(text)) return text.replace(/^0+(?=\d)/u, '');
  if (![...text].some(character => unitValues.has(character))) {
    return [...text].map(character => digitValues.get(character) ?? '').join('');
  }
  let total = 0;
  let value = 0;
  let current = 0;
  for (const character of text) {
    if (digitValues.has(character)) current = digitValues.get(character);
    else if (unitValues.get(character) === 10000) {
      total += (value + current || 1) * 10000;
      value = current = 0;
    } else {
      value += (current || 1) * (unitValues.get(character) || 0);
      current = 0;
    }
  }
  return String(total + value + current);
}

function parseReference(text) {
  const separated = normalized(text).replace(/^第?(\d+)(?:[-_](\d+))+$/u, match => match.replace(/^第/u, '').replace(/[-_]/gu, 'の'));
  if (/^\d+(?:の\d+)*$/u.test(separated)) {
    return { article: separated.replace(/の/gu, '_'), part: '' };
  }
  const match = separated.match(parseFullReference);
  if (!match) return null;
  const branch = match[2] ? match[2].split(/[のノ]/u).slice(1).map(numberValue) : [];
  const article = [numberValue(match[1]), ...branch].join('_');
  const part = match[4] ? `${match[3] ? numberValue(match[3]) : '1'}.${numberValue(match[4])}` :
    match[3] ? numberValue(match[3]) : '';
  return { article, part };
}

function routeURL(law, article = '1', part = '') {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('law', law);
  url.searchParams.set('article', article);
  if (part) url.searchParams.set('part', part);
  return url;
}

function activateLink(element, action) {
  element.addEventListener('click', event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    action();
  });
  return element;
}

function readerLink(law, article, label, className, part = '') {
  return activateLink(link(routeURL(law, article, part), label, className), () => navigate(law, article, part));
}

function currentRoute() {
  const url = new URL(location.href);
  const lawId = url.searchParams.get('law') || 'constitution';
  const articleId = url.searchParams.get('article') || '1';
  return { lawId, articleId, partId: url.searchParams.get('part') || '' };
}

async function navigate(lawId, articleId = '1', partId = '') {
  const url = routeURL(lawId, articleId, partId);
  if (url.href !== location.href) history.pushState({}, '', url);
  find('search-results').hidden = true;
  await showRoute(true);
}

function fetchJSON(path) {
  return fetch(path).then(response => {
    if (!response.ok) throw new Error(`${path} ${response.status}`);
    return response.json();
  });
}

function getLaw(id) {
  if (!state.laws.has(id)) {
    state.laws.set(id, fetchJSON(`data/${id}.json`).catch(error => {
      state.laws.delete(id);
      throw error;
    }));
  }
  return state.laws.get(id);
}

function resolveArticle(law, id) {
  const exact = law.articles.find(item => item.id === id);
  if (exact || !/^\d+$/u.test(id)) return exact;
  return law.articles.find(item => {
    const range = /^(\d+)-(\d+)$/u.exec(item.id);
    return range && Number(id) >= Number(range[1]) && Number(id) <= Number(range[2]);
  });
}

function updateToc(law, article) {
  const list = find('toc-list');
  const select = find('article-select');
  list.replaceChildren();
  select.replaceChildren();
  const fragment = document.createDocumentFragment();
  let lastChapter;
  let tocGroup;
  let optionGroup;
  for (const item of law.articles) {
    const chapter = item.chapter || (item.supplementary ? '附則' : '本文');
    if (chapter !== lastChapter) {
      lastChapter = chapter;
      tocGroup = node('div', 'toc-group');
      tocGroup.append(node('div', 'toc-group-title', chapter));
      fragment.append(tocGroup);
      optionGroup = document.createElement('optgroup');
      optionGroup.label = chapter;
      select.append(optionGroup);
    }
    const title = [item.title, item.caption].filter(Boolean).join('　');
    const anchor = readerLink(law.id, item.id, title, 'toc-link');
    anchor.dataset.article = item.id;
    if (item.id === article.id) anchor.setAttribute('aria-current', 'location');
    tocGroup.append(anchor);
    optionGroup.append(new Option(title, item.id));
  }
  select.value = article.id;
  list.append(fragment);
}

function updateTocCurrent(article) {
  find('article-select').value = article.id;
  const list = find('toc-list');
  list.querySelector('[aria-current]')?.removeAttribute('aria-current');
  const link = [...list.querySelectorAll('[data-article]')].find(item => item.dataset.article === article.id);
  link?.setAttribute('aria-current', 'location');
  const details = list.closest('details');
  if (link && (!details || details.open)) {
    const viewport = list.getBoundingClientRect();
    const item = link.getBoundingClientRect();
    if (item.top < viewport.top || item.bottom > viewport.bottom) list.scrollTop += item.top - viewport.top - 30;
  }
}

function updateLawList(current) {
  const list = find('law-list');
  list.replaceChildren(...state.catalog.laws.map(law => {
    const control = readerLink(law.id, '1', '', 'law-link');
    control.dataset.law = law.id;
    if (law.id === current) control.setAttribute('aria-current', 'page');
    control.append(
      node('span', 'law-name', law.title),
      node('span', 'law-count', `${Number(law.articles).toLocaleString('ja-JP')}条`),
    );
    return control;
  }));
}

function detectReferences(text) {
  const matches = [];
  if (!state.law || state.article?.supplementary) return matches;
  referencePattern.lastIndex = 0;
  for (const match of text.matchAll(referencePattern)) {
    const name = [...namedLaws.keys()].find(label => match[0].startsWith(label));
    const previous = text.slice(Math.max(0, match.index - 3), match.index);
    if ((!name && /[\p{Script=Han}）)」』]$/u.test(previous)) ||
        (name && /[\p{Script=Han}]/u.test(previous.slice(-1)) && !/[旧新現]/u.test(previous.slice(-1)))) continue;
    const law = name ? namedLaws.get(name) : state.law.id;
    const ref = parseReference(match[0].slice(name?.length ?? 0));
    if (!ref) continue;
    if (law === state.law.id) {
      const article = resolveArticle(state.law, ref.article);
      if (!article || (ref.part && !article.parts.some(part => part.id === ref.part))) continue;
    }
    matches.push({ ...ref, law, start: match.index, end: match.index + match[0].length });
  }
  return matches;
}

function termTokens(text, detectLinks) {
  const annotations = detectLinks ? detectReferences(text) : [];
  for (const pattern of [state.legalPattern, state.compoundPattern]) {
    if (!pattern) continue;
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const end = match.index + match[0].length;
      if (!annotations.some(annotation => match.index < annotation.end && end > annotation.start)) {
        annotations.push({ term: state.terms.get(match[0]), start: match.index, end });
      }
    }
  }
  return annotations.sort((first, second) => first.start - second.start);
}

function isCurrentMark(mark, block) {
  return mark.key === block.key;
}

function findMarkRange(mark, text) {
  if (text.slice(mark.start, mark.end) === mark.text &&
      (!mark.before || text.slice(mark.start - mark.before.length, mark.start) === mark.before) &&
      (!mark.after || text.slice(mark.end, mark.end + mark.after.length) === mark.after)) {
    return [mark.start, mark.end];
  }
  const first = text.indexOf(mark.text);
  if (first < 0) return null;
  const next = text.indexOf(mark.text, first + 1);
  if (next < 0) return [first, first + mark.text.length];
  const anchored = `${mark.before}${mark.text}${mark.after}`;
  const start = text.indexOf(anchored);
  if (start >= 0 && (mark.before || mark.after) && text.indexOf(anchored, start + 1) < 0) {
    const match = start + mark.before.length;
    return [match, match + mark.text.length];
  }
  return null;
}

function renderMarkable(block) {
  const ranges = state.marks.filter(mark => isCurrentMark(mark, block))
    .map(mark => findMarkRange(mark, block.text)).filter(Boolean)
    .sort((first, second) => first[0] - second[0]);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && previous[1] >= range[0]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push(range);
  }

  function emit(start, end, parent) {
    let cursor = start;
    for (const [markStart, markEnd] of merged) {
      if (markEnd <= cursor || markStart >= end) continue;
      const entry = Math.max(cursor, markStart);
      const exit = Math.min(end, markEnd);
      if (entry > cursor) parent.append(document.createTextNode(block.text.slice(cursor, entry)));
      parent.append(node('mark', 'user-mark highlight', block.text.slice(entry, exit)));
      cursor = exit;
    }
    if (cursor < end) parent.append(document.createTextNode(block.text.slice(cursor, end)));
  }

  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const annotation of block.tokens) {
    emit(cursor, annotation.start, fragment);
    const tokenText = block.text.slice(annotation.start, annotation.end);
    const token = annotation.term ?
      button('', () => { if (!state.marker) openTerm(annotation.term); },
        `term term-token ${annotation.term.type} ${annotation.term.type === 'compound' ? 'compound-term' : 'legal-term'}`) :
      readerLink(annotation.law, annotation.article, '', 'law-reference section-reference', annotation.part);
    if (annotation.term) {
      token.dataset.kind = annotation.term.type;
      token.setAttribute('aria-label', `${tokenText}の意味`);
    } else {
      token.title = `${tokenText}へ移動`;
    }
    emit(annotation.start, annotation.end, token);
    fragment.append(token);
    cursor = annotation.end;
  }
  emit(cursor, block.text.length, fragment);
  block.element.replaceChildren(fragment);
}

function registerText(element, key, text, label, options = {}) {
  const block = {
    element, key, text: String(text || ''), label, spoken: options.spoken, part: options.part || '',
  };
  block.tokens = options.plain ? [] : termTokens(block.text, Boolean(options.references));
  element.dataset.block = key;
  element.classList.add('reader-text', 'reader-block');
  state.blocks.set(key, block);
  renderMarkable(block);
  return block;
}

function summaryFor(article) {
  const curated = state.editorial.summaries?.[state.law.id]?.[article.id];
  const curatedRevision = state.editorial.summaryRevisions?.[state.law.id];
  if (typeof curated === 'string' && curated.trim() && (!curatedRevision || curatedRevision === state.law.revision)) {
    return { kind: 'やさしい解説', text: curated, note: '' };
  }
  const first = article.parts.find(part => part.text.trim());
  if (!first) return {
    kind: '条文の構成', text: 'この条文に表示できる本文はありません。',
    note: '法令の掲載状況は出典で確認できます。',
  };
  if (/^\s*削除\s*[。.]?\s*$/u.test(first.text)) {
    return { kind: '条文の構成', text: 'この条文は削除されています。', note: '' };
  }
  const paragraphs = article.parts.filter(part => !part.depth && /^\d+$/u.test(part.id));
  const items = article.parts.filter(part => part.depth === 1);
  const clauses = [...new Set(detectReferences(first.text).map(reference => first.text.slice(reference.start, reference.end)))];
  const summary = [];
  if (article.caption) summary.push(`この条文の見出しは「${article.caption}」です。`);
  if (paragraphs.length > 1 || items.length) {
    const counts = [];
    if (paragraphs.length) counts.push(`${paragraphs.length}項`);
    if (items.length) counts.push(`号の規定が${items.length}件`);
    summary.push(`${counts.join('、')}あります。`);
  }
  if (clauses.length) summary.push(`冒頭で${clauses.slice(0, 3).join('、')}を参照しています。`);
  const clipped = first.text.slice(0, 210);
  const fullOpening = clipped.match(/^.*?[。！？]/su)?.[0];
  const opening = fullOpening || (first.text.length > 210 ? `${clipped}…` : clipped);
  summary.push(`冒頭の原文「${opening}」`);
  return { kind: '条文の構成と抜粋', text: summary.join('\n'), note: '原文から自動作成した案内です。' };
}

function renderSummary(prefix) {
  const holder = find('article-summary');
  const summary = summaryFor(state.article);
  const heading = node('div', 'summary-kind', summary.kind);
  const text = node('p', 'summary-text part-text');
  const block = registerText(text, `${prefix}:summary`, summary.text, summary.kind);
  const actions = node('div', 'part-actions');
  actions.append(button('解説を読み上げ', () => spoken(block.text)), button('表示・マーカー', () => inspectBlock(block)));
  holder.replaceChildren(heading, text, actions);
  if (summary.note) holder.append(node('p', 'summary-note result-context', summary.note));
}

function renderPart(part, prefix) {
  const element = node('section', 'statute-part article-part');
  const level = part.depth ?? (part.id.includes('.') ? 1 : 0);
  element.dataset.level = level === 0 ? 'paragraph' : level === 1 ? 'item' : 'subitem';
  element.id = `part-${part.id}`;
  const actions = node('div', 'part-actions');
  const label = part.label || `第${part.id}項`;
  const text = node('p', 'part-text');
  const block = registerText(text, `${prefix}:part:${part.id}`, part.text, label, {
    spoken: part.reading, part: part.id, references: true,
  });
  const partLabel = button(label, () => inspectBlock(block, true), 'part-label');
  partLabel.title = `${label}を選択`;
  actions.append(partLabel, button('読み上げ', () => spoken(part.reading || part.text)));
  element.append(actions, text);
  return element;
}

function displayCase(entry) {
  const card = node('article', 'case-card');
  const title = node('h3', 'case-heading');
  const titleBlock = registerText(title, `case:${entry.id}:title`, entry.title, '判例名');
  const meta = node('p', 'case-meta', [entry.court, entry.date].filter(Boolean).join('　'));
  const summary = node('p', 'case-summary part-text');
  const body = typeof entry.body === 'string' ? entry.body : '';
  const abstract = entry.summary || 'この判例の要約は未収録です。';
  const summaryBlock = registerText(summary, `case:${entry.id}:summary`, abstract, '判例の要約');
  const actions = node('div', 'case-actions part-actions');
  const readLabel = entry.summaryKind === '事件情報' ? '事件情報を読み上げ' : '要約を読み上げ';
  actions.append(button(readLabel, () => spoken(`${titleBlock.text}。 ${summaryBlock.text}`)),
    button('表示・マーカー', () => inspectBlock(summaryBlock)));
  const source = allowedSource(entry.source);
  if (source) actions.append(officialLink(source, '裁判所の出典 ↗', 'case-source'));
  if (entry.pdf && entry.pdf !== entry.source) actions.append(officialLink(entry.pdf, '判決文PDF ↗', 'case-source'));
  card.append(title, meta);
  if (entry.summaryKind) card.append(node('span', 'result-context', entry.summaryKind));
  card.append(summary, actions);
  const relation = entry.articles?.find(item => item.law === state.law.id && item.id === state.article.id)?.relation;
  if (relation) card.append(node('p', 'case-relation result-context', relation));
  if (body) {
    const details = node('details', 'case-fulltext');
    details.append(node('summary', '', entry.bodyLabel || '収録本文を開く'));
    details.addEventListener('toggle', () => {
      if (!details.open || details.children.length > 1) return;
      const text = node('p', 'case-body part-text');
      const bodyBlock = registerText(text, `case:${entry.id}:body`, body, '判例の収録本文');
      const bodyActions = node('div', 'part-actions');
      bodyActions.append(button('本文を読み上げ', () => spoken(body)),
        button('表示・マーカー', () => inspectBlock(bodyBlock)));
      details.append(bodyActions, text);
    });
    card.append(details);
  }
  return card;
}

function renderCases(cases = [], status = 'ready') {
  const holder = find('case-list');
  holder.replaceChildren();
  if (!cases.length) {
    const message = {
      loading: '収録判例を読み込み中です。',
      failed: '判例データを開けませんでした。',
      ready: 'この条文にひもづけた判例は未収録です。',
    };
    holder.append(node('p', 'empty-state', message[status]));
    return;
  }
  holder.append(node('p', 'case-count result-context', `収録判例 ${cases.length.toLocaleString('ja-JP')}件`));
  let visible = 0;
  const more = button('さらに表示', addMore);
  function addMore() {
    const slice = cases.slice(visible, visible + CASE_BATCH);
    const fragment = document.createDocumentFragment();
    fragment.append(...slice.map(displayCase));
    holder.insertBefore(fragment, more);
    visible += slice.length;
    more.hidden = visible >= cases.length;
  }
  holder.append(more);
  addMore();
}

async function getCases(lawId, articleId) {
  state.caseIndex ||= fetchJSON('data/cases/index.json').catch(error => {
    state.caseIndex = null;
    throw error;
  });
  const index = await state.caseIndex;
  const file = index.shards?.[lawId]?.[articleId];
  if (!file) return [];
  if (typeof file !== 'string' || !/^[a-z0-9_-]+\.json$/iu.test(file)) throw new Error('invalid case shard name');
  if (!state.caseShards.has(file)) {
    const load = fetchJSON(`data/cases/${file}`).catch(error => {
      state.caseShards.delete(file);
      throw error;
    });
    state.caseShards.set(file, load);
    if (state.caseShards.size > 4) state.caseShards.delete(state.caseShards.keys().next().value);
  }
  const data = await state.caseShards.get(file);
  return (data.cases || []).filter(entry => entry.articles?.some(item => item.law === lawId && item.id === articleId));
}

async function loadCases(law, article) {
  const matchesArticle = () => state.law === law && state.article === article;
  state.currentCases = [];
  renderCases([], 'loading');
  try {
    const cases = await getCases(law.id, article.id);
    if (matchesArticle()) {
      state.currentCases = cases;
      renderCases(cases);
    }
  } catch {
    if (!matchesArticle()) return;
    const fallback = (state.editorial.cases || []).filter(entry => entry.articles?.some(item => item.law === law.id && item.id === article.id));
    state.currentCases = fallback;
    renderCases(fallback, 'failed');
  }
}

async function showRoute(moveFocus = false) {
  if (!state.catalog) return;
  const request = ++state.routeRequest;
  const route = currentRoute();
  const meta = state.catalog.laws.find(law => law.id === route.lawId) ||
    state.catalog.laws.find(law => law.id === 'constitution') || state.catalog.laws[0];
  if (!meta) return;
  try {
    const law = await getLaw(meta.id);
    if (request !== state.routeRequest) return;
    const requested = resolveArticle(law, route.articleId);
    const article = requested ||
      law.articles.find(item => item.id === '1') || law.articles[0];
    if (!article) throw new Error('no articles');
    const changed = law.id !== state.law?.id || article.id !== state.article?.id;
    if (changed || !state.article) {
      setSelection([]);
      if (state.article) speech.cancel();
      const changedLaw = law.id !== state.law?.id;
      state.law = law;
      state.article = article;
      state.blocks.clear();
      if (changedLaw) {
        updateLawList(law.id);
        updateToc(law, article);
      }
      updateTocCurrent(article);
      const articleIndex = law.articles.indexOf(article);
      const prefix = `${law.id}:${article.id}`;
      document.title = `${law.title} ${article.title}${article.caption ? `（${article.caption}）` : ''}｜六法書架`;
      const position = find('article-position');
      if (position) position.textContent = `${articleIndex + 1} / ${law.articles.length}`;
      const activeLaw = find('active-law');
      if (activeLaw) activeLaw.textContent = law.title;
      const heading = find('article-heading');
      registerText(heading, `${prefix}:title`, article.title, '条番号', { plain: true });
      const caption = find('article-caption');
      caption.hidden = !article.caption;
      registerText(caption, `${prefix}:caption`, article.caption, '条文の見出し');
      find('article-meta').textContent = [law.title, article.chapter, law.number].filter(Boolean).join('　·　');
      const parts = find('article-parts');
      parts.replaceChildren(...article.parts.map(part => renderPart(part, prefix)));
      find('law-source').href = allowedSource(law.source) || 'https://laws.e-gov.go.jp/';
      find('law-source').hidden = false;
      find('law-source').target = '_blank';
      find('law-source').rel = 'noopener noreferrer';
      const previous = find('previous-article');
      const next = find('next-article');
      previous.disabled = articleIndex === 0;
      next.disabled = articleIndex === law.articles.length - 1;
      previous.onclick = () => navigate(law.id, law.articles[articleIndex - 1].id);
      next.onclick = () => navigate(law.id, law.articles[articleIndex + 1].id);
      renderSummary(prefix);
      loadCases(law, article);
    }
    if (!requested) report(`${law.title}に指定の条番号がありません。${article.title}を表示しました。`);
    else if (route.partId) {
      const target = document.getElementById(`part-${route.partId}`);
      if (target) {
        markPartActive(route.partId);
        target.querySelector('.part-label')?.focus({ preventScroll: true });
        target.scrollIntoView({ block: 'center', behavior: 'instant' });
      } else report('指定された項・号を見つけられませんでした。');
    } else if (moveFocus) {
      markPartActive('');
      const heading = find('article-heading');
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      heading.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  } catch (error) {
    console.error(error);
    if (request === state.routeRequest) report('法令データを読み込めませんでした。オンラインで再読み込みしてください。');
  }
}

function markPartActive(id) {
  for (const part of find('article-parts').querySelectorAll('.is-selected')) part.classList.remove('is-selected');
  if (id) document.getElementById(`part-${id}`)?.classList.add('is-selected');
}

function searchData(query, laws) {
  const compact = normalized(query);
  const exactLaw = state.catalog.laws.find(law => normalized(law.title) === compact || law.id === namedLaws.get(compact));
  const qualified = state.catalog.laws.find(law => compact.startsWith(normalized(law.title)));
  const shortLaw = compact.startsWith('憲法') ? state.catalog.laws.find(law => law.id === 'constitution') : null;
  const typedLaw = qualified || shortLaw;
  const typedRef = parseReference(typedLaw ? compact.slice(qualified ? normalized(qualified.title).length : '憲法'.length) : compact);
  const results = [];
  if (exactLaw) {
    const law = laws.find(entry => entry.id === exactLaw.id);
    for (const article of law?.articles || []) results.push({ law, article, sample: article.parts[0]?.text || '' });
    return results;
  }
  const keywords = query.trim().normalize('NFKC').toLowerCase().split(/\s+/u).map(normalized).filter(Boolean);
  for (const law of laws) {
    if (typedRef && typedLaw && law.id !== typedLaw.id) continue;
    const target = typedRef ? resolveArticle(law, typedRef.article) : null;
    for (const article of law.articles) {
      if (typedRef) {
        if (article === target) {
          const part = article.parts.find(item => item.id === typedRef.part);
          if (!typedRef.part || part) results.push({ law, article, part, sample: part?.text || article.parts[0]?.text || '' });
        }
        continue;
      }
      const intro = normalized(`${law.title}${article.title}${article.caption}${article.chapter}`);
      const matches = article.parts.map(item => normalized(item.text));
      if (!keywords.every(word => intro.includes(word) || matches.some(text => text.includes(word)))) continue;
      const index = matches.findIndex(text => keywords.some(word => text.includes(word)));
      const part = article.parts[index];
      results.push({ law, article, part, sample: part?.text || article.parts[0]?.text || '' });
    }
  }
  if (typedRef && !typedLaw) results.sort((first, second) => Number(second.law.id === state.law?.id) - Number(first.law.id === state.law?.id));
  return results;
}

let searchRequest = 0;
async function submitSearch(event) {
  event.preventDefault();
  if (!state.catalog) return;
  const query = find('query').value.trim();
  const holder = find('search-results');
  const request = ++searchRequest;
  if (!query) {
    holder.hidden = true;
    return;
  }
  holder.hidden = false;
  holder.replaceChildren(node('p', 'result-context', '六法を検索しています…'));
  try {
    const results = await Promise.allSettled(state.catalog.laws.map(law => getLaw(law.id)));
    if (request !== searchRequest) return;
    const loaded = results.filter(result => result.status === 'fulfilled').map(result => result.value);
    const matches = searchData(query, loaded);
    const heading = node('div', 'result-heading');
    heading.append(node('strong', '', `「${query}」 ${matches.length.toLocaleString('ja-JP')}件`),
      button('閉じる', () => { holder.hidden = true; find('query').focus(); }));
    holder.replaceChildren(heading);
    if (loaded.length !== state.catalog.laws.length) {
      holder.append(node('p', 'result-context', `${loaded.length}法のデータを検索しました。`));
    }
    if (!matches.length) {
      holder.append(node('p', 'empty-state', '一致する条文はありません。法令名・条番号・本文の語句を入力してください。'));
      return;
    }
    let shown = 0;
    const more = button('さらに表示', draw);
    function draw() {
      const page = matches.slice(shown, shown + 24);
      const content = document.createDocumentFragment();
      for (const result of page) {
        const label = `${result.law.title} ${result.article.title}${result.part?.label ? ` ${result.part.label}` : ''}${result.article.caption ? `　${result.article.caption}` : ''}`;
        const item = readerLink(result.law.id, result.article.id, '', 'result-item', result.part?.id || '');
        item.append(node('strong', '', label), node('span', 'result-context',
          result.sample.length > 105 ? `${result.sample.slice(0, 105)}…` : result.sample));
        content.append(item);
      }
      holder.insertBefore(content, more);
      shown += page.length;
      more.hidden = shown >= matches.length;
    }
    holder.append(more);
    draw();
  } catch {
    holder.replaceChildren(node('p', 'empty-state', '検索を実行できませんでした。'));
  }
}

function openTerm(term) {
  const dialog = find('term-dialog');
  const type = term.type === 'compound' ? '熟語' : '法律用語';
  const termLabel = find('term-kind');
  if (termLabel) termLabel.textContent = type;
  state.displayedTerm = [term.reading || term.text, term.meaning].filter(Boolean).join('。');
  find('term-title').textContent = term.text;
  find('term-reading').textContent = [type, term.reading].filter(Boolean).join('　·　');
  const meaning = find('term-meaning');
  if (meaning.dataset.block) state.blocks.delete(meaning.dataset.block);
  const block = registerText(meaning, `term:${term.text}:meaning`, term.meaning, '用語の意味', { plain: true });
  find('term-mark').onclick = () => addMarks([makeSelection(block, 0, block.text.length)]);
  showDialog(dialog);
}

function makeSelection(block, start, end) {
  return { key: block.key, start, end, text: block.text.slice(start, end), label: block.label,
    before: block.text.slice(Math.max(0, start - 16), start), after: block.text.slice(end, end + 16) };
}

function captureRange(range) {
  if (!range || range.collapsed) return [];
  const matches = [];
  for (const block of state.blocks.values()) {
    if (block.element.getClientRects().length === 0 || !range.intersectsNode(block.element)) continue;
    const inner = document.createRange();
    inner.selectNodeContents(block.element);
    if (range.compareBoundaryPoints(Range.START_TO_START, inner) >= 0) inner.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, inner) <= 0) inner.setEnd(range.endContainer, range.endOffset);
    if (inner.collapsed) continue;
    const initial = document.createRange();
    initial.selectNodeContents(block.element);
    initial.setEnd(inner.startContainer, inner.startOffset);
    const start = initial.toString().length;
    const end = start + inner.toString().length;
    if (end > start) matches.push(makeSelection(block, start, end));
  }
  return matches;
}

function setSelection(selections) {
  state.selection = selections;
  const button = find('selection-open');
  if (button) button.disabled = !selections.length;
}

function showExcerpt(selections) {
  if (!selections.length) {
    report('先に表示・読み上げ・マーカーを付けたい文字を選択してください。');
    return;
  }
  state.excerpt = selections;
  find('excerpt-text').textContent = selections.map(item => item.text).join('\n\n');
  const hint = find('excerpt-source');
  if (hint) hint.textContent = selections.map(item => item.label).filter(Boolean).join('、');
  const display = find('excerpt-display');
  if (display) display.hidden = !selections.some(item => state.blocks.get(item.key)?.part);
  showDialog(find('excerpt-dialog'));
}

function inspectBlock(block, part = false) {
  if (!block.text) return;
  if (part) {
    const url = routeURL(state.law.id, state.article.id, block.part);
    if (url.href !== location.href) history.replaceState({}, '', url);
    markPartActive(block.part);
  }
  showExcerpt([makeSelection(block, 0, block.text.length)]);
}

function addMarks(selections) {
  const pending = selections.filter(selection => selection.text.trim() &&
    !state.marks.some(mark => mark.key === selection.key && mark.start === selection.start && mark.text === selection.text));
  if (!pending.length) return;
  state.marks.push(...pending.map(({ key, text, start, end, before, after }) => ({ key, text, start, end, before, after })));
  const keys = new Set(pending.map(item => item.key));
  window.getSelection()?.removeAllRanges();
  setSelection([]);
  for (const key of keys) {
    const block = state.blocks.get(key);
    if (block) renderMarkable(block);
  }
  if (saveMarks()) report('マーカーを端末に保存しました。');
}

function setMarker(enabled) {
  state.marker = enabled;
  document.body.classList.toggle('marker-active', enabled);
  find('highlight-toggle').setAttribute('aria-pressed', String(enabled));
  const status = find('marker-status');
  if (status) status.textContent = enabled ? 'マーカーモード中　文字をなぞって線を引く' : '文字を選択すると、抜粋や用語を確認できます。';
  if (!enabled) finishGesture();
}

function pointRange(x, y) {
  if (document.caretPositionFromPoint) {
    const caret = document.caretPositionFromPoint(x, y);
    if (!caret) return null;
    return { node: caret.offsetNode, offset: caret.offset };
  }
  if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    if (range) return { node: range.startContainer, offset: range.startOffset };
  }
  return null;
}

function blockAtPoint(caret) {
  const element = caret?.node.nodeType === Node.ELEMENT_NODE ? caret.node : caret?.node.parentElement;
  const readingElement = element?.closest('[data-block]');
  return readingElement ? state.blocks.get(readingElement.dataset.block) : undefined;
}

function rangeBetween(start, end) {
  const first = document.createRange();
  first.setStart(start.node, start.offset);
  first.collapse(true);
  const last = document.createRange();
  last.setStart(end.node, end.offset);
  last.collapse(true);
  const positions = first.compareBoundaryPoints(Range.START_TO_START, last);
  const range = document.createRange();
  const [begin, finish] = positions <= 0 ? [start, end] : [end, start];
  range.setStart(begin.node, begin.offset);
  range.setEnd(finish.node, finish.offset);
  return range;
}

function previewGesture(range) {
  if (window.Highlight && window.CSS?.highlights) CSS.highlights.set('roppo-preview', new Highlight(range));
}

function finishGesture(event, shouldSave = false) {
  const gesture = state.gesture;
  if (!gesture || (event && event.pointerId !== gesture.pointer)) return;
  state.gesture = null;
  window.CSS?.highlights?.delete('roppo-preview');
  try {
    gesture.element.releasePointerCapture(gesture.pointer);
  } catch {
    // The pointer may already have been released.
  }
  if (shouldSave && gesture.range) addMarks(captureRange(gesture.range));
}

function wireMarkers() {
  document.addEventListener('selectionchange', () => {
    if (state.marker || find('excerpt-dialog').open || find('term-dialog').open) return;
    const selection = window.getSelection();
    if (selection?.rangeCount && !selection.isCollapsed) setSelection(captureRange(selection.getRangeAt(0)));
  });
  document.addEventListener('pointerdown', event => {
    if (!state.marker || !event.isPrimary || event.button !== 0 || !event.target.closest('[data-block]')) return;
    const point = pointRange(event.clientX, event.clientY);
    const block = blockAtPoint(point);
    if (!block) return;
    event.preventDefault();
    const element = block.element;
    element.setPointerCapture(event.pointerId);
    state.gesture = { pointer: event.pointerId, element, point, range: null };
  });
  document.addEventListener('pointermove', event => {
    const gesture = state.gesture;
    if (!gesture || gesture.pointer !== event.pointerId) return;
    const point = pointRange(event.clientX, event.clientY);
    if (!blockAtPoint(point)) return;
    gesture.range = rangeBetween(gesture.point, point);
    previewGesture(gesture.range);
  });
  document.addEventListener('pointerup', event => finishGesture(event, true));
  document.addEventListener('pointercancel', event => finishGesture(event));
  document.addEventListener('click', event => {
    if (!state.marker || !event.target.closest('[data-block]')) return;
    event.stopPropagation();
    event.preventDefault();
  }, true);
}

function setBindings() {
  find('site-search').addEventListener('submit', submitSearch);
  find('article-select').addEventListener('change', event => {
    if (state.law) navigate(state.law.id, event.target.value);
  });
  find('read-article').addEventListener('click', () => {
    const article = state.article;
    if (!article) return;
    spoken([article.title, article.caption, ...article.parts.map(part => part.reading || part.text)].filter(Boolean).join('。\n'));
  });
  find('highlight-toggle').addEventListener('click', () => setMarker(!state.marker));
  find('clear-marks').addEventListener('click', () => {
    const article = state.article;
    if (!article) return;
    const prefix = `${state.law.id}:${article.id}:`;
    const casePrefixes = (state.currentCases || []).map(entry => `case:${entry.id}:`);
    const remaining = state.marks.filter(mark => !mark.key.startsWith(prefix) && !casePrefixes.some(key => mark.key.startsWith(key)));
    if (remaining.length === state.marks.length) {
      report('現在の条文と関連判例にマーカーはありません。');
      return;
    }
    if (!window.confirm('表示中の条文と関連判例からマーカーを消去しますか？')) return;
    state.marks = remaining;
    for (const block of state.blocks.values()) renderMarkable(block);
    if (saveMarks()) report('現在の条文と関連判例のマーカーを消去しました。');
  });

  find('selection-open')?.addEventListener('click', () => showExcerpt(state.selection));
  find('toc-mobile-toggle')?.addEventListener('click', event => {
    const control = event.currentTarget;
    control.setAttribute('aria-expanded', String(control.getAttribute('aria-expanded') !== 'true'));
  });
  find('term-close').addEventListener('click', () => closeDialog(find('term-dialog')));
  find('term-speak').addEventListener('click', () => spoken(state.displayedTerm));
  const termMark = node('button', 'text-action', '意味にマーカー');
  termMark.type = 'button';
  termMark.id = 'term-mark';
  find('term-speak').after(termMark);
  find('excerpt-close').addEventListener('click', () => closeDialog(find('excerpt-dialog')));
  find('excerpt-speak').addEventListener('click', () => spoken(state.excerpt.map(item => {
    const block = state.blocks.get(item.key);
    return block?.text === item.text && block.spoken ? block.spoken : item.text;
  }).join('。\n')));
  find('excerpt-mark').addEventListener('click', () => {
    addMarks(state.excerpt);
    closeDialog(find('excerpt-dialog'));
  });
  find('excerpt-lookup')?.addEventListener('click', () => {
    const text = state.excerpt.map(item => item.text).join(' ').trim();
    const direct = state.terms.get(text);
    const matches = state.termPattern ? text.match(state.termPattern) || [] : [];
    if (direct || matches.length) {
      const match = direct || state.terms.get(matches[0]);
      openTerm(match);
    } else {
      const hint = find('excerpt-source');
      if (hint) hint.textContent = '選択範囲に収録済みの用語はありません。';
      else report('選択範囲に収録済みの用語はありません。');
    }
  });
  find('excerpt-display')?.addEventListener('click', () => {
    const block = state.blocks.get(state.excerpt.find(item => state.blocks.get(item.key)?.part)?.key);
    if (!block?.part) return;
    closeDialog(find('excerpt-dialog'));
    navigate(state.law.id, state.article.id, block.part);
  });
  find('share-article')?.addEventListener('click', async () => {
    if (!state.law || !state.article) return;
    const url = routeURL(state.law.id, state.article.id, currentRoute().partId);
    try {
      await navigator.clipboard.writeText(url.href);
      report('条文リンクをコピーしました。');
    } catch {
      report(`条文リンク ${url.href}`);
    }
  });
  find('focus-reader')?.addEventListener('click', () => {
    const active = document.body.classList.toggle('reader-focus');
    find('focus-reader').setAttribute('aria-pressed', String(active));
    find('article-heading').scrollIntoView({ block: 'nearest' });
  });
  find('mark-export')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ format: 'roppo-marks', version: 1, marks: state.marks }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = link(url, '');
    anchor.download = 'roppo-markers.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  find('mark-import')?.addEventListener('click', () => find('mark-file')?.click());
  find('mark-file')?.addEventListener('change', async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      if (file.size > 30 * 1024 * 1024) throw new Error('size');
      const data = JSON.parse(await file.text());
      if (data.format !== 'roppo-marks' || data.version !== 1 || !Array.isArray(data.marks)) throw new Error('format');
      const importMarks = validateMarks(data.marks);
      const known = new Set(state.marks.map(mark => JSON.stringify([mark.key, mark.start, mark.text])));
      for (const mark of importMarks) {
        const signature = JSON.stringify([mark.key, mark.start, mark.text]);
        if (!known.has(signature)) {
          state.marks.push(mark);
          known.add(signature);
        }
      }
      for (const block of state.blocks.values()) renderMarkable(block);
      if (saveMarks()) report('マーカーのバックアップを読み込みました。');
    } catch {
      report('マーカーのバックアップを読み込めませんでした。');
    }
  });
  window.addEventListener('popstate', () => showRoute(true));
  setupDialog(find('term-dialog'));
  setupDialog(find('excerpt-dialog'));
  addDialogSpeechControls(find('term-dialog'));
  addDialogSpeechControls(find('excerpt-dialog'));
  wireMarkers();
  setMarker(false);
  setSelection([]);
}

async function start() {
  setBindings();
  try {
    const [catalog, editorial] = await Promise.all([
      fetchJSON('data/catalog.json'),
      fetchJSON('data/editorial.json').catch(() => defaultEditorial),
    ]);
    state.catalog = catalog;
    state.editorial = editorial;
    for (const term of editorial.terms || []) {
      if (!term.text || !term.meaning) continue;
      state.terms.set(term.text, { ...term, type: term.type === 'compound' ? 'compound' : 'legal' });
      if (term.type !== 'compound' && term.reading) state.readings.set(term.text, term.reading.split('／')[0]);
    }
    for (const [text, kana] of Object.entries(editorial.readings || {})) {
      if (text && typeof kana === 'string') state.readings.set(text, kana);
    }
    state.termPattern = patternOf([...state.terms.keys()]);
    state.legalPattern = patternOf([...state.terms.values()].filter(term => term.type === 'legal').map(term => term.text));
    state.compoundPattern = patternOf([...state.terms.values()].filter(term => term.type === 'compound').map(term => term.text));
    state.readingPattern = patternOf([...state.readings.keys()]);
    find('data-updated').textContent = catalog.updated || '日付未取得';
    if (catalog.updated && find('data-updated').tagName === 'TIME') find('data-updated').dateTime = catalog.updated;
    const dictionaryCount = find('dictionary-count');
    if (dictionaryCount) dictionaryCount.textContent = state.terms.size.toLocaleString('ja-JP');
    await showRoute();
  } catch (error) {
    console.error(error);
    report('法令の目録を開けませんでした。オンラインで再読み込みしてください。');
  }
}

start();
