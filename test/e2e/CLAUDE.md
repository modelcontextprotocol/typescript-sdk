# E2E test suite

Conformance-style tests for the SDK's public surface. `requirements.ts` is a pure-data manifest: every behavior the SDK must satisfy, with its spec/source link. Test files in `scenarios/` cite the requirement id(s) they prove via `verifies()` (`helpers/verifies.ts`), which
registers one cell per applicable (transport, spec version). `coverage.test.ts` statically checks that every non-deferred requirement is cited and that the manifest is internally consistent.

## Writing a test

Add a `verifies()` call with an anonymous async body to `scenarios/<area>.test.ts`:

```ts
verifies('tools:call:content:text', async ({ transport }) => {
    const makeServer = () => {
        const s = new McpServer({ name: 't', version: '0' });
        s.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
            content: [{ type: 'text', text }]
        }));
        return s;
    };
    const client = new Client({ name: 'c', version: '0' });

    await using _ = await wire(transport, makeServer, client);

    const r = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(r.content).toEqual([{ type: 'text', text: 'hi' }]);
});
```

Self-contained: build server inline (factory), build client inline, `wire()`, assert. No shared fixture files. Pass an array of ids when one body genuinely proves several requirements; pass `{ title: '...' }` as the third argument only when a requirement needs more than one body
(the title is how knownFailures target a specific body).

The corresponding manifest entry is pure data:

```ts
'tools:call:content:text': {
    source: 'https://modelcontextprotocol.io/...',
    behavior: 'tools/call returns content[] with type:text...'
},
```

## knownFailures, deferred, and transport restrictions

When a test asserts required behavior the SDK does not satisfy, keep the test exact and record it in the manifest:

```ts
knownFailures: [{ note: 'changed in v2: ...' /* optional: test: '<verifies title>', transport, specVersion */ }];
```

`verifies()` runs matching cells as `test.fails()` — they pass while the SDK misbehaves and fail once it is fixed (then remove the entry). When the behavior cannot be expressed against the public surface at all (e.g. an API removed in v2), mark the requirement
`deferred: '<reason>'` instead — deferred ids must not be cited by any `verifies()` call.

When a transport structurally cannot express the behavior (e.g. server→client roundtrip on stateless hosting), restrict the requirement itself rather than skipping tests:

```ts
transports: STATEFUL_TRANSPORTS, // or an explicit list
note: 'stateless hosting has no server→client back-channel'
```

`addedInSpecVersion` / `removedInSpecVersion` bound the spec versions a requirement applies to. A behavior changed by a spec release gets a sibling entry: the new entry lists every retired id it replaces in `supersedes` (an array, requires `addedInSpecVersion`), and each retired
entry points back via `supersededBy` (requires `removedInSpecVersion`). A coverage gate enforces that the links resolve and are exactly symmetric.

## Running

From the repo root (the suite is the `@modelcontextprotocol/test-e2e` workspace package):

```bash
pnpm --filter @modelcontextprotocol/test-e2e test                                    # all
pnpm --filter @modelcontextprotocol/test-e2e exec vitest run scenarios/tools.test.ts # one area
pnpm --filter @modelcontextprotocol/test-e2e exec vitest run -t 'tools:'             # one requirement-id prefix
pnpm --filter @modelcontextprotocol/test-e2e exec vitest run coverage.test.ts        # manifest gates
pnpm --filter @modelcontextprotocol/test-e2e typecheck
pnpm --filter @modelcontextprotocol/test-e2e lint
```

Slugs prefixed `typescript:` are TypeScript-SDK-specific requirements (they describe this SDK's own API surface and intentionally have no shared cross-SDK meaning); unprefixed slugs share their id and behavior wording with the Python interaction suite where both cover the
behavior.
