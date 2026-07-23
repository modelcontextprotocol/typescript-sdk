# standalone-get

Server-initiated `notifications/resources/list_changed` over the **standalone GET** SSE stream (sessionful 2025). The `add_resource` tool registers a new resource on the session's instance, which emits the notification over the GET stream the client opened via
`ClientOptions.listChanged`; the client calls the tool and asserts the notification arrived.

The original timer-driven unsolicited push (server emits on its own schedule) was traded for this tool-triggered approach for CI determinism — the `list_changed`-over-standalone-GET behaviour is still demonstrated; "server pushes on its own schedule" is no longer shown.

**HTTP-only**, sessionful 2025 by definition.
