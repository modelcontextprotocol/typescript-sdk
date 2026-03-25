---
'@modelcontextprotocol/core': minor
---

Add `getRequestHandler()` method to `Protocol`, enabling retrieval and wrapping of existing request handlers. This allows composable handler middleware without re-implementing SDK internals — for example, transforming `tools/list` responses by wrapping the default handler.
