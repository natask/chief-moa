"use strict";

const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { WebSocket } = require("ws");
const { startVoiceSessionHeartbeat, sweepVoiceSessionHeartbeats } = require("../lib/voice-session-heartbeat");

function socket(overrides = {}) {
  return Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    pings: 0,
    terminated: 0,
    ping() { this.pings += 1; },
    terminate() { this.terminated += 1; },
  }, overrides);
}

test("heartbeat terminates stale and non-open voice sockets", () => {
  const healthy = socket({ moaHeartbeatAlive: true });
  const stale = socket({ moaHeartbeatAlive: false });
  const closed = socket({ readyState: WebSocket.CLOSED });
  const broken = socket({ ping() { throw new Error("broken"); } });
  sweepVoiceSessionHeartbeats([{ ws: healthy }, { ws: stale }, { ws: closed }, { ws: broken }, {}]);
  assert.equal(healthy.pings, 1);
  assert.equal(healthy.moaHeartbeatAlive, false);
  assert.equal(stale.terminated, 1);
  assert.equal(closed.terminated, 1);
  assert.equal(broken.terminated, 1);
});

test("tracked pong keeps a voice socket alive and close releases the timer", () => {
  const tracked = socket();
  const heartbeat = startVoiceSessionHeartbeat({ connections: [], intervalMs: 1000 });
  heartbeat.track(tracked);
  tracked.moaHeartbeatAlive = false;
  tracked.emit("pong");
  assert.equal(tracked.moaHeartbeatAlive, true);
  heartbeat.close();
});
