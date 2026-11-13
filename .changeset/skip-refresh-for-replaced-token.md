---
'@modelcontextprotocol/client': patch
---

Skip the token refresh after a `401` when the stored access token is no longer the one the server
rejected. Another flow already replaced it, so a second refresh would spend a rotated refresh
token and could end in `invalid_grant`. The transport adapter passes the rejected token as the new
optional `AuthOptions.rejectedAccessToken`; forced reauthorization ignores it.
