---
'e2e': patch
---

Add the optional `agent.act` `onBeforeAction` observer for captures before dispatch, including replay and mutating tools. It exposes only the per-step budget index and model/replay source; consumers can pair a before-image with existing `onAction` metadata. Observer failures stop dispatch without changing default execution, cache verification, model-pixel policy or existing completion callbacks.
