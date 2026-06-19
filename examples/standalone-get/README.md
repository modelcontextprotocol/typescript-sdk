# standalone-get

Server-initiated `notifications/resources/list_changed` over the **standalone GET** SSE stream (sessionful 2025). The `add_resource` tool registers a new resource on the session's instance, which emits the notification over the GET stream the client opened via
`ClientOptions.listChanged`; the client calls the tool and asserts the notification arrived.

**HTTP-only**, sessionful 2025 by definition.
