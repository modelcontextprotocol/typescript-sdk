---
'@modelcontextprotocol/node': patch
---

Add `| undefined` to the optional properties of `NodeIncomingMessageLike` (`method`, `url`, `auth`) and `NodeServerResponseLike` (`destroyed`). With `exactOptionalPropertyTypes: true`, passing Node's own `IncomingMessage` to a `toNodeHandler` handler, as the `node:http` and Fastify recipes do, failed to compile with TS2379 because Node types those properties as `T | undefined`.
