# Events SDK Stress-Test Report

Six reference implementations (Gmail, Slack, GitHub, Kubernetes, Stripe, Shopify) were built against the Events SDK to exercise every documented path. All six typecheck cleanly (1,112 LoC total across `examples/server/src/events-stress/`). This report aggregates what broke, what bent, and what held.

## 1. Summary

All six implementations succeeded and typecheck without error, so the core design is sound: the `check()` callback contract, opaque cursors, `bufferEmits`, and `onSubscribe`/`onUnsubscribe` hooks compose well enough to cover a genuinely diverse set of upstreams (cursor-durable APIs, push-only webhooks, WebSocket streams, dual-path sources, and k8s list-then-watch). However, **one blocker** surfaced — the SDK forbids server-supplied `eventId`, which breaks dedup for any dual-path source (Stripe) — and **three friction points recurred across 3+ implementations each**: mandatory emit-only `check()` boilerplate, missing `payloadSchema` type inference into `matches`/`emitEvent`, and no primitive for sharing upstream lifecycle across event types. The SDK is ready for single-path sources today; dual-path and multi-event-type sources need the fixes below before the API is worth freezing.

## 2. Pain points by category

Ranked by severity × frequency. Source abbreviations: GM=Gmail, SL=Slack, GH=GitHub, K8=Kubernetes, ST=Stripe, SH=Shopify.

### 2.1 API gaps (design-level holes)

| # | Issue | Sources | Severity | Nature |
|---|---|---|---|---|
| **A1** | **Cannot set stable `eventId`** — `EventCheckResult.events` is typed `Omit<EventOccurrence, 'eventId'\|...>` and `_makeOccurrence()` always auto-generates. Dual-path sources (webhook + poll) deliver the same upstream event twice with different SDK IDs, defeating protocol-level dedup. | ST | **blocker** | design gap |
| **A2** | No primitive for shared upstream lifecycle across event types — when `slack.message` + `slack.reaction_added` share one WS connection, or two k8s event types share one watch, authors must hoist refcount maps into enclosing scope and duplicate identical `hooks` blocks. | SL, K8 | friction ×2 | design gap |
| **A3** | Composite cursors are hand-rolled — Gmail's `historyId:pageToken`, k8s's `{podsRV, eventsRV}` both required manual encode/decode/merge. Every multi-lane upstream will reinvent this. | GM, K8 | friction ×2 | design gap (or helper gap) |
| **A4** | `emitEvent()` cannot shape payload per-subscriber — broadcasts one fixed `data` to all matching subscriptions, but subscribers may have different `inputSchema` params (Stripe `expand=true` vs `false`). `matches` only filters yes/no. | ST | friction | design gap |
| **A5** | No server-lifecycle hook for always-on upstream registration — Shopify GDPR webhooks must be registered regardless of MCP subscriber count. `onSubscribe` refcounting doesn't apply; author rolled `reconcileWebhooks()` + `setInterval` + manual `server.onclose` cleanup. | SH | friction | design gap |
| **A6** | `verifyWebhookSignature` is MCP-specific (signs `timestamp + '.' + body`), unusable for GitHub's `X-Hub-Signature-256` (raw-body HMAC). Name implies generality it doesn't have. | GH | friction | naming / helper gap |
| **A7** | No clean way to expose inbound webhook handler to HTTP framework / test harness — both GitHub and Shopify resorted to `(server as unknown as {...})._foo = handler`. | GH, SH | nitpick ×2 | helper gap |

### 2.2 Type safety

| # | Issue | Sources | Severity | Nature |
|---|---|---|---|---|
| **T1** | `payloadSchema` does not flow into `matches` callback's `data` param (typed `Record<string, unknown>`), nor into `emitEvent(name, data)`, nor into `check()`'s returned `events[].data`. Authors cast `data as z.infer<typeof Payload>` everywhere. | SL, GH, K8, SH | friction ×2, nitpick ×2 | design gap — **4 of 6 sources hit this** |
| **T2** | Type/runtime mismatch: `EventCheckResult.events[].name` is required by type but runtime does `e.name ?? spec.name`. Type says mandatory, code says optional. | ST | nitpick | bug |

### 2.3 Ergonomics

| # | Issue | Sources | Severity | Nature |
|---|---|---|---|---|
| **E1** | Emit-only `check()` is mandatory boilerplate: `async () => ({ events: [], cursor: 'emit-only', nextPollSeconds: 30 })` repeated verbatim in every webhook-driven event. | SL, GH, SH | friction ×2, nitpick ×1 | polish — **3 of 6 sources** |
| **E2** | `events[]` must repeat `name: 'foo.bar'` even when the `check()` callback is scoped to a single event type. | GM (+ T2 confirms runtime already defaults it) | nitpick | polish |
| **E3** | No named `CheckEvent` type alias — authors compute `Omit<EventOccurrence, 'eventId'\|'timestamp'\|'cursor'>` in their head or read source. | K8 | friction | polish |
| **E4** | `nextPollSeconds` on emit-only check is semantically odd — it's really controlling bufferEmits merge cadence, not upstream poll rate. No guidance on what value to use. | SL | nitpick | docs |
| **E5** | Bootstrap on empty upstream needs a sentinel cursor ("what do I return when Stripe has zero events yet?"). No documented pattern. | ST | nitpick | docs |

### 2.4 Unclear semantics

| # | Issue | Sources | Severity | Nature |
|---|---|---|---|---|
| **U1** | When `bufferEmits` is set AND `check()` returns real events, the SDK merges both — same upstream event appears twice in one poll response with different SDK eventIds. SDK-REFERENCE says "eventId dedup handles overlap" but A1 makes that impossible. | ST | friction | docs + depends on A1 fix |
| **U2** | `onUnsubscribe(subId, params, ctx)` — is `params` guaranteed to be the validated subscribe-time object, or can it be `undefined` on abrupt disconnect? Slack author defensively stored `subId→channelId` in a side Map rather than trust it. | SL | friction | docs |
| **U3** | Per-user upstream credentials: go in `inputSchema` params, in `ctx.http.authInfo`, or an `onSubscribe`-populated side map? Gmail put OAuth token in params; unclear if intended. | GM | friction | docs |
| **U4** | Is `emitEvent()` on zero-subscriber event type a cheap no-op? Shopify GDPR webhooks must fire regardless; author needed confidence it won't throw. | SH | friction | docs |
| **U5** | When two event types share a logical cursor, does the SDK run two independent subscriptions/polls? K8s author assumed yes → two parallel watches against same apiserver. | K8 | friction | docs (overlaps A2) |

### 2.5 Docs

| # | Issue | Sources | Severity | Nature |
|---|---|---|---|---|
| **D1** | `ProtocolError` / `CURSOR_EXPIRED` import path not shown inline with the `throw` example. Two authors grepped source to find the re-export. | GM, K8 | nitpick ×2 | docs |

## 3. What worked well

Patterns that multiple sources found natural, with direct quotes:

**The null-cursor bootstrap contract** (4/6 sources). Gmail: "maps perfectly onto Gmail's getProfile→historyId then history.list flow. Zero impedance mismatch." Kubernetes: "`cursor===null → LIST, else → WATCH?resourceVersion=cursor` is a one-liner." Stripe: "maps cleanly onto Stripe's starting_after pagination model — cursor IS the last event ID, no encoding needed."

**`bufferEmits` as the emit→poll bridge** (4/6 sources). Slack: "exactly the right escape hatch for 'upstream pushes to me, but I still want poll clients to work'. One config line, done." GitHub: "a one-liner that makes emit-driven events visible to poll clients." Shopify: "one config flag and poll clients see webhook-delivered events without any extra plumbing."

**`CURSOR_EXPIRED` as thrown error** (2/6 sources). Gmail: "clean fit for Gmail's 404-on-stale-historyId. One throw, the SDK handles the rest." Kubernetes: "exactly right for 410 Gone — no need to return a special sentinel, just throw and the SDK re-bootstraps."

**`inputSchema` type inference into callbacks** (4/6 sources). Slack: "`{ channelId }` destructures with the correct string type in onSubscribe." Kubernetes: "namespace + labelSelector flowed through with no casts." Shopify: "minTotal showed up fully typed with no annotation." (Contrast with T1: `inputSchema` inference works, `payloadSchema` inference does not.)

**`hasMore` for bounded drain** (2/6 sources). Kubernetes: "capped at 25 events/poll and set hasMore when the watch buffer wasn't fully consumed — SDK immediately re-polls. No extra state needed." Stripe: "perfect fit for Stripe's has_more response field; one line."

**`matches` filter for broadcast fan-out** (2/6 sources). Slack: "emit once per incoming WS message and the SDK fans out to the right channel subscriptions without me tracking who subscribed to what." GitHub: "subscribers can filter by repo + action subset and the SDK handles fan-out without any per-subscription bookkeeping."

**`onSubscribe`/`onUnsubscribe` for refcounted upstream** (2/6 sources). Slack: "map cleanly to the Socket Mode lifecycle — subscribe = join channel, unsubscribe = leave channel. No impedance mismatch." Shopify: "map cleanly to refcounted upstream webhook registration."

**Dynamic `nextPollSeconds`** (2/6 sources). Gmail: "express 'tighten when busy, back off when quiet' in two lines without any extra state." Stripe: "exactly right for rate-limited upstreams."

## 4. Coverage matrix

| SDK path | GM | SL | GH | K8 | ST | SH | Gap? |
|---|:-:|:-:|:-:|:-:|:-:|:-:|---|
| `check()` with real upstream poll | ✓ | | | ✓ | ✓ | | — |
| Null-cursor bootstrap | ✓ | | | ✓ | ✓ | | — |
| `CURSOR_EXPIRED` throw → re-bootstrap | ✓ | | | ✓ | | | — |
| `hasMore` immediate re-poll | | | | ✓ | ✓ | | — |
| Dynamic `nextPollSeconds` | ✓ | | | | ✓ | | — |
| Composite/multi-lane cursor | ✓ | | | ✓ | | | — |
| `bufferEmits` (emit-only) | | ✓ | ✓ | | | ✓ | — |
| `bufferEmits` + real `check()` (dual-path) | | | | | ✓ | | **exposed blocker A1** |
| `emitEvent()` broadcast | | ✓ | ✓ | | ✓ | ✓ | — |
| `emitEvent()` on zero subscribers | | | | | | ✓ | — |
| `matches` filter | | ✓ | ✓ | | | ✓ | — |
| `onSubscribe`/`onUnsubscribe` hooks | | ✓ | | | | ✓ | — |
| Refcounted shared upstream (1 conn, N event types) | | ✓ | | ~ | | | **no SDK primitive (A2)** |
| Always-on upstream (no subscriber dependency) | | | | | | ✓ | **no SDK hook (A5)** |
| Inbound webhook HMAC verify | | | ✓ | | | ✓ | **core helper unusable for GH (A6)** |
| Multiple event types, one server | | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Per-subscriber payload shaping | | | | | ✗ | | **not possible (A4)** |
| Thin-payload + companion tool | ✓ | | | | | | — |

**Uncovered paths:** none of the six exercised subscription-scoped `emitEvent({ subscriptionId })` (all used broadcast), and none tested `check()` throwing a non-`CURSOR_EXPIRED` error.

## 5. Design recommendations

Prioritized. Effort estimates assume familiarity with `events.ts`.

### P0 — Blockers

**R1. Allow `eventId` (and `timestamp`) passthrough.** Change `EventCheckResult.events[]` element type to include optional `eventId?: string` and `timestamp?: string`; change `emitEvent(name, data, opts?)` to accept `{ subscriptionId?, eventId?, timestamp? }`. `_makeOccurrence()` uses provided values or auto-generates. Fixes A1, U1. *Effort: small — type change + one conditional in `_makeOccurrence`.*

### P1 — High-frequency friction

**R2. Infer `payloadSchema` into `matches`, `emitEvent`, and `check()` return.** Either (a) make `registerEvent` return a typed handle `{ emit(data: z.infer<P>): void }` and type `matches: (params, data: z.infer<P>) => boolean`, or (b) thread a phantom type through the event spec. Four of six sources cast around this. Fixes T1. *Effort: medium — generic plumbing through `EventSpec`.*

**R3. Make `check` optional when `bufferEmits` is set.** SDK supplies `async () => ({ events: [], cursor: '__emit_only__', nextPollSeconds: 30 })` internally. Alternatively export `const emitOnlyCheck = (seconds = 30) => ...`. Three of six sources wrote this stub verbatim. Fixes E1, E4. *Effort: trivial.*

**R4. Make `events[].name` optional in `EventCheckResult`, defaulting to the registered event name.** Runtime already does this (`e.name ?? spec.name`); align the type. Fixes T2, E2. *Effort: trivial — type-only change.*

### P2 — Design additions

**R5. Add `registerEventGroup()` or shared-hooks attachment.** Let N event types share one `hooks` block and optionally one `check()` + cursor. Covers Slack (shared WS), k8s (shared watch), and any multi-topic Kafka-style source. Fixes A2, U5. *Effort: medium — new registration surface + cursor-sharing semantics.*

**R6. Add per-subscriber transform alongside `matches`.** `transform?: (params, data) => data` lets one broadcast `emitEvent` produce different payloads per subscriber (Stripe thin vs fat). Or let `emitEvent` accept `(params) => data`. Fixes A4. *Effort: small–medium.*

**R7. Add `events.onStart`/`onStop` lifecycle hooks** at `McpServer` options level, or `alwaysActive: true` on `registerEvent` hooks. Covers mandatory-webhook registration (Shopify GDPR). Fixes A5. *Effort: small.*

### P3 — Helpers & polish

**R8. Export `compositeCursor({ encode, decode })` helper** or allow `cursor: Record<string,string>` that the SDK base64-JSONs transparently. Fixes A3. *Effort: small.*

**R9. Rename `verifyWebhookSignature` → `verifyMcpWebhookSignature`** and export `hmacSha256(secret, msg)` + `timingSafeEqualStr` primitives. Fixes A6. *Effort: trivial.*

**R10. Export named `CheckEvent` type alias.** Fixes E3. *Effort: trivial.*

**R11. Docs pass** covering U2 (onUnsubscribe params guarantee), U3 (per-user credential placement), U4 (emitEvent zero-subscriber is no-op), E5 (empty-upstream bootstrap sentinel), D1 (ProtocolError import inline). *Effort: small.*

## 6. Open questions for the spec author

These need a design decision, not just code:

1. **Is `eventId` server-authoritative or SDK-authoritative?** The current SDK assumes it owns eventId generation. Stripe/dual-path needs the upstream ID to be the dedup key. If the spec intends eventId to be the protocol-level dedup key, the SDK *must* let servers set it. If dedup is meant to happen on a payload field, the spec should say so and the SDK-REFERENCE "eventId dedup handles overlap" line is wrong.

2. **Should event types be able to share a cursor?** If a client subscribes to `k8s.pod_phase_changed` and `k8s.oom_killed` (same namespace), is that one subscription with one cursor or two? The spec's subscription model implies per-event-type, but that forces N parallel upstream connections where one would do.

3. **Where do per-user upstream credentials live?** In subscription `inputSchema` params (becomes part of subscription identity, visible in every `check()`), derived from `ctx.http.authInfo` (assumes MCP auth == upstream auth), or a separate channel? Gmail put a raw OAuth token in params — is that the intended pattern or a smell?

4. **What is `cursor` in emit-only mode?** When `bufferEmits` wraps the user cursor in a composite, does the user-supplied string matter at all? Must it be stable across calls? Can it be empty? Three sources returned the literal `'emit-only'` as a guess.

5. **Is `onUnsubscribe` guaranteed to fire with populated `params` on transport disconnect?** Or only on explicit client unsubscribe? This determines whether refcounted-upstream authors can trust `params` or must maintain a `subId → state` side map.

6. **Per-subscriber payload shaping — in scope?** Stripe's `expand` param wants one webhook emit to produce thin payloads for some subscribers and fat for others. Is this a legitimate use case the Events API should support, or should the answer be "register two event types"?
