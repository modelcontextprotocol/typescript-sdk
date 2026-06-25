---
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

Add the v2 `IdJagTokenExchangeResponse` type to the public API and register its schema as an MCP spec type. `IdJagTokenExchangeResponse` is now exported from `@modelcontextprotocol/client` and `@modelcontextprotocol/server`, `'IdJagTokenExchangeResponse'` joins the `SpecTypeName` union, and `isSpecType.IdJagTokenExchangeResponse(value)` / `specTypeSchemas.IdJagTokenExchangeResponse` validate it by name — matching how the OAuth/OpenID auth schemas are already exposed. The Zod schema itself, `IdJagTokenExchangeResponseSchema`, is available from `@modelcontextprotocol/core`.
