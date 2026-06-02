# E2E test suite

Conformance-style tests for the SDK's public surface. `requirements.ts` is the manifest: every behavior the SDK must satisfy, linked to the test cases that prove it. `matrix.test.ts` runs each over `ALL_TRANSPORTS`.

## Writing a test

A test is an exported async function in `scenarios/<area>.ts`:

```ts
export async function toolsCallContentText(transport: Transport) {
    const makeServer = () => {
        const s = new McpServer({ name: 't', version: '0' });
        s.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({ content: [{ type: 'text', text }] }));
        return s;
    };
    const client = new Client({ name: 'c', version: '0' });

    await using _ = await wire(transport, makeServer, client);

    const r = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(r.content).toEqual([{ type: 'text', text: 'hi' }]);
}
```

Self-contained: build server inline (factory), build client inline, `wire()`, assert. No shared fixture files.

Then link it in `requirements.ts`:

```ts
'tools:call:content:text': {
    source: 'https://modelcontextprotocol.io/...',
    behavior: 'tools/call returns content[] with type:text...',
    tests: [tools.toolsCallContentText]
},
```

## knownFailures and transport restrictions

When a test asserts spec-correct behavior the SDK doesn't yet implement:

```ts
knownFailures: [{ test: tools.toolsCallUnknownName, note: 'McpServer wraps as isError; spec says JSON-RPC error' }];
```

`matrix.test.ts` runs it as `test.fails()` — passes when it fails as expected, fails when the SDK is fixed (then remove the entry).

When a transport structurally cannot express the behavior (e.g., server→client roundtrip on stateless hosting), restrict the requirement itself rather than skipping tests:

```ts
transports: STATEFUL_TRANSPORTS, // or an explicit list
note: 'stateless hosting has no server→client back-channel'
```

## Running

```bash
npx vitest run test/e2e                       # all
npx vitest run test/e2e/tools.test.ts         # one area
npx vitest run test/e2e -t 'tools:'           # one requirement-id prefix
npx vitest run test/e2e/coverage.test.ts      # gate: every req id is cited by a verifies() test
```

Slugs prefixed `typescript:` are TypeScript-SDK-specific requirements (they describe this SDK's own API surface and intentionally have no shared cross-SDK meaning); unprefixed slugs share their id and behavior wording with the Python interaction suite where both cover the
behavior.
