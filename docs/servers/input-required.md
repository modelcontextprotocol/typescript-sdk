---
shape: how-to
---
# input_required

An **`input_required`** result is how a `tools/call`, `prompts/get`, or `resources/read` handler asks the connected client for input mid-call: the handler returns the embedded requests, the client answers them and retries the call, and the handler runs again with the responses.

## Return `input_required` instead of pushing a request

The handler reads what already arrived with `acceptedContent`; while the answer is missing it returns `inputRequired(...)` instead of a tool result.

```ts source="../../examples/guides/servers/input-required.examples.ts#registerTool_inputRequired"
server.registerTool(
    'deploy',
    {
        description: 'Deploy after the operator confirms',
        inputSchema: z.object({ env: z.string() })
    },
    async ({ env }, ctx): Promise<CallToolResult | InputRequiredResult> => {
        const confirmed = acceptedContent<{ confirm: boolean }>(ctx.mcpReq.inputResponses, 'confirm');
        if (confirmed?.confirm !== true) {
            return inputRequired({
                inputRequests: {
                    confirm: inputRequired.elicit({
                        message: `Deploy to ${env}?`,
                        requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] }
                    })
                }
            });
        }
        return { content: [{ type: 'text', text: `Deployed to ${env}` }] };
    }
);
```

The first round returns `resultType: 'input_required'` carrying the `confirm` request. The client fulfils it and retries `deploy` with the answer in `inputResponses`; on re-entry `acceptedContent` finds it and the handler finishes.

Every call on this page comes from an in-memory `Client` with an `elicitation/create` handler — [Test a server](../testing.md) shows that wiring. Calling `deploy` once produces both rounds:

```
[client] elicitation/create → Deploy to prod?
{ content: [ { type: 'text', text: 'Deployed to prod' } ] }
```

`inputRequired(spec)` throws a `TypeError` unless `spec` carries at least one of `inputRequests` or `requestState`. Each embedded request is checked against the capabilities the client declared; a missing capability rejects the call with `-32021` before anything reaches the wire.

::: info Coming from v1?
`ctx.mcpReq.elicitInput` and `ctx.mcpReq.requestSampling` are the 2025-era push channels — they throw on a 2026-07-28 request. See [Elicitation](./elicitation.md) and the [upgrade guide](../migration/upgrade-to-v2.md).
:::

## Read the responses on re-entry

`ctx.mcpReq.inputResponses` comes from the client — treat it as untrusted. Pass a Zod schema as `acceptedContent`'s third argument and the value reaches your handler already validated and typed.

```ts source="../../examples/guides/servers/input-required.examples.ts#acceptedContent_schema"
server.registerTool(
    'tag-release',
    {
        description: 'Tag a release after the operator confirms',
        inputSchema: z.object({ tag: z.string() })
    },
    async ({ tag }, ctx): Promise<CallToolResult | InputRequiredResult> => {
        const view = inputResponse(ctx.mcpReq.inputResponses, 'confirm');
        if (view.kind === 'elicit' && view.action !== 'accept') {
            return { content: [{ type: 'text', text: 'Tagging cancelled by the operator' }], isError: true };
        }
        const confirmed = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', z.object({ confirm: z.boolean() }));
        if (confirmed?.confirm !== true) {
            return inputRequired({
                inputRequests: {
                    confirm: inputRequired.elicit({
                        message: `Tag ${tag}?`,
                        requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] }
                    })
                }
            });
        }
        return { content: [{ type: 'text', text: `Tagged ${tag}` }] };
    }
);
```

`acceptedContent` returns `undefined` for a missing, declined, or cancelled answer alike — re-issuing the request is the right move for all three only when the request is idempotent. `inputResponse` returns a discriminated view (`missing` / `elicit` / `sampling` / `roots`) when you need to tell a refusal from a first entry. A client that declines:

```
[client] elicitation/create → Tag v2.1.0?
{
  content: [ { type: 'text', text: 'Tagging cancelled by the operator' } ],
  isError: true
}
```

## Write the handler write-once

Write one handler that runs on every round: read each answer first, then request only the keys still missing. `inputRequests` is a map, so one round carries every outstanding request.

```ts source="../../examples/guides/servers/input-required.examples.ts#registerTool_writeOnce"
server.registerTool(
    'provision',
    { description: 'Provision a database', inputSchema: z.object({}) },
    async (_args, ctx): Promise<CallToolResult | InputRequiredResult> => {
        const name = acceptedContent(ctx.mcpReq.inputResponses, 'name', z.object({ name: z.string() }));
        const region = acceptedContent(ctx.mcpReq.inputResponses, 'region', z.object({ region: z.string() }));
        if (name === undefined || region === undefined) {
            return inputRequired({
                inputRequests: {
                    ...(name === undefined && {
                        name: inputRequired.elicit({
                            message: 'Database name?',
                            requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
                        })
                    }),
                    ...(region === undefined && {
                        region: inputRequired.elicit({
                            message: 'Which region?',
                            requestedSchema: { type: 'object', properties: { region: { type: 'string' } }, required: ['region'] }
                        })
                    })
                }
            });
        }
        return { content: [{ type: 'text', text: `Provisioned ${name.name} in ${region.region}` }] };
    }
);
```

Round one finds neither key, so both requests go out together; round two finds both and the handler returns.

```
[client] elicitation/create → Database name?
[client] elicitation/create → Which region?
{
  content: [ { type: 'text', text: 'Provisioned analytics in eu-west-1' } ]
}
```

`inputResponses` holds only the latest round's answers, and nothing else on the server survives between rounds. A flow whose rounds must run in **sequence** carries what it has learned in `requestState`, below.

## Pick the embedded request kind

Each value in `inputRequests` is one embedded request, named by the builder that constructs it: `inputRequired.elicit` (form), `inputRequired.elicitUrl` (out-of-band URL), `inputRequired.createMessage` (sampling), and `inputRequired.listRoots()`.

```ts source="../../examples/guides/servers/input-required.examples.ts#inputRequired_kinds"
const next = inputRequired({
    inputRequests: {
        confirm: inputRequired.elicit({
            message: 'Continue?',
            requestedSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
        }),
        signin: inputRequired.elicitUrl({ message: 'Sign in to continue', url: 'https://example.com/auth' }),
        summary: inputRequired.createMessage({
            messages: [{ role: 'user', content: { type: 'text', text: 'Summarize the diff' } }],
            maxTokens: 200
        }),
        roots: inputRequired.listRoots()
    }
});
```

`acceptedContent` only reads accepted form elicitations; read the sampling and roots responses through `inputResponse`, which discriminates all four kinds. [Elicitation](./elicitation.md) covers `requestedSchema` and URL mode in full.

::: warning
Sampling and roots are deprecated as of protocol revision 2026-07-28 (SEP-2577) — see [Sampling](./sampling.md). Reach for the elicitation builders first.
:::

## Carry state across rounds with `requestState`

To run rounds in sequence, return an opaque `requestState` string alongside the requests. The client echoes it back byte-for-byte on the retry, and `ctx.mcpReq.requestState<State>()` reads its decoded payload on re-entry. Mint it with the codec from the next section.

```ts source="../../examples/guides/servers/input-required.examples.ts#requestState_mint"
server.registerTool(
    'wipe-cache',
    { description: 'Confirm, then pick a scope, then wipe', inputSchema: z.object({}) },
    async (_args, ctx): Promise<CallToolResult | InputRequiredResult> => {
        const state = ctx.mcpReq.requestState<{ step: string }>();

        if (state?.step !== 'confirmed') {
            const confirmed = acceptedContent<{ confirm: boolean }>(ctx.mcpReq.inputResponses, 'confirm');
            if (confirmed?.confirm !== true) {
                return inputRequired({
                    inputRequests: {
                        confirm: inputRequired.elicit({
                            message: 'Really wipe the cache?',
                            requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] }
                        })
                    }
                });
            }
            // Mint only what the response above already proved: the operator confirmed.
            return inputRequired({
                inputRequests: {
                    scope: inputRequired.elicit({
                        message: 'Which scope?',
                        requestedSchema: { type: 'object', properties: { scope: { type: 'string' } }, required: ['scope'] }
                    })
                },
                requestState: await stateCodec.mint({ step: 'confirmed' })
            });
        }

        const scope = acceptedContent<{ scope: string }>(ctx.mcpReq.inputResponses, 'scope');
        return { content: [{ type: 'text', text: `Wiped ${scope?.scope ?? 'all'}` }] };
    }
);
```

Mint only what earlier rounds already proved. The token is bearer proof of whatever it claims: state minted as `{ step: 'confirmed' }` before the confirmation arrives grants that step to anyone who echoes it. One call drives all three entries:

```
[client] elicitation/create → Really wipe the cache?
[client] elicitation/create → Which scope?
{ content: [ { type: 'text', text: 'Wiped sessions' } ] }
```

## Protect `requestState` with the codec

`requestState` round-trips through the client and comes back as attacker-controlled input; the SDK applies no protection of its own. `createRequestStateCodec` returns an HMAC-SHA256 `{ mint, verify }` pair — pass `verify` as `ServerOptions.requestState.verify` and it runs before every handler entry that carries state.

```ts source="../../examples/guides/servers/input-required.examples.ts#requestState_codec"
const stateCodec = createRequestStateCodec<{ step: string }>({
    key: crypto.getRandomValues(new Uint8Array(32)), // >= 32 bytes; share it across instances in a fleet
    ttlSeconds: 600
});

const server = new McpServer(
    { name: 'releases', version: '1.0.0' },
    { requestState: { verify: stateCodec.verify } }
);
```

With the hook in place, the accessor hands the handler `verify`'s decoded payload, and tampered or expired state never reaches the handler at all. Retrying `wipe-cache` with `requestState: 'tampered'` answers a wire-level protocol error:

```
-32602 Invalid or expired requestState
```

::: warning
The codec is signed, not encrypted — the client can base64url-decode the payload. Keep secrets out of it.
:::

## Let the shim serve older clients

The handlers above already serve every connection. On a connection that predates 2026-07-28, the SDK's legacy shim — on by default — fulfils an `input_required` return by pushing real `elicitation/create`, `sampling/createMessage`, and `roots/list` requests over the session, then re-enters the handler with the collected responses and the byte-exact `requestState` echo. Every result quoted on this page came from such a connection.

Set `ServerOptions.inputRequired.legacyShim: false` to fail loudly instead. Which revision a connection negotiates is covered in [Protocol versions](../protocol-versions.md).

## Recap

- A handler asks for input by returning `inputRequired(...)`; the client answers the embedded requests and retries the call.
- `inputRequired(spec)` needs at least one of `inputRequests` or `requestState`, and throws a `TypeError` without one.
- `acceptedContent(ctx.mcpReq.inputResponses, key, schema)` validates the untrusted client answer before it reaches your code; `inputResponse` discriminates declines and the non-elicitation kinds.
- A write-once handler re-derives its position on every entry and requests only what is still missing.
- `requestState` is the only cross-round memory; protect it with `createRequestStateCodec` and mint only what earlier rounds proved.
- The legacy shim serves the same handlers to pre-2026-07-28 clients.
