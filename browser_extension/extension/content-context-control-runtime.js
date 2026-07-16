(function installContentContextControlRuntime(global) {
  "use strict";

  const root = global || globalThis;

  function createContentContextControlRuntime(options = {}) {
    const onModeCue = typeof options.onModeCue === "function" ? options.onModeCue : () => {};
    let incognitoMode = false;
    let newThreadArmed = false;
    let newThreadLabel = "";

    function armNewThread(label = "") {
      newThreadArmed = true;
      newThreadLabel = String(label || "").trim().slice(0, 120);
    }

    function maybeHandleContextSlashCommand(instruction) {
      const raw = String(instruction || "").trim();
      if (!raw.startsWith("/")) return false;
      const match = raw.match(/^\/(\w+)\s*(.*)$/);
      if (!match) return false;
      const command = match[1].toLowerCase();
      const rest = String(match[2] || "").trim();
      if (command === "incognito") {
        const arg = rest.toLowerCase();
        if (arg === "on") incognitoMode = true;
        else if (arg === "off") incognitoMode = false;
        else incognitoMode = !incognitoMode;
        onModeCue(
          "/incognito",
          incognitoMode
            ? "Incognito on. Turns are answered but not saved."
            : "Incognito off. Turns are saved again.",
        );
        return true;
      }
      if (command === "new") {
        armNewThread(rest);
        onModeCue(
          raw,
          newThreadLabel
            ? `New thread armed ("${newThreadLabel}"). The next turn starts fresh.`
            : "New thread armed. The next turn starts fresh.",
        );
        return true;
      }
      return false;
    }

    function consumeContextControls() {
      if (incognitoMode) return { action: "incognito", label: "" };
      if (newThreadArmed) {
        const label = newThreadLabel;
        newThreadArmed = false;
        newThreadLabel = "";
        return { action: "new", label };
      }
      return { action: "", label: "" };
    }

    return Object.freeze({ armNewThread, consumeContextControls, maybeHandleContextSlashCommand });
  }

  root.AgeeContentContextControlRuntime = Object.freeze({ createContentContextControlRuntime });
})(typeof globalThis !== "undefined" ? globalThis : this);
