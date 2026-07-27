---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/server': patch
---

Make zod-to-JSON-Schema conversion wire-truthful for tool schemas. A `z.date()` (or another
unrepresentable type such as `z.bigint()`) in a registered tool's schema no longer throws
during conversion and fails the entire `tools/list` response — dates are advertised as
`{type: 'string', format: 'date-time'}` (the shape `JSON.stringify` actually produces), and
other unrepresentable types degrade to an unconstrained schema. (BigInt values embedded as
defaults or metadata, e.g. `.default(0n)`, still fail conversion — JSON cannot carry them.)
Output schemas no longer advertise constraints the server doesn't enforce on the raw
`structuredContent` it ships: fields that may be legitimately absent (`.default()`,
undefined-accepting types) are dropped from `required` — on objects and enum-keyed records —
and `additionalProperties: false` is dropped for plain `z.object()` (kept for
`z.strictObject()`), so validating clients no longer reject legitimate tool results.
Elicitation is unaffected: `inputRequired.elicit()` keeps throwing on schemas its restricted
form grammar cannot round-trip, including `z.date()`.
