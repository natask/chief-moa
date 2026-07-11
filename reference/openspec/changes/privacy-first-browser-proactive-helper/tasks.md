## 1. Privacy defaults and migration

- [x] 1.1 Stop fresh-install hosted gateway persistence and passive startup calls.
- [x] 1.2 Add a local privacy-schema migration that disables legacy automation,
      clears polling, revokes grants, and scrubs stored owner page identity.
- [x] 1.3 Make background automation versioned, default-off, fail-closed, and
      gate every task/tool/agent poll, alarm, and heartbeat.
- [x] 1.4 Redact all page and active-owner metadata from opted-in heartbeat.

## 2. Local suggestion lifecycle

- [x] 2.1 Add pure structural classification and sensitive-page suppression.
- [x] 2.2 Add an explicit tab/document grant with ten-minute expiry and complete
      navigation, close, dismiss, restart, destination, normal-workflow, and
      sensitivity revocation.
- [x] 2.3 Render the local-observation indicator and one deterministic,
      explicitly non-authoritative page suggestion preview. Require trusted
      activation for every proactive page control.
- [x] 2.4 Add `proactive-confirm.html` as the extension-owned authority. Render
      exact immutable request/retention details there and require a trusted
      final Allow activation.
- [x] 2.5 Bind both confirmation-open and final-Allow checks to the exact top
      frame/document, revalidate sensitivity/destination/body after awaits, and
      atomically consume the grant while retaining only an inert in-flight
      confirmation status before networking.
- [x] 2.6 Send one redirect-blocked text-only request to
      `POST /v1/proactive/turns`; fail closed on returned action/proposal keys or
      response-scan truncation and serialize bounded local refusal receipts.

## 3. Text-only gateway capability

- [ ] 3.1 Add authenticated `POST /v1/proactive/turns` with an exact top-level
      shape, fixed client object, packaged transcript allowlist, bounded body,
      and unknown/page/action field rejection.
- [ ] 3.2 Invoke the configured provider through a direct text-only model call;
      do not enter voice/browser routing, expose tools, start an agent/task or
      workflow, publish broker events, or persist conversations/turns.
- [ ] 3.3 Return only bounded text metadata and an empty action capability. Add
      focused tests for valid requests and every rejected field class.
- [ ] 3.4 Add an isolated-port/isolated-data gateway smoke that proves one valid
      provider-backed or deterministic-fallback reply and proves conversation,
      broker-event, task, workflow, and agent-run stores remain unchanged.

## 4. Verification and release artifact

- [x] 4.1 Add pure tests for signal bounding, hash-route suppression,
      classification, no-card stop, destination validation, immutable digest,
      response-scan limits, and serialized receipts.
- [x] 4.2 Add a real-extension headless privacy smoke proving no passive or
      observe/dismiss network; synthetic page clicks cannot grant/open/send;
      hostile page DOM/CSS cannot authorize; navigation and normal workflows
      revoke; the extension-owned disclosure matches the captured request;
      redirect and stale document/frame checks fail closed; and concurrent
      trusted Allow decisions produce at most one request.
- [x] 4.3 Add a real-worker migration leg proving legacy consent reset, owner
      URL/title scrubbing, credential preservation, alarm removal, zero network,
      and idempotence, plus service-worker network-attempt capture so DNS or
      connection failures cannot hide passive egress.
- [x] 4.4 Run browser focused/static verification and the existing extension,
      agent-loop, ambient, and unified-browser-agent smoke gates.
- [ ] 4.5 Run the focused gateway check and proactive endpoint smoke in its
      isolated preview environment.
- [ ] 4.6 Bump the manifest patch version and create a package artifact without
      reloading the user's active extension.
