---
'@modelcontextprotocol/sdk': patch
---

`Client.listTools()` no longer wipes the cached tool output validators and task support metadata when a tool's `outputSchema` fails to compile. The call still rejects, and the metadata from the last successful `listTools()` stays in use.
