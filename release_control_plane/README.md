# Release Control Plane

This component is the persistent authority boundary above Chief Moa and future
applications. Clients and build/QA runners integrate with it; they do not own
its state or promotion authority.

The current slice is a pure domain module. It performs no network, filesystem,
database, Git, build, publish, reload, or installation action. It proves the
personal-first authority and channel rules before a persistent API/store is
added.

```sh
npm run check
```

See
`reference/openspec/changes/persistent-release-control-plane` for the product
model and staged implementation plan.
