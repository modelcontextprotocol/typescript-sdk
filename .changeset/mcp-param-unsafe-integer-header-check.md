---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/server': patch
---

Reject a `tools/call` whose `x-mcp-header`-annotated numeric argument is one the header codec cannot represent. `validateMcpParamHeaders` converts each annotated body value to its header string first, and treated a `undefined` conversion as "the body carries a non-primitive, so params validation owns this fault" — skipping the missing-header, invalid-encoding and value-comparison checks for that declaration entirely. But the codec also returns `undefined` for a number it cannot represent: a non-finite value, or an integer outside ±(2^53−1). Both are reachable over the wire, because `JSON.parse('{"a":9007199254740993,"b":1e400}')` yields `9007199254740992` and `Infinity`.

Nothing downstream owned those values. An unsafe integer is a valid JSON Schema `integer` — Ajv's integer check has no safe-range bound, and `zod`'s `z.number()` accepts it — so a `tools/call` sending one while omitting the required `Mcp-Param-*` header returned `200` and ran the tool handler, instead of the spec's pre-dispatch rejection. A flatly contradictory header (body `9007199254740992`, header `1`) was swallowed the same way.

Such a value now falls through to the ordinary header checks and is refused `400 Bad Request` with JSON-RPC `-32020` (`HeaderMismatch`) before dispatch, under the existing `param-header-missing` / `param-header-mismatch` cells — this is the spec's "client omits the header but the value is in the body → server MUST reject" row, which the codec's `undefined` was accidentally masking, not a new condition.

Two behaviours are deliberately unchanged. An unsafe integer whose header matches numerically (`Mcp-Param-N: 9007199254740992`) is still accepted: header/body parity holds, and the spec's safe-range MUST is client-side and definition-scoped, so policing the value itself here would overreach. A number body against a `type: 'string'` declaration still skips the header check, because that is a genuine body-vs-schema fault `-32602` owns.

This SDK's own client omits the header for exactly these values (`buildMcpParamHeaders`), so a client sending an unsafe integer for an annotated parameter now fails fast: `callTool` treats the `HEADER_MISMATCH` as a stale-schema miss, refetches `tools/list` and retries once, then rethrows.
