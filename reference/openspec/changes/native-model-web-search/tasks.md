# Native Model Web Search Tasks

## Gateway

- [x] Add the native Google Search tool to ordinary Vertex reasoning requests,
      including streaming tool loops, without adding it to forced context
      preflight.
- [x] Add the built-in search-use, evidence, and citation instruction.
- [x] Add the bounded, optional Exa fallback for provider paths without native
      search.
- [x] Report non-secret search availability in `/health`.
- [x] Add deterministic coverage for native tool presence and Exa request/result
      bounds.

## Follow-up

- [ ] Move OpenAI-compatible reasoning to a provider protocol that exposes its
      native web-search tool, then prefer that over Exa for supporting models.
- [ ] Carry initiating page/app observation plus reason-coded capability
      availability into broker launcher context packs; do not infer this from
      search results or page text.

## Verification And Promotion

- [ ] Run `cd gateway && npm run check && npm run smoke:cascaded-reasoner`.
- [ ] Commit the coherent gateway/docs unit with a Conventional Commit.
- [ ] Create an isolated preview and promote only after rollback,
      no-interruption, state compatibility, and backup/restore gates pass.
