# scoped-tools — per-tool scope enforced in the tool handler

Demonstrates per-tool OAuth scope enforcement on a `createMcpHandler`
deployment: the HTTP gate does **bearer-verify + 401 only**, and each tool
handler checks `ctx.http?.authInfo?.scopes` for the scope it needs. The scope
decision lives next to the code it guards — the handler is the only place that
authoritatively knows which tool is executing — instead of in middleware that
would have to re-derive the operation from the request body.

`server.ts` runs a minimal demo Authorization Server alongside the MCP Resource
Server. `client.ts` connects with a `files:read` token, calls `list-files`
(works), then calls `write-file` → the handler returns `{ isError: true }` with
`insufficient_scope: requires files:write`.

The transport's automatic `403 insufficient_scope` **step-up** flow (SEP-2350 —
scope union, refresh-bypass, `maxStepUpRetries`) applies when the RS responds
`403` at the HTTP layer; that path is exercised by
`test/e2e/scenarios/client-auth.test.ts`.

```bash
pnpm --filter @mcp-examples/scoped-tools server -- --http --port 3000
pnpm --filter @mcp-examples/scoped-tools client -- --http http://127.0.0.1:3000/mcp
```

> DEMO ONLY — the bundled AS auto-approves and grants whatever scope is asked
> for. Do not deploy.
