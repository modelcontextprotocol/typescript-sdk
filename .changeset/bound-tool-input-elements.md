---
'@modelcontextprotocol/sdk': minor
---

`McpServer` now accepts a `maxToolInputElements` option that limits the number of elements in tool-call arguments: the largest combined number of array elements and object members a single `tools/call` `arguments` payload may contain. It is off by default, so behavior is
unchanged unless you set it. When it is set and a call exceeds it, that call is answered with an `isError: true` tool result that names the limit, before the input schema runs, and the server keeps serving. Set it above the largest arguments your tools legitimately accept;
`maxRequestBodySize` remains the primary limit on request size. The value must be a number of at least 1, or `Infinity` for no limit; any other value is rejected at construction. The options type is exported as `McpServerOptions`.
