---
'@modelcontextprotocol/server': minor
---

`allowedOrigins` and `validateOriginHeader` accept lowercase entries of the form `<scheme>://*`, such as `moz-extension://*` or `chrome-extension://*`, which admit every origin of that scheme. This lets a server admit MCP clients that run as a browser extension when the extension ID cannot be listed, as on Firefox, where it differs on every install. `http://*` and `https://*` are not honoured, and the defaults are unchanged.
