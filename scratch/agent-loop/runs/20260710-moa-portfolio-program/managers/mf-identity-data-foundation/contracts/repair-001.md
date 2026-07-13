# Repair contract MF-1-R1

Auditor BLOCK items only:

1. Preserve the intended foreign-key rollback test by constructing a store
   trusted as the missing principal, rather than injecting a mismatched record.
2. Exercise identity-override rejection through all seven writer methods.
3. Make tenant event namespaces injective when user ids contain delimiters and
   prove two formerly ambiguous combinations remain distinct.
4. Preserve reserved legacy-owner event identities so a previously completed
   DATA_DIR import remains idempotent across this staged release.

Run focused tests and full gateway check, then return to the fresh auditor.
