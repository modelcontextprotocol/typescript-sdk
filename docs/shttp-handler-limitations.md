# `shttpHandler` limitations (2025-11 protocol)

`shttpHandler` is the request/response entry point for the new architecture: it
calls `mcpServer.dispatch(req, env)` per HTTP POST and streams the result back
as SSE or JSON. It is intentionally stateless — no `_streamMapping`, no
`relatedRequestId` routing.

## Elicitation / sampling over the new path

`shttpHandler` does **not** supply `env.send`. If a tool handler calls
`ctx.mcpReq.elicitInput(...)` or `ctx.mcpReq.requestSampling(...)` while
running under `shttpHandler`, it throws `SdkError(NotConnected)` with a message
pointing at the MRTR-native form.

This is because the 2025-11 mechanism for server→client requests is:

1. Server writes the elicit request as an SSE event on the open POST response.
2. Client posts the answer back on a **separate** HTTP POST as a JSON-RPC response.
3. Server matches that response to the pending `env.send` promise by request id.

Step 3 requires a per-session map of `{requestId → resolver}` that survives
across HTTP requests — exactly the `_requestToStreamMapping` /
`_responseHandlers` state that `WebStandardStreamableHTTPServerTransport`
carries and that this rebuild moved out of the request path.

## What to use instead

| Need | Use |
|---|---|
| Elicitation/sampling on a 2025-11 client | `mcpServer.connect(new WebStandardStreamableHTTPServerTransport(...))` — the old transport still works via `StreamDriver`, which provides `env.send`. |
| Elicitation/sampling on a 2026-06+ client | Handler returns `IncompleteResult` (MRTR, SEP-2322). `shttpHandler` returns it as the response; client re-calls with `inputResponses`. No back-channel needed. |
| Stateless server, no elicitation | `shttpHandler` directly. |

## If we decide to implement it later

Add `pendingServerRequests: Map<RequestId, (r: Result | Error) => void>` to
`SessionCompat`. `shttpHandler`:

- Supply `env.send = (req) => { write req to SSE; return new Promise((res, rej) => session.pendingServerRequests.set(id, ...)) }`
- On inbound POST whose body is a JSON-RPC **response** (not request), look up
  the resolver in `session.pendingServerRequests` and resolve it instead of
  calling `dispatch`.

Estimated ~120 LOC across `shttpHandler.ts` + `sessionCompat.ts`. Deferred
because it re-introduces the per-session correlation state the rebuild
removed, and MRTR (accepted-with-changes) makes it obsolete.
