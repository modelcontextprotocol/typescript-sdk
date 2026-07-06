---
'@modelcontextprotocol/server': minor
---

Add a `closeOnRefusedHandshake` option (default `false`) to `WebStandardStreamableHTTPServerTransport` for transports created per handshake attempt — the session-map recipe, where a fresh transport and connected server pair serves one expected `initialize`. When enabled, a first completed request that fails to establish the session — a refused or throwing handshake, a pre-session `GET`/`DELETE`, an unsupported method — schedules the transport's close chain behind its response, so `onclose` fires and the paired server tears down instead of leaking. The close defers while another request is still in flight and re-checks before running, so a refusal settling next to an in-flight `initialize` never tears it down. The default stays off: long-lived sessionful endpoints must answer pre-session refusals (for example the SDK client's version-negotiation probe) without ending the transport, and stateless transports never close on refusals.
