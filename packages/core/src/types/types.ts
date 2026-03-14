import type { INTERNAL_ERROR, INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND, PARSE_ERROR } from './constants.js';
import type {
    CompleteRequest,
    CompleteRequestParams,
    CreateMessageRequestParams,
    ExpandRecursively,
    Prompt,
    PromptReference,
    RequestMeta,
    Resource,
    ResourceTemplateReference,
    Tool
} from './schemas.js';

/**
 * Information about a validated access token, provided to request handlers.
 */
export interface AuthInfo {
    /**
     * The access token.
     */
    token: string;

    /**
     * The client ID associated with this token.
     */
    clientId: string;

    /**
     * Scopes associated with this token.
     */
    scopes: string[];

    /**
     * When the token expires (in seconds since epoch).
     */
    expiresAt?: number;

    /**
     * The RFC 8707 resource server identifier for which this token is valid.
     * If set, this MUST match the MCP server's resource identifier (minus hash fragment).
     */
    resource?: URL;

    /**
     * Additional data associated with the token.
     * This field should be used for any additional data that needs to be attached to the auth info.
     */
    extra?: Record<string, unknown>;
}

type JSONRPCErrorObject = { code: number; message: string; data?: unknown };

export interface ParseError extends JSONRPCErrorObject {
    code: typeof PARSE_ERROR;
}
export interface InvalidRequestError extends JSONRPCErrorObject {
    code: typeof INVALID_REQUEST;
}
export interface MethodNotFoundError extends JSONRPCErrorObject {
    code: typeof METHOD_NOT_FOUND;
}
export interface InvalidParamsError extends JSONRPCErrorObject {
    code: typeof INVALID_PARAMS;
}
export interface InternalError extends JSONRPCErrorObject {
    code: typeof INTERNAL_ERROR;
}

/**
 * Callback type for list changed notifications.
 */
export type ListChangedCallback<T> = (error: Error | null, items: T[] | null) => void;

/**
 * Options for subscribing to list changed notifications.
 *
 * @typeParam T - The type of items in the list ({@linkcode Tool}, {@linkcode Prompt}, or {@linkcode Resource})
 */
export type ListChangedOptions<T> = {
    /**
     * If `true`, the list will be refreshed automatically when a list changed notification is received.
     * @default true
     */
    autoRefresh?: boolean;
    /**
     * Debounce time in milliseconds. Set to `0` to disable.
     * @default 300
     */
    debounceMs?: number;
    /**
     * Callback invoked when the list changes.
     *
     * If `autoRefresh` is `true`, `items` contains the updated list.
     * If `autoRefresh` is `false`, `items` is `null` (caller should refresh manually).
     */
    onChanged: ListChangedCallback<T>;
};

/**
 * Configuration for list changed notification handlers.
 *
 * Use this to configure handlers for tools, prompts, and resources list changes
 * when creating a client.
 *
 * Note: Handlers are only activated if the server advertises the corresponding
 * `listChanged` capability (e.g., `tools.listChanged: true`). If the server
 * doesn't advertise this capability, the handler will not be set up.
 */
export type ListChangedHandlers = {
    /**
     * Handler for tool list changes.
     */
    tools?: ListChangedOptions<Tool>;
    /**
     * Handler for prompt list changes.
     */
    prompts?: ListChangedOptions<Prompt>;
    /**
     * Handler for resource list changes.
     */
    resources?: ListChangedOptions<Resource>;
};

/**
 * Information about the incoming request.
 */
export interface RequestInfo {
    /**
     * The headers of the request.
     */
    headers: Headers;
}

/**
 * Extra information about a message.
 */
export interface MessageExtraInfo {
    /**
     * The request information.
     */
    requestInfo?: RequestInfo;

    /**
     * The authentication information.
     */
    authInfo?: AuthInfo;

    /**
     * Callback to close the SSE stream for this request, triggering client reconnection.
     * Only available when using {@linkcode @modelcontextprotocol/node!streamableHttp.NodeStreamableHTTPServerTransport | NodeStreamableHTTPServerTransport} with eventStore configured.
     */
    closeSSEStream?: () => void;

    /**
     * Callback to close the standalone GET SSE stream, triggering client reconnection.
     * Only available when using {@linkcode @modelcontextprotocol/node!streamableHttp.NodeStreamableHTTPServerTransport | NodeStreamableHTTPServerTransport} with eventStore configured.
     */
    closeStandaloneSSEStream?: () => void;
}

export type MetaObject = Record<string, unknown>;
export type RequestMetaObject = RequestMeta;

/**
 * {@linkcode CreateMessageRequestParams} without tools - for backwards-compatible overload.
 * Excludes tools/toolChoice to indicate they should not be provided.
 */
export type CreateMessageRequestParamsBase = Omit<CreateMessageRequestParams, 'tools' | 'toolChoice'>;

/**
 * {@linkcode CreateMessageRequestParams} with required tools - for tool-enabled overload.
 */
export interface CreateMessageRequestParamsWithTools extends CreateMessageRequestParams {
    tools: Tool[];
}

export type CompleteRequestResourceTemplate = ExpandRecursively<
    CompleteRequest & { params: CompleteRequestParams & { ref: ResourceTemplateReference } }
>;
export type CompleteRequestPrompt = ExpandRecursively<CompleteRequest & { params: CompleteRequestParams & { ref: PromptReference } }>;
