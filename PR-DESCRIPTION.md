Add v1-style `.parse()` / `.safeParse()` methods to every `specTypeSchemas` entry, so v1 runtime-validation call sites migrate with a one-line rename.

## Motivation and Context

**Backwards-compatibility gap this fixes:** v1 exported the protocol Zod schemas, and runtime validation with `Schema.parse(value)` / `Schema.safeParse(value)` was a documented, widely-used pattern. v2 removed the schema exports, and the current migration path is:

```ts
// v1
const result = CallToolResultSchema.parse(value); // throws ZodError (.issues) on failure
const parsed = OAuthTokensSchema.safeParse(value);
if (parsed.success) use(parsed.data);

// v2 today
const r = specTypeSchemas.CallToolResult['~standard'].validate(value);
if (r.issues !== undefined) throw new Error(/* hand-rolled from r.issues */);
use(r.value);
```

Every call site needs the same mechanical remap (`.success` → `.issues === undefined`, `.data` → `.value`, hand-rolled throw), and the result-shape inversion is easy to get wrong silently (e.g. `if (r.issues)` vs `if (!r.success)` confusion). While migrating a large production MCP host application from v1 to v2, this remap was needed at a dozen call sites (OAuth metadata/token validation, JSON-RPC message validation in custom transports, `_meta` payload checks) and several initially landed inverted or with defensive `await`s because the synchronous-validation guarantee is easy to miss.

With this change, the `specTypeSchemas` entries themselves carry the familiar methods, so migration is a pure rename:

```ts
// v1
const result = CallToolResultSchema.parse(value);
const parsed = OAuthTokensSchema.safeParse(value);

// v2 with this PR
const result = specTypeSchemas.CallToolResult.parse(value);
const parsed = specTypeSchemas.OAuthTokens.safeParse(value);
```

- `.parse(value)` returns the parsed value; on failure throws `SpecTypeValidationError` — an `SdkError` subclass with the new code `SdkErrorCode.InvalidSpecType`, so it composes with generic `instanceof SdkError` handling — whose message summarizes the failures and whose `.issues` carries the structured issues (playing the role `ZodError.issues` did in v1 catch blocks).
- `.safeParse(value)` returns `{ success: true, data } | { success: false, issues }`, so migrated call sites keep their `.success`/`.data` control flow unchanged.

Both are synchronous (the backing schemas validate synchronously — no `await` needed), and each entry remains a Standard Schema: `['~standard'].validate` keeps working and stays the documented underlying mechanism. The entries are SDK-owned frozen wrappers, so the internal validation library's error types never cross the public boundary.

## How Has This Been Tested?

- Unit tests in `packages/core/test/types/specTypeSchema.test.ts`: valid/invalid inputs for both methods, schema-default application (proving the parsed output is returned, not the input), `SpecTypeValidationError` name/message/`.specType`/`.issues`, the error being an `SdkError` with `SdkErrorCode.InvalidSpecType` (caught by generic `instanceof SdkError` handlers), the thrown error being the SDK class (not the internal library's), OAuth-record coverage, agreement between `.parse` and the entry's own `['~standard'].validate`, type-level inference (`expectTypeOf`), discriminant narrowing, sync (non-Promise) results, frozen entries, and compile-time rejection of unknown names.
- Wire-level integration tests in `packages/server/test/server/specTypeSchemaMethodsWire.test.ts`: an `McpServer` with a registered tool is driven over a real `InMemoryTransport` (initialize → tools/list → tools/call), and the raw JSON-RPC `result` payloads taken off the wire are validated with `specTypeSchemas.X.parse`/`.safeParse` — the exact v1 `Schema.parse(response.result)` call-site pattern this replaces — including a negative case validating the same wire payload against a different spec type.
- Full package suites pass locally: core 566, client 367, server 75. Lint, typecheck, and `sync:snippets` clean.
- The equivalent call shape was used throughout a real v1→v2 migration of a large MCP host application (client + server + custom transports), which is where the ergonomics gap was identified.

## Breaking Changes

None — purely additive. The entries' declared type widens from `StandardSchemaV1Sync` to `SpecTypeSchema` (a `StandardSchemaV1Sync` with the two methods); existing `['~standard'].validate` call sites are unaffected.

## Types of changes

- [ ] Bug fix (non-breaking change which fixes an issue)
- [x] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to change)
- [x] Documentation update

## Checklist

- [x] I have read the [MCP Documentation](https://modelcontextprotocol.io)
- [x] My code follows the repository's style guidelines
- [x] New and existing tests pass locally
- [x] I have added appropriate error handling
- [x] I have added or updated documentation as needed

## Additional context

- The API was reshaped from an earlier revision of this branch (string-keyed top-level `parseSpecType(name, value)` helpers) to methods on the schema entries, based on review feedback: property access matches the `specTypeSchemas`/`isSpecType` family and avoids name-string arguments entirely.
- Both migration guides now show the one-line rename as the primary replacement for v1 `parse`/`safeParse` call sites, with `['~standard'].validate` kept documented as the underlying mechanism, and state explicitly that validation is synchronous.
- Follow-up opportunity: the codemod's spec-schema transform can emit `.parse`/`.safeParse` directly once this lands, instead of rewriting call sites to the `['~standard'].validate` remap.
- `SpecTypeValidationError` exposes `.specType` and `.issues` so catch blocks that previously inspected `ZodError.issues` have a structured equivalent. Per review feedback it extends `SdkError` (mirroring `SdkHttpError`) rather than adding a new error root, and carries its extras in `.data` typed as `SpecTypeValidationErrorData`.
