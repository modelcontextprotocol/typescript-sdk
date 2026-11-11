---
'@modelcontextprotocol/client': patch
---

Report an error thrown by a `listChanged` `onChanged` callback on `Client.onerror`. Previously the throw became an unhandled promise rejection, and with `autoRefresh` the callback was first called a second time with its own error as if the list refresh had failed.
