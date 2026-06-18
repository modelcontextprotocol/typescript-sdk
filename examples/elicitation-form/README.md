# elicitation-form

Form-mode elicitation: the server requests structured user input via `ctx.mcpReq.elicitInput({ mode: 'form', requestedSchema })`; the client auto-answers the form. Covers accept and decline.

For URL-mode elicitation see `../oauth/` (excluded from the harness; browser flow). For the 2026-07-28 multi-round-trip return style see `../mrtr/`.

**stdio-only** in the harness: push server→client requests need either a stdio connection or a sessionful HTTP transport (see `../legacy-routing/`); the harness's `--http` arm is the stateless per-request `createMcpHandler`.

```bash
pnpm tsx examples/elicitation-form/client.ts --legacy
```
