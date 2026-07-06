"use strict";

// Code-mode self-configuration (the executor.sh pattern), built on executor's
// published MIT packages instead of a hand-rolled sandbox:
//
//   @executor-js/sdk            - executor + plugin registry (holds our tools)
//   @executor-js/execution      - engine that hands a `tools.*` proxy into code
//   @executor-js/runtime-quickjs - QuickJS WASM sandbox (hard timeout + memory cap)
//
// The model writes JavaScript; the ONLY reachable effects are the capability
// functions the caller registers here. Model output stays a proposal: every
// capability routes through the same sanitizers and receipt paths as the
// classic tool defs, and the sandbox has no fs, no net, no process, no require.
//
// In-sandbox call shape (from @executor-js/execution): a registered capability
// `foo` is called as `await tools.moa.foo(args)` and resolves to an
// `{ ok, data }` envelope where `data` is the capability's return value.

const MAX_CODE_CHARS = 20000;
const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;

// The executor packages are ESM; the gateway is CJS. Load them once through a
// cached dynamic import so require() call sites stay synchronous.
let modulesPromise = null;
function loadExecutorModules() {
  if (!modulesPromise) {
    modulesPromise = Promise.all([
      import("@executor-js/sdk"),
      import("@executor-js/sdk/core"),
      import("@executor-js/execution"),
      import("@executor-js/runtime-quickjs"),
    ]).then(([sdk, sdkCore, execution, quickjs]) => ({ sdk, sdkCore, execution, quickjs }));
  }
  return modulesPromise;
}

// capabilities: { name: { description, run(args) -> value|Promise } }.
// The caller binds per-turn context (session, device, sanitizers) into `run`
// closures, so a fresh executor per invocation is what keeps calls correctly
// scoped - do not cache executors across turns.
async function runExecuteCode(options) {
  const code = String(options?.code || "").trim();
  const capabilities = options?.capabilities || {};
  if (!code) {
    return { ok: false, error: "no code provided" };
  }
  if (code.length > MAX_CODE_CHARS) {
    return { ok: false, error: `code exceeds ${MAX_CODE_CHARS} characters` };
  }
  const names = Object.keys(capabilities);
  if (names.length === 0) {
    return { ok: false, error: "no capabilities registered" };
  }

  const { sdk, sdkCore, execution, quickjs } = await loadExecutorModules();
  const { definePlugin, tool, Effect } = sdkCore;

  const moaPlugin = definePlugin(() => ({
    id: "moa",
    storage: () => ({}),
    extension: () => ({}),
    staticSources: () => [
      {
        id: "moa",
        kind: "custom",
        name: "Moa gateway self-configuration",
        tools: names.map((name) => tool({
          name,
          description: String(capabilities[name].description || name),
          execute: (args) => Effect.promise(() => Promise.resolve(capabilities[name].run(args))),
        })),
      },
    ],
  }));

  const executor = await sdk.createExecutor({
    plugins: [moaPlugin()],
    onElicitation: "accept-all",
  });
  try {
    const engine = execution.createExecutionEngine({
      executor,
      codeExecutor: quickjs.makeQuickJsExecutor({
        timeoutMs: Math.max(250, Number(options?.timeoutMs) || DEFAULT_TIMEOUT_MS),
        memoryLimitBytes: Math.max(1024 * 1024, Number(options?.memoryLimitBytes) || DEFAULT_MEMORY_LIMIT_BYTES),
      }),
    });
    const outcome = await engine.execute(code);
    const logs = Array.isArray(outcome?.logs) ? outcome.logs : [];
    // ExecuteResult reports sandbox failures (timeout, throw, OOM) in an
    // `error` field on a resolved result, not as a rejection.
    if (outcome?.error) {
      return { ok: false, error: String(outcome.error).slice(0, 500), logs };
    }
    return { ok: true, result: outcome?.result, logs };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 500) };
  } finally {
    await executor.close().catch(() => {});
  }
}

module.exports = {
  runExecuteCode,
  MAX_CODE_CHARS,
};
