import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../extension/sidepanel.js", import.meta.url), "utf8");
const navigation = source.match(/const workspaceButtons[\s\S]*?(?=const TURN_WATCHDOG_MS)/)?.[0] || "";

function harness() {
  let focused = null;
  const buttons = ["now", "library", "control"].map((destination) => ({
    dataset: { workspaceTarget: destination },
    attributes: new Map(),
    listeners: new Map(),
    tabIndex: destination === "now" ? 0 : -1,
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    setAttribute(name, value) { this.attributes.set(name, value); },
    focus() { focused = this; },
  }));
  const views = ["now", "library", "control"].map((destination) => ({
    dataset: { workspaceView: destination },
    hidden: destination !== "now",
  }));
  const body = { dataset: { workspace: "now" } };
  const workspace = { scrollTo() {} };
  const document = {
    body,
    getElementById: () => workspace,
    querySelectorAll: (selector) => selector === "[data-workspace-target]" ? buttons : views,
  };
  vm.runInNewContext(navigation, { document });
  const key = (index, value) => buttons[index].listeners.get("keydown")({
    currentTarget: buttons[index], key: value, preventDefault() {},
  });
  return { body, buttons, views, key, focused: () => focused };
}

test("workspace tabs expose one roving tab stop and activate clicks", () => {
  const ui = harness();
  ui.buttons[1].listeners.get("click")();
  assert.equal(ui.body.dataset.workspace, "library");
  assert.deepEqual(ui.buttons.map((button) => button.tabIndex), [-1, 0, -1]);
  assert.deepEqual(ui.buttons.map((button) => button.attributes.get("aria-selected")), ["false", "true", "false"]);
  assert.deepEqual(ui.views.map((view) => view.hidden), [true, false, true]);
});

test("workspace tabs support arrows with wraparound plus Home and End", () => {
  const ui = harness();
  ui.key(0, "ArrowRight");
  assert.equal(ui.focused(), ui.buttons[1]);
  assert.equal(ui.body.dataset.workspace, "library");
  ui.key(0, "ArrowLeft");
  assert.equal(ui.focused(), ui.buttons[2]);
  assert.equal(ui.body.dataset.workspace, "control");
  ui.key(1, "Home");
  assert.equal(ui.focused(), ui.buttons[0]);
  ui.key(1, "End");
  assert.equal(ui.focused(), ui.buttons[2]);
});

test("workspace tabs ignore unrelated keys", () => {
  const ui = harness();
  ui.key(1, "Enter");
  assert.equal(ui.focused(), null);
  assert.equal(ui.body.dataset.workspace, "now");
});
