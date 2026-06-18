# standalone-get

Server-initiated `notifications/resources/list_changed` over the **standalone GET** SSE stream (sessionful 2025). The server adds a resource on a timer; the client opens the GET stream via `ClientOptions.listChanged` and asserts a notification arrives.

**HTTP-only**, sessionful 2025 by definition. Excluded from the harness for now (timer-driven, long-running).
