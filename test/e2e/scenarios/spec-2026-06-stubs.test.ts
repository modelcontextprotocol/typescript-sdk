/**
 * 2026-06 spec release backlog — failing stubs.
 *
 * One stub per new requirement from the SEP-2260 + SEP-2575/2567 backlog (see the
 * matching entries at the bottom of requirements.ts). Every body deliberately throws,
 * and every requirement carries a knownFailure, so these register as expected-fail
 * cells: the executable todo list for the next spec release.
 *
 * Implementing a requirement = replace its stub with a real assertion (move it to the
 * appropriate area file), make it pass, and delete the knownFailure from the manifest.
 * The TODO on each stub sketches the intended assertion; sub-batch labels (P0, G0,
 * S1–S9) give the proposed implementation order — see the backlog PR description.
 */

import { verifies } from '../helpers/verifies.js';

const stub = (plan: string): never => {
    throw new Error(`stub: not yet asserted — ${plan}`);
};

// ── P0 · SEP-2260 server-request association ──

verifies('protocol:assoc:nested-on-originating-stream', async () => {
    stub(
        'TODO(P0): during tools/call with a sampling/elicit handler, assert the server request arrives on the originating POST SSE stream, never a separate channel'
    );
});

verifies('protocol:assoc:keepalive-during-nested', async () => {
    stub(
        'TODO(P0): long-running tools/call with nested elicit; assert SSE keepalive comments observed on the response stream while waiting'
    );
});

verifies('protocol:assoc:client-rejects-unsolicited', async () => {
    stub('TODO(P0): harness-as-server pushes sampling/createMessage with no pending outbound request; assert client responds -32602');
});

verifies('protocol:assoc:get-stream-no-requests', async () => {
    stub('TODO(P0): open the GET SSE stream and trigger server activity; assert no roots/sampling/elicitation requests ever appear on it');
});

verifies('protocol:assoc:no-unsolicited-api', async () => {
    stub('TODO(P0): assert the server API offers no way to send an elicit/sample/roots request outside a request handler context');
});

verifies('protocol:assoc:ping-exempt', async () => {
    stub('TODO(P0): assert server-initiated ping is still delivered and answered outside any originating request');
});

// ── G0 · groundwork: version negotiation + the NotImplemented gate ──

verifies('lifecycle:version:2026-pin-per-instance', async () => {
    stub('TODO(G0): construct client and server pinned to ["2026-06"]; assert negotiation outside that list is refused on both sides');
});

verifies('lifecycle:version:2026-negotiable', async () => {
    stub('TODO(G0): client and server both supporting 2026-06 agree on it; assert the agreed version is observable on both ends');
});

verifies('lifecycle:version:2026-gate-not-implemented', async () => {
    stub(
        'TODO(G0): negotiate 2026-06, call tools/list and tools/call; assert each fails fast with a NotImplemented error while a 2025 client on the same server works'
    );
});

verifies('protocol:envelope:ctx-version-readable', async () => {
    stub(
        'TODO(G0): register a tool that echoes the protocol version from its handler context; assert it matches the negotiated/per-request version in both modes'
    );
});

// ── S1 · server/discover + version-negotiation errors ──

verifies('discover:basic', async () => {
    stub('TODO(S1): send server/discover; assert supportedVersions, capabilities, and serverInfo in the result');
});

verifies('lifecycle:version:unsupported-error-32004', async () => {
    stub('TODO(S1): send a request with protocolVersion "9999-01-01"; assert -32004 with the supported version list in error data');
});

verifies('lifecycle:version:unknown-method-32601', async () => {
    stub('TODO(S1): call a nonexistent method with a valid 2026 envelope; assert -32601 and HTTP 404');
});

verifies('lifecycle:version:client-retries-from-supported', async () => {
    stub(
        'TODO(S1): server advertises only 2026-06; client prefers an unsupported draft; assert the client retries with a version from supported[] and never sends initialize'
    );
});

verifies('lifecycle:version:client-retry-any-request', async () => {
    stub('TODO(S1): tools/list at version X gets -32004 with supported [Y]; assert the client retries tools/list at Y');
});

// ── S2 · client _meta envelope stamping ──

verifies('client-transport:meta:protocol-version-every-request', async () => {
    stub('TODO(S2): tap outbound 2026 requests; assert every one carries _meta io.modelcontextprotocol/protocolVersion');
});

verifies('client-transport:meta:clientinfo-every-request', async () => {
    stub('TODO(S2): tap outbound 2026 requests; assert clientInfo with name and version on every request');
});

verifies('client-transport:meta:capabilities-every-request', async () => {
    stub('TODO(S2): tap outbound 2026 requests; assert clientCapabilities present (possibly {}) on every request');
});

verifies('client-transport:http:version-header-every-post', async () => {
    stub('TODO(S2): record raw POSTs; assert MCP-Protocol-Version header on every one, equal to the _meta value');
});

verifies('client-transport:stdio:meta-envelope', async () => {
    stub('TODO(S2): over stdio, tap outbound 2026 requests; assert the full _meta envelope is present without any header mechanism');
});

// ── S3 · server envelope acceptance + enforcement ──

verifies('protocol:envelope:missing-version-rejected', async () => {
    stub('TODO(S3): hand-craft a 2026-mode request without _meta protocolVersion; assert -32602');
});

verifies('protocol:envelope:missing-clientinfo-rejected', async () => {
    stub('TODO(S3): hand-craft a 2026-mode request without _meta clientInfo; assert -32602');
});

verifies('hosting:http:header-meta-version-mismatch-400', async () => {
    stub('TODO(S3): POST with header 2025-11-25 but _meta 2026-06; assert HTTP 400');
});

verifies('protocol:envelope:caps-not-inherited-across-requests', async () => {
    stub('TODO(S3): request 1 declares sampling, request 2 declares {}; assert request 2 gets -32003 when the handler needs sampling');
});

verifies('protocol:envelope:undeclared-capability-32003', async () => {
    stub('TODO(S3): handler needs elicitation, request _meta capabilities omit it; assert -32003 with requiredCapabilities in error data');
});

verifies('hosting:http:no-version-header-treated-legacy', async () => {
    stub('TODO(S3): POST without MCP-Protocol-Version or _meta version; assert it is served as 2025-03-26 legacy traffic, not rejected');
});

// ── S4 · backward-compatibility probe matrix ──

verifies('lifecycle:compat:dual-server-answers-initialize', async () => {
    stub('TODO(S4): dual-stack server; legacy client sends initialize; assert InitializeResult and a working 2025 session');
});

verifies('lifecycle:compat:client-probes-discover-stdio', async () => {
    stub('TODO(S4): dual-era client over stdio; assert its first message is server/discover with the preferred modern version in _meta');
});

verifies('lifecycle:compat:client-falls-back-to-initialize', async () => {
    stub('TODO(S4): server answers discover with -32601; assert the client sends initialize next and completes the legacy handshake');
});

verifies('lifecycle:compat:mixed-era-one-pipe', async () => {
    stub(
        'TODO(S4): one stdio server receives discover (modern) then initialize (legacy) on the same pipe; assert both are answered correctly'
    );
});

// ── S5 · sessionless + stateless HTTP ──

verifies('hosting:sessionless:no-session-header', async () => {
    stub('TODO(S5): 2026-mode POST without Mcp-Session-Id is handled; assert no Mcp-Session-Id header on any response');
});

verifies('transport:base:no-session-concept', async () => {
    stub('TODO(S5): assert the 2026 transport surface exposes no session identifier (type-level and runtime)');
});

verifies('hosting:sessionless:get-405', async () => {
    stub('TODO(S5): GET the MCP endpoint in 2026 mode; assert 405 and no SSE stream');
});

verifies('hosting:sessionless:no-batching', async () => {
    stub('TODO(S5): POST a JSON-RPC batch array; assert 400');
});

verifies('hosting:sessionless:per-request-auth', async () => {
    stub('TODO(S5): authenticated request succeeds; immediately following unauthenticated request on the same connection is rejected');
});

verifies('hosting:sessionless:no-connection-affinity', async () => {
    stub('TODO(S5): run the same two requests over one connection and over two; assert identical results');
});

verifies('protocol:stateless:list-connection-independent', async () => {
    stub('TODO(S5): two clients with the same auth call tools/list over separate connections; assert identical results');
});

verifies('protocol:stateless:list-no-side-effects', async () => {
    stub('TODO(S5): tools/list, tools/call, tools/list on one connection; assert both lists identical');
});

verifies('protocol:request-id:outstanding-scope', async () => {
    stub('TODO(S5): reuse a request id after its first request completed; assert the second request is served normally');
});

verifies('client-transport:http:accept-both-content-types', async () => {
    stub(
        'TODO(S5): record raw 2026 POSTs; assert Accept includes application/json and text/event-stream; serve each form and assert both parse'
    );
});

verifies('hosting:http:notification-202', async () => {
    stub('TODO(S5): POST a notification in 2026 mode; assert HTTP 202 with no body');
});

verifies('hosting:http:stream-notifications-relate-to-request', async () => {
    stub('TODO(S5): tools/call with progress; assert progress notifications on the response stream carry the originating progressToken');
});

// ── S6 · removed RPCs + per-request logging ──

verifies('protocol:removed:ping-32601', async () => {
    stub('TODO(S6): send ping under a 2026 envelope; assert -32601');
});

verifies('protocol:removed:subscribe-32601', async () => {
    stub('TODO(S6): send resources/subscribe and resources/unsubscribe under 2026; assert -32601 for both');
});

verifies('protocol:removed:setlevel-32601', async () => {
    stub('TODO(S6): send logging/setLevel under 2026; assert -32601');
});

verifies('protocol:removed:initialize-32601-2026-only', async () => {
    stub('TODO(S6): server configured 2026-only; send initialize; assert -32601');
});

verifies('logging:per-request:loglevel-opt-in', async () => {
    stub('TODO(S6): handler logs during a request without _meta logLevel; assert no notifications/message on the stream');
});

verifies('logging:per-request:level-respected', async () => {
    stub('TODO(S6): request with _meta logLevel "warning"; handler logs debug and error; assert only the error notification is delivered');
});

// ── S7 · subscriptions/listen ──

verifies('subscriptions:listen-basic', async () => {
    stub(
        'TODO(S7): subscriptions/listen with a toolsListChanged filter; register a tool; assert the change notification arrives on the listen stream'
    );
});

verifies('subscriptions:filter-required', async () => {
    stub('TODO(S7): subscriptions/listen without a notifications filter; assert an error response');
});

verifies('subscriptions:opt-in-only', async () => {
    stub('TODO(S7): listen opted into toolsListChanged only; trigger a resource update; assert it is not delivered');
});

verifies('subscriptions:ack-first-message', async () => {
    stub('TODO(S7): open a listen stream; assert the first event is notifications/subscriptions/acknowledged');
});

verifies('subscriptions:subscription-id-on-notifications', async () => {
    stub('TODO(S7): assert every notification delivered on the stream carries _meta subscriptionId equal to the listen request id');
});

verifies('subscriptions:cancel-stops-delivery', async () => {
    stub('TODO(S7): cancel the listen request; trigger more changes; assert no further notifications are delivered');
});

verifies('subscriptions:server-teardown-closes', async () => {
    stub(
        'TODO(S7): server tears down the subscription; assert the SSE stream closes (HTTP) or notifications/cancelled is sent for the listen request (stdio)'
    );
});

verifies('subscriptions:no-requests-on-response-streams', async () => {
    stub('TODO(S7): inspect all response streams; assert only notifications and the final result appear, never JSON-RPC request frames');
});

verifies('subscriptions:stdio-resubscribe-after-restart', async () => {
    stub('TODO(S7): restart the stdio server process; assert the client re-sends subscriptions/listen with the same filter');
});

verifies('subscriptions:client-routes-by-subscription-id', async () => {
    stub('TODO(S7): two concurrent listens with different filters; assert each notification reaches only the matching handler');
});

// ── S8 · cancellation / SSE-close semantics ──

verifies('protocol:cancel:sse-close-cancels', async () => {
    stub('TODO(S8): close the SSE response stream mid-request; assert the handler abort signal fires and no further events are written');
});

verifies('protocol:cancel:stdio-notification-2026', async () => {
    stub('TODO(S8): cancel an in-flight 2026 stdio request; assert notifications/cancelled is emitted with the request id');
});

verifies('protocol:cancel:no-messages-after-cancel-2026', async () => {
    stub('TODO(S8): cancel a 2026 request; assert the server emits nothing further for it');
});

verifies('hosting:resume:not-honored-2026', async () => {
    stub('TODO(S8): reconnect with Last-Event-ID in 2026 mode; assert no buffered events are replayed');
});

// ── S9 · lands with the MRTR (SEP-2322) series ──

verifies('mrtr:roots-via-input-required', async () => {
    stub(
        'TODO(MRTR): handler asks for roots under 2026; assert the response is an InputRequiredResult containing a roots/list input request, not a pushed server request'
    );
});
