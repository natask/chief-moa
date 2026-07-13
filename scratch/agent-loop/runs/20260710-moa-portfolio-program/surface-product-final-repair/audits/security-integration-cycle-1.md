# Security and integration audit — cycle 1

Verdict: **BLOCK; repair required.**

Measured gates were green (Swift 9 groups at audit time, browser verify and real
headless smoke), but the auditor reproduced browser acceptance of executable
additive fields, unsafe URL schemes, malformed provenance/time/IDs and nested
post-validation mutation. It also found the adapter was not connected to a
runtime consumer. Apple atomic replacement was not an exclusive effect claim
across journal instances. Several SwiftUI safety states were unreachable, the
Windows README contradicted the scaffold, Windows execution was unproven, and
CI actions were not digest-pinned.

```text
Apple closed enums and covered safe numbers -> verified
Evidence -> Swift source/tests
Auditor verdict -> PASS narrowly

Apple exclusive crash-safe effect claim -> refuted
Evidence -> per-instance lock and read/check/write sequence
Auditor verdict -> BLOCK

Browser standalone happy path -> verified
Evidence -> focused adapter test
Auditor verdict -> PASS narrowly

Browser hostile validation and runtime integration -> refuted
Evidence -> executed hostile inputs; no runtime import
Auditor verdict -> BLOCK

Windows scaffold source -> verified
Evidence -> csproj/XAML/C#
Auditor verdict -> PASS narrowly; Windows build unproven
```

