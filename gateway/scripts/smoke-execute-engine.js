#!/usr/bin/env node
"use strict";

// Smoke for the code-mode execute engine (lib/execute-engine.js), which runs
// model-written JavaScript in executor's QuickJS WASM sandbox with our
// capability functions as the only reachable effects.
//
// Asserts:
//   1. A script can read a capability and return a value; args round-trip
//      into the capability untouched; the {ok,data} envelope is applied.
//   2. console.log output comes back in `logs`.
//   3. The sandbox is bare: no process, no require, no fetch.
//   4. A runaway loop is killed by the timeout and reports ok=false.
//   5. A capability error surfaces as a structured failure, not a crash.
//   6. Oversized and empty code are refused before the sandbox spins up.

const assert = require("node:assert");
const path = require("node:path");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const { runExecuteCode, MAX_CODE_CHARS } = require(path.join(GATEWAY_DIR, "lib", "execute-engine"));

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

function capabilities(calls) {
  return {
    profile_get: {
      description: "Read the profile",
      run: () => {
        calls.push(["profile_get"]);
        return { ok: true, profile: { voice: "Kore", assistant_name: "A.G" } };
      },
    },
    profile_patch: {
      description: "Patch the profile",
      run: (args) => {
        calls.push(["profile_patch", args]);
        return { ok: true, applied: args?.profile || {} };
      },
    },
    always_fails: {
      description: "Fails on purpose",
      run: () => {
        throw new Error("capability exploded");
      },
    },
  };
}

async function main() {
  const calls = [];

  // 1. Read-modify-write script: capability results, arg round-trip, envelope.
  const roundTrip = await runExecuteCode({
    code: `
      const p = await tools.moa.profile_get({});
      console.log("current voice", p.data.profile.voice);
      if (p.data.profile.voice !== "Aoede") {
        await tools.moa.profile_patch({ profile: { voice: "Aoede" }, reason: "smoke" });
      }
      return p.data.profile.voice;
    `,
    capabilities: capabilities(calls),
  });
  assert.equal(roundTrip.ok, true, `script must run: ${roundTrip.error || ""}`);
  assert.equal(roundTrip.result?.data ?? roundTrip.result, "Kore", "script return value must survive");
  assert.ok(calls.some((c) => c[0] === "profile_get"), "profile_get capability must be called");
  const patchCall = calls.find((c) => c[0] === "profile_patch");
  assert.ok(patchCall, "profile_patch capability must be called");
  assert.deepEqual(patchCall[1].profile, { voice: "Aoede" }, "args must round-trip into the capability untouched");

  // 2. Logs are captured.
  assert.ok(
    (roundTrip.logs || []).some((line) => String(line).includes("current voice")),
    `console.log output must come back in logs: ${JSON.stringify(roundTrip.logs)}`,
  );

  // 3. The sandbox is bare: no Node globals, and the runtime's fetch stub is
  // disabled (it exists as a function but throws on call).
  const isolation = await runExecuteCode({
    code: `
      let fetchBlocked = false;
      try { fetch("https://example.com"); } catch (e) { fetchBlocked = String(e && e.message).includes("disabled"); }
      return [typeof process, typeof require, String(fetchBlocked)].join(',');
    `,
    capabilities: capabilities([]),
  });
  assert.equal(isolation.ok, true, `isolation probe must run: ${isolation.error || ""}`);
  const probed = String(isolation.result?.data ?? isolation.result);
  assert.equal(probed, "undefined,undefined,true", `sandbox must expose no process/require and a disabled fetch: ${probed}`);

  // 4. Runaway code hits the hard timeout instead of hanging the gateway.
  const runaway = await runExecuteCode({
    code: "while (true) {}",
    capabilities: capabilities([]),
    timeoutMs: 500,
  });
  assert.equal(runaway.ok, false, "runaway loop must be killed");
  assert.ok(runaway.error, "timeout must surface an error message");

  // 5. A throwing capability surfaces as a structured failure.
  const failing = await runExecuteCode({
    code: "return await tools.moa.always_fails({});",
    capabilities: capabilities([]),
  });
  const failedCleanly = failing.ok === false
    || (failing.ok === true && failing.result && failing.result.ok === false);
  assert.ok(failedCleanly, `capability error must surface, not crash: ${JSON.stringify(failing)}`);

  // 6. Guardrails before the sandbox spins up.
  const empty = await runExecuteCode({ code: "", capabilities: capabilities([]) });
  assert.equal(empty.ok, false, "empty code must be refused");
  const oversized = await runExecuteCode({
    code: `return 1; // ${"x".repeat(MAX_CODE_CHARS)}`,
    capabilities: capabilities([]),
  });
  assert.equal(oversized.ok, false, "oversized code must be refused");

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "a script reads capabilities, patches through them, and returns a value",
      "console.log lines come back as logs",
      "the sandbox exposes no process, require, or fetch",
      "a runaway loop is killed by the timeout",
      "a throwing capability surfaces as a structured failure",
      "empty and oversized code are refused before the sandbox runs",
    ],
  }, null, 2));
}
