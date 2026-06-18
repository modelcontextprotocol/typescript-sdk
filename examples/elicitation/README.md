# elicitation

Server requests user input. One factory, both protocol eras: elicitation works on both eras with different APIs — push-style on 2025, `inputRequired` on 2026; the protocol carries it differently but the user experience is the same.

| Mode                               | 2025-era (`--legacy`, push-style)                                                                                                                                                   | 2026-07-28 (multi-round-trip)                                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **form** (`register_user`)         | `await ctx.mcpReq.elicitInput({ mode: 'form', requestedSchema })` — the server pushes an `elicitation/create` request and awaits the answer in-line                                 | `return inputRequired({ inputRequests: { form: inputRequired.elicit(...) } })` — the client collects the form and retries the same handler with the response attached |
| **url** (`link_account`)           | `await ctx.mcpReq.elicitInput({ mode: 'url', url, elicitationId })` + `createElicitationCompletionNotifier(elicitationId)` for the out-of-band `notifications/elicitation/complete` | `return inputRequired({ inputRequests: { auth: inputRequired.elicitUrl(...) } })` — no `elicitationId` / complete notification on this era                            |
| **url, throw** (`confirm_payment`) | `throw new UrlElicitationRequiredError([...])` — the wire `-32042`; the client catches the typed error and reads `.elicitations`                                                    | n/a — a throw on this era fails loudly with a steer to `inputRequired.elicitUrl(...)`                                                                                 |

The form schema includes an `enumNames` field (display labels for the `plan` enum). For the secure `requestState` round-trip pattern see [`../mrtr/`](../mrtr/README.md).

**stdio-only** in the harness: push server→client requests need either a stdio connection or a sessionful HTTP transport (see `../legacy-routing/`); the harness's `--http` arm is the stateless per-request `createMcpHandler`.

```bash
pnpm --filter @mcp-examples/elicitation client               # 2026-07-28 (inputRequired)
pnpm --filter @mcp-examples/elicitation client -- --legacy   # 2025 (push-style)
```
