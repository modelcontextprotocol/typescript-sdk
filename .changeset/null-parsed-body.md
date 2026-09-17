---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/node': patch
---

Treat a `null` `parsedBody` as no pre-parsed body. The documented `transport.handleRequest(req, res, req.body)` mounting passes `null` behind serverless-express on AWS Lambda Function URLs, which leaves `req.body` null. The transport then validated `null` as the JSON-RPC message and answered `400`, so the server could not be reached. `WebStandardStreamableHTTPServerTransport`, `createMcpHandler`, `isLegacyRequest`, `toNodeHandler` and `toWebRequest` now read the request body instead, as they do for `undefined`.
