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

module.exports = { startVoiceSessionHeartbeat, sweepVoiceSessionHeartbeats };
