## 1. Spec And Boundary

- [x] 1.3 Define a canonical provider-neutral signed package manifest.
- [x] 1.4 Add bounded non-archive resources, provenance, license,
      compatibility, moderation and revocation gates.
- [x] 1.5 Add non-mutating preview/apply/revert receipt chaining.

- [x] 1.1 Define companion as a gateway-owned manifest, not a device action or
      privileged extension customization.
- [x] 1.2 Update architecture with the companion primitive and active profile
      metadata.

## 2. Gateway Companion Catalog

- [x] 2.1 Add built-in Shimeji-line companions and file-backed custom companion
      manifests under `DATA_DIR`.
- [x] 2.2 Add token-guarded list/search, draft/create, preview, and apply
      endpoints.
- [x] 2.3 Add active companion fields to the runtime profile.
- [x] 2.4 Route voice profile-control requests to create/apply companions.
- [x] 2.5 Record companion applications in profile history/product events.

## 3. Browser Settings Surface

- [x] 3.1 Show companion catalog entries in the options page.
- [x] 3.2 Let the user search, draft a custom companion from a phrase, preview
      it without mutation, and apply it to the current profile scope.
- [x] 3.3 Keep the visible runtime profile in sync after a companion is applied.

## 4. Verify

- [x] 4.1 Gateway smoke proves draft -> preview -> apply -> `GET
      /v1/agent/profile` reflects active companion metadata.
- [x] 4.2 Voice intent smoke proves "I want you to be ..." routes as
      `profile_control`.
- [x] 4.3 Extension verify proves the settings surface keeps the thin-client
      boundary and has companion controls.
