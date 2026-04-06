---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/server': patch
---

Fix unhandled promise rejections on transport close and detect stdin EOF in StdioServerTransport. Pending request promises are now rejected asynchronously via microtask deferral, and the server transport listens for stdin `end` events to trigger a clean shutdown when the client process exits.
