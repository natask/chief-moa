import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

function loadDisposition() {
  const context = {
    document: {},
    navigator: {},
    globalThis: null,
  };
  context.globalThis = context;
  vm.runInNewContext(
    readFileSync(new URL("../extension/capture-copy-disposition.js", import.meta.url), "utf8"),
    context,
  );
  return context.AgeeCaptureCopyDisposition;
}

test("live dictation finalizes and waits for the terminal transcript before copying", async () => {
  const disposition = loadDisposition();
  const calls = [];
  const copy = disposition.create({
    isCapturing: () => true,
    canFinalizeWithoutSend: () => true,
    finalizeCapture: () => calls.push("finalize"),
    copyTranscript: async () => {
      calls.push("copy-final");
      return true;
    },
  });

  assert.equal(copy.requestFinalize(), true);
  assert.deepEqual(calls, ["finalize"]);
  assert.equal(copy.isPending(), true);

  assert.equal(await copy.complete(), true);
  assert.deepEqual(calls, ["finalize", "copy-final"]);
  assert.equal(copy.isPending(), false);
});

test("worker clipboard success does not copy the finalized transcript twice", async () => {
  const disposition = loadDisposition();
  const calls = [];
  const copy = disposition.create({
    isCapturing: () => true,
    canFinalizeWithoutSend: () => true,
    finalizeCapture: () => calls.push("finalize"),
    copyTranscript: async () => {
      calls.push("copy");
      return true;
    },
    cancelPendingCopy: () => calls.push("clear-pending"),
  });

  copy.requestFinalize();
  assert.equal(await copy.complete({ clipboardCopied: true }), true);
  assert.deepEqual(calls, ["finalize", "clear-pending"]);
});

test("canceling a pending finalization clears its deferred ribbon copy", () => {
  const disposition = loadDisposition();
  const calls = [];
  const copy = disposition.create({
    isCapturing: () => true,
    canFinalizeWithoutSend: () => true,
    finalizeCapture: () => calls.push("finalize"),
    copyTranscript: () => calls.push("copy"),
    cancelPendingCopy: () => calls.push("clear-pending"),
  });

  copy.requestFinalize();
  copy.cancel();
  assert.equal(copy.isPending(), false);
  assert.deepEqual(calls, ["finalize", "clear-pending"]);
});

test("Ask capture fails closed without cancel, commit, or interim copy", () => {
  const disposition = loadDisposition();
  const calls = [];
  const copy = disposition.create({
    isCapturing: () => true,
    canFinalizeWithoutSend: () => false,
    finalizeCapture: () => calls.push("finalize"),
    onBlocked: () => calls.push("blocked"),
    copyTranscript: () => calls.push("copy"),
  });

  assert.equal(copy.requestFinalize(), true);
  assert.deepEqual(calls, ["blocked"]);
  assert.equal(copy.isPending(), false);
});

test("idle Copy stays an immediate ribbon copy", () => {
  const disposition = loadDisposition();
  const copy = disposition.create({
    isCapturing: () => false,
    canFinalizeWithoutSend: () => true,
    finalizeCapture: () => assert.fail("idle capture must not finalize"),
    copyTranscript: () => assert.fail("the ribbon owns idle copying"),
  });

  assert.equal(copy.requestFinalize(), false);
});

test("browser bridge negotiates and handles capture-only transcript finalization", () => {
  const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  const content = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");

  assert.match(background, /transcriptFinalizeSupported = parsed\.transcript_finalize\?\.supported === true/);
  assert.match(background, /message\?\.type === "finalize_transcript"/);
  assert.match(background, /parsed\?\.type === "transcript_finalized"/);
  assert.match(content, /type: finalizeTranscriptOnly \? "finalize_transcript" : "commit_turn"/);
  assert.match(content, /msg\.type === "transcript_finalized"/);
});
