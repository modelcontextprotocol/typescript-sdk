---
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

Export the abstract `Protocol` class (was reachable in v1 via deep imports) and add `Protocol<ContextT, SpecT extends ProtocolSpec = McpSpec>` for typed custom-method vocabularies. Subclasses supplying a concrete `ProtocolSpec` get method-name autocomplete and result-type correlation on the typed `setRequestHandler`/`setNotificationHandler` overloads (handler param types come from the `paramsSchema` argument; `ProtocolSpec['params']` is informational).
