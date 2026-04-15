# MCP Events — Implementation Decisions

This document records the ambiguities encountered while implementing the MCP
Events design and the decisions made. Each entry notes the rationale and
whether the decision is easily reversible.

## Error codes (shifted by -10)

**Design says:** `-32001` through `-32006` for event-specific errors.

**Implemented:** `-32011` through `-32016`.

**Rationale:** `-32002` is already `ResourceNotFound` in this SDK. Rather than
introduce a clash, the entire range is shifted by 10. Both the `ProtocolErrorCode`
enum members and the `const` exports (`EVENT_NOT_FOUND`, etc.) use the shifted
values.

**Reversible:** trivial — only constants need editing.

## `events/stream` result schema

**Design says:** the request is long-lived and "never returns" — termination is
via abort.

**Implemented:** `ResultTypeMap['events/stream'] = EmptyResult`. The server
handler returns a `Promise` that resolves to `{}` on stream close. This keeps
the framework's request/response correlation intact while the stream is open.

**Rationale:** the existing `Protocol` layer requires every request handler to
eventually resolve or reject. Resolving to an empty result on close is the
least invasive fit.

**Reversible:** the schema is easily changed to a dedicated `StreamClosedResult`
if needed.

## Delivery mode computation is uniform per server, not per event

**Design says:** the SDK computes `delivery` "automatically" from server
configuration and transport.

**Implemented:** `delivery` is computed once per `ServerEventManager` instance
and applied to every event type:
- `poll` is always present.
- `push` is always present (the SDK has no transport-sniffing hook; all
  transports currently support server→client notifications).
- `webhook` is present iff `events.webhook.ttlMs` is configured.

**Rationale:** there's no clean way to introspect the connected transport from
the server side, and per-event delivery mode variation wasn't described.

**Reversible:** the `_computeDeliveryModes()` method can be parameterised per
event with minimal fanout.

## Poll interval is driven entirely by `nextPollSeconds` (no static hints)

**Design change:** `pollHints` was removed from the spec. The check callback's
`nextPollSeconds` return value is now the sole source of polling cadence.

**Implemented:** the server's internal poll-driven loops (`_schedulePushPoll`,
`_scheduleWebhookPoll`) receive the bootstrap check's `nextPollSeconds` as their
initial interval and then track the most recent value returned by subsequent
checks. `_pollOne` falls back to `DEFAULT_POLL_SECONDS` (30s) only when the
check callback omits it.

**Rationale:** one fewer concept, and the dynamic value can do everything the
static hint could — a check callback that wants a fixed interval just returns
the same `nextPollSeconds` every time.

## `events/stream` handler does not return per-subscription errors as a request-level error

**Design says:** subscription errors are sent as `notifications/events/error`
on the stream; the request itself succeeds.

**Implemented:** yes. Only `TooManySubscriptions` (a request-level constraint)
throws at the handler level. Unknown events, invalid params, and cursor expiry
all flow as notifications.

**Rationale:** matches the design exactly.

## `ctx.mcpReq.notify` is the push channel

**Design says:** notifications are delivered "on the SSE response stream" (HTTP)
or "on stdout" (stdio).

**Implemented:** the server's stream handler captures `ctx.mcpReq.notify` and
uses it for all event/active/error/heartbeat notifications. This routes via the
`relatedRequestId` mechanism, which the Streamable HTTP transport already uses
to associate notifications with the originating POST's SSE stream.

**Rationale:** no transport-level changes needed; the existing
`relatedRequestId` plumbing does exactly what the design requires.

## Lifecycle hook semantics for poll mode

**Design says:** `onSubscribe` fires "when a poll request introduces a new
subscription ID".

**Implemented:** `onSubscribe` fires whenever a poll subscription arrives with
`cursor: null`. Since the server is stateless, it cannot distinguish "new ID"
from "ID I've never seen before" — the `null` cursor is the bootstrap signal.

**Rationale:** the server is fully stateless for poll mode per the design. The
`null` cursor is the only observable "this is a new subscription" marker. This
means a client that sends `cursor: null` repeatedly will trigger `onSubscribe`
each time. In practice the client SDK never does this (it tracks cursors), but
a badly-behaved client could.

**Reversible:** a stateful server could track seen IDs, but that contradicts
the statelessness guarantee.

## Webhook subscription identity — compound key scoping

**Design says:** subscriptions are keyed by `(principal, id)` on authenticated
servers, `(delivery.url, id)` on unauthenticated servers. `id` must be ≥122
bits of entropy. Two scopes never overlap.

**Implemented:**
- `ServerEventManager._subscriptionKey(ctx, id, url)` produces a prefixed
  compound key (`p:<principal>\0<id>` or `u:<url>\0<id>`); the NUL byte rules
  out separator-injection collisions.
- `_getPrincipal` defaults to `ctx.http?.authInfo?.clientId` (the SDK's
  `AuthInfo` has no `sub` field; `clientId` is the closest canonical
  identifier). Servers with a real user subject override via
  `EventWebhookOptions.getPrincipal`.
- `id.length < 16` is rejected with `InvalidParams` as a cheap low-entropy
  guard. A UUIDv4 is 36 chars.
- `ClientEventManager` generates `crypto.randomUUID()` per subscription rather
  than a sequential counter.
- `events/unsubscribe` accepts optional `delivery.url`; required on
  unauthenticated servers to form the key, ignored when a principal is
  present.

**Mutable-on-refresh fields:** `name`, `params`, `secret`, TTL always replace.
`url` replaces only in principal scope (in url scope it's part of the key — a
different URL is a different subscription). `cursor: null` on refresh means
"keep the server's current position" (the refresh loop doesn't have to track
it); non-null replaces.

**Rationale (open question 2 resolution):** chose to require `delivery.url` in
unsubscribe params on unauthenticated servers rather than maintain a reverse
index. The reverse index would reintroduce a (bounded) cross-tenant collision
surface if two UUIDv4s ever collide; strictly keying on `(url, id)` eliminates
it.

## Webhook subscription `cursor` refresh semantics

**Design says:** `cursor: null` on refresh = keep server's current position;
non-null = replace. On a fresh subscription, `null` = bootstrap.

**Implemented:** yes. `_handleSubscribe` short-circuits the check callback when
refreshing with `cursor: null`, returning the existing cursor unchanged. A
non-null cursor invokes the check callback and replays any backlog — this is
the server-restart recovery path where the client's persisted cursor is the
source of truth.

**Rationale (open question 1 resolution):** a refresh loop that only cares
about TTL shouldn't have to track and re-send the cursor. The client SDK still
*does* send `sub.cursor` on refresh (not null) so that a restarted server can
resume from the client's position; the null path exists for clients that don't
persist cursors.

## Direct emit cursor advancement

**Design says:** "Each event notification on the push stream includes a
`cursor` field… The client tracks the latest cursor per subscription for use
during reconnection."

**Implemented:** for emit-driven events, the SDK assigns the `eventId` as the
cursor on each emitted event. This gives the client something to persist, but
the cursor is not meaningful to the check callback unless the server author's
upstream uses the same ID space.

**Rationale:** for pure emit-driven events (no check-callback history), there
is no upstream cursor to use. The `eventId` serves as a monotonic marker.

## `emit()` visibility to poll-mode clients (`bufferEmits`)

**Problem:** poll mode is stateless — the server doesn't know about poll
clients between requests, so `emit()` has nowhere to deliver. The design says
"direct emit works across all modes" but a naive implementation only reaches
push/webhook subscriptions.

**Implemented:** opt-in per-event ring buffer via `EventConfig.bufferEmits:
{ capacity }`. When set:

- Broadcast `emit()` calls append to a bounded in-memory buffer with a
  monotonic sequence number. Targeted emits (with `subscriptionId`) are not
  buffered — they address a specific push/webhook sub.
- `_pollOne()` wraps the check callback's cursor in a composite
  `JSON.stringify({ c: checkCursor, b: bufferSeq })`. On each poll it unwraps,
  passes the inner cursor to the check callback, scans the buffer for entries
  newer than `bufferSeq`, applies the `matches` filter, and merges both result
  sets.
- Bootstrap (`cursor: null`) sets `bufferSeq = nextSeq` — "start from now", no
  historical replay of buffered emits.
- If the ring buffer evicts entries the client hasn't seen (`bufferSeq <
  oldestRetainedSeq`), the poll returns `CursorExpired` and the client
  re-bootstraps.
- A non-composite cursor passed to a buffered event also returns
  `CursorExpired` (handles the case where `bufferEmits` was enabled after
  clients already held plain cursors).

**Trade-offs:** memory is bounded by `capacity × average_payload_size` per
event type. The composite cursor is visible to clients (it's JSON, not opaque)
but they're not expected to parse it — cursors remain opaque per spec.

## `ClientEventManager` push stream is a single shared request

**Design says:** updating subscriptions is done by "cancelling the current
stream and sending a new `events/stream` with the updated list."

**Implemented:** yes. All push-mode subscriptions share one `events/stream`
request. Adding or removing a subscription aborts the current stream and opens
a fresh one with the updated set (debounced so batch changes coalesce).

**Rationale:** matches the design.

## Webhook SSRF validation is best-effort hostname matching

**Design says:** "Servers SHOULD resolve the hostname and validate the resolved
IP before accepting the subscription to prevent DNS rebinding attacks."

**Implemented:** `isSafeWebhookUrl()` does hostname-pattern matching only. It
does not perform DNS resolution — that would require a Node-specific API and
the SDK targets multiple runtimes. The check normalises hostnames (strips IPv6
brackets, lowercases, unwraps IPv4-mapped IPv6 addresses) before pattern
matching to close the obvious bypass of `[::1]` vs `::1`.

**Covered:** RFC 1918 IPv4 ranges, loopback, link-local; IPv6 loopback (`::1`),
ULA (`fc00::/7`), link-local (`fe80::/10`); IPv4-mapped IPv6 in both dotted
(`::ffff:127.0.0.1`) and hex (`::ffff:7f00:1`) forms.

**Not covered:** DNS names that resolve to private IPs; deprecated RFC 2765
IPv4-translated addresses (`::ffff:0:a.b.c.d`); 6to4 tunnel prefixes. These
fall to delivery-time IP validation.

**Rationale:** DNS resolution is a deploy-time concern. Servers that need
rebinding protection can wrap `isSafeWebhookUrl()` or inject a custom `fetch`
that validates resolved IPs.

**Reversible:** a `resolveHostname?: (host: string) => Promise<string[]>`
option can be added without breaking the API.

## Webhook deliveries are concurrent (no per-subscription ordering)

**Design says:** out-of-order delivery is permitted for webhook mode.

**Implemented:** webhook POSTs for a single subscription fire concurrently
(`void this._deliverWebhook(...)`). A receiver handling a burst of N events may
observe them in any order; it MUST rely on `eventId` for deduplication and
`cursor` for resumption, not arrival order.

**Rationale:** serialising N deliveries adds N×round-trip latency for bursts.
Webhook receivers already have to handle retries and network reordering, so
strict server-side serialisation adds cost without changing the receiver's
contract. Poll and push modes retain per-subscription ordering (both deliver
over a single channel).

## Push-stream request timeout capped at 0x7FFFFFFF

**Design says:** the push stream stays open until explicitly cancelled.

**Implemented:** `ClientEventManager._openPushStream()` passes
`timeout: 0x7FFFFFFF` (max 32-bit signed int, ≈24.8 days) to the underlying
`Protocol.request()`. The SDK's default is 60 seconds, which would kill the
stream and force a reconnect every minute.

**Rationale:** Node's `setTimeout` clamps values larger than 2^31-1 to **1ms**
with a `TimeoutOverflowWarning`. `Number.MAX_SAFE_INTEGER` (the obvious "never"
value) triggers this, causing a tight reconnect loop. 0x7FFFFFFF is the safe
maximum.

**Reversible:** trivially — only one constant.

## No `ping` event on webhook subscribe

**Design says:** "The server SHOULD send a test POST to the callback URL during
initial subscription."

**Implemented:** not implemented. The first real event delivery serves as the
reachability test; if it fails, `deliveryStatus` surfaces the error on the next
refresh.

**Rationale:** a ping adds latency to the subscribe call and the `deliveryStatus`
feedback loop achieves the same diagnostic purpose. Easy to add if desired.

## Spec compatibility test (`spec.types.test.ts`)

**Not updated.** The Events types are SDK-only at this point (no corresponding
`spec.types.ts` types exist). Per the existing convention, the bidirectional
compat test auto-discovers spec types and ignores SDK-only types. When the
spec repo adds Events, the SDK types' optional/required alignment will need
review.

## Migration docs

**Not updated.** Events is additive — no breaking changes to document in
`docs/migration.md` or `docs/migration-SKILL.md`.

## Spec alignment 2026-04-10

Compared the implementation against `experimental-ext-triggers-events#1`
(`docs/design-sketch-proposal.md`, 928 lines). Changes made:

### Webhook secret is server-minted (the substantive change)

**Spec:** §"Secret generation" — server mints the signing secret and returns it
in the `events/subscribe` response on (re)create only; absent on refresh of an
existing subscription. Client MAY supply `delivery.secret` to override.

**Was:** client always supplied `delivery.secret` (required); server stored it;
result never carried `secret`.

**Now:**

- `WebhookDeliverySpecSchema.secret` → optional.
- `SubscribeEventResultSchema` gains `secret?: string`.
- Server `_handleSubscribe`: on create, `secret = client-supplied ?? generateWebhookSecret()`;
  on refresh, replaced only if client supplied. Result includes `secret` iff `isNew`.
- `generateWebhookSecret()` added to `eventWebhook.ts` (32 random bytes,
  `whsec_<hex>` prefix per Stripe / Standard Webhooks convention) and exported
  from `core/public`.
- Client `WebhookConfig.secret` → optional; new `onSecret(secret, subId)` callback;
  `EventSubscription.secret` field tracks the current value. `_activateWebhook`
  now omits `delivery.secret` unless an override is configured, and adopts
  `result.secret` whenever present.
- One new integration test; existing override-path tests unchanged.

**Judgment call:** when the client supplies an override on a (re)create, the
result still includes `secret` (echoing the override). The spec's only purpose
for the field is "presence ⇒ this was a (re)create", so echoing keeps that
signal intact and is harmless.

### `EventDescriptor.delivery` JSDoc

**Spec:** "any non-empty subset of poll/push/webhook. No mode is mandatory."
**Was:** JSDoc said `MUST include "poll"`. Updated JSDoc; schema unchanged.

### Divergences inspected and intentionally NOT changed

- **Error code numbers.** Spec uses `-32001..-32006`; SDK uses `-32011..-32016`.
  Aligning would collide with the existing `ProtocolErrorCode.ResourceNotFound = -32002`
  in this SDK. **Spec needs to move** — either to the `-3201x` range or by
  reassigning `ResourceNotFound`. Left as-is.
- **`Unauthorized` vs `EventUnauthorized`.** Spec table uses bare `Unauthorized`;
  SDK enum uses `EventUnauthorized`. Kept the prefixed name —
  `ProtocolErrorCode.Unauthorized` would read as a generic auth error, not an
  events-scoped one.
- **`notifications/event` method name.** Spec is internally inconsistent: the
  mermaid diagram (line 249) says `notifications/events/event`, the JSON example
  (line 297) says `notifications/event`. SDK already uses `notifications/event`,
  matching the JSON example. Left as-is; flag for spec cleanup.
- **`ServerCapabilities.events.listChanged`.** Spec example shows only
  `{ subscribe: true }` but defines `notifications/events/list_changed`. Kept
  `listChanged` in the capability shape for consistency with
  tools/resources/prompts.
- **Everything else** (poll/stream/subscribe/unsubscribe request+result shapes,
  `EventOccurrence`, subscription identity, `deliveryStatus`, HMAC headers and
  signed-string format, SSRF rules, heartbeat, terminated notification, cursor
  semantics, `bufferEmits` ring buffer) — already matched the spec.

### Not touched

`examples/client/src/eventsClient.ts` still demonstrates the override path
(hardcoded `secret: 'example-secret-please-change'`). Left per directive; it
typechecks and works, just isn't the new default flow.

## Spec deltas 2026-04-15

Applied the revision deltas from `experimental-ext-triggers-events/docs/design-sketch-revision-deltas.md`. Per-delta status:

| # | Delta | Status |
|---|---|---|
| 1 | Webhook cursor model — server no longer tracks watermark | **Applied.** Removed `cursor` from `SubscribeEventResultSchema` and the server return. Kept `sub.cursor` as the *upstream-poll* position (needed for the check() loop, distinct from a delivery watermark — we never had advance-on-ack logic). `emit()` no longer overwrites `sub.cursor` with eventId. Client `_activateWebhook` no longer reads `result.cursor`. |
| 2 | `delivery.url` always in subscription key | **Applied.** `_subscriptionKey` authenticated path → `p:<principal>\0<url>\0<id>`. URL-mutation-on-refresh branch removed. `UnsubscribeEventRequestParams.delivery` is now required. Principal-scope test rewritten: different URL ⇒ new sub. |
| 3 | `events/stream` no longer replaces GET SSE | **Already compliant.** We never removed GET SSE or routed non-event notifications onto `events/stream`. Empty-subscriptions stream is accepted and just heartbeats. |
| 4 | Poll lease key → `(principal, eventName, canonicalHash(params))` | **Gap — not applied.** We have no poll-mode lease table; `onSubscribe` fires on every `cursor: null` poll. The delta's "was" and "now" both assume a lease table that doesn't exist here. Adding one is a separate feature. |
| 5 | Broadcast emit requires author-supplied `match()` | **Already compliant.** Our `EventConfig.matches: (params, data) => bool` is the equivalent (arg order/name differs from spec's `match(event, params)`, kept as established SDK API). No-hook ⇒ deliver-to-all behaviour confirmed at `events.ts` `emit()` and `_pollOne()`. |
| 6 | DNS-rebinding mitigation at delivery time | **Applied.** New `EventWebhookOptions.resolveHost: HostResolver` (defaults to dynamic-import of `node:dns/promises` `lookup`). `_resolveDeliveryTarget()` runs on every POST: resolves all addresses, rejects if any is private/loopback (via new exported `isPrivateAddress`/`normaliseHostname`). For `http:` rewrites the URL to the validated IP and sends `Host: <original>`; for `https:` keeps the hostname (TLS SNI/cert needs it) leaving a small TOCTOU window. Subscribe-time check retained as early-reject. **Dynamic import** keeps CF Workers builds working without `nodejs_compat`. |
| 7 | `X-MCP-Timestamp` SHOULD → MUST | **Already compliant.** `_postWebhook` always sends it; `verifyWebhookSignature` already rejects when missing. |
| 8 | `StreamEventsResult` only when server can write final frame | **Already compliant in practice.** `_handleStream` resolves `{}` unconditionally; on client-initiated HTTP disconnect the transport layer cannot write it, on server-initiated close/stdio it can. No code change. |
| 9 | Webhook `CursorExpired` / terminated → POST signed error envelope | **Applied.** New `_deliverWebhookError(sub, error)` posts `{"id", "error":{code,message,data}}` via the same signed `_postWebhook` path. Called from `terminate()` (for webhook subs) and `_scheduleWebhookPoll`'s CursorExpired catch. Refresh response now surfaces the *prior* `deliveryStatus` (with `lastError`) before reactivating. Terminal client webhook listener handles bodies with top-level `error`. |
| 10 | Endpoint MUST forward `cursor`/`eventId` | **Applied.** Terminal client `printOccurrence` now includes `cursor=`. `eventId` was already shown. |
| 11–13 | Wording softened / qualified / v1 gap acknowledged | No-op (docs only). |
| 14 | Wire-format corrections | **Applied:** `notifications/event` → `notifications/events/event` (schema, server, server.ts capability switch, client handler, tests). `nextPollSeconds` already per-result-entry. Heartbeat now sends `params: {}`. **Kept divergent:** error-code numbers stay -32011..-32016 — spec's -32004 collides with `ResourceNotFound = -32002` range; still needs spec fix. |

### Judgment calls

- **#1 nuance:** "delete server-side per-subscription cursor field" interpreted as the *delivery watermark*, not the upstream check-callback cursor. The latter is essential for poll-driven webhook delivery and is not a delivery-ack position.
- **#6 HTTPS TOCTOU:** Full pin-to-IP for HTTPS would require a custom undici dispatcher with SNI override. Deferred; documented in `_resolveDeliveryTarget` JSDoc. Users needing strict pinning supply a custom `fetch`.
- **#9 refresh semantics:** Previously refresh cleared `lastError`; now it returns the *prior* status (so client sees the error) and *then* clears `failedSince`/reactivates. `lastError` is preserved across refresh until a successful delivery overwrites it.

## Buffer replay fix 2026-04-15

Three bugs prevented push and webhook subscriptions from resuming via cursor when the event used `bufferEmits`:

1. **`emit()` set the wrong cursor on live deliveries.** Push and webhook fan-out wrote `cursor = occurrence.eventId` on each notification — but the resume path (`decodeCompositeCursor`) only understands cursors of the form `{c, b}` produced by `encodeCompositeCursor`. So when a client captured a printed cursor and pasted it back as the resume cursor, the server treated it as malformed → CursorExpired.

2. **`_openStream` (push bootstrap) ignored the buffer.** It only delivered `event.check()` results. For emit-only events whose check returns nothing, the backlog was always empty regardless of the cursor.

3. **`_handleSubscribe` (webhook bootstrap) had the same bug.** Same shape — only `event.check()` results were replayed.

### Fix

Extracted the existing poll-path bootstrap into a shared `_bootstrapFromCursor(event, eventName, params, rawCursor, ctx)` helper. It decodes the composite cursor, runs `event.check()` against the unwrapped check-cursor, scans `event.buffer.entries` for entries with `seq >= bufferSeq`, returns the merged backlog and a re-encoded composite cursor. All three handlers (`_pollOne`, `_openStream`, `_handleSubscribe`) now use it.

`emit()` now encodes a composite cursor `{c: '', b: assignedSeq + 1}` on each live delivery when the event has a buffer. The `b` is "next seq to deliver" so resume picks up exactly the next emit. Events without a buffer keep the eventId fallback (no resume is possible anyway).

The polling tick functions (`_schedulePushPoll`, `_scheduleWebhookPoll`) now decode the composite cursor before passing it to `event.check()` and re-encode after, via a small `_decodeCursorForCheck` helper. This keeps `sub.cursor` consistently composite for buffered events without breaking check callbacks that read the cursor.

### Known limitation

When emit() runs while a poll-driven push/webhook sub is also running, the live delivery's cursor encodes `c: ''` — losing whatever check-cursor the SDK had last seen. If the client then disconnects and resumes from that emit's cursor, the next `event.check()` call gets `''` instead of the real position. For events whose check ignores the cursor (counter.tick, pure emit-only events) this is fine. For dual-driven events whose check uses the cursor to derive history, position is lost on resume across an emit boundary.

The proper fix is for emit() to know the most recent check-cursor per active sub, which would require maintaining that state on `ActiveSubscription`. Out of scope for this fix; documented here for future reference.

### Tests

Added 4 cases to `events.test.ts`:
- push subscribe with prior cursor replays buffered emits since that cursor
- push subscribe with cursor older than buffer head returns CursorExpired
- webhook subscribe with prior cursor replays buffered emits since that cursor (verifies via `fetchMock`)
- webhook subscribe with cursor older than buffer head returns CursorExpired

49 → 53 events tests; 471 → 475 integration total.

### Live E2E (`/tmp/events-replay-e2e.log`)

`sub counter.tick push` → captured cursor `{"c":"","b":3}` after value=2 → `unsub` → 5s gap (server emits values 3-7 to nobody) → `sub counter.tick push --from {"c":"","b":3}` → received values 4-12. Confirms end-to-end push replay works through the CLI.

## Single opaque cursor 2026-04-15

Replaced the composite cursor model (`encodeCompositeCursor({c, b})`) with a single opaque application-defined cursor. The previous design leaked delivery internals — clients saw base64-encoded JSON, replay had to decode/re-encode in three handlers, and buffer-replay events all shared one batch cursor (no mid-replay resume).

### What changed

- `EventOccurrence.cursor: string` is now **required** (was optional). Every delivered event carries a unique, resumable cursor.
- `emit(name, data, opts?)` now accepts `{cursor?: string, subscriptionId?: string}`. App-provided cursors flow through verbatim; omitted cursors get auto-assigned `seq-N` per event-name.
- `EventCheckResult.events[].cursor` is now optional per event (was disallowed). Same auto-assign fallback when absent.
- `EventConfig.bufferEmits: { capacity }` renamed to `EventConfig.buffer: { capacity? }`. Buffer is **always on** with default capacity 1000; supply `buffer: { capacity }` only to override.
- Server keeps a unified `EventLog` per event-name: `{entries, cursorMap, nextSeq, autoCursorCounter}`. Both `emit()` and `check()` results flow through the log; replay is a simple `cursorMap.get(cursor)` → seq lookup → return entries with `seq > N`.
- Resume from a cursor that's not in the log → `CursorExpired` (regardless of buffer state). Resume from `null` cursor with prior poll state → continue from server-tracked `lastSeenSeq`.

### What went away

- `encodeCompositeCursor` / `decodeCompositeCursor` / `_decodeCursorForCheck` (deleted entirely)
- `_bootstrapFromCursor` (replaced by the much simpler `_replayAfterCursor` + `_runCheckTick`)
- The "buffer seq vs check cursor" mental model
- Per-event vs batch cursor distinction (every event has a unique cursor by definition now)

### Server-side state

Per-poll-subscription state keyed by `(principal-or-anon, eventName, subId)` tracks `{checkCursor, lastSeenSeq}`. Capped at 10k entries with FIFO eviction. Added because the wire cursor is now opaque (just an event cursor) and can't double as a check cursor — the server needs its own place to remember "where check should resume" and "what's the highest seq this client has been delivered."

### Migration

This is a breaking change. Pre-existing composite cursor strings (base64 JSON `eyJ...`) won't be in any new log's cursorMap → `CursorExpired` → client re-subscribes with `null`. Acceptable since events is pre-spec; we own the only consumers.

### Trade-off

Buffer-as-canonical-log adds memory cost: events that previously bypassed the buffer (registered without `bufferEmits`) now persist in a 1000-entry default ring. Apps with high-volume emits should set explicit `buffer: { capacity }`. The simplicity win is bigger than the memory cost for normal usage.

### Docs note: emit-only events

When an event is purely emit-driven (no upstream polling), the `check` callback can be a stub: `async () => ({ events: [], cursor: '', nextPollSeconds: 60 })`. The `nextPollSeconds: 60` keeps the wasted polling tick rate low. Future work: making `check` optional for emit-only events would remove this E1 boilerplate (still tracked in stress report).
