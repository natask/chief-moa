const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

test("device approval page distinguishes approval from completed app connection", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "device.html"), "utf8");
  assert.match(html, /Waiting for the Ag app to receive the session/);
  assert.match(html, /Ag is connected/);
  assert.match(html, /The Ag app received the session/);
  assert.match(html, /await waitForAg\(\)/);
  assert.match(html, /if \(response\.status === 400\)/);
  assert.match(
    html,
    /show\('approved','Approved','Waiting for the Ag app to receive the session…'\);\s*await waitForAg\(\)/,
    "approval must enter the waiting state before connection completion is checked",
  );
});
