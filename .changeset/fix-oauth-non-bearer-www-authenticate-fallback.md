---
'@modelcontextprotocol/client': patch
---

Fixed OAuth discovery fall back to well-known URI when WWW-Authenticate carries a non-Bearer scheme (e.g. Negotiate). Previously a non-Bearer challenge could clear the `resource_metadata` URL stored from an earlier Bearer challenge, causing PRM discovery to start from the wrong endpoint. The stored URL is now preserved across non-Bearer 401s and passed through to the authorization handler via context.
