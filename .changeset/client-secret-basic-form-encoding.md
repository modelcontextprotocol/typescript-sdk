---
'@modelcontextprotocol/client': patch
---

`client_secret_basic` credentials are now percent-encoded before being joined with `:` and base64-encoded into the `Authorization` header. Each half uses the same RFC 3986 encoding as the Python SDK's `quote(value, safe="")`, so `~` stays as it is, a space becomes `%20`, and `+`, `%`, or `:` are escaped instead of corrupting what a token endpoint recovers. Previously both halves were sent raw, so a secret containing `+` reached a form-decoding endpoint as a space, a `%` broke its decoding, a `:` inside the client identifier moved the split, and any character outside Latin-1 made `btoa` throw before the request was sent. Credentials made only of unreserved characters, including `~`, are byte-identical on the wire.
