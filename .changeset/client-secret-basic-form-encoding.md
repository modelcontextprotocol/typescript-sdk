---
'@modelcontextprotocol/client': patch
---

`client_secret_basic` credentials are now encoded as RFC 6749 §2.3.1 requires: the client identifier and the client secret are each form-urlencoded (Appendix B) before being joined with `:` and base64-encoded into the `Authorization` header. Previously both halves were sent raw, so a secret containing `+` reached a conformant token endpoint as a space, a `%` broke its decoding, a `:` inside the client identifier moved the split, and any character outside Latin-1 made `btoa` throw before the request was sent. Credentials made only of unreserved characters are byte-identical on the wire.
