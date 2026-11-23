---
'@modelcontextprotocol/server': patch
---

Normalize path percent-encoding via `skillFileKey` when `SkillCatalog` resolves `resources/read` and `resources/directory/read` URIs. Previously the catalog looked up requests by raw `new URL(uri).href`, so equivalent spellings such as `Q%26A.md`, lowercase hex escapes like `Rembours%c3%a9.md`, and unencoded `^` paths produced by `new URL()` on Node 20/22 returned Resource Not Found (`-32602`).
