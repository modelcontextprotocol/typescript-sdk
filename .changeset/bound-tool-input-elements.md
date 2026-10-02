---
'@modelcontextprotocol/sdk': minor
---

`McpServer` now accepts a `maxToolInputElements` option: the largest combined number of array elements and object members a single `tools/call` `arguments` payload may contain. It is off by default, so behavior is unchanged unless you set it. When it is set and a call exceeds it,
that call is answered with an `isError: true` tool result that names the limit, before the input schema runs, and the server keeps serving. Set it above the largest arguments your tools legitimately accept; `maxRequestBodySize` remains the primary limit on request size.
`Infinity` means no limit; a non-positive or non-numeric value is rejected at construction.
