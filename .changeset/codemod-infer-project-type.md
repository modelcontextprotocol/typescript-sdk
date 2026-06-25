---
'@modelcontextprotocol/codemod': patch
---

Infer client/server project type from source for v1 projects. A project being migrated still declares the single v1 `@modelcontextprotocol/sdk` dependency, so detecting the project type from `package.json` came back "unknown" and every file importing only shared protocol symbols defaulted to `@modelcontextprotocol/server` with an action-required warning. The codemod now scans the source for quoted `@modelcontextprotocol/sdk/client/…` and `…/server/…` import specifiers to infer the type (both → "both", one → that side, neither → "unknown"), routing shared symbols to the installed package and replacing the spurious warnings with at most an info note for genuinely ambiguous "both" projects.
