---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/server': patch
---

Make zod-to-JSON-Schema conversion wire-truthful for tool schemas. A `z.date()` (or another
unrepresentable type such as `z.bigint()`) in a registered tool's schema no longer throws
during conversion and fails the entire `tools/list` response — dates are advertised as
`{type: 'string', format: 'date-time'}` (the shape `JSON.stringify` actually produces), and
other unrepresentable types degrade to an unconstrained schema. (BigInt values embedded as
defaults or metadata, e.g. `.default(0n)`, still fail conversion — JSON cannot carry them —
and so do dynamic catch values, `.catch(ctx => …)`; the `.catch()` degrade covers static
fallback values only. And a misregistered non-object ROOT — `z.bigint()` or `z.map()` as
the whole `inputSchema`/`outputSchema` — still fails `tools/list` loudly by design,
preserving the pre-fix error instead of listing a permanently-broken tool.)
Output schemas no longer advertise constraints the server doesn't enforce on the raw
`structuredContent` it ships: fields that may be legitimately absent (`.default()`,
undefined-accepting types) are dropped from `required` — on objects and enum-keyed records —
and `additionalProperties: false` is dropped for plain `z.object()` (kept for
`z.strictObject()`), so validating clients no longer reject legitimate tool results for
these schema shapes. Once any such loosening applies, exactly-one `oneOf` compositions —
including zod's discriminated-union emissions over plain objects, i.e. most of them — are
advertised as `anyOf` (the loosened members may overlap; discriminator consts keep them
distinguishable), and the serialized wire forms of tolerant values are additionally
accepted: tolerant array/tuple elements also allow `null` (what `JSON.stringify` makes of
an undefined element), `z.file()` fields also allow `{}` (a `File` has no JSON form), and
non-finite number literals also allow `null`. (Output schemas containing
`.transform()`/`.pipe()`/`z.coerce` still
advertise the post-transform shape while the server ships the raw pre-transform value — a
pre-existing gap this change does not address. And on zod 4.0–4.2.x, `toJSONSchema` skips
the sanitization hook on a schema reused both bare and via a `.describe()`/`.meta()` clone
in the same conversion; full per-node sanitization requires zod >=4.3.0. And the
`z.date()` advertisement assumes a serializing transport: `InMemoryTransport` passes the
raw `Date` by reference, so a validating client rejects it over that testing transport.
On the input side, a required tool/prompt argument of a type JSON cannot carry makes the
tool listed yet uncallable: `z.date()` is advertised as `string`/`date-time` and other
unrepresentable types (`z.bigint()`, `z.map()`, `z.set()`, `z.symbol()`) as an
unconstrained `{}`, but input validation still runs the raw zod schema, which rejects
every JSON payload — use a JSON-representable type such as `z.iso.date()`/
`z.iso.datetime()`, `z.number()`, `z.record(...)`, or `z.array(...)`, or make the field
optional. The same holds for required OUTPUT fields of such types: bigint results fail
JSON-RPC serialization and Map/Set values serialize as `{}`. And a degraded
object-`.catch()` node keeps `type: 'object'` for the 2025-era wrap proof even though
catch-validation does not enforce it on the raw value.
Hand-authored reference keywords disable the loosening: a `.meta()`/registry-injected
`$ref`/`$dynamicRef` beyond zod's own registry shapes (`#`, `#/$defs/<name>`), ANY ref —
registry-shaped included — consumed under a `not`/`if`/`contains` keyword, any
`$anchor`/`$dynamicAnchor` or `$id`, any `$recursiveRef`/`$recursiveAnchor`, a non-root
`$defs`, or any hand-authored `unevaluatedProperties`/`unevaluatedItems` makes the
conversion ship the strict pre-fix-shaped emission instead — such constructs would observe
the loosening's rewrites as dangling pointers, stale anchors, polarity-inverted negations,
or stripped evaluation annotations, so those schemas keep pre-fix strictness, compilable
and working by construction.) Elicitation is unaffected:
`inputRequired.elicit()` keeps throwing on schemas its restricted form grammar cannot
round-trip, including `z.date()`.
