---
'@modelcontextprotocol/client': patch
---

Skip the token refresh after a `401` when the stored access token is no longer the one the server
rejected. Another flow already replaced it while this one waited, so a second refresh would spend a
rotated refresh token and could end in `invalid_grant`. The transport adapter tracks the rejected
token internally; the public `AuthOptions` are unchanged.
