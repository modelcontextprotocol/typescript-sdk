### Server registration API

The deprecated variadic `.tool()`, `.prompt()`, `.resource()` are removed. Use
`registerTool` / `registerPrompt` / `registerResource` with an explicit config object.
The codemod converts the call shape and wraps `inputSchema` / `outputSchema` /
`argsSchema` / `uriSchema` raw shapes.

```typescript
// v1 — raw shape, variadic
server.tool('greet', 'Greet a user', { name: z.string() }, async ({ name }) => {
    return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
});

// v2 — config object, Standard Schema
server.registerTool('greet', { description: 'Greet a user', inputSchema: z.object({ name: z.string() }) }, async ({ name }) => {
    return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
});
```

`registerResource` requires a `metadata` argument — pass `{}` if you have none.

A tool or prompt registered **without** an `inputSchema` / `argsSchema` passes the
context as its callback's single argument — v1 passed `(extra)`, v2 passes `(ctx)`:

```typescript
server.registerTool('ping', { description: 'Liveness check' }, async ctx => ({ content: [] }));
```

A one-parameter callback typechecks under either reading, so remember that the first
parameter here is the context object, not an args object.

#### Standard Schema objects (raw shapes deprecated)

v2 expects schema objects implementing the [Standard Schema spec](https://standardschema.dev/)
for `inputSchema`, `outputSchema`, and `argsSchema`. Raw `{ field: z.string() }` shapes
are still **accepted via `@deprecated` overloads** on `registerTool`/`registerPrompt`
(auto-wrapped with `z.object()`), and `completable()` accepts any `StandardSchemaV1`;
prefer wrapping explicitly. Zod v4, ArkType, and Valibot all implement the spec.

For **optional completable arguments**, apply `.optional()` to the _result_ of
`completable()` — `completable(z.string(), cb).optional()`, not
`completable(z.string().optional(), cb)`. v2 resolves completion metadata on the schema
found after unwrapping an outer optional wrapper, so the v1 nesting returns empty
completion lists — nothing errors — and if no argument carries completion metadata in
the v2 position, the server does not advertise the `completions` capability at all. The
codemod inverts the common nesting automatically and flags shapes it cannot rewrite.

**Zod v3 is no longer supported** (v1 peer was `^3.25 || ^4.0`). Check the **declared
range** in your `package.json`, not just the installed version: a zod-3 range that
satisfied the v1 peer installs and typechecks cleanly under v2 and only fails at
runtime — and quietly: registration does not convert the schema, the server starts
and connects normally, and the first `tools/list` (so `client.listTools()`) answers
with an error pointing at `fromJsonSchema()` while the process keeps running. (Only the
deprecated unwrapped raw-shape form with zod-3 field values throws at registration,
with a message pointing at `zod/v4`.) Zod **≥4.2.0** self-converts via
`~standard.jsonSchema` — the supported path. Zod **4.0–4.1** lacks it, so the SDK falls
back to its bundled Zod's `z.toJSONSchema()` with a one-time `[mcp-sdk]` console
warning; and because `.describe()` field descriptions live in the _authoring_ Zod's
registry, the fallback **drops them** from the generated JSON Schema. Fix ladder:
(1) upgrade to `zod ^4.2.0`; (2) if you must pin an older or separate Zod, attach a
`~standard.jsonSchema` provider backed by _your_ Zod's `toJSONSchema` so conversion
(and descriptions) run through your instance; (3) author the schema as raw JSON Schema
via `fromJsonSchema()`. (Raw shapes are wrapped with the SDK's **bundled** Zod — built
with a foreign Zod they fail at registration or at the first `tools/list`; pass
`z.object()`-wrapped schemas from your own Zod instead.)

In a monorepo that pins zod@3 workspace-wide and cannot bump, step (1) can be applied
**per workspace member**: add a zod-4 alias dependency to the migrating member only —
`"zod-v4": "npm:zod@^4.2.0"` in that member's `package.json` — and author SDK-bound
schemas with it (`import { z } from 'zod-v4'`), leaving the rest of the workspace, and
the member's own zod-3 consumer schemas, untouched. The alias copy does not need to be
the same instance as the SDK's bundled zod: conversion runs through the **authoring**
instance's `~standard.jsonSchema`, so `.describe()` descriptions are preserved and the
emitted dialect is 2020-12. Keep the two z's apart — schemas authored with the alias
are for the SDK; they do not compose with the workspace's zod-3 schemas. (For the
bundle-side effects of the same pin, see
[Bundlers: nested `zod` copies](packaging-runtime.md#bundlers-nested-zod-copies-in-zod3-pinned-monorepos).)

**Hosts that forward consumer-authored schemas.** The ladder assumes you author the
schemas yourself. A host API that accepts raw shapes or schemas written by **its own
consumers** — plugin systems, agent frameworks — cannot control the authoring zod
version or instance, and v1's built-in conversion of foreign shapes is gone. Convert on
the host side and register the result with `fromJsonSchema()`: zod-4 input via zod's
own `z.toJSONSchema(z.object(shape), { io: 'input', target: 'draft-2020-12' })` (the
conversion is runtime-structural, so a zod ≥4.2 in the host handles schemas built by a
different zod-4 copy), zod-3 input via the
[`zod-to-json-schema`](https://www.npmjs.com/package/zod-to-json-schema) package. Its
default draft-07 `$schema` stamp is fine as-is — the default validator
[honors declared draft-07/06 dialects](types-schemas.md#json-schema-2020-12-posture-sep-1613-sep-2106).

How a too-old zod surfaces depends on which entry point your code imports. With
main-entry `import { z } from 'zod'` on a zod-3 range, the project **typechecks cleanly
and fails at the first `tools/list`** (the quiet runtime path above). With
`import * as z from 'zod/v4'` — or any zod whose _typings_ predate
`~standard.jsonSchema` (zod 4.0–4.1, and zod 3.25.x via the `zod/v4` subpath) — the
same code **runs** through the bundled fallback but **fails to compile**:
`registerTool`/`registerPrompt` reject the schema with `TS2769: No overload matches
this call` listing both overloads. The real cause is buried in the first overload's
elaboration — `Property 'jsonSchema' is missing in type …` (that property is
`~standard.jsonSchema`, added in zod 4.2.0) — and a follow-on implicit-`any` error on
the handler's arguments usually appears below it. If you see that two-overload error on
a registration call with a zod schema, check the installed zod version before anything
else; both symptoms resolve identically with step (1) of the ladder.

Projects that must stay below zod 4.2 and accept the documented runtime fallback can
resolve the remaining registration compile errors with an explicit assertion to the
registration schema type — `inputSchema: schema as unknown as
StandardSchemaWithJSON<Input, Output>` — or a small typed wrapper that attaches a
`~standard.jsonSchema` provider (step (2) of the ladder, which changes runtime
conversion but not the schema's static type) and returns the asserted type. The
fallback caveats (one-time warning, dropped `.describe()` descriptions) still apply
unless the provider is attached.

The forced zod-4 bump also surfaces zod's **own** type-level API changes in consumer
annotations: `z.ZodTypeDef` no longer exists and `z.ZodType`'s generic parameters
changed, so v3-era annotations like `z.ZodType<Output, z.ZodTypeDef, Input>` fail to
compile — see [zod's v3-to-v4 changelog](https://zod.dev/v4/changelog). Consumer-only
schemas can keep compiling via zod's v3 compat subpath (`zod/v3`), but anything passed
to the SDK must be a zod-4 (or other Standard Schema) schema.

The deprecated raw-shape overloads exist only on `registerTool` / `registerPrompt`.
`RegisteredTool.update()` / `RegisteredPrompt.update()` take **schema objects**
(`paramsSchema` / `outputSchema`: `StandardSchemaWithJSON`) — a raw shape passed to
`update()` is not auto-wrapped; wrap it with `z.object()` yourself.

```typescript
import * as z from 'zod/v4';
server.registerTool('greet', { inputSchema: z.object({ name: z.string() }) }, handler);

// ArkType works too
import { type } from 'arktype';
server.registerTool('greet', { inputSchema: type({ name: 'string' }) }, handler);

// Raw JSON Schema via fromJsonSchema (validator defaults to runtime-appropriate choice)
import { fromJsonSchema } from '@modelcontextprotocol/server';
server.registerTool('greet', { inputSchema: fromJsonSchema({ type: 'object', properties: { name: { type: 'string' } } }) }, handler);

// No-parameter tools: z.object({})
```

Removed Zod-specific helpers (the codemod marks each call site `@mcp-codemod-error`):
`schemaToJson` — use `fromJsonSchema()` from `@modelcontextprotocol/server` for raw JSON
Schema, or your schema library's native JSON-Schema conversion; `parseSchemaAsync` — use
your schema library's validation directly (e.g. Zod's `.safeParseAsync()`);
`getSchemaShape` / `getSchemaDescription` / `isOptionalSchema` / `unwrapOptionalSchema`
have no replacement (internal Zod introspection). `SchemaInput<T>` →
`StandardSchemaWithJSON.InferInput<T>` is rewritten mechanically by the codemod. The
internal `standardSchemaToJsonSchema` / `validateStandardSchema` helpers are **not** part
of the public surface — do not import them.

v1's second compat module, `server/zod-json-schema-compat.js` (`toJsonSchemaCompat`), is
also removed — and the codemod does **not** rewrite its import (expect `TS2307`). If you
build `Tool` / `Prompt` advertisements yourself, use your schema library's native
conversion: zod 4's `z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12' })`
produces the dialect v2 advertises.
