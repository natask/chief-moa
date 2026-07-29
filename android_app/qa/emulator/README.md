# Headless Android emulator QA

Run `bash qa/emulator/run.sh` from `android_app`. The wrapper creates an
ephemeral AVD, installs the exact debug application and test APKs, drives the
real overlay through UI Automator, and writes verified evidence under
`build/qa/emulator`.

The default dependency is the Google APIs Android 35 ARM64 image. Override it
with `MOA_QA_API` and `MOA_QA_ABI`. A missing emulator, command-line tool, build
tool, or system image exits with `BLOCKED missing_dependency=...`; the wrapper
does not install host dependencies.

Firebase runners use the same APK pair and instrumentation runner. After their
artifacts are placed in the same evidence layout, run:

```sh
node qa/emulator/verify-evidence.mjs build/qa/emulator/evidence-manifest.json
```

The debug-only broadcast action is absent from release APKs. Evidence is QA
input only and does not publish, install on a personal phone, or promote.
