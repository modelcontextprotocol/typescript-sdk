# MRTR dual-path options

Follow-up to [typescript-sdk#1597](https://github.com/modelcontextprotocol/typescript-sdk/pull/1597) and [modelcontextprotocol#2322 (comment)](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2322#issuecomment-4083481545). Same weather-lookup tool throughout so
the diff between files is the argument.

## What to look at

| Axis                                    | Where                                                                                                                                                                                            | How many options                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| **Old client → new server** (dual-path) | [`optionA`](./server/src/mrtr-dual-path/optionAShimMrtrCanonical.ts)–[`optionE`](./server/src/mrtr-dual-path/optionEDegradeOnly.ts)                                                              | Five — server handler shape is genuinely contested                        |
| **New client → old server** (dual-path) | [`clientDualPath.ts`](./client/src/mrtr-dual-path/clientDualPath.ts) + [`sdkLib.ts`](./client/src/mrtr-dual-path/sdkLib.ts)                                                                      | One — handler signature is identical on both paths                        |
| **MRTR footgun prevention**             | [`optionF`](./server/src/mrtr-dual-path/optionFCtxOnce.ts), [`optionG`](./server/src/mrtr-dual-path/optionGToolBuilder.ts), [`optionH`](./server/src/mrtr-dual-path/optionHContinuationStore.ts) | Three — opt-in primitive, structural decomposition, or genuine suspension |

## Recommended tiers

| Tier                     | Option                                                                                                                                                                                        | Who it's for                                                               | Trade-off                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Easy / default**       | [H](./server/src/mrtr-dual-path/optionHContinuationStore.ts) (`ContinuationStore`)                                                                                                            | Most servers. Single-instance, or can do sticky routing on `request_state` | Server stateful within a tool call — sticky routing at scale |
| **Stateless / advanced** | [E](./server/src/mrtr-dual-path/optionEDegradeOnly.ts) + [F](./server/src/mrtr-dual-path/optionFCtxOnce.ts) or [G](./server/src/mrtr-dual-path/optionGToolBuilder.ts)                         | Horizontally scaled, ephemeral workers, lambda-style                       | Must write re-entrant handlers; F/G mitigate the footgun     |
| **Transition compat**    | [A](./server/src/mrtr-dual-path/optionAShimMrtrCanonical.ts) / [C](./server/src/mrtr-dual-path/optionCExplicitVersionBranch.ts) / [D](./server/src/mrtr-dual-path/optionDDualRegistration.ts) | Servers that want old-client elicitation during transition                 | Carries SSE infra; opt-in                                    |
| **Don't ship**           | [B](./server/src/mrtr-dual-path/optionBShimAwaitCanonical.ts)                                                                                                                                 | Nobody                                                                     | Hidden footgun, no upside over H                             |

H is the "keep `await`" option done safely — SSE-era ergonomics, MRTR wire protocol, zero migration, zero footgun. The price is server-side state (continuation frame in memory), so horizontal scale needs sticky routing. If your deployment can't do that (lambda, truly ephemeral
workers), drop to the stateless tier: write guard-first handlers (E) and use `ctx.once` (F) or `ToolBuilder` (G) to keep side-effects safe. B is the cautionary tale — same surface as H but the await is a goto, not a suspension.

## The quadrant

| Server infra                    | 2025-11 client                    | 2026-06 client |
| ------------------------------- | --------------------------------- | -------------- |
| Can hold SSE                    | E by default; A/C/D if you opt in | MRTR           |
| MRTR-only (horizontally scaled) | E by necessity                    | MRTR           |

In both rows the server _works_ for old clients — version negotiation succeeds, `tools/list` is complete, tools that don't elicit are unaffected. Only elicitation inside a tool is unavailable. Bottom-left isn't "unresolvable"; it's "E is the only option." Top-left is "E, unless
you choose to carry SSE infra." The rows collapse for E, which is the argument for making it the SDK default.

## Options

|                                                                  | Author writes                   | SDK does                             | Hidden re-entry                             | Old client gets                                        |
| ---------------------------------------------------------------- | ------------------------------- | ------------------------------------ | ------------------------------------------- | ------------------------------------------------------ |
| [A](./server/src/mrtr-dual-path/optionAShimMrtrCanonical.ts)     | MRTR-native only                | Emulates retry loop over SSE         | Yes, but safe (guard is explicit in source) | Full elicitation                                       |
| [B](./server/src/mrtr-dual-path/optionBShimAwaitCanonical.ts)    | `await elicit()` only           | Exception → `IncompleteResult`       | Yes, **unsafe** (invisible in source)       | Full elicitation                                       |
| [C](./server/src/mrtr-dual-path/optionCExplicitVersionBranch.ts) | One handler, `if (mrtr)` branch | Version accessor                     | No                                          | Full elicitation                                       |
| [D](./server/src/mrtr-dual-path/optionDDualRegistration.ts)      | Two handlers                    | Picks by version                     | No                                          | Full elicitation                                       |
| [E](./server/src/mrtr-dual-path/optionEDegradeOnly.ts)           | MRTR-native only                | Nothing                              | No                                          | Result with default, or error — tool author's choice   |
| [F](./server/src/mrtr-dual-path/optionFCtxOnce.ts)               | MRTR-native + `ctx.once` wraps  | `once()` guard in requestState       | No                                          | (same as E — F/G are orthogonal to the dual-path axis) |
| [G](./server/src/mrtr-dual-path/optionGToolBuilder.ts)           | Step functions + `.build()`     | Step-tracking in requestState        | No                                          | (same as E)                                            |
| [H](./server/src/mrtr-dual-path/optionHContinuationStore.ts)     | SSE-era `await ctx.elicit()`    | Holds coroutine in ContinuationStore | No — genuine suspension, not re-entry       | (same as E)                                            |

"Hidden re-entry" = the handler function is invoked more than once for a single logical tool call, and the author can't tell from the source text. A is safe because MRTR-native code has the re-entry guard (`if (!prefs) return`) visible in the source even though the _loop_ is
hidden. B is unsafe because `await elicit()` looks like a suspension point but is actually a re-entry point on MRTR sessions — see the `auditLog` landmine in that file.

## Footgun prevention (F, G, H)

A–E are about the dual-path axis (old client vs new). F and G are about a different axis: even in a pure-MRTR world, the naive handler shape has a footgun. Code above the `if (!prefs)` guard runs on every retry. If that code is a DB write or HTTP POST, it executes N times for
N-round elicitation. The guard is present in A/E but nothing _enforces_ putting side-effects below it — safety depends on the developer knowing the convention. The analogy raised in SDK-WG review: the naive MRTR handler is de-facto GOTO — re-entry jumps to the top, and the state
machine progression is implicit in the `inputResponses` checks.

**F (`ctx.once`)** keeps the monolithic handler but wraps side-effects in an idempotency guard. `ctx.once('audit', () => auditLog(...))` checks `requestState` — if the key is already marked executed, skip. Opt-in: an unwrapped mutation still fires twice. The footgun isn't
eliminated; it's made _visually distinct_ from safe code, which is reviewable.

**G (`ToolBuilder`)** decomposes the handler into named step functions. `incompleteStep` may return `IncompleteResult` or data; `endStep` receives everything and runs exactly once. There is no "above the guard" zone because there is no guard — the SDK's step-tracking is the
guard. Side-effects go in `endStep`; it's structurally unreachable until all elicitations complete. Boilerplate: two function definitions + `.build()` to replace A/E's 3-line check. Worth it at 3+ rounds; overkill for single-question tools where F is lighter.

**H (`ContinuationStore`)** keeps the `await ctx.elicit()` surface but makes the await _genuine_ — the coroutine frame is held in a `Map<token, Continuation>` between rounds, keyed by `request_state`. Round 1 spawns the handler as a detached Promise; `elicit()` sends
`IncompleteResult` through a channel and parks on recv. Round 2's retry resolves the channel; the handler continues from where it stopped. No re-entry, no double-execution, zero migration from SSE-era code. The price: server-side state within a tool call, so horizontal scale
needs sticky routing on the token. Counterpart to [python-sdk#2322's `linear.py`](https://github.com/modelcontextprotocol/python-sdk/pull/2322).

Both F and G depend on `requestState` integrity. The demos use plain base64 JSON; a real SDK MUST HMAC-sign the blob, because otherwise the client can forge step-done / once-executed markers and skip the guards. Per-session key derived from `initialize` keeps it stateless.
Without signing, the safety story is advisory.

## Client impact

None. All eight options present identical wire behaviour to each client version (F, G, H are the same as E on the wire — the footgun-prevention is server-internal). A 2025-11 client sees either a standard `elicitation/create` over SSE (A/B/C/D) or a plain `CallToolResult` (E —
either a real result with a default, or an error, tool author's choice). All vanilla 2025-11 shapes. A 2026-06 client sees `IncompleteResult` in every case. The server's internal choice doesn't leak. This is the cleanest argument against per-feature `-mrtr` capability flags:
there's nothing for them to signal, because the client's behaviour is already fully determined by `protocolVersion` plus the existing `elicitation`/`sampling` capabilities.

For the reverse direction — new client SDK connecting to an old server — see `examples/client/src/mrtr-dual-path/`. Split into two files to make the boundary explicit: [`clientDualPath.ts`](./client/src/mrtr-dual-path/clientDualPath.ts) is ~55 lines of what the app developer
writes (one `handleElicitation` function, one registration, one tool call); [`sdkLib.ts`](./client/src/mrtr-dual-path/sdkLib.ts) is the retry loop + `IncompleteResult` parsing the SDK would ship. The app file is small on purpose — the delta from today's client code is zero.

## Trade-offs

**E is the SDK-default position.** A horizontally scaled server gets E for free — it's the only thing that works on that infra. A server that can hold SSE also gets E by default, and opts into A/C/D only if serving old-client elicitation is worth the extra infra dependency. That
reframes A/C/D from "ways to fill the top-left" to "opt-in exceptions for servers that choose to carry SSE through the transition."

**A vs E** is the core tension. Same author-facing code (MRTR-native), the only difference is whether old clients get served. A requires shipping and maintaining `sseRetryShim` in the SDK; E requires shipping nothing. A also carries a deployment-time hazard E doesn't: the shim
calls real SSE under the hood, so if the SDK ships it and someone uses it on MRTR-only infra, it fails at runtime when an old client connects — a constraint that lives nowhere near the tool code. E fails predictably (same error every time, from the first test); A fails only when
old client + wrong infra coincide.

**B vs H** are both "keep `await`." B does it via exception-shim: the await throws, handler re-runs from top, await returns cached answer. Everything above runs twice. H does it via ContinuationStore: the await genuinely suspends, frame held in memory, retry resumes from the
await point. Nothing above re-runs. Same author-facing surface, opposite safety story. B exists in this deck only as the cautionary tale — there's no reason to ship it when H exists.

**H vs E/F/G** is the statefulness trade. H is ergonomic and safe but the server holds a frame in memory, so horizontal scale needs sticky routing on `request_state`. E/F/G encode everything in `request_state` itself, so any server instance can handle any round — true
statelessness, at the cost of writing re-entrant handlers. Pick H if your deployment can do sticky routing (most can — hash the token). Pick E/F/G if it can't (lambda, ephemeral workers).

**C vs D** is a factoring question. C keeps both paths in one function body (duplication is visible, one file per tool). D separates them into two functions (cleaner per-handler, but two things to keep in sync and a registration API that only exists for the transition). Both put
the dual-path burden on the tool author rather than the SDK.

**A vs C/D** is about who owns the SSE fallback. A: SDK owns it, author writes once. C/D: author owns it, writes twice. A is less code for authors but more magic; C/D is more code for authors but no magic.

**F vs G** is the footgun-prevention trade. F is minimal — one line per side-effect, composes with any handler shape (A, E, or raw MRTR). G is structural — the step decomposition makes double-execution impossible for `endStep`, but costs two function definitions per tool. Neither
replaces A–E; they layer on top. The likely SDK answer is: ship F as a primitive on the MRTR context, ship G as an opt-in builder, recommend G for multi-round tools and F for single-question tools with one side-effect.

## Running

All demos use `DEMO_PROTOCOL_VERSION` to simulate the negotiated version, since the real SDK doesn't surface it to handlers yet. Server demos run from `examples/server`:

```sh
DEMO_PROTOCOL_VERSION=2025-11 pnpm tsx src/mrtr-dual-path/optionAShimMrtrCanonical.ts
DEMO_PROTOCOL_VERSION=2026-06 pnpm tsx src/mrtr-dual-path/optionAShimMrtrCanonical.ts
```

The client demo spawns the server itself (run from `examples/client`):

```sh
DEMO_PROTOCOL_VERSION=2026-06 pnpm tsx src/mrtr-dual-path/clientDualPath.ts
```

`IncompleteResult` is smuggled through the current `registerTool` signature as a JSON text block (same hack as #1597). A real implementation emits `JSONRPCIncompleteResultResponse` at the protocol layer — see `server/src/mrtr-dual-path/shims.ts:wrap()`.

## Not in scope

- Sampling and roots (same shape as elicitation, just noisier to demo)
- `requestState` / continuation-state handlers (#1597's bucket 2 — each option extends to it the same way)
- A paired demo client (drive via Inspector, look for `__mrtrIncomplete` in tool output)
