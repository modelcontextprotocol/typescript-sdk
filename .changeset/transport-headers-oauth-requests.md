---
'@modelcontextprotocol/client': patch
---

Transport `requestInit` headers now apply only to MCP requests, not to the OAuth requests issued by the transport's authorization flow (protected-resource metadata, authorization-server metadata, token, and client registration requests) — those may target a different origin than the MCP server, so connection-level headers do not carry over. A new `oauthRequestInit` transport option configures those requests explicitly.
