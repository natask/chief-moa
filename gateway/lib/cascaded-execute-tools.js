"use strict";

// Factory for the model-facing execute catalog. Keeping this closure-heavy
// catalog out of server.js makes the gateway entrypoint smaller without moving
// authority: every injected handler remains the server-owned implementation.
function createCascadedExecuteToolRuntime(deps) {
  function surfaceSkillDeps() {
    return {
      createToolRequest: deps.createToolRequest,
      readToolRequest: (id) => (deps.fs.existsSync(deps.toolRequestPath(id)) ? deps.readToolRequest(id) : null),
      launchBrowserAgentTask: ({ instruction, url, call, delegation_envelope }) => {
        const created = deps.launchBrowserAgentTaskInternal({
          instruction,
          url,
          source: (call && call.source) || "browser-agent-loop",
          conversation_id: (call && (call.conversation_id || call.session_id)) || "",
          branch_id: (call && call.branch_id) || "default",
          profile_version: call && call.profile_version,
          ...(delegation_envelope ? { delegation_envelope } : {}),
        });
        return { task_id: created.task.id, agent_run_id: created.run.id, task: created.task };
      },
      cleanError: deps.cleanError,
      browserToolReceiptTimeoutMs: deps.browserToolReceiptTimeoutMs,
      browserToolReceiptPollMs: deps.browserToolReceiptPollMs,
    };
  }

  function cascadedExecuteCapabilities(call) {
    const profileOptions = call?.device_id ? { deviceId: call.device_id } : {};
    return {
      ...deps.surfaceExecuteCapabilities(call, surfaceSkillDeps()),
      profile_get: { description: "Read the effective agent profile: identity, languages, voice, modality, model.", run: () => ({ ok: true, profile: deps.agentProfile.effective(profileOptions) }) },
      profile_options: { description: "Catalog of valid voices, languages, and models.", run: () => ({ ok: true, type: "profile_options", ...deps.gatewayProfileOptionsPayload() }) },
      profile_patch: {
        description: "Persist profile fields durably. Args: { profile, scope?, reason? }.",
        run: (args) => {
          const patch = deps.liveToolProfilePatch(args || {});
          if (Object.keys(patch).length === 0) return { ok: false, error: "no supported profile fields provided", supported_fields: deps.agentProfile.fields() };
          return deps.applyAgentProfilePatch(call, args || {}, patch, "voice-execute");
        },
      },
      profile_revert: { description: "Undo durable settings. Args: { mode?, scope?, reason? }.", run: (args) => deps.liveToolRevertAgentProfile(call, args || {}) },
      set_languages: {
        description: "Set understood and reply languages from the supported catalog. Args: { understand?, understand_primary?, reply?, reply_primary?, lock?, scope?, reason? }.",
        run: (args) => {
          const patch = deps.languageControlPatch(args || {});
          if (Object.keys(patch).length === 0) return { ok: false, error: "no languages provided; set understand and/or reply", supported: deps.supportedLanguagesSentence() };
          return deps.applyAgentProfilePatch(call, args || {}, patch, "voice-execute-languages");
        },
      },
      agents_launch: { description: "Start a background agent run. Args: { prompt, harness? }.", run: (args) => deps.liveToolLaunchAgentRun(call, args || {}) },
      agents_list: { description: "Status and latest output of this session's agent runs. Args: {}.", run: (args) => deps.liveToolListAgentRuns(call, args || {}) },
      agents_cancel: { description: "Cancel a queued or running agent run. Args: { run_id? }.", run: (args) => deps.liveToolCancelAgentRun(call, args || {}) },
    };
  }

  function cascadedExecuteToolDef(call) {
    const capabilities = cascadedExecuteCapabilities(call);
    const catalog = Object.entries(capabilities).map(([name, cap]) => `tools.moa.${name}(args) - ${cap.description}`).join("\n");
    return {
      name: "execute",
      description: ["Run a short JavaScript script in a sandbox to read or change your own configuration in ONE call instead of chaining tools.", "Available functions (all async; each resolves to { ok, data } where data is the payload):", catalog, "Use console.log for debug output and return for the final value. No fs, no network, no other globals."].join("\n"),
      parameters: { type: "object", properties: { code: { type: "string", description: "The JavaScript to run. tools.moa.* and console.log are the only APIs." } }, required: ["code"] },
      handler: async (args) => {
        const { runExecuteCode } = require("./execute-engine");
        return runExecuteCode({ code: String(args?.code || ""), capabilities });
      },
    };
  }

  return { surfaceSkillDeps, cascadedExecuteCapabilities, cascadedExecuteToolDef };
}

module.exports = { createCascadedExecuteToolRuntime };
