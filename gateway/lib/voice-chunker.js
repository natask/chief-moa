"use strict";

// Sentence/clause chunker for the streaming cascaded voice pipeline, plus the
// incremental speak-text sanitizer that feeds it. Pure functions and plain
// state — no I/O, no timers. The force-break timer is owned by the CALLER
// (the TTS pipeline): when `pendingLength() >= minChars` and no chunk has been
// produced for `flushTimeoutMs` (see `nextDeadline()`), the caller invokes
// `forceBreak()` explicitly. That keeps this module unit-testable with plain
// asserts.
//
// Boundary rules, in priority order (design: streaming-voice-design-20260706
// section 3):
//   1. Sentence enders: . ! ? … and Ethiopic ። ፧ ፨, Arabic ؟, CJK 。 ！ ？.
//      A boundary requires the ender to be followed by whitespace, end of
//      buffer, or a closing quote/bracket then whitespace.
//   2. Clause enders (, ; : and Ethiopic ፣ ፤ ፥, Arabic ،) only once the
//      pending buffer is past minChars, and only before whitespace.
//   3. Hard split past maxChars at the last whitespace; at maxChars exactly
//      for unspaced scripts.
// First-chunk-fastest: before any chunk has been emitted the hard-split cap
// tightens to firstChunkMaxChars, minChars drops to 1, and clause enders are
// accepted immediately, so "Sure." or "ሰላም።" leaves for TTS at once.
// Latin guards: abbreviations, initials, decimals, ellipses being built, and
// mid-sentence periods followed by lowercase are never boundaries.
// Expressive [tag] spans are atomic: no boundary lands inside [...], and a
// chunk must carry prose — a tag always rides with the prose it modifies.

const DEFAULT_FIRST_CHUNK_MAX_CHARS = 60;
const DEFAULT_MIN_CHARS = 60;
const DEFAULT_MAX_CHARS = 220;
const DEFAULT_FLUSH_TIMEOUT_MS = 1200;
// A bracketed expressive tag is at most this long including the brackets;
// anything longer is treated as literal prose, matching the 40–60 char tag
// bounds the gateway's expressive parsing uses.
const MAX_TAG_SPAN = 62;

// "." carries the Latin guard set below; every other ender is unambiguous.
const SENTENCE_ENDERS = new Set([".", "!", "?", "…", "።", "፧", "፨", "؟", "。", "！", "？"]);
const CLAUSE_ENDERS = new Set([",", ";", ":", "፣", "፤", "፥", "،"]);
const CLOSING_TRAIL = new Set(["\"", "'", "”", "’", "»", ")", "]", "}"]);
// Case-insensitive abbreviation set; any single letter (initials) also guards.
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "st", "sr", "jr", "vs", "etc",
  "e.g", "i.e", "no", "dept", "fig", "approx", "min", "max", "sq",
]);

function createSpeechChunker(options = {}) {
  const firstChunkMaxChars = positiveInt(options.firstChunkMaxChars, DEFAULT_FIRST_CHUNK_MAX_CHARS);
  const minChars = positiveInt(options.minChars, DEFAULT_MIN_CHARS);
  const maxChars = Math.max(positiveInt(options.maxChars, DEFAULT_MAX_CHARS), firstChunkMaxChars);
  const flushTimeoutMs = positiveInt(options.flushTimeoutMs, DEFAULT_FLUSH_TIMEOUT_MS);

  let pending = "";
  let emittedChunks = 0;
  let lastProgressAt = 0;

  const effectiveMin = () => (emittedChunks === 0 ? 1 : minChars);
  const effectiveMax = () => (emittedChunks === 0 ? firstChunkMaxChars : maxChars);

  function noteProgress() {
    lastProgressAt = Date.now();
  }

  function take(endIndex) {
    const chunk = pending.slice(0, endIndex).trim();
    pending = pending.slice(endIndex).replace(/^\s+/, "");
    if (!chunk || !hasProse(chunk)) {
      return null;
    }
    emittedChunks += 1;
    noteProgress();
    return chunk;
  }

  // Scan `pending` for the earliest usable boundary. Returns the slice end
  // index, or -1 when no boundary is usable yet.
  function findBoundary() {
    const text = pending;
    const min = effectiveMin();
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "[") {
        const close = text.indexOf("]", i + 1);
        if (close !== -1 && close - i < MAX_TAG_SPAN && !text.slice(i, close).includes("\n")) {
          i = close;
          continue;
        }
        if (close === -1 && text.length - i < MAX_TAG_SPAN) {
          // A tag may still be streaming in; never place a boundary past an
          // unclosed bracket.
          return -1;
        }
        continue;
      }

      if (SENTENCE_ENDERS.has(ch)) {
        const end = sentenceBoundaryEnd(text, i, min);
        if (end === -2) {
          // Ellipsis or trailing state still building; wait for more input.
          return -1;
        }
        if (end >= 0) {
          return end;
        }
        continue;
      }

      if (CLAUSE_ENDERS.has(ch)) {
        const next = text[i + 1];
        if (next === undefined || !isWhitespace(next)) {
          continue;
        }
        const candidate = text.slice(0, i + 1).trim();
        const clauseMin = emittedChunks === 0 ? 1 : minChars;
        if (candidate.length >= clauseMin && hasProse(candidate)) {
          return i + 1;
        }
      }
    }
    return -1;
  }

  // Sentence-ender boundary check at index i. Returns the chunk end index,
  // -1 when this ender is not a boundary, or -2 when the decision needs more
  // input (hold).
  function sentenceBoundaryEnd(text, i, min) {
    let enderEnd = i + 1;

    if (text[i] === ".") {
      // Ellipsis being built: a dot run is only decidable once it stops.
      if (text[i + 1] === ".") {
        let j = i + 1;
        while (text[j + 1] === ".") j += 1;
        if (j + 1 >= text.length) {
          return -2;
        }
        enderEnd = j + 1;
      } else {
        const before = text[i - 1];
        const after = text[i + 1];
        // Decimal / version numbers: 3.14, v2.5, 1.000.
        if (isDigit(before) && (after === undefined || isDigit(after))) {
          return -1;
        }
        // Abbreviations and initials: Mr., J., e.g., no., fig.
        const word = trailingWord(text, i);
        if (word && (ABBREVIATIONS.has(word) || /^[a-z]$/.test(word))) {
          return -1;
        }
      }
    }

    // Consume closing quotes/brackets after the ender.
    let j = enderEnd;
    while (j < text.length && CLOSING_TRAIL.has(text[j])) j += 1;

    if (j >= text.length) {
      // End of buffer counts as a boundary; "." additionally required its
      // guards above, which never see a following char here.
      return acceptCandidate(text, j, min);
    }
    if (!isWhitespace(text[j])) {
      return -1;
    }
    if (text[i] === "." || text[enderEnd - 1] === ".") {
      // Mid-sentence period: the next non-space char being lowercase marks a
      // continuation (URLs, file names, casual prose). Hold when it is not
      // visible yet.
      let k = j;
      while (k < text.length && isWhitespace(text[k])) k += 1;
      if (k >= text.length) {
        return -2;
      }
      if (isLowercaseLetter(text[k])) {
        return -1;
      }
    }
    return acceptCandidate(text, j, min);
  }

  function acceptCandidate(text, end, min) {
    const candidate = text.slice(0, end).trim();
    if (candidate.length < min || !hasProse(candidate)) {
      return -1;
    }
    return end;
  }

  // Hard split for a pending buffer past the max: last whitespace not inside
  // a bracket span, or exactly at the cap for unspaced scripts.
  function hardSplitEnd() {
    const cap = effectiveMax();
    if (pending.trim().length <= cap) {
      return -1;
    }
    const window = pending.slice(0, cap + 1);
    let split = -1;
    let bracketDepth = 0;
    for (let i = 0; i < window.length; i += 1) {
      const ch = window[i];
      if (ch === "[") bracketDepth += 1;
      else if (ch === "]" && bracketDepth > 0) bracketDepth -= 1;
      else if (isWhitespace(ch) && bracketDepth === 0 && hasProse(window.slice(0, i))) split = i;
    }
    return split > 0 ? split : cap;
  }

  function drain() {
    const out = [];
    for (;;) {
      let end = findBoundary();
      if (end < 0) {
        end = hardSplitEnd();
      }
      if (end < 0) {
        break;
      }
      const chunk = take(end);
      if (chunk) {
        out.push(chunk);
      } else if (pending.length === 0) {
        break;
      }
    }
    return out;
  }

  return {
    push(delta) {
      const text = String(delta ?? "");
      if (!text) {
        return [];
      }
      if (!pending) {
        noteProgress();
      }
      pending += text;
      return drain();
    },

    // Stream end: emit whatever remains (when it carries prose).
    flush() {
      const out = drain();
      const rest = pending.trim();
      pending = "";
      if (rest && hasProse(rest)) {
        emittedChunks += 1;
        noteProgress();
        out.push(rest);
      }
      return out;
    },

    // Caller-owned timer fired: split at the last whitespace (bracket-safe) or
    // emit the whole pending buffer when it has no whitespace.
    forceBreak() {
      const trimmed = pending.trim();
      if (!trimmed || !hasProse(trimmed)) {
        return [];
      }
      let split = -1;
      let bracketDepth = 0;
      for (let i = 0; i < pending.length; i += 1) {
        const ch = pending[i];
        if (ch === "[") bracketDepth += 1;
        else if (ch === "]" && bracketDepth > 0) bracketDepth -= 1;
        else if (isWhitespace(ch) && bracketDepth === 0 && hasProse(pending.slice(0, i))) split = i;
      }
      const end = split > 0 ? split : pending.length;
      const chunk = take(end);
      return chunk ? [chunk] : [];
    },

    pendingLength() {
      return pending.trim().length;
    },

    emittedCount() {
      return emittedChunks;
    },

    nextDeadline() {
      if (!pending.trim()) {
        return 0;
      }
      return (lastProgressAt || Date.now()) + flushTimeoutMs;
    },

    flushTimeoutMs,
    minChars,
  };
}

// Incremental sanitizer for streamed speak-text deltas. Mirrors the gateway's
// capSpeakText compaction (markdown characters stripped, whitespace collapsed,
// leading trim, hard cap) plus parseExpressiveReply's tag handling (leading
// [style: ...] captured, whitelisted inline [tag]s kept only for expressive
// TTS, all other bracketed spans dropped) — applied delta by delta with state
// carried across pushes, so the streamed text is a byte prefix of the stored
// capped reply.
function createSpeakStreamSanitizer(options = {}) {
  const onDelta = typeof options.onDelta === "function" ? options.onDelta : () => {};
  const onStyle = typeof options.onStyle === "function" ? options.onStyle : () => {};
  const keepTags = options.keepTags === true;
  const isAllowedTag = typeof options.isAllowedTag === "function" ? options.isAllowedTag : () => false;
  const capOption = options.maxChars;

  let styleHold = "";
  let styleResolved = false;
  let bracketHold = "";
  let pendingSpace = false;
  let emittedCount = 0;
  let capped = false;
  let backtickRun = 0;
  let stopped = false; // code fence encountered: stop streaming, prefix stays valid

  function cap() {
    const value = typeof capOption === "function" ? capOption() : capOption;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : Infinity;
  }

  function emitProse(text, out) {
    for (const ch of text) {
      if (capped || stopped) return;
      if (ch === "`") {
        backtickRun += 1;
        if (backtickRun >= 3) {
          stopped = true;
          return;
        }
        continue;
      }
      backtickRun = 0;
      if (/[*_#>~-]/.test(ch)) {
        continue;
      }
      if (isWhitespace(ch)) {
        if (emittedCount > 0) pendingSpace = true;
        continue;
      }
      if (pendingSpace) {
        if (emittedCount + 1 > cap()) {
          capped = true;
          return;
        }
        out.push(" ");
        emittedCount += 1;
        pendingSpace = false;
      }
      if (emittedCount + 1 > cap()) {
        capped = true;
        return;
      }
      out.push(ch);
      emittedCount += 1;
    }
  }

  function emitTag(tag, out) {
    if (capped || stopped) return;
    backtickRun = 0;
    let width = tag.length + (pendingSpace && emittedCount > 0 ? 1 : 0);
    if (emittedCount + width > cap()) {
      capped = true;
      return;
    }
    if (pendingSpace && emittedCount > 0) {
      out.push(" ");
      emittedCount += 1;
      pendingSpace = false;
    }
    out.push(tag);
    emittedCount += tag.length;
  }

  function processBody(text, out, atEnd) {
    let rest = bracketHold + text;
    bracketHold = "";
    while (rest.length > 0) {
      if (capped || stopped) return;
      const open = rest.indexOf("[");
      if (open === -1) {
        emitProse(rest, out);
        return;
      }
      emitProse(rest.slice(0, open), out);
      const close = rest.indexOf("]", open + 1);
      const span = close === -1 ? rest.length - open : close - open + 1;
      if (close === -1) {
        if (!atEnd && span < MAX_TAG_SPAN && !rest.slice(open).includes("\n")) {
          bracketHold = rest.slice(open);
          return;
        }
        // Not a tag: keep the bracket as literal prose (matches capSpeakText,
        // which only recognizes closed tags). '[' itself is not a markdown
        // char, so emit it verbatim.
        emitLiteralBracket(rest.slice(open, open + 1), out);
        rest = rest.slice(open + 1);
        continue;
      }
      if (span >= MAX_TAG_SPAN || rest.slice(open, close).includes("\n")) {
        emitLiteralBracket(rest.slice(open, open + 1), out);
        rest = rest.slice(open + 1);
        continue;
      }
      const inner = rest.slice(open + 1, close);
      if (keepTags && isAllowedTag(inner)) {
        emitTag(`[${inner}]`, out);
      } else {
        // Dropped tags become a collapsed space, as parseExpressiveReply does.
        if (emittedCount > 0) pendingSpace = true;
      }
      rest = rest.slice(close + 1);
    }
  }

  function emitLiteralBracket(ch, out) {
    if (capped || stopped) return;
    if (pendingSpace && emittedCount > 0) {
      if (emittedCount + 1 > cap()) {
        capped = true;
        return;
      }
      out.push(" ");
      emittedCount += 1;
      pendingSpace = false;
    }
    if (emittedCount + 1 > cap()) {
      capped = true;
      return;
    }
    out.push(ch);
    emittedCount += 1;
  }

  function resolveStyle(out, atEnd) {
    if (styleResolved) return "";
    const match = styleHold.match(/^\s*\[\s*style\s*:\s*([^\]\n]{1,200})\]\s*/i);
    if (match) {
      styleResolved = true;
      const style = match[1].trim();
      const rest = styleHold.slice(match[0].length);
      styleHold = "";
      if (style) {
        try {
          onStyle(style);
        } catch {
          // Style delivery is best-effort.
        }
      }
      return rest;
    }
    const head = styleHold;
    const firstNonSpace = head.search(/\S/);
    const undecidable = firstNonSpace !== -1 && head[firstNonSpace] !== "[";
    const closed = head.includes("]");
    const tooLong = head.length >= 80;
    const hasNewline = head.includes("\n");
    if (atEnd || undecidable || closed || tooLong || hasNewline) {
      styleResolved = true;
      styleHold = "";
      return head;
    }
    return null; // keep holding
  }

  function push(delta) {
    const text = String(delta ?? "");
    if (!text || capped || stopped) {
      return;
    }
    const out = [];
    if (!styleResolved) {
      styleHold += text;
      const released = resolveStyle(out, false);
      if (released === null) {
        return;
      }
      processBody(released, out, false);
    } else {
      processBody(text, out, false);
    }
    if (out.length) {
      onDelta(out.join(""));
    }
  }

  function end() {
    const out = [];
    if (!styleResolved) {
      const released = resolveStyle(out, true);
      if (released) {
        processBody(released, out, true);
      }
    }
    if (bracketHold) {
      const held = bracketHold;
      bracketHold = "";
      processBody(held, out, true);
    }
    if (out.length) {
      onDelta(out.join(""));
    }
  }

  return {
    push,
    end,
    emittedLength: () => emittedCount,
    capped: () => capped,
  };
}

function trailingWord(text, dotIndex) {
  let start = dotIndex;
  while (start > 0 && /[A-Za-z.]/.test(text[start - 1])) start -= 1;
  const word = text.slice(start, dotIndex).replace(/\.+$/, "");
  return word ? word.toLowerCase() : "";
}

// A candidate chunk must carry prose: something besides whitespace and closed
// [tag] spans, so a tag never ships alone.
function hasProse(text) {
  return String(text || "").replace(/\[[^\]\n]{0,60}\]/g, " ").trim().length > 0;
}

function isWhitespace(ch) {
  return /\s/.test(ch);
}

function isDigit(ch) {
  return ch >= "0" && ch <= "9";
}

function isLowercaseLetter(ch) {
  return typeof ch === "string" && /\p{Ll}/u.test(ch);
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

module.exports = {
  createSpeechChunker,
  createSpeakStreamSanitizer,
};
