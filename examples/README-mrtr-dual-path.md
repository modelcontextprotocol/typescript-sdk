# MRTR dual-path options

Follow-up to [typescript-sdk#1597](https://github.com/modelcontextprotocol/typescript-sdk/pull/1597) and [modelcontextprotocol#2322 (comment)](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2322#issuecomment-4083481545). Same weather-lookup tool throughout so
the diff between files is the argument.

## What to look at

| Direction                   | Where                                                                                                                                                               | How many options                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Old client → new server** | [`optionA`](./server/src/mrtr-dual-path/optionAShimMrtrCanonical.ts)–[`optionE`](./server/src/mrtr-dual-path/optionEDegradeOnly.ts) in `server/src/mrtr-dual-path/` | Five — server handler shape is genuinely contested                  |
| **New client → old server** | [`clientDualPath.ts`](./client/src/mrtr-dual-path/clientDualPath.ts) (app, ~55 lines) + [`sdkLib.ts`](./client/src/mrtr-dual-path/sdkLib.ts) (SDK machinery)        | One — handler signature is identical on both paths, SDK just routes |

The asymmetry is real: the server-side control flow changes between SSE-elicit (`await` inline) and MRTR (`return IncompleteResult`), so there are trade-offs to argue about. The client-side handler shape is the same either way (`(params) => Promise<ElicitResult>`), so there's
nothing to choose.

## The quadrant

| Server infra | 2025-11 client            | 2026-06 client |
| ------------ | ------------------------- | -------------- |
| Can hold SSE | **← options A–E**         | just use MRTR  |
| MRTR-only    | tool fails (unresolvable) | just use MRTR  |

Bottom-left is discounted: no amount of SDK work fills it when the server infra can't hold SSE. These demos are about whether the top-left is worth filling, and if so, how.

## Options

|                                                                  | Author writes                   | SDK does                       | Hidden re-entry                             | Old client gets                 |
| ---------------------------------------------------------------- | ------------------------------- | ------------------------------ | ------------------------------------------- | ------------------------------- |
| [A](./server/src/mrtr-dual-path/optionAShimMrtrCanonical.ts)     | MRTR-native only                | Emulates retry loop over SSE   | Yes, but safe (guard is explicit in source) | Full elicitation                |
| [B](./server/src/mrtr-dual-path/optionBShimAwaitCanonical.ts)    | `await elicit()` only           | Exception → `IncompleteResult` | Yes, **unsafe** (invisible in source)       | Full elicitation                |
| [C](./server/src/mrtr-dual-path/optionCExplicitVersionBranch.ts) | One handler, `if (mrtr)` branch | Version accessor               | No                                          | Full elicitation                |
| [D](./server/src/mrtr-dual-path/optionDDualRegistration.ts)      | Two handlers                    | Picks by version               | No                                          | Full elicitation                |
| [E](./server/src/mrtr-dual-path/optionEDegradeOnly.ts)           | MRTR-native only                | Nothing                        | No                                          | Error ("requires newer client") |

"Hidden re-entry" = the handler function is invoked more than once for a single logical tool call, and the author can't tell from the source text. A is safe because MRTR-native code has the re-entry guard (`if (!prefs) return`) visible in the source even though the _loop_ is
hidden. B is unsafe because `await elicit()` looks like a suspension point but is actually a re-entry point on MRTR sessions — see the `auditLog` landmine in that file.

## Client impact

None. All five options present identical wire behaviour to each client version. A 2025-11 client sees either a standard `elicitation/create` over SSE (A/B/C/D) or a `CallToolResult` with `isError: true` (E) — both vanilla 2025-11 shapes. A 2026-06 client sees `IncompleteResult`
in every case. The server's internal choice doesn't leak. This is the cleanest argument against per-feature `-mrtr` capability flags: there's nothing for them to signal, because the client's behaviour is already fully determined by `protocolVersion` plus the existing
`elicitation`/`sampling` capabilities.

For the reverse direction — new client SDK connecting to an old server — see `examples/client/src/mrtr-dual-path/`. Split into two files to make the boundary explicit: [`clientDualPath.ts`](./client/src/mrtr-dual-path/clientDualPath.ts) is ~55 lines of what the app developer
writes (one `handleElicitation` function, one registration, one tool call); [`sdkLib.ts`](./client/src/mrtr-dual-path/sdkLib.ts) is the retry loop + `IncompleteResult` parsing the SDK would ship. The app file is small on purpose — the delta from today's client code is zero.

## Trade-offs

**A vs E** is the core tension. Same author-facing code (MRTR-native), the only difference is whether old clients get served. A requires shipping and maintaining `sseRetryShim` in the SDK; E requires shipping nothing. A also carries a deployment-time hazard E doesn't: the shim
calls real SSE under the hood, so if the SDK ships it and someone uses it on MRTR-only infra, it fails at runtime when an old client connects — a constraint that lives nowhere near the tool code. E fails predictably (same error every time, from the first test); A fails only when
old client + wrong infra coincide.

**B** is the zero-migration option. Every existing `await ctx.elicitInput()` handler keeps working. The hidden re-entry on MRTR sessions is the price: a handler that does anything non-idempotent above the await is broken, and nothing warns you. Only safe if you can enforce "no
side effects before await" as a lint rule, which is hard in practice.

**C vs D** is a factoring question. C keeps both paths in one function body (duplication is visible, one file per tool). D separates them into two functions (cleaner per-handler, but two things to keep in sync and a registration API that only exists for the transition). Both put
the dual-path burden on the tool author rather than the SDK.

**A vs C/D** is about who owns the SSE fallback. A: SDK owns it, author writes once. C/D: author owns it, writes twice. A is less code for authors but more magic; C/D is more code for authors but no magic.

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
