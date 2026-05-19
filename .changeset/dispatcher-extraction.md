---
'@modelcontextprotocol/core': major
---
Extract Dispatcher from Protocol. Protocol composes `protected readonly dispatcher`; setRequestHandler/_onrequest delegate. The protected `_wrapHandler` override hook is replaced by `dispatcher.use(middleware)`.
