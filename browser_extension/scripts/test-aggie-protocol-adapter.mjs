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
for (const key of ["token_value", "authorization_hint", "client_secret_material"]) {
  assert.throws(() => validateAggieProposal({ ...base, version: 2, future: { [key]: "innocuous" } }, surface));
}
assert.throws(() => validateAggieProposal({ ...base, version: 2, future: { shell: "rm -rf /" } }, surface));
assert.throws(() => validateAggieProposal({ ...base, version: 2, future: { "java-script": "alert(1)" } }, surface));
assert.throws(() => validateAggieProposal({ ...base, version: 2, future: { s_h_e_l_l: "rm" } }, surface));
assert.throws(() => validateAggieProposal({ ...base, version: 2, message_id: undefined }, surface));
assert.throws(() => validateAggieProposal({ ...base, version: 2, payload: { ...base.payload, session_id: "other" } }, surface));
assert.throws(() => validateAggieProposal({ ...base, version: 2, timestamp: "garbage" }, surface));
assert.throws(() => validateAggieProposal({ ...base, version: 2, payload: { ...base.payload, params: { url: "javascript:alert(1)" } } }, surface));
assert.throws(() => validateAggieProposal({ ...base, version: 2, future: -0 }, surface));
const validated = validateAggieProposal({ ...base, version: 2 }, surface);
assert.throws(() => { validated.payload.params.url = "https://evil.example"; });
assert.equal(await proposalDigest(validated), "bbe5027f1120193724f2ec08d53765f36fe93adcdb0514f393ce3e67a4c702b9");
console.log("aggie browser N/N-1 adapter: pass");
