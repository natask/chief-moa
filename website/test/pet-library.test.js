import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";

import { createPetLibraryApp } from "../public/pets/library/library.js";

const realRandom = Math.random;

afterEach(() => {
  Math.random = realRandom;
  delete globalThis.window;
});

function markup() {
  return `<!doctype html><html><head></head><body>
    <div id="stage"></div><strong id="heroName"></strong><span id="heroMeta"></span>
    <div id="heroTags"></div><button id="previewBtn"></button><button id="studioBtn"></button>
    <button id="applyBtn"></button><b id="consoleTitle"></b><span id="consoleLine"></span>
    <input id="searchInput"><div id="tagChips"></div><span id="catalogStatus"></span><div id="grid"></div>
  </body></html>`;
}

function jsonResponse(data, { ok = true, status = 200, rejects = false } = {}) {
  return {
    ok,
    status,
    json: rejects ? async () => { throw new Error("invalid json"); } : async () => data,
  };
}

function makeWindow({ url = "https://agee.app/pets/library/", fetch } = {}) {
  const dom = new JSDOM(markup(), { url, virtualConsole: new VirtualConsole() });
  const frames = [];
  dom.window.fetch = fetch || (async () => jsonResponse({ pets: [] }));
  dom.window.requestAnimationFrame = (callback) => {
    frames.push(callback);
    return frames.length;
  };
  dom.window.Element.prototype.scrollIntoView = () => {};
  dom.window.Element.prototype.setPointerCapture = () => {};
  return { window: dom.window, frames };
}

describe("pet library browser module", () => {
  test("normalizes gateway pets, renders filters, and handles successful actions", async () => {
    const calls = [];
    const pets = [
      {
        id: "direct", companion_id: "direct-companion", companion_name: "Direct Pet",
        companion_summary: "Search-ready scout", source: "shared", tags: ["search", "green"],
        pet: { skin: "scout", palette: "green", motion: "peek", scale: "1.25" },
      },
      {
        companion: {
          id: "nested", name: "Nested Pet", summary: "Nested summary", source: "builtin",
          tags: ["writing"], pet: { skin: "scribe", palette: "violet", motion: "trail", scale: 0.8 },
        },
      },
      { companion_id: "defaults", companion_name: "Defaults", tags: [] },
      { id: "id-fallback", companion: {} },
    ];
    const fetch = async (url, init = {}) => {
      calls.push([url, init]);
      if (url === "/api/pets") return jsonResponse({ pets });
      if (url === "/api/pets/preview") return jsonResponse({ sample_text: "Hello from preview" });
      return jsonResponse({ profile: { active_companion_name: "Applied Direct" } });
    };
    const { window, frames } = makeWindow({
      url: "https://agee.app/pets/library/?companion=direct",
      fetch,
    });
    const app = createPetLibraryApp(window);
    await app.ready;

    assert.equal(app.state.pets.length, 4);
    assert.equal(app.state.hero.id, "direct");
    assert.match(app.els.catalogStatus.textContent, /4 pets · gateway/);
    assert.equal(app.els.grid.children.length, 4);
    assert.equal(app.els.heroName.textContent, "Direct Pet");
    assert.equal(app.state.pets[1].pet.motion, "trail");
    assert.deepEqual(app.state.pets[2].pet, {
      skin: "companion", palette: "blue", motion: "walk", scale: 1,
    });
    assert.equal(app.state.pets[3].companion_id, "id-fallback");
    assert.equal(app.state.pets[3].companion_name, "Custom pet");
    assert.equal(app.state.pets[3].companion_summary, "");
    assert.equal(app.state.pets[3].source, "custom");
    assert.deepEqual(app.state.pets[3].tags, []);
    assert.equal(frames.length, 1);

    app.els.searchInput.value = "nested";
    app.els.searchInput.dispatchEvent(new window.Event("input"));
    assert.equal(app.els.grid.children.length, 1);
    app.els.searchInput.value = "missing";
    app.els.searchInput.dispatchEvent(new window.Event("input"));
    assert.equal(app.els.grid.children.length, 0);
    app.els.searchInput.value = "";
    app.els.searchInput.dispatchEvent(new window.Event("input"));

    const searchChip = [...app.els.tagChips.children].find((chip) => chip.textContent === "search");
    searchChip.click();
    assert.equal(app.state.tag, "search");
    assert.equal(app.els.grid.children.length, 1);
    [...app.els.tagChips.children].find((chip) => chip.textContent === "search").click();
    assert.equal(app.state.tag, "");

    app.els.grid.children[1].click();
    assert.equal(app.state.hero.id, "nested");
    app.els.studioBtn.click();
    await app.previewHero();
    assert.equal(app.els.consoleTitle.textContent, "Preview");
    assert.match(app.els.consoleLine.textContent, /Hello from preview/);
    await app.applyHero();
    assert.equal(app.els.consoleTitle.textContent, "Applied");
    assert.match(app.els.consoleLine.textContent, /Applied Direct/);
    assert.equal(JSON.parse(calls.at(-1)[1].body).source, "website-pet-library");
  });

  test("uses the local fallback and exercises creature, drag, and physics behavior", async () => {
    const { window, frames } = makeWindow({
      fetch: async () => jsonResponse({}, { ok: false, status: 503 }),
    });
    const app = createPetLibraryApp(window);
    await app.ready;

    assert.equal(app.state.pets, app.FALLBACK_PETS);
    assert.match(app.els.catalogStatus.textContent, /10 pets · local fallback/);
    assert.equal(app.pickFromUrl(), null);
    window.history.replaceState({}, "", "?companion=unknown");
    assert.equal(app.pickFromUrl(), null);
    window.history.replaceState({}, "", "?companion=shigmi-scout");
    assert.equal(app.pickFromUrl().id, "shigmi-scout");

    window.fetch = async () => jsonResponse({});
    await app.loadPets();
    assert.equal(app.state.pets, app.FALLBACK_PETS);

    const creature = app.createCreature();
    app.styleCreature(creature, {}, 40, "idle");
    assert.equal(creature.style.getPropertyValue("--pet-em"), "40px");
    assert.equal(creature.dataset.skin, "companion");
    app.styleCreature(creature, { skin: "tinker", palette: "amber", motion: "spark", scale: 1.5 }, 40);
    assert.equal(creature.style.getPropertyValue("--pet-em"), "60px");
    assert.equal(creature.dataset.mode, "spark");

    assert.equal(app.motionMode("float"), "float");
    assert.equal(app.motionMode("trail"), "float");
    assert.equal(app.motionMode("tap"), "tap");
    assert.equal(app.motionMode("spark"), "spark");
    assert.equal(app.motionMode("climb"), "climb");
    assert.equal(app.motionMode("peek"), "peek");
    assert.equal(app.motionMode("hover"), "hover");
    assert.equal(app.motionMode("anything"), "walk");

    const stageRect = { left: 10, top: 20, width: 250, height: 300 };
    app.els.stage.getBoundingClientRect = () => stageRect;
    const hero = app.els.stage.querySelector(".interactive");
    app.startDrag({ pointerId: 7, clientX: -100, clientY: 999 });
    assert.equal(app.state.drag, true);
    assert.equal(app.state.x, 8);
    assert.equal(app.state.y, 182);
    app.dragMove({ clientX: 130, clientY: 120 });
    assert.equal(app.state.x, 78);
    app.endDrag();
    assert.equal(app.state.drag, false);
    app.dragMove({ clientX: 1, clientY: 1 });
    app.endDrag();
    assert.equal(hero.classList.contains("dragging"), false);

    app.state.last = 100;
    app.state.nextModeAt = Infinity;
    app.state.mode = "walk";
    app.state.x = -2;
    app.tick(120);
    assert.equal(app.state.x, 8);
    app.state.x = 999;
    app.tick(140);
    assert.equal(app.state.dir, -1);
    app.state.mode = "climb";
    app.state.y = 12;
    app.tick(180);
    assert.equal(app.state.mode, "fall");
    app.state.y = 200;
    app.tick(220);
    assert.equal(app.state.mode, "walk");
    app.state.mode = "float";
    app.tick(260);
    app.state.drag = true;
    app.tick(300);
    app.state.drag = false;
    app.state.last = 0;
    app.state.nextModeAt = 0;
    app.state.hero = null;
    Math.random = () => 0.9;
    app.tick(400);
    assert.equal(app.state.last, 400);
    assert.ok(frames.length >= 6);

    for (const [motion, low, high] of [
      ["climb", "climb", "walk"], ["peek", "climb", "walk"],
      ["float", "float", "walk"], ["trail", "float", "walk"], ["hover", "float", "walk"],
      ["spark", "wave", "spark"], ["tap", "wave", "tap"], ["walk", "idle", "walk"],
    ]) {
      Math.random = () => 0;
      assert.equal(app.randomMode(motion), low);
      Math.random = () => 0.99;
      assert.equal(app.randomMode(motion), high);
    }
  });

  test("reports preview and apply failures without exposing credentials", async () => {
    const failures = [];
    const { window } = makeWindow({
      fetch: async (url) => {
        if (url === "/api/pets") {
          return jsonResponse({ pets: [{ id: "pet", companion_name: "Pet", companion_summary: "Safe fallback" }] });
        }
        failures.push(url);
        if (url.endsWith("preview")) return jsonResponse({}, { ok: false, rejects: true });
        return jsonResponse({ error: "Policy denied" }, { ok: false });
      },
    });
    const app = createPetLibraryApp(window);
    await app.ready;

    await app.previewHero();
    assert.equal(app.els.consoleTitle.textContent, "Preview");
    assert.match(app.els.consoleLine.textContent, /Safe fallback/);
    await app.applyHero();
    assert.equal(app.els.consoleTitle.textContent, "Apply blocked");
    assert.match(app.els.consoleLine.textContent, /Policy denied/);
    assert.deepEqual(failures, ["/api/pets/preview", "/api/pets/apply"]);

    window.fetch = async (url) => url.endsWith("preview")
      ? jsonResponse({})
      : jsonResponse({ profile: {} });
    await app.previewHero();
    assert.match(app.els.consoleLine.textContent, /Pet/);
    await app.applyHero();
    assert.match(app.els.consoleLine.textContent, /Pet/);

    window.fetch = async () => { throw { message: "" }; };
    app.state.hero.companion_summary = "";
    await app.previewHero();
    assert.match(app.els.consoleLine.textContent, /Pet/);
    await app.applyHero();
    assert.match(app.els.consoleLine.textContent, /Gateway unavailable/);
    app.setConsole("Empty", "");
    assert.equal(app.els.consoleLine.textContent, "— ");

    app.state.hero = null;
    app.state.drag = true;
    app.endDrag();
    await app.previewHero();
    await app.applyHero();
    app.selectHero(null);
    app.els.studioBtn.click();
  });

});
