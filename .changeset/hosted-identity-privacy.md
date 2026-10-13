---
"e2e": patch
---

Withhold optional hosted external test identity when any provider-backed secret is configured, before any trace bytes are written. Leave providers lazy, retain literal/environment-secret redaction and stable identities without providers, and keep external verdict and retry facts unchanged.
