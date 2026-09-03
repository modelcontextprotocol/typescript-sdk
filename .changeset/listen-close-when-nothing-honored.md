---
'@modelcontextprotocol/server': patch
---

Close a `subscriptions/listen` stream that has honored nothing.

`listenRouter.serve()` computed `honoredSubset(filter, capabilities)` and then
opened the stream, acknowledged it, subscribed to the event bus and armed a
keep-alive without consulting the result. A server declaring no `listChanged`
capabilities and no `resources.subscribe` produced an empty set, so
`listenFilterAccepts({}, event)` was false for every event kind and the
subscription could never deliver anything — yet nothing closed it, since
`teardown` ran only on client disconnect or abort.

It now writes the acknowledgement and then takes the same graceful
`teardown(true)` path `closeAll()` uses, so the client still learns exactly what
was honored and still receives the `resultType: "complete"` result. Streams that
honor at least one notification type are unaffected.

This is most visible on request-scoped runtimes, where an invocation held open
for a subscription that can never deliver runs until the platform kills it and
the client immediately reconnects.
