---
'@modelcontextprotocol/server': patch
---

`resources/read` finds a static resource by the exact URI it was registered and listed under. A URI that `new URL()` serializes differently, such as `https://example.com` (parsed as `https://example.com/`), an uppercase host, a default port or dot segments, was answered with Resource not found. A static resource registered under the exact requested URI is now read, or reported disabled, ahead of a resource registered under the parsed form or a matching template; when no resource has the exact URI, the parsed-form lookup runs as before.
