import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const landingHtml = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const landingDom = new JSDOM(landingHtml, { url: "https://agee.app/" });
const nativeSetTimeout = globalThis.setTimeout;
let landingFetch = async () => new Response(JSON.stringify({ message: "Welcome" }), {
  status: 200,
  headers: { "content-type": "application/json" },
});
const scheduled = [];
globalThis.document = landingDom.window.document;
globalThis.fetch = (...args) => landingFetch(...args);
globalThis.setTimeout = (callback, delay) => {
  scheduled.push({ callback, delay });
  return scheduled.length;
};
await import("../public/landing.js");
const landing = globalThis.MoaLanding;
globalThis.setTimeout = nativeSetTimeout;

function waitlistDom() {
  return new JSDOM(`<!doctype html><form id="waitlistForm">
    <input id="waitlistEmail"><button id="waitlistSubmit">Join</button>
    <p id="waitlistMsg" class="msg"></p></form>`);
}

async function submit(dom) {
  dom.window.document.getElementById("waitlistForm").dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  await new Promise((resolve) => setImmediate(resolve));
}

test("landing waitlist validates, submits, and renders success", async () => {
  const document = landingDom.window.document;
  const email = document.getElementById("waitlistEmail");
  const message = document.getElementById("waitlistMsg");
  email.value = "not-an-email";
  await submit(landingDom);
  assert.equal(message.textContent, "Enter a valid email address.");
  assert.equal(message.classList.contains("err"), true);
  assert.equal(document.activeElement, email);

  email.value = " person@example.com ";
  await submit(landingDom);
  assert.equal(document.getElementById("waitlistForm").style.display, "none");
  assert.equal(message.textContent, "Welcome");
  assert.equal(message.classList.contains("ok"), true);
});

test("landing waitlist covers response and network fallbacks", async () => {
  const malformed = waitlistDom();
  malformed.window.document.getElementById("waitlistEmail").value = "a@example.com";
  landing.initWaitlist(malformed.window.document, async () => ({
    ok: true,
    json: async () => { throw new Error("bad json"); },
  }));
  await submit(malformed);
  assert.equal(malformed.window.document.getElementById("waitlistMsg").textContent, "You are on the list. Check your inbox.");

  for (const body of [{ error: "Already joined" }, {}]) {
    const denied = waitlistDom();
    denied.window.document.getElementById("waitlistEmail").value = "a@example.com";
    landing.initWaitlist(denied.window.document, async () => ({ ok: false, json: async () => body }));
    await submit(denied);
    const message = denied.window.document.getElementById("waitlistMsg").textContent;
    assert.equal(message, body.error || "Something went wrong. Try again.");
    assert.equal(denied.window.document.getElementById("waitlistSubmit").disabled, false);
    assert.equal(denied.window.document.getElementById("waitlistSubmit").textContent, "Join");
  }

  const offline = waitlistDom();
  offline.window.document.getElementById("waitlistEmail").value = "a@example.com";
  landing.initWaitlist(offline.window.document, async () => { throw new Error("offline"); });
  await submit(offline);
  assert.equal(offline.window.document.getElementById("waitlistMsg").textContent, "Network error. Try again.");
  assert.equal(offline.window.document.getElementById("waitlistSubmit").disabled, false);
});

test("floating agent toggles and cycles through all live states", () => {
  const document = landingDom.window.document;
  const root = document.getElementById("ag-root");
  const launcher = document.getElementById("ag-launcher");
  assert.equal(root.classList.contains("ag-state-listening"), true);
  assert.equal(scheduled[0].delay, 2400);
  launcher.click();
  assert.equal(launcher.getAttribute("aria-expanded"), "true");
  launcher.click();
  assert.equal(launcher.getAttribute("aria-expanded"), "false");

  scheduled.shift().callback();
  assert.equal(root.classList.contains("ag-state-thinking"), true);
  scheduled.shift().callback();
  assert.equal(root.classList.contains("ag-state-speaking"), true);
  assert.equal(scheduled[0].delay, 3400);
  scheduled.shift().callback();
  assert.equal(root.classList.contains("ag-state-listening"), true);

  landing.initFloatingAgent(new JSDOM("<!doctype html>").window.document, () => {});
  landing.initFloatingAgent(new JSDOM('<div id="ag-root"></div>').window.document, () => {});
});

const slidesDom = new JSDOM('<!doctype html><div class="slides"></div><div id="counter"></div>');
const revealEvents = new Map();
let currentIndex = 0;
const reveal = {
  initialize(options) { this.options = options; },
  on(name, callback) { revealEvents.set(name, callback); },
  getIndices() { return { h: currentIndex }; },
  getHorizontalSlides() { return slidesDom.window.document.querySelectorAll(".slides > section"); },
};
globalThis.document = slidesDom.window.document;
globalThis.Reveal = reveal;
await import("../public/slides/slides.js");
const slides = globalThis.MoaSlides;

test("slides render the complete deck and initialize Reveal", () => {
  const document = slidesDom.window.document;
  assert.equal(document.querySelectorAll(".slides > section").length, 12);
  assert.equal(document.querySelectorAll(".bio-photo").length, 1);
  assert.equal(document.querySelectorAll(".chip.on").length, 1);
  assert.equal(reveal.options.width, 1280);
  assert.equal(reveal.options.controls, false);
  assert.deepEqual([...revealEvents.keys()], ["ready", "slidechanged"]);

  revealEvents.get("ready")();
  assert.equal(document.getElementById("counter").textContent, "01 — 12");
  currentIndex = 11;
  revealEvents.get("slidechanged")();
  assert.equal(document.getElementById("counter").textContent, "12 — 12");
  assert.equal(slides.formatCounter(2, 9), "03 — 09");
});

test("slide renderers cover optional copy, sizing, and style branches", () => {
  const R = slides.renderers;
  assert.doesNotMatch(R.title({ eyebrow: "E", h: "H", size: "md" }), /class="sub"/);
  assert.doesNotMatch(R.statement({ h: "H", size: "lg" }), /class="sub/);
  assert.match(R.statement({ h: "H", size: "lg", sub: "S", wide: false }), /class="sub"/);
  assert.doesNotMatch(R.bio({ eyebrow: "E", photo: "p", name: "N", role: "R", creds: [] }), /sub wide/);
  assert.match(R.morph({ size: "md", aPre: "A", from: "F", bPre: "B", to: "T" }), /class="md"/);

  const rendered = slides.renderDeck([
    { type: "title", eyebrow: "One", h: "Hello" },
    { type: "proof", size: "md", h: "Proof", pipe: "pipe", chips: [{ t: "off", on: false }] },
  ], R);
  assert.match(rendered, /Hello/);
  assert.match(rendered, /class="chip">off/);
});
