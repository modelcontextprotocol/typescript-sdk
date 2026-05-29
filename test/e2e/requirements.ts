/**
 * Requirements manifest for the e2e suite.
 *
 * Each entry documents one behavior the SDK must satisfy, links to the test
 * cases that prove it, and records known failures (where the SDK does not yet
 * meet the requirement) and structural skips (where a transport cannot express
 * the behavior).
 */

import type { Requirement } from './types.js';

/** Transports with a persistent server instance / standalone notification stream. */
const STATEFUL_TRANSPORTS = ['inMemory', 'stdio', 'streamableHttp'] as const;

export const REQUIREMENTS: Record<string, Requirement> = {
    // Lifecycle & version negotiation

    'lifecycle:capability:client-not-declared': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#operation',
        behavior: 'The client rejects sending notifications or registering handlers for capabilities it did not declare.',
        note: 'Under stateless hosting each request is served by a new server instance, so state set up earlier in the session cannot be observed.'
    },
    'lifecycle:capability:server-not-advertised': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#operation',
        behavior: 'The client rejects calls to methods (e.g. resources/list) for capabilities the server did not advertise.'
    },
    'lifecycle:initialize:basic': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#initialization',
        behavior:
            'Connecting sends initialize with the protocol version, client capabilities, and client info; the server responds with its own and the connection is established.'
    },
    'lifecycle:initialize:instructions': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#initialization',
        behavior: 'A server may include an instructions string in the initialize result; the client exposes it.'
    },
    'lifecycle:initialized-notification': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#initialization',
        behavior: 'After successful initialization, the client sends exactly one initialized notification, before any non-ping request.'
    },
    'lifecycle:ping': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/ping#behavior-requirements',
        behavior: 'ping in either direction returns an empty result.'
    },
    'lifecycle:version:downgrade': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#version-negotiation',
        behavior:
            'When the server returns an older supported protocol version, the client downgrades to it and the connection succeeds at that version.'
    },
    'lifecycle:version:match': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#version-negotiation',
        behavior:
            'When the server supports the requested protocol version it echoes that version in the initialize result, and the connection proceeds at that version.'
    },
    'lifecycle:version:reject-unsupported': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#version-negotiation',
        behavior: 'When server returns a protocolVersion the client does not support, connect rejects and the transport is closed.',
        knownFailures: [
            {
                transport: 'stdio',
                note: 'connect rejects but client.transport is not cleared on stdio (other transports clear it)'
            }
        ]
    },
    'lifecycle:capability:experimental-passthrough': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#capability-negotiation',
        behavior:
            'Server-declared capabilities.experimental entries (vendor-namespaced keys, arbitrary object values) survive the initialize handshake and are exposed verbatim via client.getServerCapabilities().experimental; an undeclared key reads as undefined. Symmetric for client→server via getClientCapabilities().',
        note: 'Under stateless hosting each request is served by a new server instance, so state set up earlier in the session cannot be observed.'
    },
    'lifecycle:connect:onerror-pre-handshake': {
        source: 'sdk',
        behavior:
            'Transport errors emitted after transport.start() but before client.connect() resolves are delivered to a client.onerror handler set prior to connect (Protocol wires transport.onerror before start() and before the initialize handshake).',
        transports: ['stdio'],
        note: 'The behavior itself is transport-agnostic but the garbage injection needs a real child process.'
    },
    'lifecycle:initialize:server-info': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#initialization',
        behavior: 'The initialize result identifies the server: name and version, plus title when declared.'
    },
    'lifecycle:initialize:client-info': {
        source: 'sdk',
        behavior: "The client's name, version, and title are visible to server handlers after initialization.",
        transports: STATEFUL_TRANSPORTS,
        note: 'Under stateless hosting each request is served by a new server instance, so state set up earlier in the session cannot be observed.'
    },
    'lifecycle:version:server-fallback-latest': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#version-negotiation',
        behavior:
            'An initialize request carrying a protocol version the server does not support is answered with another version the server supports — the latest one — rather than an error.'
    },
    'lifecycle:pre-initialization-ordering': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#initialization',
        behavior:
            'Before initialization completes, the client sends no requests other than pings, and the server sends no requests other than pings and logging.'
    },
    'lifecycle:initialize:capabilities:minimal': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#capability-negotiation',
        behavior: 'A server with no feature handlers advertises no feature capabilities.'
    },
    'typescript:server:get-client-capabilities': {
        source: 'sdk',
        behavior:
            'After initialize, Server.getClientCapabilities() returns the capabilities object the client sent in InitializeRequest.params.capabilities; before initialize it returns undefined. Servers use this to gate optional features (e.g. dynamic registration) on what the connected client declared.',
        transports: STATEFUL_TRANSPORTS,
        note: 'Under stateless hosting each request is served by a new server instance, so state set up earlier in the session cannot be observed.'
    },

    // Protocol primitives: cancellation, timeout, progress, errors, _meta

    'protocol:cancel:abort-signal': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation#cancellation-flow',
        behavior:
            'Cancelling an in-flight request through the client API sends notifications/cancelled with the request id and fails the local call.'
    },
    'protocol:cancel:handler-abort-propagates': {
        transports: STATEFUL_TRANSPORTS,
        source: 'sdk',
        behavior: 'On the receiving side, a cancellation notification stops the running request handler.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'protocol:cancel:initialize-not-cancellable': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation#behavior-requirements',
        behavior: 'The client never sends notifications/cancelled for the initialize request.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.',
        knownFailures: [
            {
                note: 'SDK sends notifications/cancelled for initialize when connect() is aborted; spec says initialize MUST NOT be cancelled.'
            }
        ]
    },
    'protocol:cancel:late-response-ignored': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation#timing-considerations',
        behavior:
            'A response that arrives after the sender issued notifications/cancelled is ignored; the request stays failed and no error is raised.',
        knownFailures: [
            {
                note: 'late response after cancellation fires client.onerror; spec says silently ignore'
            }
        ]
    },
    'protocol:cancel:unknown-id-ignored': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation#error-handling',
        behavior:
            'The receiver silently ignores a cancellation notification referencing an unknown or already-completed request id; no error response is sent and no exception is raised.'
    },
    'typescript:protocol:error:connection-closed': {
        source: 'sdk',
        behavior: 'Closing the transport invokes onclose and rejects all in-flight requests with ErrorCode.ConnectionClosed.',
        knownFailures: [
            {
                transport: 'stdio',
                note: 'in-process stdio does not fire client.onclose after close()'
            }
        ]
    },
    'protocol:error:internal-error': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic#responses',
        behavior: 'An unhandled exception in a request handler is returned to the caller as JSON-RPC error -32603 Internal error.'
    },
    'protocol:error:invalid-params': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic#responses',
        behavior: 'A request with malformed params is answered with JSON-RPC error -32602 Invalid params.'
    },
    'protocol:error:method-not-found': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic#responses',
        behavior: 'A request whose method has no registered handler is answered with a METHOD_NOT_FOUND error.'
    },
    'protocol:error:reconnect-no-stale-timers': {
        transports: STATEFUL_TRANSPORTS,
        source: 'sdk',
        behavior: 'Reconnecting on the same Protocol instance after close does not leave stale timers that fire spurious cancellations.',
        note: 'Under stateless hosting each request is served by a new server instance, so state set up earlier in the session cannot be observed.'
    },
    'protocol:progress:callback': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress#progress-flow',
        behavior:
            "Progress notifications emitted by a handler during a request are delivered to the caller's progress callback, in order, with their progress, total, and message."
    },
    'typescript:protocol:progress:token-injected': {
        source: 'sdk',
        behavior: 'Passing onprogress causes a progressToken to be injected into request _meta, preserving existing _meta fields.'
    },
    'protocol:progress:token-unique': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress#progress-flow',
        behavior: 'Concurrent in-flight requests that each supply a progress callback carry distinct progress tokens.'
    },
    'protocol:timeout:basic': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#timeouts',
        behavior: 'A request that exceeds its read timeout fails with a request-timeout error instead of waiting forever for the response.'
    },
    'protocol:timeout:max-total': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#timeouts',
        behavior: 'A maximum total timeout is enforced even when progress notifications keep arriving.'
    },
    'protocol:timeout:reset-on-progress': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#timeouts',
        behavior: "When configured to do so, each progress notification resets the request's read timeout."
    },
    'protocol:timeout:sends-cancellation': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#timeouts',
        behavior: 'When a request times out, the sender issues notifications/cancelled for that request before failing the local call.'
    },
    'mcpserver:onerror:reach-through': {
        source: 'sdk',
        behavior:
            'Setting mcpServer.server.onerror (or server.onerror on raw Server) receives both transport-level errors and protocol/handler errors (uncaught notification handler, failed-to-send-response, unknown-message-id). The reach-through via McpServer.server is the supported access path until McpServer exposes onerror directly.'
    },
    'protocol:custom-method:notification': {
        transports: STATEFUL_TRANSPORTS,
        source: 'sdk',
        behavior:
            "server.notification({method:'x/custom', params}) reaches a client.setNotificationHandler(CustomSchema, ...) registered for that non-spec method; the handler fires with Zod-parsed params and no capability error is raised on either side.",
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'protocol:custom-method:request': {
        source: 'sdk',
        behavior:
            "A user-defined request schema registered via server.setRequestHandler(CustomSchema, h) is dispatched when client.request({method:'x/custom', params}, CustomResultSchema) is called; the handler's return value is parsed by the result schema and resolved to the caller. Capability checks do not reject non-spec method names."
    },
    'protocol:custom-method:roundtrip': {
        source: 'sdk',
        behavior:
            "server.setRequestHandler with a schema whose method literal is NOT in the MCP spec registers a handler; client.request({method:'<custom>'}, ResultSchema) returns the handler's result, not -32601 MethodNotFound. Capability assertions on both sides pass through unknown methods."
    },
    'protocol:custom-notification:roundtrip': {
        source: 'sdk',
        behavior:
            "server.setNotificationHandler(CustomNotifSchema, h) registers a handler for a non-spec method; client.notification({method:'myorg/event', params}) delivers to it and h receives the schema-parsed notification."
    },
    'protocol:error:data-roundtrip': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic#responses',
        behavior:
            'A request handler that throws McpError(code, message, data) produces a JSON-RPC error whose error.data equals the thrown data; the client-side rejection is an McpError with .data deep-equal to the original object.'
    },
    'protocol:fallback-notification-handler': {
        source: 'sdk',
        behavior:
            'Setting fallbackNotificationHandler on a Client/Server receives any inbound notification whose method has no registered handler; notifications with a method-specific handler do not reach it.'
    },
    'protocol:handler:re-register-replaces': {
        transports: STATEFUL_TRANSPORTS,
        source: 'sdk',
        behavior:
            'Calling setRequestHandler() twice for the same method replaces the prior handler (no throw, no chaining); subsequent inbound requests dispatch only to the latest handler.',
        note: 'Under stateless hosting each request is served by a new server instance, so state set up earlier in the session cannot be observed.'
    },
    'protocol:request-handler:override-builtin': {
        source: 'sdk',
        behavior:
            'server.setRequestHandler() for a spec method that has a built-in handler (initialize, ping, logging/setLevel) replaces that handler; the user-supplied result is what the client receives. No throw on re-registration.'
    },

    // Tools

    'tools:call:content:audio': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/tools#audio-content',
        behavior: 'A tool result can carry audio content: base64 data with a mimeType.'
    },
    'tools:call:content:embedded-resource': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/tools#embedded-resources',
        behavior: 'A tool result can carry an embedded resource with full text or blob contents.'
    },
    'tools:call:content:image': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/tools#image-content',
        behavior: 'A tool result can carry image content: base64 data with a mimeType.'
    },
    'tools:call:content:mixed': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool-result',
        behavior: 'A tool result can carry multiple content blocks of different types; order is preserved.'
    },
    'tools:call:content:resource-link': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/tools#resource-links',
        behavior: 'A tool result can carry a resource_link content block referencing a resource by URI.'
    },
    'tools:call:content:text': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/tools#text-content',
        behavior: 'tools/call delivers arguments to the tool handler and returns its text content to the caller.'
    },
    'tools:call:elicitation-roundtrip': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#user-interaction-model',
        behavior: "A tool handler that issues an elicitation receives the client's result and can embed it in the tool call result.",
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'tools:call:is-error': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/tools#error-handling',
        behavior:
            'A tool execution failure is returned as a result with isError true and the failure described in content, not as a JSON-RPC error.'
    },
    'tools:call:logging-mid-execution': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/logging#log-message-notifications',
        behavior:
            "Log notifications emitted by a tool handler during execution reach the client's logging callback before the tool result returns."
    },
    'tools:call:progress': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress#progress-flow',
        behavior: "Progress notifications emitted by a tool handler reach the caller's progress callback before the tool result returns."
    },
    'tools:call:sampling-roundtrip': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/sampling',
        behavior:
            "A tool handler that issues a sampling request receives the client's completion and can embed it in the tool call result.",
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'tools:call:structured-content': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/tools#structured-content',
        behavior: 'A tool result can carry structuredContent alongside content; the client receives both.'
    },
    'tools:call:structured-content:text-mirror': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/tools#structured-content',
        behavior: 'A tool returning structured content also returns the serialized JSON as a text content block.'
    },
    'tools:call:unknown-name': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/tools#error-handling',
        behavior: 'tools/call for a name the server does not recognise returns a JSON-RPC error.'
    },
    'tools:capability:declared': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/tools#capabilities',
        behavior: 'A server that exposes tools declares the tools capability (optionally with listChanged) in its InitializeResult.'
    },
    'tools:input-schema:json-schema-2020-12': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool',
        behavior:
            'A tool registered with a JSON Schema 2020-12 inputSchema (nested objects, $defs references) is discoverable and callable.'
    },
    'tools:input-schema:preserve-additional-properties': {
        source: 'sdk',
        behavior: 'tools/list preserves inputSchema additionalProperties as registered.'
    },
    'tools:input-schema:preserve-defs': {
        source: 'sdk',
        behavior: 'tools/list preserves inputSchema $defs as registered.'
    },
    'tools:input-schema:preserve-schema-dialect': {
        source: 'sdk',
        behavior: 'tools/list preserves the inputSchema $schema dialect URI as registered.'
    },
    'tools:list-changed': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/tools#list-changed-notification',
        behavior: "When the tool set changes, the server sends notifications/tools/list_changed and it reaches the client's handler.",
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'tools:list:basic': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/tools#listing-tools',
        behavior: 'tools/list returns the registered tools with name, description, and inputSchema.'
    },
    'tools:list:metadata': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool',
        behavior:
            'tools/list includes title, annotations (readOnlyHint, destructiveHint, idempotentHint, openWorldHint), _meta, icons, and execution.taskSupport when set.'
    },
    'tools:list:pagination': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/tools#listing-tools',
        behavior:
            'tools/list supports cursor pagination: the nextCursor returned by a list handler round-trips back to the handler as an opaque cursor until the listing is exhausted.',
        knownFailures: [
            {
                test: 'mcpserver',
                note: 'McpServer does not implement automatic pagination — handlers receive the cursor but the high-level API returns the full list with no nextCursor unless the user implements cursor handling in their own handler.'
            }
        ]
    },
    'tools:call:concurrent': {
        source: 'sdk',
        behavior:
            'Multiple tool calls in flight on one session are dispatched concurrently, and each caller receives the response to its own request.'
    },

    // Tools: SDK guarantees

    'client:output-schema:skip-on-error': {
        source: 'sdk',
        behavior: 'The client skips structured-content validation when the tool result has isError true.'
    },
    'client:output-schema:validate': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/tools#output-schema',
        behavior:
            "A tool result whose structuredContent does not conform to the tool's declared outputSchema is rejected by the client: the call raises instead of returning the invalid result."
    },
    'client:output-schema:missing-structured': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/tools#output-schema',
        behavior: 'A tool that declares an output schema but returns no structuredContent fails client-side validation.'
    },
    'mcpserver:output-schema:missing-structured': {
        source: 'sdk',
        behavior: 'A tool with an output schema whose function returns no structured content produces a server error.'
    },
    'typescript:mcpserver:output-schema:server-validate': {
        source: 'sdk',
        behavior: 'McpServer validates structuredContent against outputSchema before returning; mismatch produces a server error.'
    },
    'mcpserver:output-schema:skip-on-error': {
        source: 'sdk',
        behavior: 'Server-side output schema validation is skipped when the tool returns an isError result.'
    },
    'mcpserver:tool:duplicate-name': {
        source: 'sdk',
        behavior: 'Registering a tool with a name already in use is rejected at registration time.'
    },
    'typescript:mcpserver:tool:extra': {
        source: 'sdk',
        behavior:
            'Tool handlers receive RequestHandlerExtra with sessionId, requestId, signal, sendNotification, and (when applicable) authInfo and requestInfo.'
    },
    'mcpserver:tool:handle-update': {
        transports: STATEFUL_TRANSPORTS,
        source: 'sdk',
        behavior:
            'The handle returned by registerTool can .update() description/schema/handler; changes reflect in subsequent tools/list and tools/call and trigger list_changed.',
        note: 'Under stateless hosting each request is served by a new server instance, so state set up earlier in the session cannot be observed.'
    },
    'typescript:mcpserver:tool:handler-throws': {
        source: 'sdk',
        behavior: "A tool handler that throws is converted to {isError:true, content:[{type:'text', text:<message>}]}."
    },
    'mcpserver:tool:input-validation': {
        source: 'sdk',
        behavior:
            "Arguments that fail the tool's input validation produce a tool execution error (isError true with the validation failure described in content) without invoking the function."
    },
    'mcpserver:tool:naming-validation': {
        source: 'sdk',
        behavior: "Registering a tool whose name violates the spec's tool-naming conventions emits a warning; registration still succeeds."
    },
    'mcpserver:tool:url-elicitation-error': {
        source: 'sdk',
        behavior:
            'A tool function that raises the URL-elicitation-required error surfaces to the caller as error -32042 with the elicitation parameters intact.'
    },
    'typescript:mcpserver:tool:schema-variants': {
        source: 'sdk',
        behavior:
            'inputSchema accepts Zod union, intersection, nested-object, preprocess, transform, and pipe schemas; validation/coercion runs before the handler.'
    },
    'client:call-tool:compat-result-schema': {
        source: 'sdk',
        behavior:
            'Client.callTool(params, CompatibilityCallToolResultSchema) accepts a legacy protocol-2024-10-07 result ({toolResult: ...}, no content[]) without throwing and returns the parsed toolResult field.',
        deferred:
            'removed in v2: Client.callTool() no longer takes a result-schema parameter, so the legacy {toolResult} compatibility path is not reachable from the public API.'
    },
    'mcpserver:tool:variadic-forms': {
        source: 'sdk',
        behavior:
            'Deprecated McpServer.tool() positional overloads — (name,cb), (name,desc,cb), (name,paramsSchema,cb), (name,desc,paramsSchema,cb), (name,desc,paramsSchema,annotations,cb), and the annotations-without-schema forms — register tools whose tools/list entry and tools/call result match an equivalent registerTool() registration.',
        deferred: 'removed in v2: the deprecated McpServer.tool() positional overloads were dropped; only registerTool() exists.'
    },

    // Resources

    'resources:annotations': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/resources#annotations',
        behavior:
            'Resources, resource templates, and resource contents may carry annotations {audience, priority, lastModified}; these round-trip from server registration to the client list/read result.'
    },
    'resources:capability:declared': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/resources#capabilities',
        behavior:
            'A server with resource handlers advertises the resources capability, including the subscribe  sub-flag when a subscribe handler is registered.'
    },
    'resources:list-changed': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/resources#list-changed-notification',
        behavior:
            "When the resource set changes, the server sends notifications/resources/list_changed and it reaches the client's handler.",
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'resources:list:basic': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/resources#listing-resources',
        behavior:
            'resources/list returns the registered resources with uri, name, and the optional descriptive fields supplied by the server.'
    },
    'resources:list:pagination': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/resources#listing-resources',
        behavior: 'resources/list supports cursor pagination.',
        knownFailures: [
            {
                test: 'mcpserver',
                note: 'McpServer does not implement automatic pagination — handlers receive the cursor but the high-level API returns the full list with no nextCursor unless the user implements cursor handling in their own handler.'
            }
        ]
    },
    'resources:read:blob': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/resources#reading-resources',
        behavior: 'resources/read returns binary contents base64-encoded in blob.'
    },
    'resources:read:template-vars': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/resources#resource-templates',
        behavior: 'Variables extracted from a templated resource URI reach the resource function as typed arguments.'
    },
    'resources:read:text': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/resources#reading-resources',
        behavior: 'resources/read returns text contents carrying uri, mimeType, and the text.'
    },
    'resources:read:unknown-uri': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/resources#error-handling',
        behavior: 'resources/read for an unknown URI returns JSON-RPC error -32002 (resource not found).'
    },
    'resources:subscribe:capability-required': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/resources#capabilities',
        behavior: 'resources/subscribe to a server that did not advertise the subscribe capability is rejected with an error.'
    },
    'resources:subscribe:updated': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/resources#subscriptions',
        behavior: 'After resources/subscribe, server changes to that URI send notifications/resources/updated.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'resources:templates:list': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/resources#resource-templates',
        behavior: 'resources/templates/list returns the registered templates with their uriTemplate and descriptive fields.'
    },
    'resources:templates:pagination': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/pagination#operations-supporting-pagination',
        behavior: 'resources/templates/list supports cursor pagination.',
        knownFailures: [
            {
                test: 'mcpserver',
                note: 'McpServer does not implement automatic pagination — handlers receive the cursor but the high-level API returns the full list with no nextCursor unless the user implements cursor handling in their own handler.'
            }
        ]
    },
    'resources:unsubscribe:stops-updates': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/resources#subscriptions',
        behavior: 'After resources/unsubscribe the server stops sending updated notifications for that URI.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },

    // Resources: SDK guarantees

    'mcpserver:resource:duplicate-name': {
        source: 'sdk',
        behavior: 'Registering a resource or template with a duplicate identifier is rejected at registration time.'
    },
    'mcpserver:resource:handle-update-remove': {
        transports: STATEFUL_TRANSPORTS,
        source: 'sdk',
        behavior: 'The handle from resource()/registerResource() can .update() and .remove(), triggering list_changed.',
        note: 'Under stateless hosting each request is served by a new server instance, so state set up earlier in the session cannot be observed.'
    },
    'mcpserver:resource:metadata-override': {
        source: 'sdk',
        behavior: 'Per-resource metadata from a template list callback overrides template-level metadata field-by-field.'
    },
    'mcpserver:resource:read-throws-surfaced': {
        source: 'sdk',
        behavior: 'A resource function that raises is surfaced to the caller as a JSON-RPC error response.'
    },
    'mcpserver:resource:template-list-callback': {
        source: 'sdk',
        behavior: 'A ResourceTemplate with a list callback contributes its expanded items to resources/list.'
    },
    'mcpserver:resource:legacy-overload': {
        source: 'sdk',
        behavior:
            'The deprecated McpServer.resource() overloads (fixed-URI and ResourceTemplate, with and without the optional metadata arg) register a resource that surfaces in resources/list and reads via resources/read identically to registerResource().',
        deferred: 'removed in v2: the deprecated McpServer.resource() overloads were dropped; only registerResource() exists.'
    },

    // Prompts

    'prompts:capability:declared': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/prompts#capabilities',
        behavior: 'A server with a list_prompts handler advertises the prompts capability in its initialize result.'
    },
    'prompts:get:content:audio': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/prompts#audio-content',
        behavior: 'Prompt messages may contain audio content with base64 data and a mimeType.'
    },
    'prompts:get:content:embedded-resource': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/prompts#embedded-resources',
        behavior: 'Prompt messages may contain embedded resource content.'
    },
    'prompts:get:content:image': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/prompts#image-content',
        behavior: 'Prompt messages may contain image content.'
    },
    'prompts:get:missing-required-args': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/prompts#error-handling',
        behavior: 'prompts/get omitting a required argument returns JSON-RPC error -32602 (Invalid params).'
    },
    'prompts:get:no-args': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/prompts#getting-a-prompt',
        behavior: "prompts/get with no arguments returns the prompt's messages."
    },
    'prompts:get:unknown-name': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/prompts#error-handling',
        behavior: 'prompts/get for an unknown prompt name returns JSON-RPC error -32602 (Invalid params).'
    },
    'prompts:get:with-args': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/prompts#getting-a-prompt',
        behavior: 'prompts/get delivers the supplied arguments to the prompt handler and returns its messages.'
    },
    'prompts:list-changed': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/prompts#list-changed-notification',
        behavior: "When the prompt set changes, the server sends notifications/prompts/list_changed and it reaches the client's handler.",
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'prompts:list:basic': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/prompts#listing-prompts',
        behavior: 'prompts/list returns the registered prompts with name, description, and argument declarations.'
    },
    'prompts:list:pagination': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/prompts#listing-prompts',
        behavior: 'prompts/list supports cursor pagination.',
        knownFailures: [
            {
                test: 'mcpserver',
                note: 'McpServer does not implement automatic pagination — handlers receive the cursor but the high-level API returns the full list with no nextCursor unless the user implements cursor handling in their own handler.'
            }
        ]
    },
    'prompts:get:multi-message': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/prompts#getting-a-prompt',
        behavior: 'A prompt can return multiple messages mixing user and assistant roles; order is preserved.'
    },

    // Prompts: SDK guarantees

    'mcpserver:prompt:args-validation': {
        source: 'sdk',
        behavior: "prompts/get arguments that fail the prompt's argument schema are rejected before the function runs."
    },
    'mcpserver:prompt:duplicate-name': {
        source: 'sdk',
        behavior: 'Registering a duplicate prompt name is rejected at registration time.'
    },
    'mcpserver:prompt:handle-update-remove': {
        transports: STATEFUL_TRANSPORTS,
        source: 'sdk',
        behavior: 'The handle from prompt()/registerPrompt() can .update() and .remove(), triggering list_changed.',
        note: 'Under stateless hosting each request is served by a new server instance, so state set up earlier in the session cannot be observed.'
    },
    'mcpserver:prompt:optional-args': {
        source: 'sdk',
        behavior: 'A prompt with optional arguments can be fetched without supplying them.'
    },
    'mcpserver:prompt:legacy-overload': {
        source: 'sdk',
        behavior:
            'McpServer.prompt() (deprecated positional overloads: name+cb, name+desc+cb, name+args+cb, name+desc+args+cb) registers a prompt that appears in prompts/list with the given description/arguments and is callable via prompts/get.',
        deferred: 'removed in v2: the deprecated McpServer.prompt() positional overloads were dropped; only registerPrompt() exists.'
    },

    // Completion

    'completion:capability:declared': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/completion#capabilities',
        behavior: 'A server with a completion handler advertises the completions capability in its initialize result.'
    },
    'completion:context-arguments': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/completion#requesting-completions',
        behavior: 'Previously-resolved argument values supplied in context.arguments reach the completion handler.'
    },
    'completion:error:invalid-ref': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/completion#error-handling',
        behavior:
            'completion/complete with a ref naming an unknown prompt or non-matching resource URI returns JSON-RPC error -32602 (Invalid params).'
    },
    'completion:prompt-arg': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/completion#reference-types',
        behavior: 'completion/complete with a ref/prompt returns suggested values for the named prompt argument.'
    },
    'completion:resource-template-arg': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/completion#reference-types',
        behavior: 'completion/complete with a ref/resource returns suggested values for a URI template variable.'
    },
    'completion:result-shape': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/completion#completion-results',
        behavior: 'The completion result carries values (at most 100), an optional total, and an optional hasMore flag.'
    },
    'completion:complete:not-supported': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/completion#capabilities',
        behavior:
            'A server with no completion handler does not advertise the completions capability and rejects completion/complete with METHOD_NOT_FOUND.'
    },
    'mcpserver:completion:capability-auto': {
        source: 'sdk',
        behavior:
            'MCPServer advertises the completions capability when at least one completion source is registered, and omits it otherwise.'
    },

    // Logging

    'logging:capability:declared': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/logging#capabilities',
        behavior: 'A server that emits log message notifications declares the logging capability in its initialize result.'
    },
    'logging:message:fields': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/logging#log-message-notifications',
        behavior:
            "A log message sent by a server handler is delivered to the client's logging callback with its severity level, logger name, and data."
    },
    'logging:message:filtered': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/logging#setting-log-level',
        behavior: 'After logging/setLevel, log messages below the configured level are not sent.',
        note: 'Under stateless hosting each request is served by a new server instance, so state set up earlier in the session cannot be observed.'
    },
    'logging:set-level': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/logging#setting-log-level',
        behavior: 'logging/setLevel sets the minimum level for notifications/message.',
        note: 'Under stateless hosting each request is served by a new server instance, so state set up earlier in the session cannot be observed.'
    },
    'logging:set-level:invalid-level': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/logging#error-handling',
        behavior: 'logging/setLevel with an invalid level value returns JSON-RPC error -32602 (Invalid params).',
        knownFailures: [
            {
                test: 'mcpserver',
                note: 'Protocol wraps schema-parse failures as -32603 (InternalError), not -32602 (InvalidParams) as required by JSON-RPC 2.0.'
            }
        ]
    },
    'logging:out-of-band:basic': {
        transports: STATEFUL_TRANSPORTS,
        source: 'sdk',
        behavior:
            'McpServer.sendLoggingMessage() called outside any request handler delivers the notifications/message to a connected client over the standalone notification stream.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'logging:message:all-levels': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/logging#log-levels',
        behavior: 'All eight RFC 5424 severity levels are deliverable as log message notifications.',
        transports: ['inMemory', 'stdio', 'streamableHttp'],
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },

    // Sampling

    'sampling:capability:declare': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/sampling#capabilities',
        behavior: 'A client that handles sampling requests advertises the sampling capability in its initialize request.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'sampling:create:basic': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/sampling#creating-messages',
        behavior:
            "A sampling/createMessage request from a server handler is answered by the client's sampling callback, and the callback's result (role, content, model, stopReason) is returned to the handler.",
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'sampling:create:include-context': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/sampling#capabilities',
        behavior: 'The includeContext value supplied by the server reaches the client callback intact.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'sampling:create:model-preferences': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/sampling#model-preferences',
        behavior:
            'The model preferences supplied by the server (hints and the cost, speed, and intelligence priorities) reach the client callback intact.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'sampling:create:system-prompt': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/sampling#creating-messages',
        behavior: 'The system prompt supplied by the server reaches the client callback intact.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'sampling:create:tools': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/sampling#tools-in-sampling',
        behavior:
            'A sampling request carrying tools and toolChoice reaches the client, and a tool_use response with a toolUse stop reason returns to the requesting handler.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'sampling:error:user-rejected': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/sampling#error-handling',
        behavior:
            "A sampling request the user rejects is answered with a JSON-RPC error (the spec's code for this case is -1, 'User rejected sampling request'), surfaced to the requesting handler as an MCPError.",
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'sampling:message:content-cardinality': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/sampling',
        behavior: "A sampling message's content may be a single block or an array of blocks.",
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'sampling:result:no-tools-single-content': {
        transports: STATEFUL_TRANSPORTS,
        source: 'sdk',
        behavior: 'When the request carries no tools, a sampling callback result whose content is an array is rejected by the client.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'sampling:result:with-tools-array-content': {
        transports: STATEFUL_TRANSPORTS,
        source: 'sdk',
        behavior:
            'When the request includes tools, the client accepts a callback result whose content is an array including tool_use blocks.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'sampling:tool-result:no-mixed-content': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/sampling#tool-result-messages',
        behavior:
            'A user SamplingMessage containing tool_result content MUST contain only tool_result blocks; mixing with text/image/audio is rejected by the client with -32602 Invalid params.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'sampling:tool-use:result-balance': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/sampling#tool-use-and-result-balance',
        behavior:
            'In a sampling/createMessage request, every assistant tool_use block in messages MUST be matched by a tool_result with the same toolUseId in the immediately-following user message; an unmatched tool_use is rejected with -32602 Invalid params.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.',
        knownFailures: [
            {
                note: 'changed in v2: mismatched toolUseId pairs are now rejected, but an assistant tool_use in the final message with no following user message is still accepted.'
            }
        ]
    },
    'sampling:tools:server-gated-by-capability': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/sampling#tools-in-sampling',
        behavior:
            'A tool-enabled sampling request to a client that did not declare sampling.tools is rejected by the server before anything reaches the wire (the SDK surfaces this as an Invalid params error).',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'sampling:create:image-content': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/sampling#image-content',
        behavior:
            'sampling/createMessage round-trips image content: base64 data and mimeType survive from the server request to the client callback and back in the result.',
        transports: ['inMemory', 'stdio', 'streamableHttp'],
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'sampling:create:audio-content': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/sampling#audio-content',
        behavior:
            'sampling/createMessage round-trips audio content: base64 data and mimeType survive from the server request to the client callback and back in the result.',
        transports: ['inMemory', 'stdio', 'streamableHttp'],
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'sampling:context:server-gated-by-capability': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/sampling#capabilities',
        behavior:
            'The server does not use includeContext values thisServer or allServers unless the client declared the sampling.context capability.',
        transports: ['inMemory', 'stdio', 'streamableHttp'],
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.',
        knownFailures: [
            {
                note: "Server.createMessage (src/server/index.ts ~line 497) only gates tools/toolChoice on clientCapabilities.sampling.tools; there is no check of clientCapabilities.sampling.context for includeContext 'thisServer'/'allServers', so the request reaches the client callback instead of being refused."
            }
        ]
    },
    'sampling:create:not-supported': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/sampling#capabilities',
        behavior: 'The server refuses to send sampling/createMessage to a client that did not declare the sampling capability.',
        transports: ['inMemory', 'stdio', 'streamableHttp'],
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },

    // Elicitation

    'elicitation:capability:empty-is-form': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#capabilities',
        behavior: 'A client advertising an empty elicitation capability accepts form-mode elicitation requests.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'elicitation:capability:mode-mismatch': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#error-handling',
        behavior: 'The client answers elicitation requests for a mode it did not advertise with JSON-RPC error -32602 (Invalid params).',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'elicitation:capability:server-respects-mode': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#capabilities',
        behavior: 'The server refuses to send an elicitation request with a mode the connected client did not declare in its capabilities.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'elicitation:form:action:accept': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#response-actions',
        behavior: "A form-mode elicitation answered with action 'accept' returns the user's content to the requesting handler.",
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'elicitation:form:action:cancel': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#response-actions',
        behavior: "A form-mode elicitation answered with action 'cancel' returns no content to the handler.",
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'elicitation:form:action:decline': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#response-actions',
        behavior: "A form-mode elicitation answered with action 'decline' returns no content to the handler.",
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'elicitation:form:basic': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#form-mode-elicitation-requests',
        behavior:
            'A form-mode elicitation delivers the message and requested schema to the client callback exactly as the server sent them.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'elicitation:form:defaults': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#requested-schema',
        behavior: 'When client advertises elicitation.form.applyDefaults, schema default values are filled into the result content.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'elicitation:form:mode-omitted-default': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#elicitation-requests',
        behavior: 'An elicitation request with no mode field is treated as form mode by the client.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'elicitation:form:schema:enum-variants': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#requested-schema',
        behavior: 'Requested-schema enum fields (including titled and multi-select variants) reach the client callback as sent.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'elicitation:form:schema:primitives': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#requested-schema',
        behavior: 'Requested-schema fields may be string (with format), number or integer, or boolean.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'elicitation:url:action:accept-no-content': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#response-actions',
        behavior:
            'A URL-mode elicitation delivers the message, URL, and elicitationId to the client; an accept response carries no content (accept means the user agreed to visit the URL, not that the interaction completed).',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'elicitation:url:basic': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#url-mode-elicitation-requests',
        behavior: 'A url-mode elicitation delivers the elicitation id and URL to the client callback exactly as the server sent them.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'elicitation:url:complete-notification': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#completion-notifications-for-url-mode-elicitation',
        behavior:
            'An elicitation/complete notification sent by the server after an out-of-band elicitation finishes reaches the client carrying the elicitationId.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'elicitation:url:complete-unknown-ignored': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#completion-notifications-for-url-mode-elicitation',
        behavior:
            'The client ignores an elicitation/complete notification referencing an unknown or already-completed elicitationId without error.'
    },
    'elicitation:url:required-error': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#url-elicitation-required-error',
        behavior:
            'A handler that cannot proceed without a URL elicitation rejects the request with error -32042, carrying the pending elicitations in the error data.'
    },
    'elicitation:form:response-validation': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#form-mode-security',
        behavior:
            'Accepted form-mode content is validated against the requested schema: the client validates the response before sending and the server validates the content it receives.',
        transports: ['inMemory', 'stdio', 'streamableHttp'],
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'elicitation:capability:not-declared': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#error-handling',
        behavior:
            'The server refuses to send elicitation/create (form or URL mode) to a client that did not declare the elicitation capability.',
        transports: ['inMemory', 'stdio', 'streamableHttp'],
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'elicitation:url:action:cancel': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#response-actions',
        behavior: "A URL-mode elicitation answered with action 'cancel' returns no content to the handler.",
        transports: ['inMemory', 'stdio', 'streamableHttp'],
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'elicitation:url:action:decline': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#response-actions',
        behavior: "A URL-mode elicitation answered with action 'decline' returns no content to the handler.",
        transports: ['inMemory', 'stdio', 'streamableHttp'],
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'elicitation:form:schema:restricted-subset': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#requested-schema',
        behavior:
            'Form-mode requested schemas are flat objects with primitive-typed properties only; nested structures and arrays of objects are not used.',
        transports: ['inMemory', 'stdio', 'streamableHttp'],
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },

    // Roots

    'roots:list-changed': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/roots#root-list-changes',
        behavior: "A roots/list_changed notification sent by the client is delivered to the server's handler.",
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'roots:list:basic': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/roots#listing-roots',
        behavior:
            "A roots/list request from a server handler is answered by the client's roots callback, and the returned roots (uri, name) reach the handler.",
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'roots:list:client-error': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/roots#error-handling',
        behavior: 'A roots callback that answers with an error surfaces to the requesting handler as an MCPError.',
        transports: ['inMemory', 'stdio', 'streamableHttp'],
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'roots:list:not-supported': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/roots#error-handling',
        behavior: 'A roots/list request to a client that did not declare the roots capability is answered with -32601 Method not found.',
        transports: ['inMemory', 'stdio', 'streamableHttp'],
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'roots:list:empty': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/roots#listing-roots',
        behavior: 'An empty roots list is a valid response and reaches the handler as such.',
        transports: ['inMemory', 'stdio', 'streamableHttp'],
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },

    // list_changed & dynamic registration

    'client:list-changed:auto-refresh': {
        transports: STATEFUL_TRANSPORTS,
        source: 'sdk',
        behavior:
            'A client configured to react to list_changed notifications automatically re-fetches the corresponding list and delivers the fresh result to its callback.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'client:list-changed:capability-gated': {
        transports: STATEFUL_TRANSPORTS,
        source: 'sdk',
        behavior: 'The client does not activate list-changed handling for a kind the server did not advertise with listChanged true.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'client:list-changed:signal-only': {
        transports: STATEFUL_TRANSPORTS,
        source: 'sdk',
        behavior: 'A client configured for signal-only list-changed handling is notified without auto-refreshing.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'mcpserver:handle:enable-disable': {
        transports: STATEFUL_TRANSPORTS,
        source: 'sdk',
        behavior:
            'handle.disable() removes the item from list results and calling/reading it errors; handle.enable() restores it; each transition emits list_changed.',
        note: 'Under stateless hosting each request is served by a new server instance, so state set up earlier in the session cannot be observed.'
    },
    'mcpserver:list-changed:debounce': {
        transports: STATEFUL_TRANSPORTS,
        source: 'sdk',
        behavior: 'Bursts of registration changes on MCPServer are debounced into one list_changed notification per kind.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'mcpserver:register:post-connect': {
        transports: STATEFUL_TRANSPORTS,
        source: 'sdk',
        behavior:
            'A tool, resource, or prompt registered or removed after the client connected appears in (or disappears from) the corresponding list results, and the change is announced with a list_changed notification.',
        note: 'Under stateless hosting each request is served by a new server instance, so state set up earlier in the session cannot be observed.'
    },

    // Pagination

    'pagination:invalid-cursor': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/pagination#error-handling',
        behavior: 'A list request with an invalid cursor returns JSON-RPC error -32602 (Invalid params).',
        knownFailures: [
            {
                note: 'McpServer does not implement automatic pagination — handlers receive the cursor but the high-level API ignores invalid cursors instead of returning -32602.'
            }
        ]
    },
    'pagination:client:cursor-handling': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/pagination#implementation-guidelines',
        behavior:
            'The client treats cursors as opaque tokens — it does not parse, modify, or persist them — and does not assume a fixed page size.'
    },

    // Tasks
    'protocol:meta:related-task': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#related-task-metadata',
        behavior: 'Messages may carry related-task _meta associating them with a task.',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'protocol:meta:request-to-handler': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic#_meta',
        behavior: "_meta sent in a request's params by the client is delivered intact to the server-side request handler."
    },
    'protocol:meta:result-to-client': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic#_meta',
        behavior: "_meta returned in a handler's result is delivered intact to the requesting client."
    },
    'protocol:request-id:unique': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic#requests',
        behavior:
            'Every request sent on a session carries a unique, non-null string or integer id; ids are never reused within the session.'
    },
    'protocol:notifications:no-response': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic#notifications',
        behavior:
            'Notifications are never answered: every message the server delivers is either the response to a request the client sent or a notification carrying no id.'
    },
    'protocol:progress:monotonic': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress#behavior-requirements',
        behavior: 'The progress value increases with each notification for a given token, even when the total is unknown.',
        knownFailures: [
            {
                note: 'Neither the sender path (Protocol.notification via extra.sendNotification) nor the receiver (_onprogress, src/shared/protocol.ts:856-883, which just calls handler(params)) enforces the spec MUST that progress increases per token, so a non-increasing value emitted by the handler is forwarded to the client callback unchanged.'
            }
        ]
    },
    'protocol:progress:stops-after-completion': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress#behavior-requirements',
        behavior: 'Progress notifications for a token stop once the associated request completes.',
        transports: ['inMemory', 'stdio', 'streamableHttp'],
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.',
        knownFailures: [
            {
                note: 'The server-side send path (server.notification / Protocol.notification) does not check whether the request associated with a progressToken has already completed, so a post-completion progress notification is still sent and reaches the client wire (the client merely drops it via the unknown-token onerror path in _onprogress, src/shared/protocol.ts:860-863).'
            }
        ]
    },
    'protocol:cancel:in-flight': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation#behavior-requirements',
        behavior:
            'A cancellation notification for an in-flight request stops the server-side handler, and the receiver does not send a response for the cancelled request.',
        transports: ['inMemory', 'stdio', 'streamableHttp'],
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'protocol:progress:client-to-server': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress#progress-flow',
        behavior: "A progress notification sent by the client is delivered to the server's progress handler.",
        transports: ['inMemory', 'stdio', 'streamableHttp'],
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },

    'tasks:auth:context-isolation': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#task-isolation-and-access-control',
        behavior:
            'When an authorization context is available, task operations are scoped to the context that created the task: other contexts cannot get it, retrieve its result, cancel it, or see it in tasks/list.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting/auth layer; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:bidirectional': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#definitions',
        behavior: 'Task APIs are bidirectional: the server may create, get, list, and cancel tasks on the client.',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:cancel:no-handler-abort': {
        source: 'sdk',
        behavior:
            'tasks/cancel marks the task cancelled without aborting the originating request handler (the spec says receivers SHOULD attempt to stop execution).',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:cancel:remains-cancelled': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#task-cancellation',
        behavior: 'After tasks/cancel, the task remains cancelled even if the underlying handler subsequently completes or fails.',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:cancel:terminal-rejected': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#task-cancellation',
        behavior: 'tasks/cancel on a task already in a terminal state returns Invalid params (-32602).',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:cancel:working': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#task-cancellation',
        behavior: 'tasks/cancel on a working task transitions it to cancelled and returns the updated task.',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:create:ttl-honored': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#ttl-and-resource-management',
        behavior:
            'tasks/get responses include the actual ttl applied by the receiver (or null for unlimited); the create-task result carries the same value.',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:create:via-tool-call': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#creating-tasks',
        behavior: 'A task-augmented tools/call returns a create-task result instead of the tool result.',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:get': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#getting-tasks',
        behavior: "tasks/get returns the task's current status, ttl, timestamps, and status message.",
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:lifecycle:initial-working': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#task-status-lifecycle',
        behavior: "A newly created task has status 'working'.",
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:lifecycle:input-required': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#input-required-status',
        behavior:
            'While a task awaits a side-channel client response its status is input_required; once the response arrives the task leaves input_required (typically returning to working).',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:list:invalid-cursor': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#protocol-errors',
        behavior: 'tasks/list with an invalid cursor returns Invalid params (-32602).',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:list:pagination': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#listing-tasks',
        behavior: 'tasks/list returns created tasks and supports cursor pagination.',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:no-capability:ignore-task-param': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#task-support-and-handling',
        behavior:
            'A receiver that did not declare task capability for a request type processes the request normally and returns the ordinary result, ignoring the task augmentation.',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:progress:after-create': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#task-progress-notifications',
        behavior:
            'After the create-task result, progress notifications keyed to the original progress token continue to reach the caller until the task is terminal.',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:request-cancel:no-task-cancel': {
        source: 'sdk',
        behavior: 'A cancellation notification for the originating request does not auto-cancel the created task.',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:result:failed': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#task-execution-errors',
        behavior: 'tasks/result for a failed task returns the failure result (isError true).',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:result:related-task-meta': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#related-task-metadata',
        behavior: 'The tasks/result response carries related-task _meta naming the requested task.',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:result:terminal': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#result-retrieval',
        behavior: 'tasks/result for a completed task returns the stored result of the original request type.',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:side-channel:drain-fifo': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#input-required-status',
        behavior: 'tasks/result drains queued related-task messages in FIFO order before returning the final result.',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:side-channel:drop-on-cancel': {
        source: 'sdk',
        behavior: 'When a task is cancelled before tasks/result, queued related-task messages are dropped.',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:side-channel:elicitation': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#input-required-status',
        behavior:
            "An elicitation issued mid-task is delivered through the tasks/result side-channel, and the client's response routes back to the handler.",
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:side-channel:queue': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#input-required-status',
        behavior: 'Server-to-client requests with related-task metadata sent while no tasks/result is open are queued.',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:side-channel:sampling': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#input-required-status',
        behavior:
            "A sampling request issued mid-task is delivered through the tasks/result side-channel, and the client's response routes back to the task.",
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:side-channel:stream': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#result-retrieval',
        behavior:
            'Calling tasks/result while the task is working streams related-task messages as they are produced, then returns the result.',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:status-notification': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#task-status-notification',
        behavior: 'Task status notifications deliver status updates carrying the full task fields.',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:tool-level:forbidden-with-task-32601': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#tool-level-negotiation',
        behavior: 'A task-augmented tools/call on a tool that does not support tasks returns Method not found (-32601).',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:tool-level:required-no-task-32601': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#tool-level-negotiation',
        behavior: 'A plain tools/call on a tool that requires task augmentation returns Method not found (-32601).',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'tasks:unknown-id': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#protocol-errors',
        behavior: 'tasks/get, tasks/result, and tasks/cancel for an unknown task id return Invalid params (-32602).',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },

    // Tasks: registerToolTask (SDK)

    'mcpserver:tooltask:advertise': {
        source: 'sdk',
        behavior: 'registerToolTask tools advertise their execution.taskSupport in tools/list.',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'mcpserver:tooltask:autopoll-cancelled': {
        source: 'sdk',
        behavior: 'Auto-polling surfaces a cancelled task as an error result.',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'mcpserver:tooltask:autopoll-failed': {
        source: 'sdk',
        behavior: 'Auto-polling surfaces a task that ends failed as the failed CallToolResult.',
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'mcpserver:tooltask:forbidden-throws': {
        source: 'sdk',
        behavior: "registerToolTask throws at registration if taskSupport:'forbidden'.",
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'mcpserver:tooltask:optional-autopoll': {
        source: 'sdk',
        behavior:
            "A taskSupport:'optional' tool called without task augmentation transparently creates and polls the task, returning the final CallToolResult.",
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'mcpserver:tooltask:required-with-task': {
        source: 'sdk',
        behavior: "A taskSupport:'required' tool called with task augmentation returns CreateTaskResult.",
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },
    'mcpserver:tooltask:required-without-task': {
        source: 'sdk',
        behavior: "A registerToolTask tool with taskSupport:'required' returns isError when called without task augmentation.",
        deferred:
            'Tasks are experimental and the spec is being substantially revised. Scenarios deferred until the next spec revision settles.'
    },

    // Client streaming API (SDK)

    'client:stream:non-task-single': {
        source: 'sdk',
        behavior: 'requestStream() on a non-task request yields exactly the final result.',
        deferred: 'client.stream() is a thin wrapper over tasks; deferred with tasks.'
    },
    'client:stream:task-elicitation': {
        source: 'sdk',
        behavior:
            'callToolStream() over a task-augmented tool with mid-task elicitation delivers it to the client handler and yields the final result.',
        deferred: 'client.stream() is a thin wrapper over tasks; deferred with tasks.'
    },
    'client:stream:terminal-error': {
        source: 'sdk',
        behavior:
            'requestStream() yields a terminal error message and nothing further on server error, timeout, abort, network error, or task failure.',
        deferred: 'client.stream() is a thin wrapper over tasks; deferred with tasks.'
    },
    'client:stream:tool-validation': {
        source: 'sdk',
        behavior:
            'callToolStream() applies the same outputSchema validation as callTool(); mismatch yields an error, isError skips validation.',
        deferred:
            'client.stream() is a thin wrapper over tasks; deferred with tasks, part of the task-streaming work and not transport-specific.'
    },

    // McpServer reach-through (SDK)

    'mcpserver:reach-through:set-request-handler': {
        transports: STATEFUL_TRANSPORTS,
        source: 'sdk',
        behavior:
            'mcpServer.server is public: .server.setRequestHandler(Schema, fn) installs a low-level handler alongside high-level registrations. A handler for a method McpServer has not auto-wired (e.g. resources/list with no registerResource) is reachable by clients; if set before the first registerX of that kind, registerX throws via assertCanSetRequestHandler.',
        note: 'Under stateless hosting each request is served by a new server instance, so state set up earlier in the session cannot be observed.'
    },

    // Validation (SDK)

    'validation:cfworker-provider': {
        source: 'sdk',
        behavior:
            'Passing jsonSchemaValidator: new CfWorkerJsonSchemaValidator() to the Client produces the same accept/reject outcomes as the default Ajv provider for client-side tool outputSchema validation.'
    },
    'validation:pluggable-provider': {
        source: 'sdk',
        behavior:
            'ClientOptions.jsonSchemaValidator swaps the JSON Schema validator implementation: the configured provider is the one consulted for client-side tool outputSchema validation and its verdicts are honored.'
    },

    // Hosting: session lifecycle

    'hosting:session:cors-expose': {
        source: 'sdk',
        behavior: 'CORS configuration exposes the Mcp-Session-Id header so browser clients can read it.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer and session management; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:session:create': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management',
        behavior: 'An initialize POST without a session id creates a session and returns Mcp-Session-Id in the response headers.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer and session management; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:session:delete': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management',
        behavior: 'DELETE with a valid Mcp-Session-Id terminates the session.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer and session management; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:session:id-charset': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management',
        behavior: 'Generated Mcp-Session-Id values contain only visible ASCII characters.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer and session management; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:session:isolation': {
        source: 'sdk',
        behavior: 'Each session gets its own server instance; closing one session does not affect others.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer and session management; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:session:missing-id': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management',
        behavior: 'A non-initialize POST without Mcp-Session-Id in stateful mode returns 400.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer and session management; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:session:reinitialize': {
        source: 'sdk',
        behavior: 'A second initialize on an already-initialized session transport is rejected.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer and session management; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:session:reuse': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management',
        behavior: "A POST carrying a valid Mcp-Session-Id routes to that session's transport with state preserved.",
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer and session management; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:session:unknown-id': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management',
        behavior: 'A POST, GET, or DELETE with an unknown Mcp-Session-Id returns 404.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer and session management; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.',
        knownFailures: [
            {
                note: "The SDK's documented hosting pattern rejects unknown session ids with 400 at the app level (see src/examples servers); the transport's own validateSession 404 is never reached, while the spec requires 404."
            }
        ]
    },
    'hosting:stateless:concurrent-clients': {
        source: 'sdk',
        behavior: 'Multiple independent clients can connect to a stateless server concurrently.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer and stateless mode; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:stateless:no-reuse': {
        source: 'sdk',
        behavior: 'A stateless per-request transport cannot be reused for a second request.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer and stateless mode; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.',
        knownFailures: [
            {
                note: 'changed in v2: the stateless reuse guard was removed, so a second request on the same per-request transport is processed instead of rejected.'
            }
        ]
    },
    'hosting:stateless:no-session-id': {
        source: 'sdk',
        behavior: 'In stateless mode no Mcp-Session-Id is emitted and no session validation is performed.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer and stateless mode; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:session:delete-cancels-inflight': {
        source: 'sdk',
        behavior:
            "DELETE on a session aborts every in-flight request handler's RequestHandlerExtra.signal; their POST-initiated SSE streams close without a JSON-RPC response being written.",
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer and session management; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:stateless:get-delete-405': {
        source: 'sdk',
        behavior:
            'In stateless mode (sessionIdGenerator: undefined), GET (standalone SSE) and DELETE on /mcp return 405 Method Not Allowed — there is no session to stream to or terminate.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer and stateless mode; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.',
        knownFailures: [
            {
                note: 'webStandardStreamableHttp.ts:833-836: validateSession() returns undefined in stateless mode, so GET opens an SSE stream and DELETE succeeds with 200 instead of 405.'
            }
        ]
    },
    'hosting:stateless:progress-in-post-stream': {
        source: 'sdk',
        behavior:
            "In stateless mode (sessionIdGenerator: undefined), notifications/progress emitted by a tool handler via sendNotification are delivered on the POST-initiated SSE stream and reach the client's onprogress before the result resolves.",
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer and stateless mode; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'transport:streamable-http:stateless-restrictions': {
        source: 'sdk',
        behavior:
            'A handler that attempts a server-initiated request in stateless mode fails with an error result, because there is no session to call back through.',
        transports: ['streamableHttpStateless'],
        note: 'The exercised behavior depends on stateless hosting; the test runs as streamableHttpStateless to test the specific stateless condition.',
        knownFailures: [
            {
                note: 'Under stateless hosting a server-to-client request (e.g. sampling/createMessage) with no GET stream and no relatedRequestId is silently dropped by send(), so the tool call hangs instead of failing fast with an error result.'
            }
        ]
    },

    // Hosting: auth

    'hosting:auth:as-router': {
        source: 'sdk',
        behavior:
            'The authorization-server routes expose the authorize, token, and registration endpoints (and revocation when supported).',
        transports: ['streamableHttp'],
        note: 'These exercise the HTTP hosting/auth layer (mostly over real Express); the matrix transport arg is ignored, so they run as a single streamableHttp-labelled cell to avoid duplicate runs.',
        deferred:
            'removed in v2: the bundled OAuth authorization server (mcpAuthRouter, OAuthServerProvider) is no longer part of the SDK; only requireBearerAuth, mcpAuthMetadataRouter and hostHeaderValidation remain.'
    },
    'hosting:auth:aud-validation': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#access-token-usage',
        behavior: 'The resource server validates that the token audience matches its resource identifier.',
        transports: ['streamableHttp'],
        note: 'These exercise the HTTP hosting/auth layer (mostly over real Express); the matrix transport arg is ignored, so they run as a single streamableHttp-labelled cell to avoid duplicate runs.',
        knownFailures: [
            {
                note: 'src/server/auth/middleware/bearerAuth.ts: authInfo.resource is never compared to the resource identifier — audience validation missing.'
            }
        ]
    },
    'hosting:auth:authinfo-propagates': {
        source: 'sdk',
        behavior: "A valid token's auth info is exposed to request handlers.",
        transports: ['streamableHttp'],
        note: 'These exercise the HTTP hosting/auth layer (mostly over real Express); the matrix transport arg is ignored, so they run as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:auth:expired-401': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#token-handling',
        behavior: 'An expired token returns 401 invalid_token.',
        transports: ['streamableHttp'],
        note: 'These exercise the HTTP hosting/auth layer (mostly over real Express); the matrix transport arg is ignored, so they run as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:auth:invalid-401': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#token-handling',
        behavior: 'A malformed bearer token or token-verification failure returns 401 with WWW-Authenticate.',
        transports: ['streamableHttp'],
        note: 'These exercise the HTTP hosting/auth layer (mostly over real Express); the matrix transport arg is ignored, so they run as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:auth:metadata-endpoints': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#authorization-server-location',
        behavior:
            'The MCP server publishes protected-resource metadata at its well-known endpoint, and the authorization server (which the SDK can also host) publishes authorization-server metadata at its own.',
        transports: ['streamableHttp'],
        note: 'These exercise the HTTP hosting/auth layer (mostly over real Express); the matrix transport arg is ignored, so they run as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:auth:missing-401': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#error-handling',
        behavior:
            "A request without an Authorization header is rejected with 401; the WWW-Authenticate header carries resource_metadata (one of the spec's two permitted discovery mechanisms).",
        transports: ['streamableHttp'],
        note: 'These exercise the HTTP hosting/auth layer (mostly over real Express); the matrix transport arg is ignored, so they run as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:auth:prm:authorization-servers-field': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#authorization-server-location',
        behavior: 'The protected-resource metadata document includes an authorization_servers array with at least one entry.',
        transports: ['streamableHttp'],
        note: 'These exercise the HTTP hosting/auth layer (mostly over real Express); the matrix transport arg is ignored, so they run as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:auth:scope-403': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#runtime-insufficient-scope-errors',
        behavior:
            'A token lacking a required scope returns 403 with WWW-Authenticate carrying insufficient_scope, the required scope, and resource_metadata.',
        transports: ['streamableHttp'],
        note: 'These exercise the HTTP hosting/auth layer (mostly over real Express); the matrix transport arg is ignored, so they run as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:auth:proxy-provider': {
        source: 'sdk',
        behavior:
            'ProxyOAuthServerProvider plugged into mcpAuthRouter mounts the /authorize, /token, and /revoke endpoints and serves them.',
        transports: ['streamableHttp'],
        note: 'These exercise the HTTP hosting/auth layer (mostly over real Express); the matrix transport arg is ignored, so they run as a single streamableHttp-labelled cell to avoid duplicate runs. Asserting that requests are forwarded to the configured upstream AS endpoints is post-ship backlog.',
        deferred:
            'removed in v2: ProxyOAuthServerProvider and mcpAuthRouter are no longer part of the SDK, so there is no public API to mount proxied authorization-server endpoints.'
    },

    // Hosting: resumability

    'typescript:hosting:resume:bad-event-id': {
        source: 'sdk',
        behavior: 'Last-Event-ID that cannot be mapped to a stream returns 400; replay failure returns 500.',
        transports: ['streamableHttp'],
        note: 'Resumability requires a per-session transport with an EventStore and a standalone GET stream; stateless hosting has neither.'
    },
    'hosting:resume:buffered-replay': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#resumability-and-redelivery',
        behavior: 'Notifications emitted while no client is connected are replayed in order on reconnect.',
        transports: ['streamableHttp'],
        note: 'Resumability requires a per-session transport with an EventStore and a standalone GET stream; stateless hosting has neither.'
    },
    'hosting:resume:close-stream': {
        source: 'sdk',
        behavior: 'Handlers can close an SSE stream cleanly when an event store is configured.',
        transports: ['streamableHttp'],
        note: 'Resumability requires a per-session transport with an EventStore and a standalone GET stream; stateless hosting has neither.'
    },
    'hosting:resume:event-ids': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#resumability-and-redelivery',
        behavior: 'With an event store configured, every SSE event carries an id field.',
        transports: ['streamableHttp'],
        note: 'Resumability requires a per-session transport with an EventStore and a standalone GET stream; stateless hosting has neither.'
    },
    'hosting:resume:priming': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#sending-messages-to-the-server',
        behavior: 'With eventStore + new protocol, POST SSE streams begin with a priming event carrying the configured retry: interval.',
        transports: ['streamableHttp'],
        note: 'Resumability requires a per-session transport with an EventStore and a standalone GET stream; stateless hosting has neither.'
    },
    'hosting:resume:replay': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#resumability-and-redelivery',
        behavior: 'GET with Last-Event-ID replays stored events for that stream after the given id.',
        transports: ['streamableHttp'],
        note: 'Resumability requires a per-session transport with an EventStore and a standalone GET stream; stateless hosting has neither.'
    },
    'hosting:resume:stream-scoped': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#resumability-and-redelivery',
        behavior: 'Replay via Last-Event-ID returns only messages from the stream that event id belongs to.',
        transports: ['streamableHttp'],
        note: 'Resumability requires a per-session transport with an EventStore and a standalone GET stream; stateless hosting has neither.'
    },

    // Hosting: HTTP semantics

    'hosting:http:accept-406': {
        source: 'sdk',
        behavior: 'A request whose Accept header does not allow the response representation returns 406.',
        transports: ['streamableHttp'],
        note: 'These test the per-session host layer (via hostPerSession helper); stateless transport tests use hostStateless which has different request routing.'
    },
    'hosting:http:batch': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#sending-messages-to-the-server',
        behavior:
            'POST body is a single JSON-RPC message; batched arrays are accepted only as an SDK back-compat affordance for pre-2025-06-18 clients (spec forbids batches).',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:http:content-type-415': {
        source: 'sdk',
        behavior: 'A POST with a Content-Type other than application/json returns 415.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:http:disconnect-not-cancel': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#sending-messages-to-the-server',
        behavior:
            'A client connection drop during an in-flight request does not cancel the server-side handler; the request continues and its result remains retrievable.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:http:dns-rebinding': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#security-warning',
        behavior: 'With DNS-rebinding protection enabled, disallowed Host/Origin returns 403; missing Origin is accepted.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:http:json-response-mode': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#sending-messages-to-the-server',
        behavior: 'With JSON response mode enabled, POST returns application/json instead of SSE.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:http:method-405': {
        source: 'sdk',
        behavior: 'An unsupported HTTP method on the MCP endpoint returns 405.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:http:no-broadcast': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#multiple-connections',
        behavior:
            'When multiple SSE streams are open for a session, each server-originated message is sent on exactly one stream, never duplicated.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:http:notifications-202': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#sending-messages-to-the-server',
        behavior: 'A POST containing only notifications or responses returns 202 with no body.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:http:onerror': {
        source: 'sdk',
        behavior: 'Transport-level rejections are reported through an error callback on the server transport.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:http:parse-error-400': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#sending-messages-to-the-server',
        behavior:
            'A POST body that is not valid JSON or not a valid JSON-RPC message is rejected with HTTP 400; the body may carry a JSON-RPC error response (the SDK sends a Parse error body).',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:http:protocol-version-400': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#protocol-version-header',
        behavior: 'An invalid or unsupported MCP-Protocol-Version header returns 400 Bad Request.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:http:response-same-connection': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#sending-messages-to-the-server',
        behavior:
            "A response is delivered on the SSE stream opened by the POST that carried its request (or that stream's resumed continuation), not on an unrelated stream.",
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:http:second-sse-rejected': {
        source: 'sdk',
        behavior: 'A second concurrent standalone GET SSE stream on the same session is rejected.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:http:sse-close-after-response': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#sending-messages-to-the-server',
        behavior: 'The server terminates a POST-initiated SSE stream after writing the JSON-RPC response.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:http:standalone-sse': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#listening-for-messages-from-the-server',
        behavior: 'GET opens a standalone SSE stream that receives server-initiated messages.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:http:standalone-sse-no-response': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#listening-for-messages-from-the-server',
        behavior:
            'The standalone GET SSE stream carries server requests and notifications but never a JSON-RPC response, except when resuming a prior request stream.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:express-app-helper': {
        transports: ['streamableHttp'],
        source: 'sdk',
        behavior:
            'createMcpExpressApp() returns an Express app with JSON body parsing and localhost host-header validation pre-applied: an MCP endpoint mounted on it serves an initialize POST over real HTTP from 127.0.0.1 and rejects a spoofed Host header with 403.',
        note: 'This exercises the Express hosting layer; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:http:host-validation-middleware': {
        transports: ['streamableHttp'],
        source: 'sdk',
        behavior:
            "hostHeaderValidation()/localhostHostValidation() Express middleware reject requests whose Host header is missing or not in the allow-list with 403 (port-agnostic), independent of the transport's enableDnsRebindingProtection.",
        note: 'This exercises the Express hosting layer; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:http:send-no-listener-noop': {
        source: 'sdk',
        behavior:
            'A server-initiated notification sent on a stateful session with no open standalone GET SSE stream does not throw; it is silently dropped (or stored for replay when an eventStore is configured).',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:auth:as:redirect-uri-scheme': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#communication-security',
        behavior: 'The bundled registration endpoint accepts only redirect URIs that use HTTPS or target a loopback host.',
        transports: ['streamableHttp'],
        note: 'These exercise the HTTP hosting/auth layer (mostly over real Express); the matrix transport arg is ignored, so they run as a single streamableHttp-labelled cell to avoid duplicate runs.',
        deferred:
            'removed in v2: the bundled dynamic client registration endpoint no longer exists, so its redirect_uri scheme validation cannot be exercised (this was a knownFailure on v1.x).'
    },
    'hosting:auth:as:redirect-uri-binding': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#open-redirection',
        behavior:
            "The bundled token endpoint rejects an authorization-code exchange whose `redirect_uri` differs from the one used at authorize; the bundled authorize endpoint rejects a `redirect_uri` not in the client's registered list without redirecting to it.",
        transports: ['streamableHttp'],
        note: 'These exercise the HTTP hosting/auth layer (mostly over real Express); the matrix transport arg is ignored, so they run as a single streamableHttp-labelled cell to avoid duplicate runs.',
        deferred:
            'removed in v2: the bundled authorize and token endpoints no longer exist, so redirect_uri binding across authorize and token cannot be exercised.'
    },
    'hosting:session:post-termination-404': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management',
        behavior: 'After a session is terminated, any further request carrying that session ID is answered with 404 Not Found.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer and session management; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.',
        knownFailures: [
            {
                note: 'The documented per-session hosting pattern (hostPerSession) removes the transport from the session map on DELETE via onsessionclosed and answers any later request carrying the stale Mcp-Session-Id with 400 at the app level, so the spec-required 404 is never produced.'
            }
        ]
    },
    'hosting:auth:query-token-ignored': {
        source: 'sdk',
        behavior: 'An access token presented in the URI query string is not accepted; the request is treated as unauthenticated.',
        transports: ['streamableHttp'],
        note: 'These exercise the HTTP hosting/auth layer (mostly over real Express); the matrix transport arg is ignored, so they run as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:auth:as:authorize-requires-pkce': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#authorization-code-protection',
        behavior: 'The bundled authorization endpoint rejects an authorize request that omits `code_challenge` with `invalid_request`.',
        transports: ['streamableHttp'],
        note: 'These exercise the HTTP hosting/auth layer (mostly over real Express); the matrix transport arg is ignored, so they run as a single streamableHttp-labelled cell to avoid duplicate runs.',
        deferred:
            'removed in v2: the bundled authorization endpoint no longer exists, so PKCE enforcement at authorize cannot be exercised.'
    },
    'hosting:auth:as:verifier-mismatch': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#authorization-code-protection',
        behavior:
            'The bundled token endpoint rejects an authorization-code exchange whose `code_verifier` does not hash to the stored `code_challenge` with `invalid_grant`.',
        transports: ['streamableHttp'],
        note: 'These exercise the HTTP hosting/auth layer (mostly over real Express); the matrix transport arg is ignored, so they run as a single streamableHttp-labelled cell to avoid duplicate runs.',
        deferred:
            'removed in v2: the bundled token endpoint no longer exists, so code_verifier checking at token exchange cannot be exercised.'
    },
    'hosting:auth:as:code-single-use': {
        source: 'sdk',
        behavior:
            'An authorization code can be exchanged exactly once; a second exchange of the same code is rejected with `invalid_grant`. Enforced by the provider deleting the code on first use; the handler relies on `the stored authorization code` returning None.',
        transports: ['streamableHttp'],
        note: 'These exercise the HTTP hosting/auth layer (mostly over real Express); the matrix transport arg is ignored, so they run as a single streamableHttp-labelled cell to avoid duplicate runs.',
        deferred:
            'removed in v2: the bundled token endpoint no longer exists, so single-use authorization-code exchange cannot be exercised.'
    },
    'hosting:http:protocol-version-default': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#protocol-version-header',
        behavior:
            'When no MCP-Protocol-Version header is received and the version cannot be determined another way, the server assumes protocol version 2025-03-26.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },

    // Client transport: streamableHttp

    'client-transport:http:404-surfaces': {
        source: 'sdk',
        behavior: 'A 404 (session expired) on a request surfaces as an error to the caller.',
        transports: ['streamableHttp'],
        note: 'Session-id continuity testing requires the per-session host (404 is session-not-found).'
    },
    'client-transport:http:session-404-reinitialize': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management',
        behavior:
            'A 404 in response to a request carrying a session ID makes the client start a new session with a fresh InitializeRequest and no session ID attached.',
        transports: ['streamableHttp'],
        note: 'This exercises the StreamableHTTP client transport directly; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.',
        knownFailures: [
            {
                note: 'On a 404 for an existing session the transport throws StreamableHTTPError (streamableHttp.ts:551) and never re-initializes — no session recovery is attempted.'
            }
        ]
    },
    'client-transport:http:accept-header-get': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#listening-for-messages-from-the-server',
        behavior: 'The client GET to the MCP endpoint includes an Accept header listing text/event-stream.',
        transports: ['streamableHttp'],
        note: 'This exercises the StreamableHTTP client transport directly; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-transport:http:accept-header-post': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#sending-messages-to-the-server',
        behavior: 'Every client POST to the MCP endpoint includes an Accept header listing both application/json and text/event-stream.',
        transports: ['streamableHttp'],
        note: 'This exercises the StreamableHTTP client transport directly; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-transport:http:concurrent-streams': {
        source: 'sdk',
        behavior: 'Multiple concurrent POST-initiated SSE streams each deliver their response to the right caller.',
        transports: ['streamableHttp'],
        note: 'This exercises the StreamableHTTP client transport directly; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'typescript:client-transport:http:custom-fetch': {
        source: 'sdk',
        behavior: 'A custom fetch in options is used for all HTTP including OAuth; global fetch is not called.',
        transports: ['streamableHttp'],
        note: 'This exercises the StreamableHTTP client transport directly; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-transport:http:custom-headers': {
        source: 'sdk',
        behavior: 'Caller-supplied headers are sent on every POST, GET, and DELETE to the MCP endpoint.',
        transports: ['streamableHttp'],
        note: 'This exercises the StreamableHTTP client transport directly; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-transport:http:json-response-parsed': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#sending-messages-to-the-server',
        behavior: 'A Content-Type application/json response is parsed as a single JSON-RPC message.',
        transports: ['streamableHttp'],
        note: 'This exercises the StreamableHTTP client transport directly; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-transport:http:no-reconnect-after-close': {
        source: 'sdk',
        behavior: 'After the transport is closed, no further reconnection attempts are scheduled.',
        transports: ['streamableHttp'],
        note: 'This exercises the StreamableHTTP client transport directly; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-transport:http:no-reconnect-after-response': {
        source: 'sdk',
        behavior: 'A POST-initiated stream that already delivered its response is not reconnected when it closes.',
        transports: ['streamableHttp'],
        note: 'This exercises the StreamableHTTP client transport directly; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-transport:http:protocol-version-header': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#protocol-version-header',
        behavior: 'After initialization, the client sends the negotiated MCP-Protocol-Version header on every subsequent HTTP request.',
        transports: ['streamableHttp'],
        note: 'This exercises the StreamableHTTP client transport directly; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'typescript:client-transport:http:protocol-version-stored': {
        source: 'sdk',
        behavior: 'transport.protocolVersion is populated after connect() completes.',
        transports: ['streamableHttp'],
        note: 'This exercises the StreamableHTTP client transport directly; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-transport:http:reconnect-get': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#resumability-and-redelivery',
        behavior: 'A standalone GET SSE stream that errors is reconnected with the Last-Event-ID of the last received event.',
        transports: ['streamableHttp'],
        note: 'This exercises the StreamableHTTP client transport directly; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-transport:http:reconnect-post-priming': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#sending-messages-to-the-server',
        behavior:
            'A POST-initiated SSE stream that errors before delivering its response is reconnected only if a priming event (an event carrying an ID) was received on it.',
        transports: ['streamableHttp'],
        note: 'This exercises the StreamableHTTP client transport directly; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-transport:http:reconnect-retry-value': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#sending-messages-to-the-server',
        behavior: 'Reconnection delay uses the SSE retry: value if sent; otherwise exponential backoff up to maxRetries.',
        transports: ['streamableHttp'],
        note: 'This exercises the StreamableHTTP client transport directly; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-transport:http:resume-stream-api': {
        source: 'sdk',
        behavior: 'The client can capture a resumption token, reconnect with the same session id, and receive the notifications it missed.',
        transports: ['streamableHttp'],
        note: 'This exercises the StreamableHTTP client transport directly; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-transport:http:session-stored': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management',
        behavior: 'The Mcp-Session-Id returned by initialize is stored by the client transport and sent on every subsequent request.',
        transports: ['streamableHttp'],
        note: 'This exercises the StreamableHTTP client transport directly; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-transport:http:sse-405-tolerated': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#listening-for-messages-from-the-server',
        behavior: 'Opening the standalone GET SSE stream tolerates a 405 response without failing the connection.',
        transports: ['streamableHttp'],
        note: 'This exercises the StreamableHTTP client transport directly; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-transport:http:terminate-405-ok': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management',
        behavior: 'Session termination succeeds without error if the server answers 405 (termination unsupported).',
        transports: ['streamableHttp'],
        note: 'This exercises the StreamableHTTP client transport directly; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-transport:http:body-stream-error-preserved': {
        source: 'sdk',
        behavior:
            'When the SSE response body stream errors during read, transport.onerror is invoked with an Error that preserves the original thrown error (as the instance itself or via .cause), not a string-interpolated wrapper that discards its type and stack.',
        transports: ['streamableHttp'],
        note: 'Session-id continuity testing requires the per-session host (validates session recovery/GET stream behavior).',
        knownFailures: [
            {
                note: 'src/client/streamableHttp.ts error-wrapping code: SSE body-stream errors wrapped as new Error(`SSE stream disconnected: ...`) with no .cause, losing original instance/stack.'
            }
        ]
    },

    // Client auth

    'client-auth:401-after-auth-throws': {
        source: 'sdk',
        behavior: 'If the server still returns 401 after a successful authorization, the client fails instead of looping.',
        transports: ['streamableHttp'],
        note: 'These exercise the HTTP hosting/auth layer (mostly over real Express); the matrix transport arg is ignored, so they run as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-auth:401-triggers-flow': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#protected-resource-metadata-discovery-requirements',
        behavior: 'A 401 on a request triggers the OAuth authorization flow once.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting/auth layer and OAuth client; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-auth:403-scope-upgrade': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#step-up-authorization-flow',
        behavior: 'A 403 with WWW-Authenticate triggers a scope-upgrade authorization attempt; repeated 403s do not loop.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting/auth layer and OAuth client; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-auth:as-metadata-discovery:priority-order': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#authorization-server-metadata-discovery',
        behavior:
            'The client discovers authorization-server metadata by trying, in order, the OAuth path-inserted, OIDC path-inserted, and OIDC path-appended well-known URLs (with the root-path forms when the issuer URL has no path).',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting/auth layer and OAuth client; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-auth:bearer-header:every-request': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#token-requirements',
        behavior:
            'Once authorized, the client sends the bearer token in the Authorization header on every HTTP request to the MCP server, never in the query string.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting/auth layer and OAuth client; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-auth:cimd': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#client-id-metadata-document',
        behavior: 'The client can use a client-ID metadata document URL as its OAuth client_id instead of registration.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting/auth layer and OAuth client; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-auth:client-credentials': {
        source: 'sdk',
        behavior:
            'A client-credentials provider obtains a token without user interaction and the resulting bearer token authorizes subsequent requests.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting/auth layer and OAuth client; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-auth:dcr': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#dynamic-client-registration',
        behavior: 'The client performs dynamic client registration against the authorization server when no client_id is preconfigured.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting/auth layer and OAuth client; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-auth:invalid-client-clears-all': {
        source: 'sdk',
        behavior: 'An invalid-client or unauthorized-client error during authorization invalidates all stored credentials.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting/auth layer and OAuth client; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-auth:invalid-grant-clears-tokens': {
        source: 'sdk',
        behavior: 'An invalid-grant error during authorization invalidates only the stored tokens.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting/auth layer and OAuth client; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-auth:pkce:refuse-if-unsupported': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#authorization-code-protection',
        behavior: 'Client refuses to proceed when AS metadata advertises code_challenge_methods_supported without S256.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting/auth layer and OAuth client; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-auth:pkce:s256': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#authorization-code-protection',
        behavior: 'The authorization request includes a PKCE S256 code challenge and the token request includes the matching verifier.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting/auth layer and OAuth client; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-auth:pre-registration': {
        source: 'sdk',
        behavior: 'A client with statically preconfigured credentials skips dynamic registration and uses them directly.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting/auth layer and OAuth client; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-auth:private-key-jwt': {
        source: 'sdk',
        behavior: 'The client can authenticate the client-credentials grant with a signed JWT assertion.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting/auth layer and OAuth client; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-auth:prm-discovery:fallback-order': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#protected-resource-metadata-discovery-requirements',
        behavior:
            'The client uses resource_metadata from WWW-Authenticate when present, then falls back to the well-known protected-resource locations in the documented order.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting/auth layer and OAuth client; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-auth:prm-resource-mismatch': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#authorization-server-location',
        behavior:
            "The client refuses to proceed when the protected-resource metadata's resource field does not match the server URL it is connecting to.",
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting/auth layer and OAuth client; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-auth:resource-parameter': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#resource-parameter-implementation',
        behavior:
            'The client includes the canonical server URI as the resource parameter in both the authorization request and the token request.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting/auth layer and OAuth client; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-auth:scope-selection:priority': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#scope-selection-strategy',
        behavior:
            'Client selects requested scope from the WWW-Authenticate scope param if present; otherwise uses scopes_supported from the PRM document; otherwise omits scope.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting/auth layer and OAuth client; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'typescript:client-auth:state:verify': {
        source: 'sdk',
        behavior: 'SDK calls provider.state?.() and includes the returned value as the state parameter in the authorize URL.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting/auth layer and OAuth client; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-auth:token-endpoint-auth-method': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#token-request',
        behavior: 'The client authenticates to the token endpoint using the auth method established at registration.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting/auth layer and OAuth client; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-auth:low-level:discover-and-exchange': {
        source: 'sdk',
        behavior:
            'The low-level auth helpers compose standalone: discoverOAuthProtectedResourceMetadata → discoverAuthorizationServerMetadata → startAuthorization → exchangeAuthorization, called directly (without the auth() orchestrator or an OAuthClientProvider), chain their outputs to inputs and yield valid OAuthTokens against a live AS.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting/auth layer and OAuth client; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-auth:middleware:with-oauth': {
        source: 'sdk',
        behavior:
            'withOAuth(provider, baseUrl) wraps a fetch: adds Authorization: Bearer from provider.tokens(); on 401 it runs the auth() flow (discovery/refresh) and retries once with the fresh token; a REDIRECT result or a second 401 throws UnauthorizedError.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting/auth layer and OAuth client; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-auth:private-key-jwt:static-assertion': {
        source: 'sdk',
        behavior:
            'StaticPrivateKeyJwtProvider authenticates the client_credentials grant by sending a caller-supplied pre-built JWT verbatim as client_assertion (jwt-bearer), with a fixed client_id so DCR is skipped — no per-request signing.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting/auth layer and OAuth client; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-auth:refresh:transparent': {
        source: 'sdk',
        behavior:
            'An access token the client considers expired is transparently refreshed before the next request, using the stored refresh token; the refresh request includes the resource indicator and the new token is persisted.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting/auth layer and OAuth client; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-auth:as-metadata-discovery:issuer-validation': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#authorization-server-metadata-discovery',
        behavior:
            'The client rejects authorization-server metadata whose issuer does not match the URL the metadata was retrieved from (RFC 8414 section 3.3).',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting/auth layer and OAuth client; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.',
        knownFailures: [
            {
                note: 'discoverAuthorizationServerMetadata never validates that the returned issuer matches the authorization-server URL the metadata was fetched from (RFC 8414 section 3.3), so spoofed-issuer metadata is accepted and the OAuth flow proceeds to registration and redirect.'
            }
        ]
    },
    'client-auth:prm-discovery:no-prm-fallback': {
        source: 'sdk',
        behavior:
            "When every protected-resource metadata probe fails, the client falls back to discovering authorization-server metadata directly at the MCP server's origin (the legacy 2025-03-26 path) rather than aborting.",
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting/auth layer and OAuth client; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },

    // Client middleware (SDK)

    'client-middleware:compose': {
        source: 'sdk',
        behavior:
            'applyMiddlewares(...mw) chains createMiddleware-built handlers in declaration order around a base fetch; passed as the transport fetch option, each layer can read/mutate request init and the result reaches the server.',
        transports: ['streamableHttp'],
        note: 'Exercises the client fetch middleware over HTTP; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-middleware:with-logging': {
        source: 'sdk',
        behavior:
            'withLogging() wraps fetch: invokes the configured logger once per HTTP request with {method, url, status, duration} and passes the response through unmodified so the MCP call result is unaffected.',
        transports: ['streamableHttp'],
        note: 'Exercises the client fetch middleware over HTTP; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },

    // stdio transport

    'transport:stdio:clean-shutdown': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#shutdown',
        behavior: "Closing the client transport closes the child process's stdin and the server exits cleanly.",
        transports: ['stdio'],
        note: 'Spawn-based tests against the real StdioClientTransport child process; only meaningful on stdio.'
    },
    'transport:stdio:no-embedded-newlines': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#stdio',
        behavior: 'Serialized JSON-RPC messages on stdio contain no embedded newlines; one message per line.',
        transports: ['stdio'],
        note: 'Spawn-based tests against the real StdioClientTransport child process; only meaningful on stdio.'
    },
    'transport:stdio:shutdown-escalation': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#stdio',
        behavior:
            'If the server process does not exit after stdin is closed, the client transport terminates it (and kills it if still alive) after a grace period.',
        transports: ['stdio'],
        note: 'Spawn-based tests against the real StdioClientTransport child process; only meaningful on stdio.'
    },
    'transport:stdio:stderr-passthrough': {
        source: 'sdk',
        behavior: 'Server stderr is available to the client and is not consumed by the transport.',
        transports: ['stdio'],
        note: 'Spawn-based tests against the real StdioClientTransport child process; only meaningful on stdio.'
    },
    'transport:stdio:default-env-safelist': {
        source: 'sdk',
        behavior:
            'StdioClientTransport spawned with no `env` option passes only DEFAULT_INHERITED_ENV_VARS (PATH, HOME, USER, …) to the child; arbitrary parent process.env entries (secrets) are not inherited. getDefaultEnvironment() is the public helper that produces this safelist.',
        transports: ['stdio'],
        note: 'Spawn-based tests against the real StdioClientTransport child process; only meaningful on stdio.'
    },

    // Composite end-to-end flows

    'flow:compat:dual-transport-server': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#backwards-compatibility',
        behavior:
            'A single server instance can serve streamable HTTP and the legacy SSE transport concurrently; clients on either transport can call the same tools.',
        transports: ['streamableHttp'],
        note: 'Deferred flows test legacy SSE; transport restriction reflects test infrastructure, not behavioral exclusion.',
        deferred: 'Legacy SSE transport is deprecated in the spec. Back-compat flows that require an SSE server are deferred.'
    },
    'flow:compat:streamable-then-sse-fallback': {
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#backwards-compatibility',
        behavior:
            'When a streamable HTTP initialize fails with 400, 404, or 405, falling back to the legacy SSE client transport against the same server connects successfully.',
        transports: ['streamableHttp'],
        note: 'This is an HTTP-specific compatibility flow; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.',
        deferred: 'Legacy SSE transport is deprecated in the spec. Back-compat flows that require an SSE server are deferred.'
    },
    'flow:elicitation:multi-step-form': {
        transports: STATEFUL_TRANSPORTS,
        source: 'sdk',
        behavior:
            'A single tool handler issues sequential elicitations; an accept on one step feeds the next, and a decline or cancel at any step short-circuits to a final result.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'flow:elicitation:url-at-session-init': {
        transports: ['streamableHttp'],
        source: 'sdk',
        behavior:
            'The server can issue a URL-mode elicitation over the standalone GET stream immediately after session initialization, before any client request.',
        note: 'This is an HTTP-specific flow requiring session management and a standalone GET stream; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'flow:elicitation:url-required-then-retry': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#url-elicitation-required-error',
        behavior:
            'A tool call rejected with the URL-elicitation-required error can be retried successfully after the client completes the URL flow and the server announces completion.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'flow:multi-client:stateful-isolation': {
        transports: ['streamableHttp'],
        source: 'sdk',
        behavior:
            'Independent clients connected to one stateful server each receive a distinct session and only the notifications produced by their own requests.',
        note: 'This is an HTTP-specific flow requiring session management; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'flow:oauth:authorization-code-roundtrip': {
        transports: ['streamableHttp'],
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#authorization-flow-steps',
        behavior:
            'Connecting to a protected server walks the authorization-code flow end to end: the first attempt requires authorization, the code is exchanged, and a subsequent connection succeeds.',
        note: 'End-to-end authorization-code journey (401 → discovery → DCR → redirect → finishAuth → authorized reconnect); the individual mechanisms are covered by the client-auth:* requirements. This exercises the HTTP hosting/auth layer and OAuth client; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'flow:resume:tool-call-resumption-token': {
        transports: ['streamableHttp'],
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#resumability-and-redelivery',
        behavior:
            'A tool call interrupted mid-stream is transparently resumed by the client transport using the last-seen event id, delivering only the remaining notifications and the final result.',
        note: 'Resumability requires a per-session transport with an EventStore and a standalone GET stream; stateless hosting has neither.'
    },
    'flow:session:terminate-then-reconnect': {
        transports: ['streamableHttp'],
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management',
        behavior: 'After terminating a session, a fresh connection obtains a new session id and operations succeed.',
        note: 'This is an HTTP-specific flow requiring session management; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'flow:tool-result:resource-link-follow': {
        transports: STATEFUL_TRANSPORTS,
        source: 'https://modelcontextprotocol.io/specification/2025-11-25/server/tools#resource-links',
        behavior:
            'A resource_link returned by a tool call can be followed with resources/read on the linked URI to retrieve the referenced contents.',
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'flow:proxy:forward-tools-resources': {
        transports: ['inMemory', 'streamableHttp'],
        source: 'sdk',
        behavior:
            "A proxy node composing a low-level Server (downstream) with a Client (upstream) forwards tools/list and resources/list; the downstream caller receives the upstream server's tool and resource lists with names, schemas, and _meta intact (mcp-proxy / mcp-remote / firebase-tools shape).",
        note: 'This is a multi-hop proxy flow that should work across transports; restricted to inMemory and streamableHttp to avoid test matrix bloat.'
    },
    // v2 features
    'standardschema:tool:valibot-input': {
        source: 'sdk',
        behavior:
            "registerTool() accepts a valibot object schema wrapped with @valibot/to-json-schema's toStandardJsonSchema() as inputSchema: tools/list advertises the derived JSON Schema and tools/call passes validated, parsed arguments to the handler."
    },
    'standardschema:tool:arktype-input': {
        source: 'sdk',
        behavior:
            'registerTool() accepts an arktype type as inputSchema: tools/list advertises the JSON Schema derived from it and tools/call passes validated, parsed arguments to the handler.'
    },
    'standardschema:tool:output-schema-validation': {
        source: 'sdk',
        behavior:
            'When a tool declares outputSchema, a handler return whose structuredContent does not conform is rejected by the server with JSON-RPC -32602 instead of being returned to the caller.',
        knownFailures: [
            {
                note: "McpServer's tools/call handler catches the output-validation ProtocolError (-32602) and returns it as an isError result instead of a JSON-RPC error; the nonconforming structuredContent is still withheld from the caller."
            }
        ]
    },
    'standardschema:prompt:args-schema': {
        source: 'sdk',
        behavior:
            'registerPrompt() accepts any Standard Schema as argsSchema: prompts/list exposes the argument names derived from it and prompts/get arguments are validated against it before the callback runs.'
    },
    'standardschema:tool:invalid-args-rejected': {
        source: 'sdk',
        behavior:
            'tools/call arguments that fail the registered Standard Schema validation are rejected with JSON-RPC -32602 (Input validation error) and the tool handler is not invoked.',
        knownFailures: [
            {
                note: "McpServer's tools/call handler catches the input-validation ProtocolError (-32602) and returns it as an isError result, so callTool() resolves instead of rejecting; the handler is still not invoked."
            }
        ]
    },
    'validators:from-json-schema:tool-roundtrip': {
        source: 'sdk',
        behavior:
            'A tool registered with fromJsonSchema(rawJsonSchema) advertises that JSON Schema in tools/list and accepts conforming arguments end to end.'
    },
    'validators:from-json-schema:invalid-args-rejected': {
        source: 'sdk',
        behavior:
            'tools/call arguments violating the JSON Schema wrapped by fromJsonSchema() are rejected with JSON-RPC -32602 and the handler is not invoked.',
        knownFailures: [
            {
                note: "McpServer's tools/call handler catches the input-validation ProtocolError (-32602) and returns it as an isError result, so callTool() resolves instead of rejecting; the handler is still not invoked."
            }
        ]
    },
    'validators:custom-validator:override': {
        source: 'sdk',
        behavior:
            'fromJsonSchema(schema, validator) uses the supplied jsonSchemaValidator implementation for argument validation instead of the runtime default.'
    },
    'guards:spec-type:call-tool-result': {
        source: 'sdk',
        behavior:
            'isSpecType.CallToolResult() returns true for a CallToolResult produced by a real tools/call and false for a structurally non-conforming value, narrowing the type for the caller.'
    },
    'guards:spec-type-schemas:sync-validate': {
        source: 'sdk',
        behavior:
            "specTypeSchemas.X['~standard'].validate() validates synchronously: it returns an object (not a Promise) carrying value for conforming input and issues for non-conforming input."
    },
    'hosting:hono:basic-flow': {
        source: 'sdk',
        behavior:
            "createMcpHonoApp() hosts an McpServer over real HTTP: a StreamableHTTPClientTransport pointed at the served app completes initialize, tools/list and tools/call against a WebStandardStreamableHTTPServerTransport mounted on the app's /mcp routes.",
        transports: ['streamableHttp'],
        note: 'This exercises the Hono hosting adapter over a real HTTP listener; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:hono:host-header-validation': {
        source: 'sdk',
        behavior:
            'A createMcpHonoApp() bound to the default localhost host rejects requests whose Host header is not an allowed localhost name with HTTP 403 (DNS-rebinding protection), while requests with a localhost Host succeed.',
        transports: ['streamableHttp'],
        note: 'This exercises the Hono hosting adapter over a real HTTP listener; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:fastify:basic-flow': {
        source: 'sdk',
        behavior:
            'createMcpFastifyApp() hosts an McpServer over real HTTP: a StreamableHTTPClientTransport pointed at the listening Fastify instance completes initialize, tools/list and tools/call against a WebStandardStreamableHTTPServerTransport wired to its /mcp routes.',
        transports: ['streamableHttp'],
        note: 'This exercises the Fastify hosting adapter over a real HTTP listener; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:fastify:host-header-validation': {
        source: 'sdk',
        behavior:
            'A createMcpFastifyApp() bound to the default localhost host rejects requests whose Host header is not an allowed localhost name with HTTP 403 (DNS-rebinding protection), while requests with a localhost Host succeed.',
        transports: ['streamableHttp'],
        note: 'This exercises the Fastify hosting adapter over a real HTTP listener; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:express:adapter-basic-flow': {
        source: 'sdk',
        behavior:
            'createMcpExpressApp() returns an Express app that, with a streamable HTTP server transport mounted on a POST route, serves a full initialize and tools/call exchange.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'hosting:express:adapter-host-header-validation': {
        source: 'sdk',
        behavior:
            'An app created by createMcpExpressApp() with the default localhost host applies DNS-rebinding protection: a request whose Host header is not an allowed local host is rejected with 403 before reaching the MCP transport.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'custom-methods:server-handler:roundtrip': {
        source: 'sdk',
        behavior:
            "A server handler registered with setRequestHandler('<vendor>/method', { params, result }, handler) for a non-spec method receives schema-validated params and its return value is delivered to a client calling request() with the matching result schema."
    },
    'custom-methods:client-handler:roundtrip': {
        source: 'sdk',
        behavior:
            "A client handler registered with setRequestHandler('<vendor>/method', { params, result }, handler) for a non-spec method serves requests sent by the server via request() with the matching result schema.",
        transports: STATEFUL_TRANSPORTS,
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'custom-methods:params-validation-error': {
        source: 'sdk',
        behavior:
            'A non-spec request whose params fail the params schema given at setRequestHandler() is answered with JSON-RPC -32602 and the handler is not invoked.'
    },
    'custom-methods:notification-handler': {
        source: 'sdk',
        behavior:
            'A notification handler registered for a non-spec method with a params schema receives schema-validated custom notifications sent by the remote side.',
        transports: STATEFUL_TRANSPORTS,
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'typescript:method-string-handlers:result-type-inference': {
        source: 'sdk',
        behavior:
            'client.request() called with a spec method string and no result schema resolves with the result already parsed and validated for that method (ResultTypeMap inference), e.g. tools/list yields a usable tools array without passing a schema.'
    },
    'protocol:result-validation:invalid-result-sdkerror': {
        source: 'sdk',
        behavior:
            'A response whose result does not conform to the expected result schema causes the requesting side to reject with SdkError code InvalidResult instead of resolving with the malformed result.'
    },
    'mcpserver:context:log-from-handler': {
        source: 'sdk',
        behavior:
            'ctx.mcpReq.log() inside a registered tool handler emits a notifications/message logging notification that the client receives while the call is in flight.',
        transports: STATEFUL_TRANSPORTS,
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'mcpserver:context:elicit-from-handler': {
        source: 'sdk',
        behavior:
            "ctx.mcpReq.elicitInput() inside a tool handler sends elicitation/create to the client and resolves with the client's ElicitResult, which the handler can fold into its tool result.",
        transports: STATEFUL_TRANSPORTS,
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'mcpserver:context:sampling-from-handler': {
        source: 'sdk',
        behavior:
            "ctx.mcpReq.requestSampling() inside a tool handler sends sampling/createMessage to the client and resolves with the client's CreateMessageResult.",
        transports: STATEFUL_TRANSPORTS,
        note: 'Stateless hosting creates a fresh server per request and has no standalone GET stream, so there is no server→client channel to deliver/observe these.'
    },
    'hosting:context:web-request-headers': {
        source: 'sdk',
        behavior:
            "Under HTTP hosting, a request handler's ctx.http.req exposes the incoming HTTP request's headers as Fetch Headers, so a custom header sent by the client transport is readable inside the handler.",
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'errors:timeout:sdkerror-request-timeout': {
        source: 'sdk',
        behavior:
            'A request that exceeds its timeout option rejects with an SdkError whose code is RequestTimeout, and the rejection carries the timeout details rather than a generic Error.'
    },
    'errors:capability:sdkerror-capability-not-supported': {
        source: 'sdk',
        behavior:
            'Invoking an operation whose capability the remote side did not declare rejects locally with an SdkError whose code is CapabilityNotSupported (no request is sent).',
        transports: STATEFUL_TRANSPORTS,
        note: 'The clearest probe is a server→client operation (createMessage without client sampling capability), which needs a live server instance bound to the session.'
    },
    'errors:wire:protocolerror-invalid-params': {
        source: 'sdk',
        behavior:
            'A JSON-RPC error response surfaces on the requesting side as a ProtocolError carrying the wire error code (e.g. -32602) and message, distinguishable from SDK-side SdkErrors.'
    },
    'errors:http:sdkhttperror-status': {
        source: 'sdk',
        behavior:
            'An HTTP-level failure from the server endpoint (non-2xx response that is not an auth retry) surfaces on the client as an SdkHttpError exposing the HTTP status code via .status.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP hosting layer; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-auth:oauth-error:consolidated-class': {
        source: 'sdk',
        behavior:
            'OAuth error responses surface as OAuthError instances carrying a machine-readable OAuthErrorCode (e.g. invalid_grant, invalid_token) instead of the per-code subclasses removed in v2.',
        transports: ['streamableHttp'],
        note: 'This exercises the HTTP auth layer against a mock authorization server; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.'
    },
    'client-auth:authprovider:token-attached': {
        source: 'sdk',
        behavior:
            'An AuthProvider supplied to StreamableHTTPClientTransport has token() called before each request and the returned token is attached as an Authorization: Bearer header on the HTTP requests.',
        transports: ['streamableHttp'],
        note: "This exercises the HTTP client transport's auth hook; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs."
    },
    'client-auth:authprovider:onunauthorized-retry': {
        source: 'sdk',
        behavior:
            'When the server answers 401, the transport awaits AuthProvider.onUnauthorized() and retries the request once with the refreshed token; a second 401 (or a provider without onUnauthorized) surfaces as UnauthorizedError.',
        transports: ['streamableHttp'],
        note: "This exercises the HTTP client transport's auth hook; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs.",
        knownFailures: [
            {
                test: 'second 401 after retry surfaces as UnauthorizedError',
                note: 'A second 401 after onUnauthorized() re-authentication surfaces as SdkHttpError (ClientHttpAuthentication) instead of the UnauthorizedError documented on AuthProvider.onUnauthorized().'
            }
        ]
    },
    'client-auth:authprovider:oauth-provider-adapted': {
        source: 'sdk',
        behavior:
            'Passing a full OAuthClientProvider as authProvider still works: the transport adapts it internally and attaches its access token as the bearer token on requests.',
        transports: ['streamableHttp'],
        note: "This exercises the HTTP client transport's auth hook; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs."
    },
    'client-transport:http:reconnection-scheduler': {
        source: 'sdk',
        behavior:
            'A reconnectionScheduler supplied to StreamableHTTPClientTransport is invoked with (reconnect, delay, attemptCount) when an SSE stream drops, and invoking the provided reconnect callback re-establishes the stream (replacing the default backoff timer).',
        transports: ['streamableHttp'],
        note: "This exercises the HTTP client transport's reconnection path; the matrix transport arg is ignored, so it runs as a single streamableHttp-labelled cell to avoid duplicate runs."
    },
    'lifecycle:version:custom-supported-versions': {
        source: 'sdk',
        behavior:
            'supportedProtocolVersions passed in Client/Server options overrides the negotiation list: a client requesting a version the server supports gets that version back, and both sides report the negotiated version after connect.'
    },
    'lifecycle:version:no-overlap-rejects': {
        source: 'sdk',
        behavior:
            "When the server's negotiated protocol version is not in the client's supportedProtocolVersions list, client.connect() rejects and the connection is not established."
    },
    'lifecycle:capability:list-empty-when-not-advertised': {
        source: 'sdk',
        behavior:
            'Client.listTools(), listPrompts(), listResources() and listResourceTemplates() resolve with empty result lists, without sending a request, when the server did not advertise the corresponding capability.'
    },
    'lifecycle:capability:strict-mode-throws': {
        source: 'sdk',
        behavior:
            'With enforceStrictCapabilities: true, calling a list method for a capability the server did not advertise rejects with a capability error instead of resolving empty.'
    },
    'tasks:result:failed-task-stored-result': {
        source: 'sdk',
        behavior:
            'When a task-augmented tool call fails, the failure is stored with status failed and a subsequent tasks/result request for that task returns the stored error result instead of losing it.',
        transports: STATEFUL_TRANSPORTS,
        note: 'Task polling and result retrieval need the same server instance across requests, which stateless hosting does not provide.'
    }
} satisfies Record<string, Requirement>;

export type RequirementId = keyof typeof REQUIREMENTS;
