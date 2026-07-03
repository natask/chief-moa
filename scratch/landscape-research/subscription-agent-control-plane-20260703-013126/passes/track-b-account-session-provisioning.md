# Pass: Account And Browser Session Provisioning

Agent: `019f271b-71c2-7e40-bb68-089b9a5e22e1`

## Summary

The safe version of "create accounts for agents" is not automated consumer
signup farming. It is identity lifecycle management inside owned, sandbox, or
customer-authorized tenants, paired with OAuth grants, browser-session vaults,
and human-supervised credential use.

## Best Candidates

| Rank | Candidate | Use |
| ---: | --- | --- |
| 1 | SCIM + Okta / Entra / SailPoint | Account/persona lifecycle, deprovisioning, groups, audit |
| 2 | Arcade / Nango / Composio / Pipedream / Nylas | Delegated OAuth connection brokers |
| 3 | Browserbase / Browserless / Airtop | Managed persistent browser sessions and profiles |
| 4 | UiPath / Automation Anywhere / Blue Prism | RPA control-plane patterns: robots, queues, credential vaults |
| 5 | Playwright / Puppeteer / Selenium / CDP | Browser context and storage-state primitives |
| 6 | Mailosaur / MailSlurp / Mailtrap / Ethereal | QA inboxes for owned signup/password-reset flows |
| 7 | Auth0 / FusionAuth / Keycloak / WorkOS | Owned-tenant persona factories |
| 8 | OpenAI Operator / ChatGPT agent / Anthropic Computer Use / browser-use | Human handoff and consequential-action boundaries |

## Safe Boundary

Chief Moa should support:

- creating personas inside systems the user owns or administers
- connecting user accounts through normal OAuth consent
- using browser profiles only with user approval and leases
- testing signup flows with QA inboxes only for owned apps
- recording every action with owner, agent identity, session, target app,
  approval, and receipt

Chief Moa should not support:

- fake consumer account creation
- CAPTCHA bypass
- bot-detection evasion
- disposable email abuse
- misleading OAuth/device-code consent
- using another service against its stated automation policy
