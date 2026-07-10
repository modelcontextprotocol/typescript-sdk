---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/server-legacy': patch
---

Build protocol-revision wire schemas lazily on first validation instead of at import. Each revision's schema set is now constructed by a module-level memoized factory, so importing the client or server package no longer pays the construction cost of both frozen wire-schema graphs up front. Method membership in the revision registries stays static, the schemas themselves are unchanged, and registry lookups keep returning reference-identical schema objects.
