---
'@e2e-dev/mobile': patch
'@e2e-dev/limrun': patch
'@e2e-dev/testmu': patch
---

Update agent-device to 0.21.34. Hosted WebDriver fills replace the confirmed focused field instead of appending, and an unsupported active-element lookup refuses before tapping. The pre-tap focus probe no longer reads the previous field's geometry.
