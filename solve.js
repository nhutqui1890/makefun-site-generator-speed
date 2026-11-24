// solve.js — a fast drop-in for makefun-site 1.0.0 (the reference static site
// generator of the site-generator-speed-01 bounty). run(input) returns exactly
// the output tree makefun-site 1.0.0's build returns for the input, as a JSON
// object of path -> text. Written from the reference's documented rules
// (README.md) and its observable behaviour, with its own structure and
// algorithms: a fused Markdown lexer/renderer, bulk HTML escaping, a cached
// slugifier with an ASCII fast path, and a compiled template renderer.
//
// No dependencies, no I/O, no clock, no randomness: the answer is a function
// of the input alone. No state carries from one run() call to the next.

'use strict';

// ------------------------------------------------------------------ text

/** `s` with & < > " ' escaped. The native replace beats a manual scan. */
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;
const ESC_ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s) {
  return s.replace(ESC_RE, (c) => ESC_ENT[c]);
}

/**
 * A template value, escaped: strings are tested first (most template values
 * hold nothing to escape), numbers and booleans never do, arrays are joined
 * then escaped, anything else is "".
 */
function et(v) {
  if (typeof v === 'string') return ESC_TEST.test(v) ? v.replace(ESC_RE, (c) => ESC_ENT[c]) : v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return escapeHtml(v.map(textOf).join(', '));
  return '';
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** This run's slug cache: reset by run(), so no case learns from another. */
let slugCache = null;

function slugifyUncached(text) {
  // ASCII is already NFKD and holds no combining mark: skip the normaliser.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  while (out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
  return out === '' ? 'untitled' : out;
}

/** The slug of `text`, memoised within one run. */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const out = slugifyUncached(text);
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const m = (date.charCodeAt(5) - 48) * 10 + (date.charCodeAt(6) - 48);
  const d = (date.charCodeAt(8) - 48) * 10 + (date.charCodeAt(9) - 48);
  return `${d} ${MONTHS[m - 1]} ${date.slice(0, 4)}`;
}

/** Whether code unit `c` is whitespace in JavaScript's \s sense. */
function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 160 || c === 0x1680 || c === 0x2028 || c === 0x2029 || c === 0x202f ||
    c === 0x205f || c === 0x3000 || c === 0xfeff || (c >= 0x2000 && c <= 0x200a);
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 32) {
      // ASCII letters and digits are the common case; the only whitespace
      // above 32 is the Unicode set (NBSP and friends).
      if (c < 160) {
        if (!inWord) { n++; inWord = true; }
        continue;
      }
      if (c === 160 || c === 0x1680 || c === 0x2028 || c === 0x2029 || c === 0x202f ||
        c === 0x205f || c === 0x3000 || c === 0xfeff || (c >= 0x2000 && c <= 0x200a)) { inWord = false; continue; }
      if (!inWord) { n++; inWord = true; }
    } else if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13) inWord = false;
    else if (!inWord) { n++; inWord = true; }
  }
  return n;
}

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let s = 0;
  let e = line.length;
  while (s < e) {
    const c = line.charCodeAt(s);
    if (c !== 32 && c !== 9) break;
    s++;
  }
  while (e > s) {
    const c = line.charCodeAt(e - 1);
    if (c !== 32 && c !== 9) break;
    e--;
  }
  return s === 0 && e === line.length ? line : line.slice(s, e);
}

/** Whether `line` holds only spaces and tabs. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// ------------------------------------------------------------ front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isDigit(c) {
  return c >= 48 && c <= 57;
}

/** A string value: quoted ("..." with \" and \\ its only escapes) or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    let start = 1;
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw.charCodeAt(i);
      if (c === 92) {
        const n = raw.charCodeAt(i + 1);
        if ((n !== 34 && n !== 92) || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += raw.slice(start, i);
        out += raw[i + 1];
        i += 1;
        start = i + 1;
      } else if (c === 34) return { error: 'a quoted string holds a stray quote' };
    }
    out += raw.slice(start, raw.length - 1);
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0;
      let mo = 0;
      let d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          if (!isDigit(raw.charCodeAt(i))) { ok = false; break; }
        }
      }
      if (ok) {
        y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
        mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
        d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i].trim();
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let j = 0; j < t.length; j++) {
          const c = t.charCodeAt(j);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        tags[i] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length >= 1 && raw.length <= 64;
      if (ok) {
        const first = raw.charCodeAt(0);
        const last = raw.charCodeAt(raw.length - 1);
        if (!((first >= 97 && first <= 122) || (first >= 48 && first <= 57))) ok = false;
        else if (!((last >= 97 && last <= 122) || (last >= 48 && last <= 57))) ok = false;
        else {
          let prevDash = false;
          for (let i = 0; i < raw.length; i++) {
            const c = raw.charCodeAt(i);
            if (c === 45) {
              if (prevDash) { ok = false; break; }
              prevDash = true;
            } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
            else { ok = false; break; }
          }
        }
      }
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body lines: { data, bodyLines }, or { error }.
 * `lines` is the source's text split on "\n" (line ends already normalised).
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    let e = raw.length;
    while (e > 0) {
      const c = raw.charCodeAt(e - 1);
      if (c !== 32 && c !== 9) break;
      e--;
    }
    if (e !== raw.length) raw = raw.slice(0, e);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyLines: lines.slice(close + 1) };
}

// ---------------------------------------------------------------- markdown

/** Whether code unit `c` is one a backslash escapes. */
function isEscapable(c) {
  return c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 ||
    c === 40 || c === 41 || c === 35 || c === 43 || c === 45 || c === 46 ||
    c === 33 || c === 62;
}

/** The inline characters that need handling, and the ones HTML escapes. */
const INLINE_RE = /[\\`*[&<>"']/g;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const wlen = what.length;
  for (let j = from; j <= s.length - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) { j++; continue; }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href. One scan handles
 * both the inline marks and the HTML escaping: the text between two matches
 * holds neither, so it goes out raw.
 */
function inline(s, env) {
  let out = '';
  let i = 0;
  const n = s.length;
  for (;;) {
    INLINE_RE.lastIndex = i;
    const m = INLINE_RE.exec(s);
    const j = m === null ? n : m.index;
    if (j > i) out += s.slice(i, j);
    if (m === null) break;
    const c = s.charCodeAt(j);
    if (c === 38) { out += '&amp;'; i = j + 1; continue; }
    if (c === 60) { out += '&lt;'; i = j + 1; continue; }
    if (c === 62) { out += '&gt;'; i = j + 1; continue; }
    if (c === 34) { out += '&quot;'; i = j + 1; continue; }
    if (c === 39) { out += '&#39;'; i = j + 1; continue; }
    if (c === 92) {
      const d = s.charCodeAt(j + 1);
      if (j + 1 < n && isEscapable(d)) {
        out += d === 62 ? '&gt;' : s[j + 1];
        i = j + 2;
      } else {
        out += '\\';
        i = j + 1;
      }
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += '<code>';
        out += escapeHtml(s.slice(j + 1, k));
        out += '</code>';
        i = k + 1;
      } else {
        out += '`';
        i = j + 1;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out += '<strong>';
          out += inline(s.slice(j + 2, k), env);
          out += '</strong>';
          i = k + 2;
        } else {
          out += '**';
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out += '<em>';
          out += inline(s.slice(j + 1, k), env);
          out += '</em>';
          i = k + 1;
        } else {
          out += '*';
          i = j + 1;
        }
      }
      continue;
    }
    // '[': a link only when "](" follows the text and the target is non-empty
    // and holds no whitespace.
    const k = findUnescaped(s, ']', j + 1);
    let linked = false;
    if (k !== -1 && s.charCodeAt(k + 1) === 40) {
      const m2 = s.indexOf(')', k + 2);
      if (m2 !== -1) {
        const target = s.slice(k + 2, m2);
        if (target !== '' && !/\s/.test(target)) {
          out += '<a href="';
          out += escapeHtml(env.link(target));
          out += '">';
          out += inline(s.slice(j + 1, k), env);
          out += '</a>';
          i = m2 + 1;
          linked = true;
        }
      }
    }
    if (!linked) {
      out += '[';
      i = j + 1;
    }
  }
  return out;
}

/** A fence's language when `line` opens one, else null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether `line` closes a fence. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6 || h >= line.length) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let s = h;
  while (s < line.length) {
    const d = line.charCodeAt(s);
    if (d !== 32 && d !== 9) break;
    s++;
  }
  let e = line.length;
  while (e > s) {
    const d = line.charCodeAt(e - 1);
    if (d !== 32 && d !== 9) break;
    e--;
  }
  return e === s ? null : { depth: h, text: line.slice(s, e) };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 === 45) {
    if (line.charCodeAt(1) !== 45 || line.charCodeAt(2) !== 45) return false;
  } else if (c0 === 42) {
    if (line.charCodeAt(1) !== 42 || line.charCodeAt(2) !== 42) return false;
  } else return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  const c0 = line.charCodeAt(0);
  if (c0 === 96) return fenceOpen(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  if (c0 === 32 || c0 === 9 || line.length === 0) return isBlank(line);
  return false;
}

/**
 * A list item's start: null, or { ordered, start, content }. A bullet is
 * "- " or "* "; an ordered item is 1-9 digits then ". ".
 */
function listStart(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return { ordered: false, start: 1, content: line.slice(2) };
  if (c0 >= 48 && c0 <= 57) {
    let i = 0;
    while (i < 9 && i < line.length) {
      const c = line.charCodeAt(i);
      if (c < 48 || c > 57) break;
      i++;
    }
    if (line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32) {
      return { ordered: true, start: Number(line.slice(0, i)), content: line.slice(i + 2) };
    }
  }
  return null;
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (line.charCodeAt(i) === 32) i++;
  return i < line.length && !isSpaceCode(line.charCodeAt(i));
}

/**
 * `lines` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading) and its excerpt
 * (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(lines, env) {
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceOpen(line);
    if (lang !== null) {
      i++;
      let body = '';
      while (i < n && !fenceClose(lines[i])) {
        body += escapeHtml(lines[i]);
        body += '\n';
        i++;
      }
      i++;
      blocks.push(lang === '' ? `<pre><code>${body}</code></pre>` : `<pre><code class="language-${escapeHtml(lang)}">${body}</code></pre>`);
      continue;
    }
    const h = headingOf(line);
    if (h !== null) {
      const id = uniqueSlug(slugify(h.text), ids);
      const html = inline(h.text, env);
      blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>`);
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const parts = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i];
        l = l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        l = trimLine(l);
        if (l !== '') parts.push(l);
        i++;
      }
      blocks.push(parts.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(parts.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const ls = listStart(line);
    if (ls !== null) {
      const ordered = ls.ordered;
      const items = [[trimLine(ls.content)]];
      i++;
      while (i < n) {
        const l = lines[i];
        const m = listStart(l);
        if (m !== null && m.ordered === ordered) {
          items.push([trimLine(m.content)]);
          i++;
        } else if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && ls.start !== 1 ? `<ol start="${ls.start}">` : `<${tag}>`;
      let inner = '';
      for (let k = 0; k < items.length; k++) inner += `<li>${inline(items[k].join('\n'), env)}</li>\n`;
      blocks.push(`${open}\n${inner}</${tag}>`);
      continue;
    }
    const parts = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      parts.push(trimLine(lines[i]));
      i++;
    }
    const html = inline(parts.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (let k = 0; k < blocks.length; k++) html += blocks[k] + '\n';
  return { html, toc, excerpt: excerpt ?? '' };
}

// --------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** Node kinds: text, {{ }}, {{{ }}}, {% if %}, {% for %}, {% include %}. */
const N_TEXT = 0;
const N_VAR = 1;
const N_RAW = 2;
const N_IF = 3;
const N_FOR = 4;
const N_INCLUDE = 5;
/** A {% %} tag token (only tokenize uses this; the tree holds N_IF/N_FOR/N_INCLUDE). */
const N_TAG = 6;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `s` from `a` to `b` holds only spaces and tabs. */
function onlySpaceTab(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: N_TEXT, text });
      text = '';
      tokens.push({ t: raw ? N_RAW : N_VAR, path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpaceTab(src, lineStart, open) && onlySpaceTab(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: N_TEXT, text });
    text = '';
    tokens.push({ t: N_TAG, tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: N_TEXT, text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { k: -1, body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === N_TEXT) body.push({ k: N_TEXT, text: tok.text });
    else if (tok.t === N_VAR || tok.t === N_RAW) body.push({ k: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { k: N_FOR, name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { k: N_IF, not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.k !== N_IF || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        const want = tag === 'endfor' ? N_FOR : N_IF;
        if (top.k !== want) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.k === -1 ? parent.body : parent.k === N_FOR ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ k: N_INCLUDE, name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) {
    const top = stack[stack.length - 1];
    throw new TemplateError(`template "${name}": a ${top.k === N_FOR ? 'for' : 'if'} is not closed`);
  }
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** `nodes` rendered in `scope` ({ vars, parent }), appended to `out`. */
function renderNodes(nodes, scope, templates, depth, out) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    switch (n.k) {
      case N_TEXT:
        out.push(n.text);
        break;
      case N_VAR:
        out.push(et(lookup(scope, n.path)));
        break;
      case N_RAW:
        out.push(textOf(lookup(scope, n.path)));
        break;
      case N_IF: {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, templates, depth, out);
        break;
      }
      case N_FOR: {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, templates, depth, out);
        }
        break;
      }
      case N_INCLUDE: {
        const t = templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, templates, depth + 1, out);
        break;
      }
    }
  }
}

// ------------------------------------------------------- template compiler

/**
 * Compiled templates: each parsed tree becomes a function
 *   fn(out, V, S, depth, T)
 * out is the output array, V the top-level values (a null-prototype object),
 * S the caller's loop bindings flattened (innermost wins), depth the include
 * depth and T the map of compiled templates. Loop bindings inside the template
 * resolve at compile time to locals; anything else goes through gtop (the
 * caller's scope, then V) and gv (one own-property step). Where the sandbox
 * refuses generated code, compileTemplate throws and the run falls back to
 * the tree-walking renderer above.
 */

/** One own-property step down a path, or undefined. */
function gv(o, k) {
  return o !== null && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined;
}

/** A first name: the caller's scope first, then the top-level values. */
function gtop(S, V, name) {
  return Object.hasOwn(S, name) ? S[name] : V[name];
}

/** Whether a value counts as true in an if (the compiled form of truthy). */
function ty(v) {
  return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** An empty caller scope, shared: nothing is bound above the top level. */
const EMPTY_SCOPE = Object.freeze({});

/** `nodes` compiled to a render function. */
function compileTemplate(nodes) {
  const parts = [];
  let uid = 0;
  const emitPath = (path, bindings) => {
    const first = path[0];
    let expr;
    if (first === 'loop' && bindings.length > 0) expr = bindings[bindings.length - 1].loopVar;
    else {
      let found = null;
      for (let i = bindings.length - 1; i >= 0; i--) {
        if (bindings[i].forName === first) { found = bindings[i].forVar; break; }
      }
      expr = found !== null ? found : `gtop(S,V,${JSON.stringify(first)})`;
    }
    for (let k = 1; k < path.length; k++) expr = `gv(${expr},${JSON.stringify(path[k])})`;
    return expr;
  };
  const emit = (ns, bindings) => {
    for (let i = 0; i < ns.length; i++) {
      const n = ns[i];
      switch (n.k) {
        case N_TEXT:
          parts.push(`out.push(${JSON.stringify(n.text)});`);
          break;
        case N_VAR:
          parts.push(`out.push(et(${emitPath(n.path, bindings)}));`);
          break;
        case N_RAW:
          parts.push(`out.push(textOf(${emitPath(n.path, bindings)}));`);
          break;
        case N_IF: {
          const cond = `${n.not ? '!' : ''}ty(${emitPath(n.path, bindings)})`;
          parts.push(`if(${cond}){`);
          emit(n.then, bindings);
          parts.push('}');
          if (n.else !== null) {
            parts.push('else{');
            emit(n.else, bindings);
            parts.push('}');
          }
          break;
        }
        case N_FOR: {
          const id = uid++;
          const xs = `x${id}`;
          const kk = `k${id}`;
          const vv = `v${id}`;
          const ll = `l${id}`;
          parts.push(`{const ${xs}=${emitPath(n.path, bindings)};if(Array.isArray(${xs})){for(let ${kk}=0;${kk}<${xs}.length;${kk}++){const ${vv}=${xs}[${kk}];const ${ll}={index:${kk}+1,first:${kk}===0,last:${kk}===${xs}.length-1,length:${xs}.length};`);
          emit(n.body, [...bindings, { forName: n.name, forVar: vv, loopVar: ll }]);
          parts.push('}}}');
          break;
        }
        case N_INCLUDE: {
          let scope = 'S';
          if (bindings.length > 0) {
            const fields = [];
            for (let b = 0; b < bindings.length; b++) {
              fields.push(`${JSON.stringify(bindings[b].forName)}:${bindings[b].forVar}`);
              fields.push(`"loop":${bindings[b].loopVar}`);
            }
            scope = `{...S,${fields.join(',')}}`;
          }
          const id = uid++;
          parts.push(`if(depth<8){const f${id}=T.get(${JSON.stringify(n.name)});if(f${id}!==undefined)f${id}(out,V,${scope},depth+1,T);}`);
          break;
        }
      }
    }
  };
  emit(nodes, []);
  return new Function('gv', 'gtop', 'ty', 'textOf', 'et', `"use strict";return function(out,V,S,depth,T){${parts.join('')}}`)(gv, gtop, ty, textOf, et);
}

// ------------------------------------------------------------------- build

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

/** Whether `t` opens on a scheme: a letter, then letters, digits, +, - or ., then ':'. */
function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** The words of a body's lines: a word never spans the "\n" between lines. */
function wordsOfLines(lines) {
  let n = 0;
  for (let l = 0; l < lines.length; l++) n += wordsOf(lines[l]);
  return n;
}

/** One site's output tree: path -> text. */
export function run(input) {
  slugCache = new Map();
  const site = input.site;
  let base = site.base_url;
  let be = base.length;
  while (be > 0 && base.charCodeAt(be - 1) === 47) be--;
  if (be !== base.length) base = base.slice(0, be);

  // Templates, parsed in code-unit order of their names; one that does not
  // parse is reported and left out. Each parsed tree is then compiled to a
  // render function; where generated code is refused, the run falls back to
  // walking the trees.
  const templates = new Map();
  const report = [];
  const tNames = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < tNames.length; i++) {
    const name = tNames[i];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  let compiled = null;
  try {
    compiled = new Map();
    for (const [name, nodes] of templates) compiled.set(name, compileTemplate(nodes));
  } catch {
    compiled = null;
  }

  // Sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      let text = f.content;
      if (text.indexOf('\r') !== -1) text = text.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, lines: text.split('\n') });
    } else statics.push(f);
  }

  // Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyLines = fm.bodyLines;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's directory and url, its slug unique in its directory.
  const taken = new Map();
  const bySource = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown: each body's HTML, its links resolved to the pages and static
  // files they name.
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const broken = new Set();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null) {
          const page = bySource.get(path);
          if (page !== undefined) return `${page.url}${frag}`;
          if (staticPaths.has(path)) return `${base}/${path}${frag}`;
        }
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.bodyLines, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest first and then by slug; each post's newer
  // and older neighbours.
  const posts = [];
  for (let i = 0; i < kept.length; i++) if (kept[i].post) posts.push(kept[i]);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags: grouped by their slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const tags = s.data.tags ?? [];
    const seen = new Set();
    const out = [];
    for (let i = 0; i < tags.length; i++) {
      const slug = slugify(tags[i]);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(tags[i]);
      }
    }
    return out;
  };
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    const names = ownTags(p);
    for (let j = 0; j < names.length; j++) {
      const name = names[j];
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // The records as templates read them.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cards = new Map();
  const cardOf = (s) => {
    let c = cards.get(s);
    if (c === undefined) {
      // A tag's link record is the same on every card that names it, and a
      // source's reading time never changes: both are computed once.
      c = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: (s.rm ??= Math.max(1, Math.ceil(wordsOfLines(s.bodyLines) / 200))),
        tags: s.tagRefs.map((t) => (t.link ??= { name: t.name, slug: t.slug, url: t.url })),
      };
      cards.set(s, c);
    }
    return c;
  };
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // Layouts: every page through its layout, the index and tag pages through theirs.
  const output = Object.create(null);
  const siteCtx = { title: site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, site.recent).map((p) => cardOf(p));
  const render = (name, vars) => {
    if (compiled !== null) {
      const fn = compiled.get(name);
      if (fn === undefined) return null;
      const out = [];
      fn(out, { __proto__: null, site: siteCtx, tags: allTags, recent, ...vars }, EMPTY_SCOPE, 0, compiled);
      return out.join('');
    }
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site: siteCtx, tags: allTags, recent, ...vars }, parent: null }, templates, 0, out);
    return out.join('');
  };
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  }
  const per = site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not
  // parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let npages = 0;
  for (let i = 0; i < kept.length; i++) if (!kept[i].post) npages++;
  lines.push(`built ${npages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
