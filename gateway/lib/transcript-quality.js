"use strict";

const LETTER = /\p{Letter}/u;
const LATIN = /\p{Script=Latin}/u;
const ETHIOPIC = /\p{Script=Ethiopic}/u;

function inspectTranscriptScript(text, languageCodes = []) {
  const codes = (Array.isArray(languageCodes) ? languageCodes : [])
    .map((code) => String(code || "").trim().toLowerCase())
    .filter(Boolean);
  const englishAmharicOnly = codes.length > 0
    && codes.every((code) => code === "auto" || code.startsWith("en") || code.startsWith("am"))
    && codes.some((code) => code.startsWith("am"));
  let letterCount = 0;
  let latinCount = 0;
  let ethiopicCount = 0;
  let foreignCount = 0;
  const foreignCodePoints = [];

  for (const character of String(text || "")) {
    if (!LETTER.test(character)) continue;
    letterCount += 1;
    if (LATIN.test(character)) {
      latinCount += 1;
    } else if (ETHIOPIC.test(character)) {
      ethiopicCount += 1;
    } else {
      foreignCount += 1;
      if (foreignCodePoints.length < 8) {
        foreignCodePoints.push(`U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
      }
    }
  }

  const wrongScript = englishAmharicOnly && foreignCount > 0;
  return {
    accepted: !wrongScript,
    policy: englishAmharicOnly ? "latin-ethiopic-only" : "provider-language-only",
    letter_count: letterCount,
    latin_letters: latinCount,
    ethiopic_letters: ethiopicCount,
    foreign_letters: foreignCount,
    foreign_letter_rate: letterCount ? foreignCount / letterCount : 0,
    foreign_code_points: foreignCodePoints,
    reason: wrongScript ? "wrong_script" : "",
  };
}

function editDistance(left, right) {
  const a = Array.from(left);
  const b = Array.from(right);
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function errorRate(reference, observed, unit = "word") {
  const normalize = (value) => String(value || "").normalize("NFC").trim();
  const tokenize = unit === "character"
    ? (value) => Array.from(normalize(value))
    : (value) => normalize(value).toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const expected = tokenize(reference);
  const actual = tokenize(observed);
  if (expected.length === 0) return actual.length === 0 ? 0 : 1;
  return editDistance(expected, actual) / expected.length;
}

module.exports = {
  errorRate,
  inspectTranscriptScript,
};
