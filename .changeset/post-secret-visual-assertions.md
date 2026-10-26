---
'e2e': patch
'@e2e-dev/web': patch
'@e2e-dev/mobile': patch
---

Add an assertion-scoped screenshot policy and capture-bound engine attestation for complete redaction of filled secrets. Default taint, secure-field masking, custom executors and non-assertion calls remain restricted. The shipped web and mobile engines do not yet supply full-frame secret-redaction evidence, so the opt-in remains denied on those engines.
