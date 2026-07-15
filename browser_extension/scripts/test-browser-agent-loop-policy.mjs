import assert from "node:assert/strict";
import test from "node:test";
import {
  agentLoopScreenshotObservation,
  buildAgentLoopObservationPayload,
  clampAgentLoopMaxSteps,
  validateAgentLoopAction,
} from "../extension/browser-agent-loop-policy.js";

test("agent-loop step limits are finite integer bounds", () => {
  for (const value of [undefined, null, "bad", 0, -1, Number.POSITIVE_INFINITY]) {
    assert.equal(clampAgentLoopMaxSteps(value), 24);
  }
  assert.equal(clampAgentLoopMaxSteps(1.9), 1);
  assert.equal(clampAgentLoopMaxSteps("3"), 3);
  assert.equal(clampAgentLoopMaxSteps(100), 40);
});

test("screenshot observations omit missing and oversized payloads", () => {
  assert.deepEqual(agentLoopScreenshotObservation(""), {
    encoding: "omitted",
    reason: "screenshot capture failed",
  });
  assert.deepEqual(agentLoopScreenshotObservation("x".repeat(420 * 1024 + 1)), {
    encoding: "omitted",
    reason: "screenshot too large for gateway observation payload",
  });
  assert.deepEqual(agentLoopScreenshotObservation("base64"), {
    encoding: "base64_jpeg",
    data: "base64",
  });
});

test("observation shaping bounds page-derived evidence", () => {
  assert.deepEqual(buildAgentLoopObservationPayload(null, 0), {
    url: "",
    title: "",
    elements: [],
    step: 0,
  });

  const elements = Array.from({ length: 105 }, (_, index) => ({
    i: index,
    tag: index === 0 ? "button" : "",
    type: index === 0 ? "submit" : null,
    label: index === 0 ? "x".repeat(100) : undefined,
  }));
  const action = { kind: "click", index: 0 };
  const result = buildAgentLoopObservationPayload({
    url: 42,
    title: false,
    pageText: `  ${"p".repeat(6100)}  `,
    elements,
  }, 3, {
    withScreenshot: true,
    screenshot: "shot",
    lastAction: action,
    lastActionResult: "r".repeat(600),
  });
  assert.equal(result.url, "42");
  assert.equal(result.title, "");
  assert.equal(result.elements.length, 100);
  assert.deepEqual(result.elements[0], {
    i: 0,
    tag: "button",
    type: "submit",
    label: "x".repeat(80),
  });
  assert.equal(result.page_text.length, 6000);
  assert.deepEqual(result.screenshot, { encoding: "base64_jpeg", data: "shot" });
  assert.equal(result.last_action, action);
  assert.equal(result.last_action_result.length, 500);

  const emptyOptional = buildAgentLoopObservationPayload({ elements: "bad", pageText: "   " }, 1, {
    withScreenshot: true,
    screenshot: "",
    lastAction: null,
    lastActionResult: "",
  });
  assert.equal("page_text" in emptyOptional, false);
  assert.equal("last_action" in emptyOptional, false);
  assert.equal("last_action_result" in emptyOptional, false);
  assert.equal(emptyOptional.screenshot.encoding, "omitted");
});

test("agent-loop action policy accepts only bounded declarative actions", () => {
  const normalizeUrl = (value) => value === "good" ? "https://example.test/" : "";
  for (const value of [null, undefined, "click"]) {
    assert.deepEqual(validateAgentLoopAction(value, normalizeUrl), { ok: false, kind: "(none)" });
  }
  assert.deepEqual(validateAgentLoopAction({}, normalizeUrl), { ok: false, kind: "(unknown)" });
  assert.deepEqual(validateAgentLoopAction({ kind: "future" }, normalizeUrl), { ok: false, kind: "future" });

  for (const kind of ["click", "clear"]) {
    assert.deepEqual(validateAgentLoopAction({ kind, index: 0 }, normalizeUrl), {
      ok: true, kind, action: { kind, index: 0 },
    });
    for (const index of [-1, 1.5, "1"]) assert.equal(validateAgentLoopAction({ kind, index }, normalizeUrl).ok, false);
  }

  assert.equal(validateAgentLoopAction({ kind: "type", index: -1, text: "x" }, normalizeUrl).ok, false);
  assert.equal(validateAgentLoopAction({ kind: "type", index: 1, text: 2 }, normalizeUrl).ok, false);
  assert.equal(validateAgentLoopAction({ kind: "type", index: 1, text: "x".repeat(2001) }, normalizeUrl).ok, false);
  assert.equal(validateAgentLoopAction({ kind: "type", index: 1, text: "x".repeat(2000) }, normalizeUrl).ok, true);
  assert.equal(validateAgentLoopAction({ kind: "select", index: -1, text: "x" }, normalizeUrl).ok, false);
  assert.equal(validateAgentLoopAction({ kind: "select", index: 1, text: 2 }, normalizeUrl).ok, false);
  assert.equal(validateAgentLoopAction({ kind: "select", index: 1, text: "x".repeat(201) }, normalizeUrl).ok, false);
  assert.equal(validateAgentLoopAction({ kind: "select", index: 1, text: "x".repeat(200) }, normalizeUrl).ok, true);

  assert.deepEqual(validateAgentLoopAction({ kind: "scroll", direction: "up" }, normalizeUrl).action, { kind: "scroll", direction: "up" });
  assert.deepEqual(validateAgentLoopAction({ kind: "scroll", direction: "down" }, normalizeUrl).action, { kind: "scroll", direction: "down" });
  assert.equal(validateAgentLoopAction({ kind: "scroll", direction: "sideways" }, normalizeUrl).ok, false);
  assert.equal(validateAgentLoopAction({ kind: "navigate", url: "bad" }, normalizeUrl).ok, false);
  assert.equal(validateAgentLoopAction({ kind: "navigate", url: "good" }).ok, false);
  assert.deepEqual(validateAgentLoopAction({ kind: "navigate", url: "good" }, normalizeUrl).action, {
    kind: "navigate", url: "https://example.test/",
  });

  for (const text of ["", 2, "x".repeat(33)]) {
    assert.equal(validateAgentLoopAction({ kind: "key", text }, normalizeUrl).ok, false);
  }
  assert.equal(validateAgentLoopAction({ kind: "key", text: "x".repeat(32) }, normalizeUrl).ok, true);
  assert.deepEqual(validateAgentLoopAction({ kind: "wait" }, normalizeUrl).action, { kind: "wait" });
  assert.deepEqual(validateAgentLoopAction({ kind: "screenshot" }, normalizeUrl).action, { kind: "screenshot" });

  assert.equal(validateAgentLoopAction({ kind: "finish", status: "invalid" }, normalizeUrl).ok, false);
  assert.deepEqual(validateAgentLoopAction({ kind: "finish", status: "blocked", summary: 4 }, normalizeUrl).action, {
    kind: "finish", status: "blocked", summary: "",
  });
  const finished = validateAgentLoopAction({ kind: "finish", status: "done", summary: "s".repeat(2100) }, normalizeUrl);
  assert.equal(finished.action.summary.length, 2000);
});
