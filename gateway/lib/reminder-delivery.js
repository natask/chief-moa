"use strict";

const TOOL = "notification.reminder";

function createReminderDeliveryCoordinator(deps = {}) {
  const {
    reminders, deviceClientsForTool, createToolRequest,
    recordToolRequestProductEvent,
  } = deps;
  if (!reminders?.listDueForDelivery || !reminders?.queueDelivery
      || !reminders?.recordDeliveryReceipt) {
    throw new Error("reminder delivery requires a delivery-aware reminder store");
  }
  if (typeof deviceClientsForTool !== "function" || typeof createToolRequest !== "function") {
    throw new Error("reminder delivery requires the device tool hub");
  }

  async function deliverDue() {
    await reminders.sweepDue();
    const due = await reminders.listDueForDelivery();
    let queued = 0;
    for (const reminder of due) {
      const candidates = deviceClientsForTool({ surfaceType: "android", tool: TOOL });
      if (candidates.length !== 1) continue;
      const target = candidates[0];
      const updated = await reminders.queueDelivery(
        reminder.user_id,
        reminder.id,
        { device_id: target.device_id || target.id, surface_type: "android" },
        async ({ reminder: current, target_device_id: deviceId }) => {
          const request = createToolRequest({
            tool: TOOL,
            idempotency_key: `reminder:${current.id}:${deviceId}`,
            target_device_id: deviceId,
            target_surface_type: "android",
            source: "gateway-reminder",
            source_surface_type: "gateway",
            session_id: current.source?.session_id || "",
            branch_id: current.source?.branch_id || "default",
            instruction: `Display due reminder ${current.id}.`,
            input: {
              schema_version: 1,
              reminder_id: current.id,
              message: current.message,
              due_at: current.due_at,
            },
          });
          if (typeof recordToolRequestProductEvent === "function") {
            await recordToolRequestProductEvent(request, "queued");
          }
          return { tool_request_id: request.id };
        },
      );
      if (updated?.delivery?.status === "queued") queued += 1;
    }
    return { due: due.length, queued };
  }

  async function recordToolReceipt(toolRequest, receipt) {
    if (toolRequest?.tool !== TOOL) return null;
    const reminderId = toolRequest.input?.reminder_id;
    if (!reminderId) return null;
    return reminders.recordDeliveryReceipt({
      reminder_id: reminderId,
      tool_request_id: toolRequest.id,
      device_id: receipt?.device_id || toolRequest.claimed_by || toolRequest.target_device_id,
      ok: receipt?.ok === true,
      summary: receipt?.summary || receipt?.error || "",
    });
  }

  return Object.freeze({ deliverDue, recordToolReceipt });
}

module.exports = { TOOL, createReminderDeliveryCoordinator };
