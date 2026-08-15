import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../extension/options.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../extension/options.css", import.meta.url), "utf8");
const scripts = [
  readFileSync(new URL("../extension/options.js", import.meta.url), "utf8"),
  readFileSync(new URL("../extension/injected-tool-settings.js", import.meta.url), "utf8"),
].join("\n");

function htmlIds(source) {
  return [...source.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
}

test("options shell preserves every element wired by its runtime", () => {
  const ids = htmlIds(html);
  const required = [...scripts.matchAll(/getElementById\("([^"]+)"\)/g)].map((match) => match[1]);
  const missing = [...new Set(required.filter((id) => !ids.includes(id)))];
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  assert.deepEqual(missing, []);
  assert.deepEqual(duplicates, []);
});

test("options shell exposes a complete, progressively disclosed settings map", () => {
  for (const section of ["connection", "voice", "companion", "automation", "advanced"]) {
    assert.match(html, new RegExp(`href="#${section}"`));
    assert.match(html, new RegExp(`id="${section}"`));
  }
  assert.ok((html.match(/<details class="surface-card disclosure-card"/g) || []).length >= 4);
  assert.match(html, /<link rel="stylesheet" href="options\.css"/);
});

test("options styling stays external and includes narrow and accessible states", () => {
  assert.doesNotMatch(html, /\sstyle=/);
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /input:focus/);
  assert.match(css, /\.switch-row input:focus-visible/);
  assert.match(css, /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
});
