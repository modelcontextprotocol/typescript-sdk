# E2E test suite

Conformance-style tests for the SDK's public surface. `requirements.ts` is the manifest: pure data, one entry per behavior the SDK must satisfy. The linkage is inverted — scenario files cite the requirement id(s) they prove via `verifies()` (`helpers/verifies.ts`), and
`coverage.test.ts` statically scans `scenarios/*.test.ts` to gate the linkage both ways: every non-deferred requirement must be cited by at least one `verifies()` call, and every cited id must exist and not be deferred (plus internal consistency: `knownFailures` test titles must
resolve, transport restrictions need a `note`, `supersedes` must point at a real id).

## Writing a test

A test is a `verifies()` call in `scenarios/<area>.test.ts`:

```ts
verifies('tools:call:content:text', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 't', version: '0' });
        s.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({ content: [{ type: 'text', text }] }));
        return s;
    };
    const client = new Client({ name: 'c', version: '0' });

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const r = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(r.content).toEqual([{ type: 'text', text: 'hi' }]);
});
```

Self-contained: build the server inline (a _factory_ — per-session HTTP hosting creates a server per session, stateless per request), build the client inline, `wire()`, assert. No shared fixture files.

The id must already exist in `requirements.ts`; `verifies()` throws at registration on unknown or deferred ids, so a typo can never silently drop coverage. It expands the body into one cell per applicable (transport, spec version) pair — `req.transports ?? ALL_TRANSPORTS` crossed
with the entries of `ALL_SPEC_VERSIONS` inside the requirement's `addedInSpecVersion`/`removedInSpecVersion` window — each registered as `<id> [<transport> <version>] > <title>` with a 15s timeout. The title defaults to `'verifies'`; pass `{ title: '...' }` only when one
requirement is cited by multiple bodies (a `knownFailures` entry with a `test` string applies to exactly that title). An array of ids registers the same body under each.

## knownFailures and transport restrictions

When a test asserts spec-correct behavior the SDK doesn't yet implement:

```ts
knownFailures: [{ test: 'mcpserver', note: 'McpServer wraps as isError; spec says JSON-RPC error' }];
```

Matching cells run as `test.fails()` — they pass while the SDK is broken and go red when it's fixed (then remove the entry). Entries can be narrowed by `test` (title), `transport`, and `specVersion`.

When a transport structurally cannot express the behavior (e.g., server→client roundtrip on stateless hosting), restrict the requirement itself rather than skipping tests:

```ts
transports: STATEFUL_TRANSPORTS, // or an explicit list
note: 'stateless hosting has no server→client back-channel'
```

## Transports and wiring

`wire()` (`helpers/index.ts`) connects the pair over the cell's transport: `inMemory` (linked pair), `stdio` (in-process PassThrough pipes speaking the real newline-framed format — spawn/env/signal tests use the real `StdioClientTransport` instead, see `scenarios/stdio.test.ts`),
`streamableHttp` (per-session hosting), `streamableHttpStateless` (fresh server per request), and `sse` (legacy transport; the only one on a real loopback listener, since its server half needs Node req/res). The HTTP hosting helpers (`hostPerSession`, `hostStateless`,
`hostResumable`) mirror the SDK's documented production patterns; `helpers/express.ts` hosts real Express apps for the middleware scenarios.

Every message crossing the client transport passes through the wire-sniffer (`helpers/wire-sniffer.ts`): JSON-RPC envelope check, then per-direction validation against the SDK's runtime Zod schemas — which `test/spec.types.test.ts` proves equivalent to the spec-synced types, so a
sniffer pass is transitively a spec-conformance check. Tests using vendor-extension methods pass `{ allowCustomMethods: true }` to `wire()`; tests that deliberately put malformed MCP on the wire pass `{ strictValidation: false }`. `tapWire(client)` records raw sent/received
frames for wire-level assertions.

## The spec-version axis

Each cell is labeled with a spec version (`ALL_SPEC_VERSIONS`, `types.ts`), and the label is tied to the wire: when a body hands its `TestArgs` to `wire()`, the helper asserts after connect that the client both _requested_ the cell's version in `initialize` and _negotiated_ it
(accepted it from the result, observed via `setProtocolVersion`). A protocol-version constant bump therefore cannot silently re-point every cell at a new negotiation — cells go red until the axis is consciously extended. Two manifest guards complete the loop:
`LATEST_PROTOCOL_VERSION` must appear on the axis, and every axis version must remain in `SUPPORTED_PROTOCOL_VERSIONS` (so a bump can't silently drop the previous version).

Exemptions, by principle: the assertion applies to cells that negotiate normally through the SDK client via `wire()`. Tests whose _subject_ is the negotiation mechanism (downgrade, fallback, reject) deliberately end at a different version — they pass a bare transport name instead
of `TestArgs` and say so in a comment. Tests that bypass `wire()` (stdio spawn, raw HTTP/hosting requests) pin the version literal on the wire themselves, so the assertion has nothing to add there — and staying green under an additive version bump is the correct verdict for those
cells.

## Running

```bash
npx vitest run test/e2e                              # everything: scenarios, gates, helper self-tests
npx vitest run test/e2e/scenarios/tools.test.ts      # one area
npx vitest run test/e2e -t 'tools:'                  # one requirement-id prefix
npx vitest run test/e2e/coverage.test.ts             # manifest gates only
```

Slugs prefixed `typescript:` are TypeScript-SDK-specific requirements (they describe this SDK's own API surface and intentionally have no shared cross-SDK meaning); unprefixed slugs share their id and behavior wording with the Python interaction suite where both cover the
behavior.
