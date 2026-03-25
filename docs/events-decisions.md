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
