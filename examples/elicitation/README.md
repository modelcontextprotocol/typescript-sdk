# elicitation

Server requests user input. One factory, both protocol eras: elicitation works on both eras with different APIs — push-style on 2025, `inputRequired` on 2026; the protocol carries it differently but the user experience is the same.

| Mode                               | 2025-era (`--legacy`, push-style)                                                                                                                                                   | 2026-07-28 (multi-round-trip)                                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **form** (`register_user`)         | `await ctx.mcpReq.elicitInput({ mode: 'form', requestedSchema })` — the server pushes an `elicitation/create` request and awaits the answer in-line                                 | `return inputRequired({ inputRequests: { form: inputRequired.elicit(...) } })` — the client collects the form and retries the same handler with the response attached |
| **url** (`link_account`)           | `await ctx.mcpReq.elicitInput({ mode: 'url', url, elicitationId })` + `createElicitationCompletionNotifier(elicitationId)` for the out-of-band `notifications/elicitation/complete` | `return inputRequired({ inputRequests: { auth: inputRequired.elicitUrl(...) } })` — no `elicitationId` / complete notification on this era                            |
| **url, throw** (`confirm_payment`) | `throw new UrlElicitationRequiredError([...])` — the wire `-32042`; the client catches the typed error and reads `.elicitations`                                                    | n/a — a throw on this era fails loudly with a steer to `inputRequired.elicitUrl(...)`                                                                                 |

`plan_trip` chains **two** form elicitations inside one tool call (destination → dates for that destination): two sequential `ctx.mcpReq.elicitInput` pushes on 2025, two `inputRequired` rounds with `requestState` carry-over on 2026. The `register_user` form schema includes an
`enumNames` field (display labels for the `plan` enum). For the secure `requestState` round-trip pattern see [`../mrtr/`](../mrtr/README.md).

Runs all four transport/era legs: `server.ts` inlines a sessionful `NodeStreamableHTTPServerTransport` arm for 2025 traffic (the same `isLegacyRequest` composition `../legacy-routing/` shows by hand), so push server→client requests reach the client over either transport.

```bash
pnpm --filter @mcp-examples/elicitation client               # 2026-07-28 (inputRequired)
pnpm --filter @mcp-examples/elicitation client -- --legacy   # 2025 (push-style)
```
