## Why

The frozen Aggie protocol needs an Apple consumer before a macOS or iOS product
shell can be chosen safely. A shared local-authority library proves the trust
boundary without inventing permanent UX, credentials, signing, or distribution.

## What Changes

- Add a Swift package for macOS and iOS that validates bounded N/N-1 proposals.
- Add injected approval, local-state, and executor seams with actor isolation.
- Form bound local receipts only after explicit approval and final state checks.
- Keep transport, persistence, OS effects, UI, signing, and devices out of scope.
