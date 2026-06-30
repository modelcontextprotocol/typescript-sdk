---
status: scaffold
shape: how-to
---
# Logging, progress, and cancellation

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: The ctx every handler receives: logging, progress, cancellation.
teaches: ServerContext, ctx.mcpReq.notify, ctx.mcpReq.log, ctx.mcpReq.signal, ctx.mcpReq._meta
source: mined from docs/server.md "Logging", "Progress" + protocol cancellation behavior
-->

## Report progress from a handler
<!-- teaches: ctx.mcpReq._meta.progressToken, ctx.mcpReq.notify('notifications/progress') | salvage: docs/server.md "Progress" (registerTool_progress) -->

```ts
// draft - API verified against packages/core-internal/src/shared/protocol.ts (BaseContext.mcpReq._meta/notify, lines 375-433)
server.registerTool(
  'process-files',
  {
    description: 'Process files with progress updates',
    inputSchema: z.object({ files: z.array(z.string()) }),
  },
  async ({ files }, ctx) => {
    const progressToken = ctx.mcpReq._meta?.progressToken;

    for (let i = 0; i < files.length; i++) {
      // ... process files[i] ...
      if (progressToken !== undefined) {
        await ctx.mcpReq.notify({
          method: 'notifications/progress',
          params: { progressToken, progress: i + 1, total: files.length, message: `Processed ${files[i]}` },
        });
      }
    }

    return { content: [{ type: 'text', text: `Processed ${files.length} files` }] };
  }
);
```
<!-- result: the client's progress callback fires once per file with progress/total/message. -->

## Skip progress when the client did not ask
<!-- teaches: progressToken is opt-in; progress must increase; total and message are optional | salvage: docs/server.md "Progress" closing rules -->
<!-- code: the same loop guarded on progressToken === undefined, one comment per rule -->

## Log to the client
<!-- teaches: capabilities: { logging: {} } + ctx.mcpReq.log(level, data) | salvage: docs/server.md "Logging" (logging_capability, registerTool_logging) -->
<!-- code: declare the logging capability at construction, then ctx.mcpReq.log('info', ...) inside the handler -->
<!-- ::: warning placeholder: MCP logging is deprecated (SEP-2577); migrate to stderr (stdio) or OpenTelemetry -->

## Respect the client's log level
<!-- teaches: per-request logLevel _meta key (2026-07-28) vs logging/setLevel (2025-era); silent no-op when unset | salvage: docs/server.md "Logging" closing paragraph -->
<!-- code: none; one-line era cross-link to /protocol-versions -->

## Stop work when the request is cancelled
<!-- teaches: ctx.mcpReq.signal is an AbortSignal aborted by notifications/cancelled and client disconnects | source: packages/core-internal/src/shared/protocol.ts (signal, line 406) -->
<!-- code: a long-running loop that checks ctx.mcpReq.signal.aborted and returns early -->
<!-- result: the client sees no response for the cancelled request; the handler stops burning work -->

## Pass the signal to your own I/O
<!-- teaches: forwarding ctx.mcpReq.signal into fetch / db calls so cancellation propagates -->
<!-- code: fetch(url, { signal: ctx.mcpReq.signal }) inside the handler -->

## Recap
<!-- the claims this page will prove:
- Every handler receives a context as its second argument; request-scoped helpers live on ctx.mcpReq.
- notify() sends notifications/progress when the client supplied a progressToken; progress must increase.
- log(level, data) sends structured log notifications once the logging capability is declared; logging is sunset (SEP-2577).
- The client's level filter is per-request on 2026-07-28 and per-session on 2025-era connections.
- ctx.mcpReq.signal aborts on cancellation; check it and forward it to your own I/O.
-->
