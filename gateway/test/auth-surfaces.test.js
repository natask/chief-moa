const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const publicDir = path.join(__dirname, "..", "public");
const signIn = fs.readFileSync(path.join(publicDir, "sign-in.html"), "utf8");
const device = fs.readFileSync(path.join(publicDir, "device.html"), "utf8");

function ids(html) {
  return new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), match => match[1]));
}

test("sign-in surface preserves the auth contract and safe return path", () => {
  assert.deepEqual(ids(signIn), new Set(["welcome-title", "auth-title", "form", "name", "email", "password", "signup", "status"]));
  assert.match(signIn, /submit\('sign-in\/email', false\)/);
  assert.match(signIn, /submit\('sign-up\/email', true\)/);
  assert.match(signIn, /next\.startsWith\('\/'\) && !next\.startsWith\('\/\/'\)/);
  assert.match(signIn, /credentials:'include'/);
});

test("device surface preserves approval controls and polling contract", () => {
  const required = ["context-title", "card", "heading", "detail", "code", "actions", "approve", "deny", "status"];
  for (const id of required) assert.ok(ids(device).has(id), `missing #${id}`);
  assert.match(device, /\/api\/auth\/device\/['"]? \+ action/);
  assert.match(device, /response\.status === 400/);
  assert.match(device, /await waitForAg\(\)/);
  assert.match(device, /credentials:'include'/);
  assert.match(device, /Step 2 of 3/);
  assert.match(device, /catch\(\(\) => \(\{ok:false/);
});

test("auth surfaces use border-box sizing and mobile containment", () => {
  for (const [name, html] of [["sign-in", signIn], ["device", device]]) {
    assert.match(html, /\* \{ box-sizing: border-box; \}/, `${name} needs predictable field sizing`);
    assert.match(html, /@media \(max-width: 430px\)/, `${name} needs a narrow-screen layout`);
    assert.match(html, /min-width: 320px/, `${name} must establish its minimum supported viewport`);
    assert.match(html, /overflow-x: hidden/, `${name} must contain decorative layers`);
    assert.doesNotMatch(html, /width:min\([^;]+calc\(100% - 40px\)/, `${name} must not mix content width with padding`);
  }
});

test("auth surfaces expose accessible names and live state", () => {
  assert.match(signIn, /<label for="email">/);
  assert.match(signIn, /<label for="password">/);
  assert.match(signIn, /id="status" role="status" aria-live="polite"/);
  assert.match(device, /aria-labelledby="heading"/);
  assert.match(device, /id="status" role="status" aria-live="polite"/);
  assert.match(device, /aria-label="Connection progress"/);
});
