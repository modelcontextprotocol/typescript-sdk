---
'@modelcontextprotocol/sdk': patch
---

Handle `application/x-www-form-urlencoded` OAuth token responses per RFC 6749, fixing compatibility with providers (e.g. GitHub) that return URL-encoded token responses instead of JSON.
