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

## The createMcpHandler entry arms (entryStateless / entryModern)

Two transport arms host the dual-era HTTP entry (`createMcpHandler`) in process via an injected fetch, exactly like the other HTTP arms. They are era-fixed (`TRANSPORT_SPEC_VERSIONS`), so each registers cells on exactly one spec-version axis:

- `entryStateless` — the entry with its stateless legacy fallback (`legacy: 'stateless'`, the entry's default posture, passed explicitly so the arm stays era-pinned); the scenario's plain client is served per request through the fallback. Cells run on the 2025-11-25 axis only.
- `entryModern` — the entry hosted modern-only strict (`legacy: 'reject'`); the arm pins the scenario's client to the 2026-07-28 revision via `setVersionNegotiation()`, and the client attaches the per-request `_meta` envelope to every outgoing request/notification itself. Cells
  run on the 2026-07-28 axis only. The pin is unconditional, so a scenario that needs to assert non-pin negotiation behavior (e.g. `mode: 'auto'` probing) must restrict off `entryModern` or drive a non-entry transport.

Both arms are part of the default transport list, so unrestricted requirements run through the entry automatically. When a requirement cannot run on an entry arm, annotate it with a machine-readable reason instead of bending the test:

```ts
entryExclusions: [{ arm: 'entryModern', reason: 'method-not-in-modern-registry' /* optional note */ }];
```

Omitting `arm` excludes both arms. The reasons (`EntryExclusionReason` in types.ts) are the acceptance checklist for re-admitting cells when the corresponding entry feature lands; a coverage gate rejects annotations that would never have an effect. Requirement families that the
per-request entry structurally cannot serve at all (server→client requests, sessions/resumability, standalone GET streams, subscriptions) are already expressed through their `transports` restrictions and need no annotation.

Arm-specific helpers: `wire()`'s fourth argument also accepts `entry` (createMcpHandler hosting overrides — e.g. a `responseMode` or a different `legacy` posture), the returned `Wired.httpLog` records every HTTP exchange (request body, status, content-type, a readable response
clone) for raw wire assertions, factories may accept the optional per-request context (`EntryServerFactory`), and `modernEnvelopeMeta()` builds the envelope for bodies that POST raw 2026-era requests through `wired.fetch`. Compositions that the entry no longer expresses through
an option (for example an existing sessionful legacy wiring routed via `isLegacyRequest` next to a strict entry) are hosted by the test body itself behind an in-process fetch — see `scenarios/hosting-entry-session.test.ts`.

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
