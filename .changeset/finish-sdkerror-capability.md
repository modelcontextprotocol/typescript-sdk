---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/client': patch
---

Convert remaining capability-assertion throws to `SdkError(SdkErrorCode.CapabilityNotSupported, ...)`. Follow-up to #1454 which missed `Client.assertCapability()` and the task capability helpers in `experimental/tasks/helpers.ts`.
