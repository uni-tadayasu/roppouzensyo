// Reader data validation stays independent of the DOM so saved data can be checked safely.
export function validateMarks(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 10000).filter(item => item && typeof item.key === 'string' &&
    item.key.length <= 320 && typeof item.text === 'string' && item.text.length > 0 && item.text.length <= 250000 &&
    Number.isSafeInteger(item.start) && Number.isSafeInteger(item.end) && item.start >= 0 && item.end > item.start && item.end - item.start === item.text.length)
    .map(item => ({
      key: item.key, text: item.text, start: item.start, end: item.end,
      before: typeof item.before === 'string' ? item.before.slice(-16) : '',
      after: typeof item.after === 'string' ? item.after.slice(0, 16) : '',
    }));
}


export function findMarkRange(mark, text) {
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


export function bookmarkKey(entry) {
  return `${entry.law}:${entry.article}:${entry.part || ''}`;
}

function savedArticle(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.law !== 'string' || typeof entry.article !== 'string' ||
      (entry.part != null && typeof entry.part !== 'string') || !/^[a-z-]{1,40}$/.test(entry.law) ||
      !/^[a-zA-Z0-9_.-]{1,100}$/.test(entry.article || '') ||
      (entry.part && !/^\d+(?:\.[a-zA-Z0-9_-]+)*$/.test(entry.part))) return null;
  return {
    law: entry.law, article: entry.article, part: entry.part || '',
    label: typeof entry.label === 'string' ? entry.label.slice(0, 200) : entry.article,
  };
}

export function readStudyState(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object') return { bookmarks: [], last: null };
    const known = new Set();
    const bookmarks = (Array.isArray(parsed.bookmarks) ? parsed.bookmarks : []).slice(0, 100)
      .map(savedArticle).filter(entry => {
        if (!entry || known.has(bookmarkKey(entry))) return false;
        known.add(bookmarkKey(entry));
        return true;
      });
    return { bookmarks, last: savedArticle(parsed.last) };
  } catch {
    return { bookmarks: [], last: null };
  }
}

// Map normalized search characters back to source offsets, including full-width text.
export function searchExcerpt(text, query, length = 105) {
  const offsets = [];
  let normalized = '';
  let offset = 0;
  for (const character of text) {
    const normalizedCharacter = character.normalize('NFKC').toLowerCase().replace(/[\s・･]/gu, '');
    normalized += normalizedCharacter;
    offsets.push(...Array(normalizedCharacter.length).fill(offset));
    offset += character.length;
  }
  const keywords = query.normalize('NFKC').toLowerCase().trim().split(/\s+/u)
    .map(word => word.replace(/[\s・･]/gu, '')).filter(Boolean);
  const hits = keywords.map(word => normalized.indexOf(word)).filter(index => index >= 0);
  const hit = hits.length ? offsets[Math.min(...hits)] : 0;
  let start = Math.max(0, hit - 24);
  let end = Math.min(text.length, start + length);
  // Keep supplementary Unicode characters intact at the window boundaries.
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start])) start--;
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end])) end++;
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
