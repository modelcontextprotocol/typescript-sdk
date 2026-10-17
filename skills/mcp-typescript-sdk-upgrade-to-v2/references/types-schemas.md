### Types & schemas

#### Zod `*Schema` constants moved to `@modelcontextprotocol/core`

The Zod schemas (`CallToolResultSchema`, `ListToolsResultSchema`, …) that v1 exported
from `types.js` now live in a separate **`@modelcontextprotocol/core`** package. Neither
`@modelcontextprotocol/client` nor `@modelcontextprotocol/server` re-exports them — both
packages stay Zod-free in their public surface.

The v1→v2 change is just an import-path swap — `.parse()` / `.safeParse()` keep working
unchanged:

```typescript
// v1
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
if (CallToolResultSchema.safeParse(value).success) { ... }

// v2 — same Zod schema, new package
import { CallToolResultSchema } from '@modelcontextprotocol/core';
if (CallToolResultSchema.safeParse(value).success) { ... }
```

`@modelcontextprotocol/core` is the canonical home for the spec's Zod schema constants
(and the OAuth/OpenID metadata schemas). It is runtime-neutral (its only dependency is
`zod`) and arrives transitively as the shared runtime schema graph of `client` /
`server` — add it to your own `dependencies` only when you import the raw schemas
directly.

If you would rather keep your project Zod-free, the **`isSpecType` / `specTypeSchemas`**
alternatives are exported from `@modelcontextprotocol/client` and `…/server`:

```typescript
import { isSpecType, specTypeSchemas } from '@modelcontextprotocol/client';
if (isSpecType.CallToolResult(value)) { ... }
const blocks = mixed.filter(isSpecType.ContentBlock);
const result = specTypeSchemas.CallToolResult['~standard'].validate(value);
```

`isSpecType` and `specTypeSchemas` are keyed by `SpecTypeName` — a literal union of
every named type in the MCP spec — so you get autocomplete and a compile error on typos.
`specTypeSchemas.X` is a `StandardSchemaV1Sync<In, Out>` (`validate()` is synchronous).
`validate()` returns `{ value }` or `{ issues }` and never throws — unlike `.parse()` on
the real schema; code that caught a `ZodError` should inspect `result.issues` (or keep
`.parse()` on the schema imported from `@modelcontextprotocol/core`).
The pre-existing `isCallToolResult(value)` guard still works.

**`specTypeSchemas.X` is `StandardSchemaV1`, not `ZodType`.** Zod-specific composition
— `.extend()`, `.pick()`, `.omit()`, `.merge()`, `.shape`, `.passthrough()`,
`.parseAsync()` — does **not** compile on a `specTypeSchemas` entry; reach for the real
Zod schema from `@modelcontextprotocol/core` when you need to derive a tolerant variant
of a spec schema (e.g.
`ListToolsResultSchema.extend({ tools: ToolSchema.omit({ outputSchema: true }).array() })`).
The Zod-specific `AnySchema` / `SchemaOutput` types from `…/zod-compat.js` are removed —
replace with `StandardSchemaV1` / `StandardSchemaV1.InferOutput<T>` (the codemod's
removal message says the same).

**Composing two core schemas.** Zod composition needs a shared zod: deriving from a
single core schema (as above) and combining core schemas with your own `z` typecheck
when your `zod` resolves to the **same copy** `@modelcontextprotocol/core` uses (a
`zod ^4.2.0` range that dedupes). When it cannot — a zod@3-pinned project nests core's
own zod@4 — v1 idioms that combined two spec schemas with your `z` no longer compile:
core does not export its zod instance, and a foreign zod's `z.union(…)` / `.or(…)`
rejects core's schema types. For accept-either result parsing, skip composition:
request with the `ResultSchema` passthrough (the same one the
[gateway note](protocol-ctx.md#request-ctxmcpreqsend-and-calltool-no-longer-require-a-schema-for-spec-methods)
uses) and discriminate with sequential `safeParse`:

```typescript
// v1 — one composed schema
const result = await client.request(req, z.union([CompatibilityCallToolResultSchema, CreateTaskResultSchema]));

// v2 — passthrough request, then sequential discrimination
import { CompatibilityCallToolResultSchema, CreateTaskResultSchema, ResultSchema } from '@modelcontextprotocol/core';
const raw = await client.request(req, ResultSchema);
const asTask = CreateTaskResultSchema.safeParse(raw);
const result = asTask.success ? asTask.data : CompatibilityCallToolResultSchema.parse(raw);
```

Order the candidates from most to least specific, and `.parse()` the last one so a
result that matches no candidate still fails loudly.

The role-aggregate unions (`ClientRequest`, `ServerResult`, `ServerRequest`,
`ClientResult`, `ClientNotification`, `ServerNotification`) and the typed-method maps
(`RequestMethod`, `RequestTypeMap`, `ResultTypeMap`, `NotificationTypeMap`) no longer
include task vocabulary; the deprecated `Task*` types remain importable on their own.
(One published-alpha qualification, like the `-32002` note in [Errors](errors.md#errors): the
`2.0.0-alpha.3` and earlier typings predate this — the typed maps there still carry the
`tasks/*` entries, and `ResultTypeMap['tools/call']` still unions `CreateTaskResult`, so
a `client.request({ method: 'tools/call', … })` result does not assign to
`Promise<CallToolResult>`. If pinned to those alphas, narrow with the
`isCallToolResult` guard — the recommended discrimination tool anyway, per the next
paragraph; `2.0.0-alpha.4` and later are unaffected.)

**Discriminating result shapes: use guards, not the `in` operator.** The v2
zod-inferred result types are passthrough objects — every union member carries an index
signature — so v1-idiomatic property discrimination such as
`if ('content' in result) { … } else { result.toolResult }` no longer narrows: the `in`
check is satisfiable by every member, and the else branch can collapse to `never`
(surfacing as `TS2339` on the property you then read). Use the exported guards instead:
`isCallToolResult(result)`, or `isSpecType.GetPromptResult(result)` and friends for any
other spec type ([above](#zod-schema-constants-moved-to-modelcontextprotocolcore)). An
adjacent trap when keeping a union for later narrowing: a `const` **annotation** is
control-flow-narrowed straight back to the initializer's type — after
`const r: A | B = await fn()`, `r` has `fn`'s return type, not the union — so when you
need the wider union (e.g. a `CompatibilityCallToolResult` branch), apply an
`as A | B` assertion instead of an annotation.

#### Removed type aliases

| Removed                                                         | Replacement                                                     |
| --------------------------------------------------------------- | --------------------------------------------------------------- |
| `JSONRPCError`                                                  | `JSONRPCErrorResponse`                                          |
| `JSONRPCErrorSchema`                                            | `JSONRPCErrorResponseSchema`                                    |
| `isJSONRPCError`                                                | `isJSONRPCErrorResponse`                                        |
| `isJSONRPCResponse` (deprecated in v1)                          | `isJSONRPCResultResponse` ²                                     |
| `JSONRPCResponseSchema` (result-only in v1)                     | `JSONRPCResultResponseSchema` ²                                 |
| `JSONRPCResponse` (result-only in v1)                           | `JSONRPCResultResponse` ²                                       |
| `ResourceReference` / `ResourceReferenceSchema`                 | `ResourceTemplateReference` / `ResourceTemplateReferenceSchema` |
| `IsomorphicHeaders`                                             | Web Standard `Headers`                                          |
| `RequestHandlerExtra`                                           | `ServerContext` / `ClientContext` / `BaseContext`               |
| `ResourceTemplate` (the spec wire **type** from `sdk/types.js`) | `ResourceTemplateType` ³                                        |

² v2 introduces **new** `isJSONRPCResponse` / `JSONRPCResponse` / `JSONRPCResponseSchema`
with corrected semantics — they match **both** result and error responses (the schema is
`z.union([JSONRPCResultResponseSchema, JSONRPCErrorResponseSchema])`). v1's symbols only
matched results. To preserve v1 behavior, rename to `isJSONRPCResultResponse` /
`JSONRPCResultResponse` / `JSONRPCResultResponseSchema` (the codemod does this).

³ The `ResourceTemplate` URI-template helper **class** (from `sdk/server/mcp.js`) is
**unchanged** — keep `new ResourceTemplate(...)` as-is. Only the like-named spec wire
type from `types.js` was renamed to `ResourceTemplateType` to resolve the v1 collision;
the codemod scopes the rename to imports from `sdk/types.js` only.

All other symbols from `@modelcontextprotocol/sdk/types.js` retain their original
names — import the TypeScript types, error classes, enums, and type guards from
`@modelcontextprotocol/client` or `@modelcontextprotocol/server`, and the Zod
`*Schema` constants from `@modelcontextprotocol/core`.

One type-level narrowing to note: client/server capability `experimental` payloads are
now typed as JSON-compatible objects (nested JSON values) rather than arbitrary
objects. A payload typed `Record<string, unknown>` no longer assigns (`TS2322`) — give
the source a JSON-compatible type or cast at the boundary.

The `Protocol` base class and `mergeCapabilities` moved: import them from the
`@modelcontextprotocol/client` or `@modelcontextprotocol/server` package root instead
of `shared/protocol.js`. Most code should not use `Protocol` directly — `Client` and
`Server` are the supported surfaces, and for observing unmatched inbound requests
prefer `client.fallbackRequestHandler` / `server.fallbackRequestHandler`. The codemod
rewrites `Protocol` and `mergeCapabilities` imports to the package root, like the
module's other symbols. One caveat: the client and server packages each bundle their
own compiled copy of the class, so the two roots' `Protocol` exports are distinct
classes — import it from one package consistently within a process.

#### JSON Schema 2020-12 posture (SEP-1613, SEP-2106)

The default validator dispatches on the schema's declared `$schema`: absent or 2020-12
validates as **JSON Schema 2020-12** — on Node via `Ajv2020` instead of v1's draft-07
`Ajv` (the Cloudflare Workers default was already 2020-12) — a declared 2019-09
`$schema` validates with 2019-09 semantics (`Ajv2019`), and a declared draft-07 or
draft-06 `$schema` validates with draft-07 semantics. Schemas declaring any other
`$schema` are rejected with `Error("…unsupported dialect…")`. Two known draft-07 engine
differences: the Node engine (classic Ajv, same as v1's default) evaluates keywords
adjacent to `$ref`, stricter than draft-07's ignore-siblings rule, while the
browser/Workers engine ignores them per spec; and the browser/Workers engine does not
resolve a `$ref` inside a `dependencies` entry whose key collides with a JSON Schema
keyword (`type`, `default`, `format`, …) — validation throws `Unresolved $ref` when
that dependency triggers (surfaced as the SDK's typed validation error), while the
Node engine handles the same schema correctly.

`CallToolResult.structuredContent` is widened from `{ [k: string]: unknown }` to
`unknown` (SEP-2106 lifts the `type:"object"` root restriction). The presence check is
`!== undefined`, not falsy (`null` / `0` / `false` / `""` are legal values now). External
`$ref` is not dereferenced (unchanged from v1; Ajv throws `MissingRefError` at compile,
surfaced per-tool on `callTool`).

| v1 pattern                                                                                                   | Mechanical fix                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `result.structuredContent.<key>` / `result.structuredContent?.<k>`                                           | narrow first: `const sc = result.structuredContent; if (typeof sc === 'object' && sc !== null && '<k>' in sc) { sc.<k> }`                                                                              |
| `if (!result.structuredContent)`                                                                             | `if (result.structuredContent === undefined)`                                                                                                                                                          |
| draft-07 idioms **without** a declared `$schema` (a declared draft-07/06 `$schema` dispatches automatically) | `new AjvJsonSchemaValidator(new Ajv({ strict: false, validateFormats: true, validateSchema: false, allErrors: true }))` (import `Ajv`, `addFormats`, `AjvJsonSchemaValidator` from `…/validators/ajv`) |
| undeclared draft-07 idioms via `fromJsonSchema(schema)`                                                      | `fromJsonSchema(schema, new AjvJsonSchemaValidator(ajv))` — the `McpServer`/`Client` `jsonSchemaValidator` option does **not** reach `fromJsonSchema`-authored schemas                                 |
| `outputSchema` / `inputSchema` with absolute-URI `$ref`                                                      | inline under `$defs` and reference with `#/$defs/Name`                                                                                                                                                 |

A tool may now register an `outputSchema` whose root is `type:"array"`, `type:"string"`,
etc.; toward 2025-era clients the codec wraps it in a `{result:…}` envelope, and toward
every era a non-object `structuredContent` with no `text` block of its own gets a
`JSON.stringify(...)` `text` block auto-appended. See [support-2026-07-28.md › Per-era wire codecs](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.md#per-era-wire-codecs) for how the codec applies these per era.

**Your advertised tool schemas change shape on the wire.** The same `registerTool`
calls produce `tools/list` entries whose generated `inputSchema` differs from v1:
JSON Schema 2020-12 idioms (zod 4 conversion), different `additionalProperties`
handling (no `additionalProperties: false` by default; passthrough objects emit
`"additionalProperties": {}` instead of `true`), and no `execution.taskSupport` member.
Golden tests, transcript pins, and strict client-side validators of your advertised
tool list need re-baselining — the new shapes are spec-conformant.
