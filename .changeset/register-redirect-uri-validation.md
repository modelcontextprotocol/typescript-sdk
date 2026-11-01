---
'@modelcontextprotocol/sdk': patch
---

The client registration handler of `mcpAuthRouter` now rejects a redirect URI that uses plain `http:` on a host other than `localhost`, `127.0.0.1` or `[::1]`, and a redirect URI that includes a fragment, with `400 invalid_client_metadata`. The MCP authorization specification
requires redirect URIs to use HTTPS or a loopback host, and RFC 6749 §3.1.2 forbids a fragment. A client that registered such a URI before keeps its registration, but registering it again now fails; HTTPS URIs, loopback `http:` URIs on any port and private-use schemes such as
`com.example.app:/callback` are accepted as before.
