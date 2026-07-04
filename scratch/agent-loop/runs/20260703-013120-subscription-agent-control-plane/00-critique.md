# Critique

## 1. Contradictions

- "One agent per chat history" conflicts with the observed local scale:
  thousands of sessions exist across tools. Launching one live agent per raw
  transcript would waste context, duplicate work, and likely mutate unrelated
  repos without clear approval.
- "Agents can use my subscriptions" must not mean handing raw secrets to every
  agent. The gateway should broker narrow, audited capabilities with scoped
  OAuth grants or short-lived tokens.
- "Create accounts for my agents" is useful for legitimate workspace/test
  provisioning, but unsafe if interpreted as mass signup, policy evasion, or
  account farming.
- "Do not stop" still needs durable checkpoints. Endless background work without
  ledgers, gates, and evidence would recreate the same lost-thread problem.

## 2. Missing Primitives

- Credential/subscription registry: account, provider, plan, billing owner,
  OAuth grant, token state, refresh result, expiry, required scopes, and
  notification policy.
- Agent identity registry: human owner, agent persona/service account, allowed
  tools, allowed subscriptions, workspace boundaries, and revocation state.
- Session/account provisioning workflow: email/domain policy, browser profile,
  OAuth consent, MFA/human gates, ToS policy, receipt, and rollback.
- Chat-history index: source tool, project, session, messages, embeddings or
  lexical index, extracted tasks, status, and evidence links.
- Work-item router: converts extracted requests into tickets/runs, prevents
  duplicates, and attaches new evidence to active work instead of blindly
  restarting.
- Approval and audit layer: human approval for sensitive auth changes,
  provider-account creation, destructive repo work, deploys, and payments.

## 3. Smallest Viable Loop

Build an inspectable research-backed control-plane plan first:

1. Use CH to inventory local chat histories read-only.
2. Research prior art for four tracks: credential/subscription vaulting,
   account/session provisioning, chat-history search, and agent orchestration.
3. Produce a ranked source-backed report and a Chief Moa fit map.
4. Create a Fabro workflow with tickets for the first implementation milestone:
   "CH-backed work intake plus credential-vault design, no secret mutation."
5. Only after user approval, implement a narrow gateway slice that imports CH
   tasks into broker/work artifacts and displays them in the control center.
