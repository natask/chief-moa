const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const activeBrandFiles = [
  "README.md",
  "browser_extension/extension/manifest.json",
  "browser_extension/extension/options.html",
  "browser_extension/extension/sidepanel.html",
  "gateway/.env.example",
  "gateway/public/console.html",
  "gateway/public/development.html",
  "gateway/public/credential-panel.html",
  "gateway/public/gateway-ui.html",
  "gateway/lib/ui-spec.js",
];

test("active product entry points use the exact Ag identity", () => {
  const forbidden = /Chief Moa|Aggie|A\.G\.|\bAG\b|\bMoa\b/g;
  for (const relative of activeBrandFiles) {
    const source = fs.readFileSync(path.join(repoRoot, relative), "utf8");
    assert.equal(source.match(forbidden), null, `${relative} contains a retired product name`);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "browser_extension/extension/manifest.json"), "utf8"));
  assert.equal(manifest.name, "Ag");
  assert.match(manifest.description, /personal AI companion/);

  const exampleEnv = fs.readFileSync(path.join(repoRoot, "gateway/.env.example"), "utf8");
  assert.match(exampleEnv, /^SYSTEM_PROMPT=You are Ag, the user's personal AI companion\./m);
});
