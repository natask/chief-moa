import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { proposalDigest, validateAggieProposal } from "../extension/aggie-protocol-adapter.js";

globalThis.crypto ??= webcrypto;
const surface = { id: "moa-browser", kind: "browser", mode: "text", device_id: "browser-1" };
const base = { type: "action.proposed", message_id: "msg-1", session_id: "sess-1", surface,
  timestamp: "2023-11-14T22:13:20.000Z", payload: { proposal_id: "prop-1", kind: "open_url",
    approval_class: "confirm", expires_at: "2023-11-14T22:14:20.000Z", preconditions: { tab: "tab-1" },
    params: { url: "https://example.com" }, proposed_by: "gateway", session_id: "sess-1" } };

for (const version of [1, 2]) assert.equal(validateAggieProposal({ ...base, version }, surface).version, version);
assert.throws(() => validateAggieProposal({ ...base, version: 3 }, surface));
assert.throws(() => validateAggieProposal({ ...base, version: 2, surface: { ...surface, device_id: "other" } }, surface));
assert.throws(() => validateAggieProposal({ ...base, version: 2, payload: { ...base.payload, kind: "future_effect" } }, surface));
assert.throws(() => validateAggieProposal({ ...base, version: 2, future: { oauth_token: "secret" } }, surface));
assert.throws(() => validateAggieProposal({ ...base, version: 2, future: -0 }, surface));
assert.match(await proposalDigest({ ...base, version: 2 }), /^[a-f0-9]{64}$/);
console.log("aggie browser N/N-1 adapter: pass");
