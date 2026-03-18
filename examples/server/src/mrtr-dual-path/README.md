# MRTR dual-path options

Five approaches to the top-left quadrant of the SEP-2322 compatibility matrix: a server that **can** hold SSE, talking to a **2025-11** client, running **MRTR-era** tool code.

Follow-up to [typescript-sdk#1597](https://github.com/modelcontextprotocol/typescript-sdk/pull/1597) and [modelcontextprotocol#2322 (comment)](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2322#issuecomment-4083481545). All five files register the same
weather-lookup tool so the diff between files is the argument.

## The quadrant

| Server infra | 2025-11 client            | 2026-06 client |
| ------------ | ------------------------- | -------------- |
| Can hold SSE | **← this folder**         | just use MRTR  |
| MRTR-only    | tool fails (unresolvable) | just use MRTR  |

Bottom-left is discounted: no amount of SDK work fills it when the server infra can't hold SSE. These demos are about whether the top-left is worth filling, and if so, how.

## Options

|                                 | Author writes                   | SDK does                       | Hidden re-entry                             | Old client gets                 |
| ------------------------------- | ------------------------------- | ------------------------------ | ------------------------------------------- | ------------------------------- |
| [A](./shimMrtrCanonical.ts)     | MRTR-native only                | Emulates retry loop over SSE   | Yes, but safe (guard is explicit in source) | Full elicitation                |
| [B](./shimAwaitCanonical.ts)    | `await elicit()` only           | Exception → `IncompleteResult` | Yes, **unsafe** (invisible in source)       | Full elicitation                |
| [C](./explicitVersionBranch.ts) | One handler, `if (mrtr)` branch | Version accessor               | No                                          | Full elicitation                |
| [D](./dualRegistration.ts)      | Two handlers                    | Picks by version               | No                                          | Full elicitation                |
| [E](./degradeOnly.ts)           | MRTR-native only                | Nothing                        | No                                          | Error ("requires newer client") |

"Hidden re-entry" = the handler function is invoked more than once for a single logical tool call, and the author can't tell from the source text. A is safe because MRTR-native code has the re-entry guard (`if (!prefs) return`) visible in the source even though the _loop_ is
hidden. B is unsafe because `await elicit()` looks like a suspension point but is actually a re-entry point on MRTR sessions — see the `auditLog` landmine in that file.

## Trade-offs

**A vs E** is the core tension. Same author-facing code (MRTR-native), the only difference is whether old clients get served. A requires shipping and maintaining `sseRetryShim` in the SDK; E requires shipping nothing. If elicitation-using tools are rare and old clients upgrade on
a reasonable timeline, E's cost (a few tools error for a few months) is lower than A's cost (permanent SDK machinery).

**B** is the zero-migration option. Every existing `await ctx.elicitInput()` handler keeps working. The hidden re-entry on MRTR sessions is the price: a handler that does anything non-idempotent above the await is broken, and nothing warns you. Only safe if you can enforce "no
side effects before await" as a lint rule, which is hard in practice.

**C vs D** is a factoring question. C keeps both paths in one function body (duplication is visible, one file per tool). D separates them into two functions (cleaner per-handler, but two things to keep in sync and a registration API that only exists for the transition). Both put
the dual-path burden on the tool author rather than the SDK.

**A vs C/D** is about who owns the SSE fallback. A: SDK owns it, author writes once. C/D: author owns it, writes twice. A is less code for authors but more magic; C/D is more code for authors but no magic.

## Running

All demos use `DEMO_PROTOCOL_VERSION` to simulate the negotiated version, since the real SDK doesn't surface it to handlers yet:

```sh
DEMO_PROTOCOL_VERSION=2025-11 pnpm tsx src/mrtr-dual-path/shimMrtrCanonical.ts
DEMO_PROTOCOL_VERSION=2026-06 pnpm tsx src/mrtr-dual-path/shimMrtrCanonical.ts
```

`IncompleteResult` is smuggled through the current `registerTool` signature as a JSON text block (same hack as #1597). A real implementation emits `JSONRPCIncompleteResultResponse` at the protocol layer — see `shims.ts:wrap()`.

## Not in scope

- Sampling and roots (same shape as elicitation, just noisier to demo)
- `requestState` / continuation-state handlers (#1597's bucket 2 — each option extends to it the same way)
- A paired demo client (drive via Inspector, look for `__mrtrIncomplete` in tool output)
