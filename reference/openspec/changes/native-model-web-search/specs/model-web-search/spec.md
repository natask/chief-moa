# Model Web Search

## ADDED Requirements

### Requirement: Model web search is bounded evidence retrieval

The gateway SHALL offer provider-native public web search when supported and a
bounded gateway-owned fallback otherwise, while keeping credentials server-side
and treating all retrieved content as untrusted evidence.

#### Scenario: current public fact needs retrieval

- GIVEN an ordinary reasoning turn requires a changing public fact
- WHEN the selected provider supports native search
- THEN the gateway offers its native search tool
- AND search results grant no browser-session, local-file, or action authority.

