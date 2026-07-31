import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const contentSource = await readFile(
  new URL("../extension/content.js", import.meta.url),
  "utf8",
);

const primeAudio = contentSource.match(
  /function primeAudio\(\) \{(?<body>[\s\S]*?)\n  \}/,
);

assert.ok(primeAudio?.groups?.body, "content script defines primeAudio");
assert.match(
  primeAudio.groups.body,
  /audioCtx\.resume\(\)\.catch\(\(\) => \{\}\)/,
  "content-script AudioContext resume rejection is handled",
);
