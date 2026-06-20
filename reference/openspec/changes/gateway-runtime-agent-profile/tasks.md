## 1. Profile Store

- [x] 1.1 Add a profile store under the gateway `data/`: effective profile = persisted profile if present, else the `SYSTEM_PROMPT` env default; fields `system_prompt`, `model`, plus a minimal behavior set.
- [x] 1.2 On boot, load the persisted profile if present; otherwise use the env default with no behavior change.

## 2. Apply Per Request

- [x] 2.1 Change `/v1/chat` and `/v1/voice/turns` to read the effective profile per request instead of the boot-time `SYSTEM_PROMPT` constant.
- [x] 2.2 Confirm no behavior change when no profile is persisted and no override is sent.

## 3. Endpoints

- [x] 3.1 `GET /v1/agent/profile` → effective profile + whether it differs from the env default, token-guarded like other `/v1/agent/*` routes.
- [x] 3.2 `PUT /v1/agent/profile` → patch + persist fields, applied to subsequent turns with no restart.
- [x] 3.3 `POST /v1/agent/profile/reset` → drop overrides, return to env default.
- [x] 3.4 Accept `profile_overrides` on `/v1/chat` and `/v1/voice/turns`; merge for that request only, do not persist.

## 4. Verify

- [x] 4.1 Gateway smoke: `PUT` a new prompt → next `/v1/voice/turns` reflects it → `reset` returns to default, all without restarting the process.
- [x] 4.2 Smoke: a `profile_overrides` request applies for that request only and leaves the persisted profile unchanged.
- [x] 4.3 Smoke: profile endpoints reject requests without a valid bearer token.
