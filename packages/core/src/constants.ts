export const LATEST_PROTOCOL_VERSION = '2025-11-25';
export const DEFAULT_NEGOTIATED_PROTOCOL_VERSION = '2025-03-26';
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];

/**
 * `_meta` key associating a message with a 2025-11-25 task.
 *
 * @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
 */
export const RELATED_TASK_META_KEY = 'io.modelcontextprotocol/related-task';

/* Reserved `_meta` keys for the per-request envelope (protocol revision 2026-07-28) */

/**
 * `_meta` key carrying the MCP protocol version governing a request.
 *
 * For the HTTP transport, the value must match the `MCP-Protocol-Version` header.
 */
export const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';

/**
 * `_meta` key identifying the client software making a request.
 */
export const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';

/**
 * `_meta` key carrying the client's capabilities for a request.
 *
 * Capabilities are declared per request rather than once at initialization;
 * servers must not infer capabilities from prior requests.
 */
export const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';

/**
 * `_meta` key carrying the JSON-RPC ID of the `subscriptions/listen` request
 * that opened the stream a notification was delivered on.
 *
 * Stamped by the server on every notification delivered via a
 * `subscriptions/listen` stream (including the leading
 * `notifications/subscriptions/acknowledged`); on stdio, where all messages
 * share one channel, clients use it to correlate notifications with their
 * originating subscription. The value is the listen request's JSON-RPC ID
 * verbatim.
 */
export const SUBSCRIPTION_ID_META_KEY = 'io.modelcontextprotocol/subscriptionId';

/**
 * `_meta` key carrying the desired log level for a request.
 *
 * When absent, the server must not send `notifications/message` notifications
 * for the request.
 *
 * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
 * in the specification for at least twelve months.
 */
export const LOG_LEVEL_META_KEY = 'io.modelcontextprotocol/logLevel';

/*
 * Reserved `_meta` keys for distributed trace context propagation (SEP-414).
 *
 * These unprefixed keys are reserved by the MCP specification as an explicit
 * exception to the `_meta` key prefix rule. The SDK does not interpret them;
 * they pass through `_meta` untouched for OpenTelemetry-style propagation.
 */

/**
 * `_meta` key carrying W3C Trace Context for distributed tracing (SEP-414).
 *
 * When present, the value MUST follow the W3C `traceparent` header format,
 * e.g. `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`.
 *
 * @see https://www.w3.org/TR/trace-context/#traceparent-header
 */
export const TRACEPARENT_META_KEY = 'traceparent';

/**
 * `_meta` key carrying vendor-specific trace state for distributed tracing (SEP-414).
 *
 * When present, the value MUST follow the W3C `tracestate` header format,
 * e.g. `vendor1=value1,vendor2=value2`.
 *
 * @see https://www.w3.org/TR/trace-context/#tracestate-header
 */
export const TRACESTATE_META_KEY = 'tracestate';

/**
 * `_meta` key carrying cross-cutting propagation values for distributed tracing (SEP-414).
 *
 * When present, the value MUST follow the W3C Baggage header format,
 * e.g. `userId=alice,serverRegion=us-east-1`.
 *
 * @see https://www.w3.org/TR/baggage/
 */
export const BAGGAGE_META_KEY = 'baggage';

/* JSON-RPC types */
export const JSONRPC_VERSION = '2.0';

/* Standard JSON-RPC error code constants */
export const PARSE_ERROR = -32_700;
export const INVALID_REQUEST = -32_600;
export const METHOD_NOT_FOUND = -32_601;
export const INVALID_PARAMS = -32_602;
export const INTERNAL_ERROR = -32_603;
