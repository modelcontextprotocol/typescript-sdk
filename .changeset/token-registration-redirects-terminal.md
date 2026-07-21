---
'@modelcontextprotocol/client': patch
---

Token and client registration requests no longer follow HTTP redirects — including the cross-app access token exchanges. Token responses are terminal (RFC 6749 §5), so a 3xx answer from a token or registration endpoint now rejects with an error instead of being re-sent to the redirect target.
