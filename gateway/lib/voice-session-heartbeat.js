"use strict";

const { WebSocket } = require("ws");

function startVoiceSessionHeartbeat({ connections, intervalMs = 30000 } = {}) {
  const interval = Math.max(1000, Math.min(Number(intervalMs) || 30000, 120000));
  const timer = setInterval(() => sweepVoiceSessionHeartbeats(connections), interval);
  timer.unref?.();
  return {
    track(socket) {
      socket.moaHeartbeatAlive = true;
      socket.on("pong", () => { socket.moaHeartbeatAlive = true; });
    },
    close() { clearInterval(timer); },
  };
}

function sweepVoiceSessionHeartbeats(connections) {
  for (const connection of connections || []) {
    const socket = connection?.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      socket?.terminate?.();
    } else if (socket.moaHeartbeatAlive === false) {
      socket.terminate();
    } else {
      socket.moaHeartbeatAlive = false;
      try { socket.ping(); } catch { socket.terminate(); }
    }
  }
}

function summarizeVoiceActivity(connections) {
  const summary = {
    active_voice_connections: 0, active_turns: 0, active_recording_turns: 0,
    active_committed_turns: 0, active_responding_connections: 0, drain_safe: true, turn_statuses: {},
  };
  const terminal = new Set(["completed", "canceled", "error", "closed", "interrupted", "replaced", "no_speech"]);
  for (const connection of connections || []) {
    summary.active_voice_connections += 1;
    if (connection?.responding) summary.active_responding_connections += 1;
    const turn = connection?.turn;
    if (!turn || terminal.has(turn.status)) continue;
    const status = String(turn.status || "unknown");
    summary.active_turns += 1;
    summary.turn_statuses[status] = (summary.turn_statuses[status] || 0) + 1;
    if (status === "recording") summary.active_recording_turns += 1;
    else summary.active_committed_turns += 1;
  }
  summary.drain_safe = summary.active_voice_connections === 0 && summary.active_turns === 0
    && summary.active_responding_connections === 0;
  return summary;
}

module.exports = { startVoiceSessionHeartbeat, summarizeVoiceActivity, sweepVoiceSessionHeartbeats };
