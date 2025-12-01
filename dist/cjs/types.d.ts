import * as z from 'zod/v4';
import { AuthInfo } from './server/auth/types.js';
export declare const LATEST_PROTOCOL_VERSION = "2025-06-18";
export declare const DEFAULT_NEGOTIATED_PROTOCOL_VERSION = "2025-03-26";
export declare const SUPPORTED_PROTOCOL_VERSIONS: string[];
export declare const RELATED_TASK_META_KEY = "io.modelcontextprotocol/related-task";
export declare const JSONRPC_VERSION = "2.0";
/**
 * Utility types
 */
type ExpandRecursively<T> = T extends object ? (T extends infer O ? {
    [K in keyof O]: ExpandRecursively<O[K]>;
} : never) : T;
/**
 * A progress token, used to associate progress notifications with the original request.
 */
export declare const ProgressTokenSchema: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
/**
 * An opaque token used to represent a cursor for pagination.
 */
export declare const CursorSchema: z.ZodString;
/**
 * Task creation parameters, used to ask that the server create a task to represent a request.
 */
export declare const TaskCreationParamsSchema: z.ZodObject<{
    /**
     * Time in milliseconds to keep task results available after completion.
     * If null, the task has unlimited lifetime until manually cleaned up.
     */
    ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
    /**
     * Time in milliseconds to wait between task status requests.
     */
    pollInterval: z.ZodOptional<z.ZodNumber>;
}, z.core.$loose>;
/**
 * Task association metadata, used to signal which task a message originated from.
 */
export declare const RelatedTaskMetadataSchema: z.ZodObject<{
    taskId: z.ZodString;
}, z.core.$loose>;
declare const RequestMetaSchema: z.ZodObject<{
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    /**
     * If specified, this request is related to the provided task.
     */
    "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
    }, z.core.$loose>>;
}, z.core.$loose>;
/**
 * Common params for any request.
 */
declare const BaseRequestParamsSchema: z.ZodObject<{
    /**
     * If specified, the caller is requesting that the receiver create a task to represent the request.
     * Task creation parameters are now at the top level instead of in _meta.
     */
    task: z.ZodOptional<z.ZodObject<{
        /**
         * Time in milliseconds to keep task results available after completion.
         * If null, the task has unlimited lifetime until manually cleaned up.
         */
        ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
        /**
         * Time in milliseconds to wait between task status requests.
         */
        pollInterval: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
    /**
     * See [General fields: `_meta`](/specification/draft/basic/index#meta) for notes on `_meta` usage.
     */
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
         */
        progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
        /**
         * If specified, this request is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
}, z.core.$loose>;
export declare const RequestSchema: z.ZodObject<{
    method: z.ZodString;
    params: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, the caller is requesting that the receiver create a task to represent the request.
         * Task creation parameters are now at the top level instead of in _meta.
         */
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        /**
         * See [General fields: `_meta`](/specification/draft/basic/index#meta) for notes on `_meta` usage.
         */
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
}, z.core.$strip>;
declare const NotificationsParamsSchema: z.ZodObject<{
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on _meta usage.
     */
    _meta: z.ZodOptional<z.ZodObject<{
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
}, z.core.$loose>;
export declare const NotificationSchema: z.ZodObject<{
    method: z.ZodString;
    params: z.ZodOptional<z.ZodObject<{
        /**
         * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
         * for notes on _meta usage.
         */
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
}, z.core.$strip>;
export declare const ResultSchema: z.ZodObject<{
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on _meta usage.
     */
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
}, z.core.$loose>;
/**
 * A uniquely identifying ID for a request in JSON-RPC.
 */
export declare const RequestIdSchema: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
/**
 * A request that expects a response.
 */
export declare const JSONRPCRequestSchema: z.ZodObject<{
    method: z.ZodString;
    params: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, the caller is requesting that the receiver create a task to represent the request.
         * Task creation parameters are now at the top level instead of in _meta.
         */
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        /**
         * See [General fields: `_meta`](/specification/draft/basic/index#meta) for notes on `_meta` usage.
         */
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    jsonrpc: z.ZodLiteral<"2.0">;
    id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
}, z.core.$strict>;
export declare const isJSONRPCRequest: (value: unknown) => value is JSONRPCRequest;
/**
 * A notification which does not expect a response.
 */
export declare const JSONRPCNotificationSchema: z.ZodObject<{
    method: z.ZodString;
    params: z.ZodOptional<z.ZodObject<{
        /**
         * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
         * for notes on _meta usage.
         */
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    jsonrpc: z.ZodLiteral<"2.0">;
}, z.core.$strict>;
export declare const isJSONRPCNotification: (value: unknown) => value is JSONRPCNotification;
/**
 * A successful (non-error) response to a request.
 */
export declare const JSONRPCResponseSchema: z.ZodObject<{
    jsonrpc: z.ZodLiteral<"2.0">;
    id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
    result: z.ZodObject<{
        /**
         * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
         * for notes on _meta usage.
         */
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, this result is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>;
}, z.core.$strict>;
export declare const isJSONRPCResponse: (value: unknown) => value is JSONRPCResponse;
/**
 * Error codes defined by the JSON-RPC specification.
 */
export declare enum ErrorCode {
    ConnectionClosed = -32000,
    RequestTimeout = -32001,
    ParseError = -32700,
    InvalidRequest = -32600,
    MethodNotFound = -32601,
    InvalidParams = -32602,
    InternalError = -32603,
    UrlElicitationRequired = -32042
}
/**
 * A response to a request that indicates an error occurred.
 */
export declare const JSONRPCErrorSchema: z.ZodObject<{
    jsonrpc: z.ZodLiteral<"2.0">;
    id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
    error: z.ZodObject<{
        code: z.ZodNumber;
        message: z.ZodString;
        data: z.ZodOptional<z.ZodUnknown>;
    }, z.core.$strip>;
}, z.core.$strict>;
export declare const isJSONRPCError: (value: unknown) => value is JSONRPCError;
export declare const JSONRPCMessageSchema: z.ZodUnion<readonly [z.ZodObject<{
    method: z.ZodString;
    params: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, the caller is requesting that the receiver create a task to represent the request.
         * Task creation parameters are now at the top level instead of in _meta.
         */
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        /**
         * See [General fields: `_meta`](/specification/draft/basic/index#meta) for notes on `_meta` usage.
         */
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    jsonrpc: z.ZodLiteral<"2.0">;
    id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
}, z.core.$strict>, z.ZodObject<{
    method: z.ZodString;
    params: z.ZodOptional<z.ZodObject<{
        /**
         * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
         * for notes on _meta usage.
         */
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    jsonrpc: z.ZodLiteral<"2.0">;
}, z.core.$strict>, z.ZodObject<{
    jsonrpc: z.ZodLiteral<"2.0">;
    id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
    result: z.ZodObject<{
        /**
         * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
         * for notes on _meta usage.
         */
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, this result is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>;
}, z.core.$strict>, z.ZodObject<{
    jsonrpc: z.ZodLiteral<"2.0">;
    id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
    error: z.ZodObject<{
        code: z.ZodNumber;
        message: z.ZodString;
        data: z.ZodOptional<z.ZodUnknown>;
    }, z.core.$strip>;
}, z.core.$strict>]>;
/**
 * A response that indicates success but carries no data.
 */
export declare const EmptyResultSchema: z.ZodObject<{
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on _meta usage.
     */
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
}, z.core.$strict>;
export declare const CancelledNotificationParamsSchema: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    requestId: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
    reason: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
/**
 * This notification can be sent by either side to indicate that it is cancelling a previously-issued request.
 *
 * The request SHOULD still be in-flight, but due to communication latency, it is always possible that this notification MAY arrive after the request has already finished.
 *
 * This notification indicates that the result will be unused, so any associated processing SHOULD cease.
 *
 * A client MUST NOT attempt to cancel its `initialize` request.
 */
export declare const CancelledNotificationSchema: z.ZodObject<{
    method: z.ZodLiteral<"notifications/cancelled">;
    params: z.ZodObject<{
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        requestId: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
        reason: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>;
}, z.core.$strip>;
/**
 * Icon schema for use in tools, prompts, resources, and implementations.
 */
export declare const IconSchema: z.ZodObject<{
    src: z.ZodString;
    mimeType: z.ZodOptional<z.ZodString>;
    sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
/**
 * Base schema to add `icons` property.
 *
 */
export declare const IconsSchema: z.ZodObject<{
    icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
        src: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
/**
 * Base metadata interface for common properties across resources, tools, prompts, and implementations.
 */
export declare const BaseMetadataSchema: z.ZodObject<{
    name: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * Describes the name and version of an MCP implementation.
 */
export declare const ImplementationSchema: z.ZodObject<{
    version: z.ZodString;
    websiteUrl: z.ZodOptional<z.ZodString>;
    icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
        src: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>>;
    name: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * Task capabilities for clients, indicating which request types support task creation.
 */
export declare const ClientTasksCapabilitySchema: z.ZodObject<{
    list: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    cancel: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    requests: z.ZodOptional<z.ZodObject<{
        sampling: z.ZodOptional<z.ZodObject<{
            createMessage: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        }, z.core.$loose>>;
        elicitation: z.ZodOptional<z.ZodObject<{
            create: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
}, z.core.$loose>;
/**
 * Task capabilities for servers, indicating which request types support task creation.
 */
export declare const ServerTasksCapabilitySchema: z.ZodObject<{
    list: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    cancel: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    requests: z.ZodOptional<z.ZodObject<{
        tools: z.ZodOptional<z.ZodObject<{
            call: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
}, z.core.$loose>;
/**
 * Capabilities a client may support. Known capabilities are defined here, in this schema, but this is not a closed set: any client can define its own, additional capabilities.
 */
export declare const ClientCapabilitiesSchema: z.ZodObject<{
    experimental: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodCustom<object, object>>>;
    sampling: z.ZodOptional<z.ZodObject<{
        context: z.ZodOptional<z.ZodCustom<object, object>>;
        tools: z.ZodOptional<z.ZodCustom<object, object>>;
    }, z.core.$strip>>;
    elicitation: z.ZodOptional<z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodIntersection<z.ZodObject<{
        form: z.ZodOptional<z.ZodIntersection<z.ZodObject<{
            applyDefaults: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>, z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
        url: z.ZodOptional<z.ZodCustom<object, object>>;
    }, z.core.$strip>, z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>>;
    roots: z.ZodOptional<z.ZodObject<{
        listChanged: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    tasks: z.ZodOptional<z.ZodObject<{
        list: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        cancel: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        requests: z.ZodOptional<z.ZodObject<{
            sampling: z.ZodOptional<z.ZodObject<{
                createMessage: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            }, z.core.$loose>>;
            elicitation: z.ZodOptional<z.ZodObject<{
                create: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
}, z.core.$strip>;
export declare const InitializeRequestParamsSchema: z.ZodObject<{
    task: z.ZodOptional<z.ZodObject<{
        /**
         * Time in milliseconds to keep task results available after completion.
         * If null, the task has unlimited lifetime until manually cleaned up.
         */
        ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
        /**
         * Time in milliseconds to wait between task status requests.
         */
        pollInterval: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
         */
        progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
        /**
         * If specified, this request is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    protocolVersion: z.ZodString;
    capabilities: z.ZodObject<{
        experimental: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodCustom<object, object>>>;
        sampling: z.ZodOptional<z.ZodObject<{
            context: z.ZodOptional<z.ZodCustom<object, object>>;
            tools: z.ZodOptional<z.ZodCustom<object, object>>;
        }, z.core.$strip>>;
        elicitation: z.ZodOptional<z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodIntersection<z.ZodObject<{
            form: z.ZodOptional<z.ZodIntersection<z.ZodObject<{
                applyDefaults: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strip>, z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
            url: z.ZodOptional<z.ZodCustom<object, object>>;
        }, z.core.$strip>, z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>>;
        roots: z.ZodOptional<z.ZodObject<{
            listChanged: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>>;
        tasks: z.ZodOptional<z.ZodObject<{
            list: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            cancel: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            requests: z.ZodOptional<z.ZodObject<{
                sampling: z.ZodOptional<z.ZodObject<{
                    createMessage: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
                }, z.core.$loose>>;
                elicitation: z.ZodOptional<z.ZodObject<{
                    create: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
                }, z.core.$loose>>;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$strip>;
    clientInfo: z.ZodObject<{
        version: z.ZodString;
        websiteUrl: z.ZodOptional<z.ZodString>;
        icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
            src: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>>;
        name: z.ZodString;
        title: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$loose>;
/**
 * This request is sent from the client to the server when it first connects, asking it to begin initialization.
 */
export declare const InitializeRequestSchema: z.ZodObject<{
    method: z.ZodLiteral<"initialize">;
    params: z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        protocolVersion: z.ZodString;
        capabilities: z.ZodObject<{
            experimental: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodCustom<object, object>>>;
            sampling: z.ZodOptional<z.ZodObject<{
                context: z.ZodOptional<z.ZodCustom<object, object>>;
                tools: z.ZodOptional<z.ZodCustom<object, object>>;
            }, z.core.$strip>>;
            elicitation: z.ZodOptional<z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodIntersection<z.ZodObject<{
                form: z.ZodOptional<z.ZodIntersection<z.ZodObject<{
                    applyDefaults: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strip>, z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
                url: z.ZodOptional<z.ZodCustom<object, object>>;
            }, z.core.$strip>, z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>>;
            roots: z.ZodOptional<z.ZodObject<{
                listChanged: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strip>>;
            tasks: z.ZodOptional<z.ZodObject<{
                list: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
                cancel: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
                requests: z.ZodOptional<z.ZodObject<{
                    sampling: z.ZodOptional<z.ZodObject<{
                        createMessage: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
                    }, z.core.$loose>>;
                    elicitation: z.ZodOptional<z.ZodObject<{
                        create: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
                    }, z.core.$loose>>;
                }, z.core.$loose>>;
            }, z.core.$loose>>;
        }, z.core.$strip>;
        clientInfo: z.ZodObject<{
            version: z.ZodString;
            websiteUrl: z.ZodOptional<z.ZodString>;
            icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
                src: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strip>>>;
            name: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$loose>;
}, z.core.$strip>;
export declare const isInitializeRequest: (value: unknown) => value is InitializeRequest;
/**
 * Capabilities that a server may support. Known capabilities are defined here, in this schema, but this is not a closed set: any server can define its own, additional capabilities.
 */
export declare const ServerCapabilitiesSchema: z.ZodObject<{
    experimental: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodCustom<object, object>>>;
    logging: z.ZodOptional<z.ZodCustom<object, object>>;
    completions: z.ZodOptional<z.ZodCustom<object, object>>;
    prompts: z.ZodOptional<z.ZodObject<{
        listChanged: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    resources: z.ZodOptional<z.ZodObject<{
        subscribe: z.ZodOptional<z.ZodBoolean>;
        listChanged: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    tools: z.ZodOptional<z.ZodObject<{
        listChanged: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    tasks: z.ZodOptional<z.ZodObject<{
        list: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        cancel: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        requests: z.ZodOptional<z.ZodObject<{
            tools: z.ZodOptional<z.ZodObject<{
                call: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
}, z.core.$loose>;
/**
 * After receiving an initialize request from the client, the server sends this response.
 */
export declare const InitializeResultSchema: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    protocolVersion: z.ZodString;
    capabilities: z.ZodObject<{
        experimental: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodCustom<object, object>>>;
        logging: z.ZodOptional<z.ZodCustom<object, object>>;
        completions: z.ZodOptional<z.ZodCustom<object, object>>;
        prompts: z.ZodOptional<z.ZodObject<{
            listChanged: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>>;
        resources: z.ZodOptional<z.ZodObject<{
            subscribe: z.ZodOptional<z.ZodBoolean>;
            listChanged: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>>;
        tools: z.ZodOptional<z.ZodObject<{
            listChanged: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>>;
        tasks: z.ZodOptional<z.ZodObject<{
            list: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            cancel: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            requests: z.ZodOptional<z.ZodObject<{
                tools: z.ZodOptional<z.ZodObject<{
                    call: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
                }, z.core.$loose>>;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>;
    serverInfo: z.ZodObject<{
        version: z.ZodString;
        websiteUrl: z.ZodOptional<z.ZodString>;
        icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
            src: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>>;
        name: z.ZodString;
        title: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    instructions: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
/**
 * This notification is sent from the client to the server after initialization has finished.
 */
export declare const InitializedNotificationSchema: z.ZodObject<{
    params: z.ZodOptional<z.ZodObject<{
        /**
         * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
         * for notes on _meta usage.
         */
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    method: z.ZodLiteral<"notifications/initialized">;
}, z.core.$strip>;
export declare const isInitializedNotification: (value: unknown) => value is InitializedNotification;
/**
 * A ping, issued by either the server or the client, to check that the other party is still alive. The receiver must promptly respond, or else may be disconnected.
 */
export declare const PingRequestSchema: z.ZodObject<{
    params: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, the caller is requesting that the receiver create a task to represent the request.
         * Task creation parameters are now at the top level instead of in _meta.
         */
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        /**
         * See [General fields: `_meta`](/specification/draft/basic/index#meta) for notes on `_meta` usage.
         */
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    method: z.ZodLiteral<"ping">;
}, z.core.$strip>;
export declare const ProgressSchema: z.ZodObject<{
    progress: z.ZodNumber;
    total: z.ZodOptional<z.ZodNumber>;
    message: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const ProgressNotificationParamsSchema: z.ZodObject<{
    progressToken: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
    progress: z.ZodNumber;
    total: z.ZodOptional<z.ZodNumber>;
    message: z.ZodOptional<z.ZodString>;
    _meta: z.ZodOptional<z.ZodObject<{
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
}, z.core.$strip>;
/**
 * An out-of-band notification used to inform the receiver of a progress update for a long-running request.
 *
 * @category notifications/progress
 */
export declare const ProgressNotificationSchema: z.ZodObject<{
    method: z.ZodLiteral<"notifications/progress">;
    params: z.ZodObject<{
        progressToken: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
        progress: z.ZodNumber;
        total: z.ZodOptional<z.ZodNumber>;
        message: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const PaginatedRequestParamsSchema: z.ZodObject<{
    task: z.ZodOptional<z.ZodObject<{
        /**
         * Time in milliseconds to keep task results available after completion.
         * If null, the task has unlimited lifetime until manually cleaned up.
         */
        ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
        /**
         * Time in milliseconds to wait between task status requests.
         */
        pollInterval: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
         */
        progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
        /**
         * If specified, this request is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    cursor: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const PaginatedRequestSchema: z.ZodObject<{
    method: z.ZodString;
    params: z.ZodOptional<z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        cursor: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
}, z.core.$strip>;
export declare const PaginatedResultSchema: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    nextCursor: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
/**
 * A pollable state object associated with a request.
 */
export declare const TaskSchema: z.ZodObject<{
    taskId: z.ZodString;
    status: z.ZodEnum<{
        working: "working";
        input_required: "input_required";
        completed: "completed";
        failed: "failed";
        cancelled: "cancelled";
    }>;
    ttl: z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>;
    createdAt: z.ZodString;
    lastUpdatedAt: z.ZodString;
    pollInterval: z.ZodOptional<z.ZodNumber>;
    statusMessage: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * Result returned when a task is created, containing the task data wrapped in a task field.
 */
export declare const CreateTaskResultSchema: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    task: z.ZodObject<{
        taskId: z.ZodString;
        status: z.ZodEnum<{
            working: "working";
            input_required: "input_required";
            completed: "completed";
            failed: "failed";
            cancelled: "cancelled";
        }>;
        ttl: z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>;
        createdAt: z.ZodString;
        lastUpdatedAt: z.ZodString;
        pollInterval: z.ZodOptional<z.ZodNumber>;
        statusMessage: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$loose>;
/**
 * Parameters for task status notification.
 */
export declare const TaskStatusNotificationParamsSchema: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    taskId: z.ZodString;
    status: z.ZodEnum<{
        working: "working";
        input_required: "input_required";
        completed: "completed";
        failed: "failed";
        cancelled: "cancelled";
    }>;
    ttl: z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>;
    createdAt: z.ZodString;
    lastUpdatedAt: z.ZodString;
    pollInterval: z.ZodOptional<z.ZodNumber>;
    statusMessage: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * A notification sent when a task's status changes.
 */
export declare const TaskStatusNotificationSchema: z.ZodObject<{
    method: z.ZodLiteral<"notifications/tasks/status">;
    params: z.ZodObject<{
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        taskId: z.ZodString;
        status: z.ZodEnum<{
            working: "working";
            input_required: "input_required";
            completed: "completed";
            failed: "failed";
            cancelled: "cancelled";
        }>;
        ttl: z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>;
        createdAt: z.ZodString;
        lastUpdatedAt: z.ZodString;
        pollInterval: z.ZodOptional<z.ZodNumber>;
        statusMessage: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>;
/**
 * A request to get the state of a specific task.
 */
export declare const GetTaskRequestSchema: z.ZodObject<{
    method: z.ZodLiteral<"tasks/get">;
    params: z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        taskId: z.ZodString;
    }, z.core.$loose>;
}, z.core.$strip>;
/**
 * The response to a tasks/get request.
 */
export declare const GetTaskResultSchema: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    taskId: z.ZodString;
    status: z.ZodEnum<{
        working: "working";
        input_required: "input_required";
        completed: "completed";
        failed: "failed";
        cancelled: "cancelled";
    }>;
    ttl: z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>;
    createdAt: z.ZodString;
    lastUpdatedAt: z.ZodString;
    pollInterval: z.ZodOptional<z.ZodNumber>;
    statusMessage: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * A request to get the result of a specific task.
 */
export declare const GetTaskPayloadRequestSchema: z.ZodObject<{
    method: z.ZodLiteral<"tasks/result">;
    params: z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        taskId: z.ZodString;
    }, z.core.$loose>;
}, z.core.$strip>;
/**
 * A request to list tasks.
 */
export declare const ListTasksRequestSchema: z.ZodObject<{
    params: z.ZodOptional<z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        cursor: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    method: z.ZodLiteral<"tasks/list">;
}, z.core.$strip>;
/**
 * The response to a tasks/list request.
 */
export declare const ListTasksResultSchema: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    nextCursor: z.ZodOptional<z.ZodString>;
    tasks: z.ZodArray<z.ZodObject<{
        taskId: z.ZodString;
        status: z.ZodEnum<{
            working: "working";
            input_required: "input_required";
            completed: "completed";
            failed: "failed";
            cancelled: "cancelled";
        }>;
        ttl: z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>;
        createdAt: z.ZodString;
        lastUpdatedAt: z.ZodString;
        pollInterval: z.ZodOptional<z.ZodNumber>;
        statusMessage: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$loose>;
/**
 * A request to cancel a specific task.
 */
export declare const CancelTaskRequestSchema: z.ZodObject<{
    method: z.ZodLiteral<"tasks/cancel">;
    params: z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        taskId: z.ZodString;
    }, z.core.$loose>;
}, z.core.$strip>;
/**
 * The response to a tasks/cancel request.
 */
export declare const CancelTaskResultSchema: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    taskId: z.ZodString;
    status: z.ZodEnum<{
        working: "working";
        input_required: "input_required";
        completed: "completed";
        failed: "failed";
        cancelled: "cancelled";
    }>;
    ttl: z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>;
    createdAt: z.ZodString;
    lastUpdatedAt: z.ZodString;
    pollInterval: z.ZodOptional<z.ZodNumber>;
    statusMessage: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * The contents of a specific resource or sub-resource.
 */
export declare const ResourceContentsSchema: z.ZodObject<{
    uri: z.ZodString;
    mimeType: z.ZodOptional<z.ZodString>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
export declare const TextResourceContentsSchema: z.ZodObject<{
    uri: z.ZodString;
    mimeType: z.ZodOptional<z.ZodString>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    text: z.ZodString;
}, z.core.$strip>;
export declare const BlobResourceContentsSchema: z.ZodObject<{
    uri: z.ZodString;
    mimeType: z.ZodOptional<z.ZodString>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    blob: z.ZodString;
}, z.core.$strip>;
/**
 * A known resource that the server is capable of reading.
 */
export declare const ResourceSchema: z.ZodObject<{
    uri: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    mimeType: z.ZodOptional<z.ZodString>;
    _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
        src: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>>;
    name: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * A template description for resources available on the server.
 */
export declare const ResourceTemplateSchema: z.ZodObject<{
    uriTemplate: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    mimeType: z.ZodOptional<z.ZodString>;
    _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
        src: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>>;
    name: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * Sent from the client to request a list of resources the server has.
 */
export declare const ListResourcesRequestSchema: z.ZodObject<{
    params: z.ZodOptional<z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        cursor: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    method: z.ZodLiteral<"resources/list">;
}, z.core.$strip>;
/**
 * The server's response to a resources/list request from the client.
 */
export declare const ListResourcesResultSchema: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    nextCursor: z.ZodOptional<z.ZodString>;
    resources: z.ZodArray<z.ZodObject<{
        uri: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        mimeType: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
            src: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>>;
        name: z.ZodString;
        title: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$loose>;
/**
 * Sent from the client to request a list of resource templates the server has.
 */
export declare const ListResourceTemplatesRequestSchema: z.ZodObject<{
    params: z.ZodOptional<z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        cursor: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    method: z.ZodLiteral<"resources/templates/list">;
}, z.core.$strip>;
/**
 * The server's response to a resources/templates/list request from the client.
 */
export declare const ListResourceTemplatesResultSchema: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    nextCursor: z.ZodOptional<z.ZodString>;
    resourceTemplates: z.ZodArray<z.ZodObject<{
        uriTemplate: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        mimeType: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
            src: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>>;
        name: z.ZodString;
        title: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$loose>;
export declare const ResourceRequestParamsSchema: z.ZodObject<{
    task: z.ZodOptional<z.ZodObject<{
        /**
         * Time in milliseconds to keep task results available after completion.
         * If null, the task has unlimited lifetime until manually cleaned up.
         */
        ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
        /**
         * Time in milliseconds to wait between task status requests.
         */
        pollInterval: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
         */
        progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
        /**
         * If specified, this request is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    uri: z.ZodString;
}, z.core.$loose>;
/**
 * Parameters for a `resources/read` request.
 */
export declare const ReadResourceRequestParamsSchema: z.ZodObject<{
    task: z.ZodOptional<z.ZodObject<{
        /**
         * Time in milliseconds to keep task results available after completion.
         * If null, the task has unlimited lifetime until manually cleaned up.
         */
        ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
        /**
         * Time in milliseconds to wait between task status requests.
         */
        pollInterval: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
         */
        progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
        /**
         * If specified, this request is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    uri: z.ZodString;
}, z.core.$loose>;
/**
 * Sent from the client to the server, to read a specific resource URI.
 */
export declare const ReadResourceRequestSchema: z.ZodObject<{
    method: z.ZodLiteral<"resources/read">;
    params: z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        uri: z.ZodString;
    }, z.core.$loose>;
}, z.core.$strip>;
/**
 * The server's response to a resources/read request from the client.
 */
export declare const ReadResourceResultSchema: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    contents: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        uri: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        uri: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        blob: z.ZodString;
    }, z.core.$strip>]>>;
}, z.core.$loose>;
/**
 * An optional notification from the server to the client, informing it that the list of resources it can read from has changed. This may be issued by servers without any previous subscription from the client.
 */
export declare const ResourceListChangedNotificationSchema: z.ZodObject<{
    params: z.ZodOptional<z.ZodObject<{
        /**
         * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
         * for notes on _meta usage.
         */
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    method: z.ZodLiteral<"notifications/resources/list_changed">;
}, z.core.$strip>;
export declare const SubscribeRequestParamsSchema: z.ZodObject<{
    task: z.ZodOptional<z.ZodObject<{
        /**
         * Time in milliseconds to keep task results available after completion.
         * If null, the task has unlimited lifetime until manually cleaned up.
         */
        ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
        /**
         * Time in milliseconds to wait between task status requests.
         */
        pollInterval: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
         */
        progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
        /**
         * If specified, this request is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    uri: z.ZodString;
}, z.core.$loose>;
/**
 * Sent from the client to request resources/updated notifications from the server whenever a particular resource changes.
 */
export declare const SubscribeRequestSchema: z.ZodObject<{
    method: z.ZodLiteral<"resources/subscribe">;
    params: z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        uri: z.ZodString;
    }, z.core.$loose>;
}, z.core.$strip>;
export declare const UnsubscribeRequestParamsSchema: z.ZodObject<{
    task: z.ZodOptional<z.ZodObject<{
        /**
         * Time in milliseconds to keep task results available after completion.
         * If null, the task has unlimited lifetime until manually cleaned up.
         */
        ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
        /**
         * Time in milliseconds to wait between task status requests.
         */
        pollInterval: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
         */
        progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
        /**
         * If specified, this request is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    uri: z.ZodString;
}, z.core.$loose>;
/**
 * Sent from the client to request cancellation of resources/updated notifications from the server. This should follow a previous resources/subscribe request.
 */
export declare const UnsubscribeRequestSchema: z.ZodObject<{
    method: z.ZodLiteral<"resources/unsubscribe">;
    params: z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        uri: z.ZodString;
    }, z.core.$loose>;
}, z.core.$strip>;
/**
 * Parameters for a `notifications/resources/updated` notification.
 */
export declare const ResourceUpdatedNotificationParamsSchema: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    uri: z.ZodString;
}, z.core.$loose>;
/**
 * A notification from the server to the client, informing it that a resource has changed and may need to be read again. This should only be sent if the client previously sent a resources/subscribe request.
 */
export declare const ResourceUpdatedNotificationSchema: z.ZodObject<{
    method: z.ZodLiteral<"notifications/resources/updated">;
    params: z.ZodObject<{
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        uri: z.ZodString;
    }, z.core.$loose>;
}, z.core.$strip>;
/**
 * Describes an argument that a prompt can accept.
 */
export declare const PromptArgumentSchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    required: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
/**
 * A prompt or prompt template that the server offers.
 */
export declare const PromptSchema: z.ZodObject<{
    description: z.ZodOptional<z.ZodString>;
    arguments: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        required: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>>;
    _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
        src: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>>;
    name: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * Sent from the client to request a list of prompts and prompt templates the server has.
 */
export declare const ListPromptsRequestSchema: z.ZodObject<{
    params: z.ZodOptional<z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        cursor: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    method: z.ZodLiteral<"prompts/list">;
}, z.core.$strip>;
/**
 * The server's response to a prompts/list request from the client.
 */
export declare const ListPromptsResultSchema: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    nextCursor: z.ZodOptional<z.ZodString>;
    prompts: z.ZodArray<z.ZodObject<{
        description: z.ZodOptional<z.ZodString>;
        arguments: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            required: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>>>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
            src: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>>;
        name: z.ZodString;
        title: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$loose>;
/**
 * Parameters for a `prompts/get` request.
 */
export declare const GetPromptRequestParamsSchema: z.ZodObject<{
    task: z.ZodOptional<z.ZodObject<{
        /**
         * Time in milliseconds to keep task results available after completion.
         * If null, the task has unlimited lifetime until manually cleaned up.
         */
        ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
        /**
         * Time in milliseconds to wait between task status requests.
         */
        pollInterval: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
         */
        progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
        /**
         * If specified, this request is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    name: z.ZodString;
    arguments: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
}, z.core.$loose>;
/**
 * Used by the client to get a prompt provided by the server.
 */
export declare const GetPromptRequestSchema: z.ZodObject<{
    method: z.ZodLiteral<"prompts/get">;
    params: z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        name: z.ZodString;
        arguments: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, z.core.$loose>;
}, z.core.$strip>;
/**
 * Text provided to or from an LLM.
 */
export declare const TextContentSchema: z.ZodObject<{
    type: z.ZodLiteral<"text">;
    text: z.ZodString;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
/**
 * An image provided to or from an LLM.
 */
export declare const ImageContentSchema: z.ZodObject<{
    type: z.ZodLiteral<"image">;
    data: z.ZodString;
    mimeType: z.ZodString;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
/**
 * An Audio provided to or from an LLM.
 */
export declare const AudioContentSchema: z.ZodObject<{
    type: z.ZodLiteral<"audio">;
    data: z.ZodString;
    mimeType: z.ZodString;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
/**
 * A tool call request from an assistant (LLM).
 * Represents the assistant's request to use a tool.
 */
export declare const ToolUseContentSchema: z.ZodObject<{
    type: z.ZodLiteral<"tool_use">;
    name: z.ZodString;
    id: z.ZodString;
    input: z.ZodObject<{}, z.core.$loose>;
    _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
}, z.core.$loose>;
/**
 * The contents of a resource, embedded into a prompt or tool call result.
 */
export declare const EmbeddedResourceSchema: z.ZodObject<{
    type: z.ZodLiteral<"resource">;
    resource: z.ZodUnion<readonly [z.ZodObject<{
        uri: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        uri: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        blob: z.ZodString;
    }, z.core.$strip>]>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
/**
 * A resource that the server is capable of reading, included in a prompt or tool call result.
 *
 * Note: resource links returned by tools are not guaranteed to appear in the results of `resources/list` requests.
 */
export declare const ResourceLinkSchema: z.ZodObject<{
    uri: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    mimeType: z.ZodOptional<z.ZodString>;
    _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
        src: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>>;
    name: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"resource_link">;
}, z.core.$strip>;
/**
 * A content block that can be used in prompts and tool results.
 */
export declare const ContentBlockSchema: z.ZodUnion<readonly [z.ZodObject<{
    type: z.ZodLiteral<"text">;
    text: z.ZodString;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"image">;
    data: z.ZodString;
    mimeType: z.ZodString;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"audio">;
    data: z.ZodString;
    mimeType: z.ZodString;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>, z.ZodObject<{
    uri: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    mimeType: z.ZodOptional<z.ZodString>;
    _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
        src: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>>;
    name: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"resource_link">;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"resource">;
    resource: z.ZodUnion<readonly [z.ZodObject<{
        uri: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        uri: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        blob: z.ZodString;
    }, z.core.$strip>]>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>]>;
/**
 * Describes a message returned as part of a prompt.
 */
export declare const PromptMessageSchema: z.ZodObject<{
    role: z.ZodEnum<{
        user: "user";
        assistant: "assistant";
    }>;
    content: z.ZodUnion<readonly [z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        data: z.ZodString;
        mimeType: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"audio">;
        data: z.ZodString;
        mimeType: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        uri: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        mimeType: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
            src: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>>;
        name: z.ZodString;
        title: z.ZodOptional<z.ZodString>;
        type: z.ZodLiteral<"resource_link">;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"resource">;
        resource: z.ZodUnion<readonly [z.ZodObject<{
            uri: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            text: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            uri: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            blob: z.ZodString;
        }, z.core.$strip>]>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>]>;
}, z.core.$strip>;
/**
 * The server's response to a prompts/get request from the client.
 */
export declare const GetPromptResultSchema: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    description: z.ZodOptional<z.ZodString>;
    messages: z.ZodArray<z.ZodObject<{
        role: z.ZodEnum<{
            user: "user";
            assistant: "assistant";
        }>;
        content: z.ZodUnion<readonly [z.ZodObject<{
            type: z.ZodLiteral<"text">;
            text: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"image">;
            data: z.ZodString;
            mimeType: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"audio">;
            data: z.ZodString;
            mimeType: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            uri: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
                src: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strip>>>;
            name: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
            type: z.ZodLiteral<"resource_link">;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"resource">;
            resource: z.ZodUnion<readonly [z.ZodObject<{
                uri: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                text: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                uri: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                blob: z.ZodString;
            }, z.core.$strip>]>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>]>;
    }, z.core.$strip>>;
}, z.core.$loose>;
/**
 * An optional notification from the server to the client, informing it that the list of prompts it offers has changed. This may be issued by servers without any previous subscription from the client.
 */
export declare const PromptListChangedNotificationSchema: z.ZodObject<{
    params: z.ZodOptional<z.ZodObject<{
        /**
         * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
         * for notes on _meta usage.
         */
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    method: z.ZodLiteral<"notifications/prompts/list_changed">;
}, z.core.$strip>;
/**
 * Additional properties describing a Tool to clients.
 *
 * NOTE: all properties in ToolAnnotations are **hints**.
 * They are not guaranteed to provide a faithful description of
 * tool behavior (including descriptive properties like `title`).
 *
 * Clients should never make tool use decisions based on ToolAnnotations
 * received from untrusted servers.
 */
export declare const ToolAnnotationsSchema: z.ZodObject<{
    title: z.ZodOptional<z.ZodString>;
    readOnlyHint: z.ZodOptional<z.ZodBoolean>;
    destructiveHint: z.ZodOptional<z.ZodBoolean>;
    idempotentHint: z.ZodOptional<z.ZodBoolean>;
    openWorldHint: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
/**
 * Execution-related properties for a tool.
 */
export declare const ToolExecutionSchema: z.ZodObject<{
    taskSupport: z.ZodOptional<z.ZodEnum<{
        optional: "optional";
        required: "required";
        forbidden: "forbidden";
    }>>;
}, z.core.$strip>;
/**
 * Definition for a tool the client can call.
 */
export declare const ToolSchema: z.ZodObject<{
    description: z.ZodOptional<z.ZodString>;
    inputSchema: z.ZodObject<{
        type: z.ZodLiteral<"object">;
        properties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodCustom<object, object>>>;
        required: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$catchall<z.ZodUnknown>>;
    outputSchema: z.ZodOptional<z.ZodObject<{
        type: z.ZodLiteral<"object">;
        properties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodCustom<object, object>>>;
        required: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$catchall<z.ZodUnknown>>>;
    annotations: z.ZodOptional<z.ZodObject<{
        title: z.ZodOptional<z.ZodString>;
        readOnlyHint: z.ZodOptional<z.ZodBoolean>;
        destructiveHint: z.ZodOptional<z.ZodBoolean>;
        idempotentHint: z.ZodOptional<z.ZodBoolean>;
        openWorldHint: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    execution: z.ZodOptional<z.ZodObject<{
        taskSupport: z.ZodOptional<z.ZodEnum<{
            optional: "optional";
            required: "required";
            forbidden: "forbidden";
        }>>;
    }, z.core.$strip>>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
        src: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>>;
    name: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * Sent from the client to request a list of tools the server has.
 */
export declare const ListToolsRequestSchema: z.ZodObject<{
    params: z.ZodOptional<z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        cursor: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    method: z.ZodLiteral<"tools/list">;
}, z.core.$strip>;
/**
 * The server's response to a tools/list request from the client.
 */
export declare const ListToolsResultSchema: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    nextCursor: z.ZodOptional<z.ZodString>;
    tools: z.ZodArray<z.ZodObject<{
        description: z.ZodOptional<z.ZodString>;
        inputSchema: z.ZodObject<{
            type: z.ZodLiteral<"object">;
            properties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodCustom<object, object>>>;
            required: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$catchall<z.ZodUnknown>>;
        outputSchema: z.ZodOptional<z.ZodObject<{
            type: z.ZodLiteral<"object">;
            properties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodCustom<object, object>>>;
            required: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$catchall<z.ZodUnknown>>>;
        annotations: z.ZodOptional<z.ZodObject<{
            title: z.ZodOptional<z.ZodString>;
            readOnlyHint: z.ZodOptional<z.ZodBoolean>;
            destructiveHint: z.ZodOptional<z.ZodBoolean>;
            idempotentHint: z.ZodOptional<z.ZodBoolean>;
            openWorldHint: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>>;
        execution: z.ZodOptional<z.ZodObject<{
            taskSupport: z.ZodOptional<z.ZodEnum<{
                optional: "optional";
                required: "required";
                forbidden: "forbidden";
            }>>;
        }, z.core.$strip>>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
            src: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>>;
        name: z.ZodString;
        title: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$loose>;
/**
 * The server's response to a tool call.
 */
export declare const CallToolResultSchema: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        data: z.ZodString;
        mimeType: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"audio">;
        data: z.ZodString;
        mimeType: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        uri: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        mimeType: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
            src: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>>;
        name: z.ZodString;
        title: z.ZodOptional<z.ZodString>;
        type: z.ZodLiteral<"resource_link">;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"resource">;
        resource: z.ZodUnion<readonly [z.ZodObject<{
            uri: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            text: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            uri: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            blob: z.ZodString;
        }, z.core.$strip>]>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>]>>>;
    structuredContent: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    isError: z.ZodOptional<z.ZodBoolean>;
}, z.core.$loose>;
/**
 * CallToolResultSchema extended with backwards compatibility to protocol version 2024-10-07.
 */
export declare const CompatibilityCallToolResultSchema: z.ZodUnion<[z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        data: z.ZodString;
        mimeType: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"audio">;
        data: z.ZodString;
        mimeType: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        uri: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        mimeType: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
            src: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>>;
        name: z.ZodString;
        title: z.ZodOptional<z.ZodString>;
        type: z.ZodLiteral<"resource_link">;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"resource">;
        resource: z.ZodUnion<readonly [z.ZodObject<{
            uri: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            text: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            uri: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            blob: z.ZodString;
        }, z.core.$strip>]>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>]>>>;
    structuredContent: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    isError: z.ZodOptional<z.ZodBoolean>;
}, z.core.$loose>, z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    toolResult: z.ZodUnknown;
}, z.core.$loose>]>;
/**
 * Parameters for a `tools/call` request.
 */
export declare const CallToolRequestParamsSchema: z.ZodObject<{
    task: z.ZodOptional<z.ZodObject<{
        /**
         * Time in milliseconds to keep task results available after completion.
         * If null, the task has unlimited lifetime until manually cleaned up.
         */
        ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
        /**
         * Time in milliseconds to wait between task status requests.
         */
        pollInterval: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
         */
        progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
        /**
         * If specified, this request is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    name: z.ZodString;
    arguments: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$loose>;
/**
 * Used by the client to invoke a tool provided by the server.
 */
export declare const CallToolRequestSchema: z.ZodObject<{
    method: z.ZodLiteral<"tools/call">;
    params: z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        name: z.ZodString;
        arguments: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$loose>;
}, z.core.$strip>;
/**
 * An optional notification from the server to the client, informing it that the list of tools it offers has changed. This may be issued by servers without any previous subscription from the client.
 */
export declare const ToolListChangedNotificationSchema: z.ZodObject<{
    params: z.ZodOptional<z.ZodObject<{
        /**
         * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
         * for notes on _meta usage.
         */
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    method: z.ZodLiteral<"notifications/tools/list_changed">;
}, z.core.$strip>;
/**
 * The severity of a log message.
 */
export declare const LoggingLevelSchema: z.ZodEnum<{
    error: "error";
    debug: "debug";
    info: "info";
    notice: "notice";
    warning: "warning";
    critical: "critical";
    alert: "alert";
    emergency: "emergency";
}>;
/**
 * Parameters for a `logging/setLevel` request.
 */
export declare const SetLevelRequestParamsSchema: z.ZodObject<{
    task: z.ZodOptional<z.ZodObject<{
        /**
         * Time in milliseconds to keep task results available after completion.
         * If null, the task has unlimited lifetime until manually cleaned up.
         */
        ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
        /**
         * Time in milliseconds to wait between task status requests.
         */
        pollInterval: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
         */
        progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
        /**
         * If specified, this request is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    level: z.ZodEnum<{
        error: "error";
        debug: "debug";
        info: "info";
        notice: "notice";
        warning: "warning";
        critical: "critical";
        alert: "alert";
        emergency: "emergency";
    }>;
}, z.core.$loose>;
/**
 * A request from the client to the server, to enable or adjust logging.
 */
export declare const SetLevelRequestSchema: z.ZodObject<{
    method: z.ZodLiteral<"logging/setLevel">;
    params: z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        level: z.ZodEnum<{
            error: "error";
            debug: "debug";
            info: "info";
            notice: "notice";
            warning: "warning";
            critical: "critical";
            alert: "alert";
            emergency: "emergency";
        }>;
    }, z.core.$loose>;
}, z.core.$strip>;
/**
 * Parameters for a `notifications/message` notification.
 */
export declare const LoggingMessageNotificationParamsSchema: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    level: z.ZodEnum<{
        error: "error";
        debug: "debug";
        info: "info";
        notice: "notice";
        warning: "warning";
        critical: "critical";
        alert: "alert";
        emergency: "emergency";
    }>;
    logger: z.ZodOptional<z.ZodString>;
    data: z.ZodUnknown;
}, z.core.$loose>;
/**
 * Notification of a log message passed from server to client. If no logging/setLevel request has been sent from the client, the server MAY decide which messages to send automatically.
 */
export declare const LoggingMessageNotificationSchema: z.ZodObject<{
    method: z.ZodLiteral<"notifications/message">;
    params: z.ZodObject<{
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        level: z.ZodEnum<{
            error: "error";
            debug: "debug";
            info: "info";
            notice: "notice";
            warning: "warning";
            critical: "critical";
            alert: "alert";
            emergency: "emergency";
        }>;
        logger: z.ZodOptional<z.ZodString>;
        data: z.ZodUnknown;
    }, z.core.$loose>;
}, z.core.$strip>;
/**
 * Hints to use for model selection.
 */
export declare const ModelHintSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * The server's preferences for model selection, requested of the client during sampling.
 */
export declare const ModelPreferencesSchema: z.ZodObject<{
    hints: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    costPriority: z.ZodOptional<z.ZodNumber>;
    speedPriority: z.ZodOptional<z.ZodNumber>;
    intelligencePriority: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
/**
 * Controls tool usage behavior in sampling requests.
 */
export declare const ToolChoiceSchema: z.ZodObject<{
    mode: z.ZodOptional<z.ZodEnum<{
        required: "required";
        auto: "auto";
        none: "none";
    }>>;
}, z.core.$strip>;
/**
 * The result of a tool execution, provided by the user (server).
 * Represents the outcome of invoking a tool requested via ToolUseContent.
 */
export declare const ToolResultContentSchema: z.ZodObject<{
    type: z.ZodLiteral<"tool_result">;
    toolUseId: z.ZodString;
    content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        data: z.ZodString;
        mimeType: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"audio">;
        data: z.ZodString;
        mimeType: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        uri: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        mimeType: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
            src: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>>;
        name: z.ZodString;
        title: z.ZodOptional<z.ZodString>;
        type: z.ZodLiteral<"resource_link">;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"resource">;
        resource: z.ZodUnion<readonly [z.ZodObject<{
            uri: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            text: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            uri: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            blob: z.ZodString;
        }, z.core.$strip>]>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>]>>>;
    structuredContent: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    isError: z.ZodOptional<z.ZodBoolean>;
    _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
}, z.core.$loose>;
/**
 * Content block types allowed in sampling messages.
 * This includes text, image, audio, tool use requests, and tool results.
 */
export declare const SamplingMessageContentBlockSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"text">;
    text: z.ZodString;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"image">;
    data: z.ZodString;
    mimeType: z.ZodString;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"audio">;
    data: z.ZodString;
    mimeType: z.ZodString;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool_use">;
    name: z.ZodString;
    id: z.ZodString;
    input: z.ZodObject<{}, z.core.$loose>;
    _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"tool_result">;
    toolUseId: z.ZodString;
    content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        data: z.ZodString;
        mimeType: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"audio">;
        data: z.ZodString;
        mimeType: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        uri: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        mimeType: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
            src: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>>;
        name: z.ZodString;
        title: z.ZodOptional<z.ZodString>;
        type: z.ZodLiteral<"resource_link">;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"resource">;
        resource: z.ZodUnion<readonly [z.ZodObject<{
            uri: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            text: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            uri: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            blob: z.ZodString;
        }, z.core.$strip>]>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>]>>>;
    structuredContent: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    isError: z.ZodOptional<z.ZodBoolean>;
    _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
}, z.core.$loose>]>;
/**
 * Describes a message issued to or received from an LLM API.
 */
export declare const SamplingMessageSchema: z.ZodObject<{
    role: z.ZodEnum<{
        user: "user";
        assistant: "assistant";
    }>;
    content: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        data: z.ZodString;
        mimeType: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"audio">;
        data: z.ZodString;
        mimeType: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_use">;
        name: z.ZodString;
        id: z.ZodString;
        input: z.ZodObject<{}, z.core.$loose>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"tool_result">;
        toolUseId: z.ZodString;
        content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
            type: z.ZodLiteral<"text">;
            text: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"image">;
            data: z.ZodString;
            mimeType: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"audio">;
            data: z.ZodString;
            mimeType: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            uri: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
                src: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strip>>>;
            name: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
            type: z.ZodLiteral<"resource_link">;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"resource">;
            resource: z.ZodUnion<readonly [z.ZodObject<{
                uri: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                text: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                uri: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                blob: z.ZodString;
            }, z.core.$strip>]>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>]>>>;
        structuredContent: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        isError: z.ZodOptional<z.ZodBoolean>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    }, z.core.$loose>]>, z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        data: z.ZodString;
        mimeType: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"audio">;
        data: z.ZodString;
        mimeType: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_use">;
        name: z.ZodString;
        id: z.ZodString;
        input: z.ZodObject<{}, z.core.$loose>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"tool_result">;
        toolUseId: z.ZodString;
        content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
            type: z.ZodLiteral<"text">;
            text: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"image">;
            data: z.ZodString;
            mimeType: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"audio">;
            data: z.ZodString;
            mimeType: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            uri: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
                src: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strip>>>;
            name: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
            type: z.ZodLiteral<"resource_link">;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"resource">;
            resource: z.ZodUnion<readonly [z.ZodObject<{
                uri: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                text: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                uri: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                blob: z.ZodString;
            }, z.core.$strip>]>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>]>>>;
        structuredContent: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        isError: z.ZodOptional<z.ZodBoolean>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    }, z.core.$loose>]>>]>;
    _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
}, z.core.$loose>;
/**
 * Parameters for a `sampling/createMessage` request.
 */
export declare const CreateMessageRequestParamsSchema: z.ZodObject<{
    task: z.ZodOptional<z.ZodObject<{
        /**
         * Time in milliseconds to keep task results available after completion.
         * If null, the task has unlimited lifetime until manually cleaned up.
         */
        ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
        /**
         * Time in milliseconds to wait between task status requests.
         */
        pollInterval: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
         */
        progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
        /**
         * If specified, this request is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    messages: z.ZodArray<z.ZodObject<{
        role: z.ZodEnum<{
            user: "user";
            assistant: "assistant";
        }>;
        content: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
            type: z.ZodLiteral<"text">;
            text: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"image">;
            data: z.ZodString;
            mimeType: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"audio">;
            data: z.ZodString;
            mimeType: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"tool_use">;
            name: z.ZodString;
            id: z.ZodString;
            input: z.ZodObject<{}, z.core.$loose>;
            _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        }, z.core.$loose>, z.ZodObject<{
            type: z.ZodLiteral<"tool_result">;
            toolUseId: z.ZodString;
            content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
                type: z.ZodLiteral<"text">;
                text: z.ZodString;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"image">;
                data: z.ZodString;
                mimeType: z.ZodString;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"audio">;
                data: z.ZodString;
                mimeType: z.ZodString;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            }, z.core.$strip>, z.ZodObject<{
                uri: z.ZodString;
                description: z.ZodOptional<z.ZodString>;
                mimeType: z.ZodOptional<z.ZodString>;
                _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
                icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
                    src: z.ZodString;
                    mimeType: z.ZodOptional<z.ZodString>;
                    sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strip>>>;
                name: z.ZodString;
                title: z.ZodOptional<z.ZodString>;
                type: z.ZodLiteral<"resource_link">;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"resource">;
                resource: z.ZodUnion<readonly [z.ZodObject<{
                    uri: z.ZodString;
                    mimeType: z.ZodOptional<z.ZodString>;
                    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                    text: z.ZodString;
                }, z.core.$strip>, z.ZodObject<{
                    uri: z.ZodString;
                    mimeType: z.ZodOptional<z.ZodString>;
                    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                    blob: z.ZodString;
                }, z.core.$strip>]>;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            }, z.core.$strip>]>>>;
            structuredContent: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            isError: z.ZodOptional<z.ZodBoolean>;
            _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        }, z.core.$loose>]>, z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            type: z.ZodLiteral<"text">;
            text: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"image">;
            data: z.ZodString;
            mimeType: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"audio">;
            data: z.ZodString;
            mimeType: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"tool_use">;
            name: z.ZodString;
            id: z.ZodString;
            input: z.ZodObject<{}, z.core.$loose>;
            _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        }, z.core.$loose>, z.ZodObject<{
            type: z.ZodLiteral<"tool_result">;
            toolUseId: z.ZodString;
            content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
                type: z.ZodLiteral<"text">;
                text: z.ZodString;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"image">;
                data: z.ZodString;
                mimeType: z.ZodString;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"audio">;
                data: z.ZodString;
                mimeType: z.ZodString;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            }, z.core.$strip>, z.ZodObject<{
                uri: z.ZodString;
                description: z.ZodOptional<z.ZodString>;
                mimeType: z.ZodOptional<z.ZodString>;
                _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
                icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
                    src: z.ZodString;
                    mimeType: z.ZodOptional<z.ZodString>;
                    sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strip>>>;
                name: z.ZodString;
                title: z.ZodOptional<z.ZodString>;
                type: z.ZodLiteral<"resource_link">;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"resource">;
                resource: z.ZodUnion<readonly [z.ZodObject<{
                    uri: z.ZodString;
                    mimeType: z.ZodOptional<z.ZodString>;
                    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                    text: z.ZodString;
                }, z.core.$strip>, z.ZodObject<{
                    uri: z.ZodString;
                    mimeType: z.ZodOptional<z.ZodString>;
                    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                    blob: z.ZodString;
                }, z.core.$strip>]>;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            }, z.core.$strip>]>>>;
            structuredContent: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            isError: z.ZodOptional<z.ZodBoolean>;
            _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        }, z.core.$loose>]>>]>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    }, z.core.$loose>>;
    modelPreferences: z.ZodOptional<z.ZodObject<{
        hints: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        costPriority: z.ZodOptional<z.ZodNumber>;
        speedPriority: z.ZodOptional<z.ZodNumber>;
        intelligencePriority: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    systemPrompt: z.ZodOptional<z.ZodString>;
    includeContext: z.ZodOptional<z.ZodEnum<{
        none: "none";
        thisServer: "thisServer";
        allServers: "allServers";
    }>>;
    temperature: z.ZodOptional<z.ZodNumber>;
    maxTokens: z.ZodNumber;
    stopSequences: z.ZodOptional<z.ZodArray<z.ZodString>>;
    metadata: z.ZodOptional<z.ZodCustom<object, object>>;
    tools: z.ZodOptional<z.ZodArray<z.ZodObject<{
        description: z.ZodOptional<z.ZodString>;
        inputSchema: z.ZodObject<{
            type: z.ZodLiteral<"object">;
            properties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodCustom<object, object>>>;
            required: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$catchall<z.ZodUnknown>>;
        outputSchema: z.ZodOptional<z.ZodObject<{
            type: z.ZodLiteral<"object">;
            properties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodCustom<object, object>>>;
            required: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$catchall<z.ZodUnknown>>>;
        annotations: z.ZodOptional<z.ZodObject<{
            title: z.ZodOptional<z.ZodString>;
            readOnlyHint: z.ZodOptional<z.ZodBoolean>;
            destructiveHint: z.ZodOptional<z.ZodBoolean>;
            idempotentHint: z.ZodOptional<z.ZodBoolean>;
            openWorldHint: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>>;
        execution: z.ZodOptional<z.ZodObject<{
            taskSupport: z.ZodOptional<z.ZodEnum<{
                optional: "optional";
                required: "required";
                forbidden: "forbidden";
            }>>;
        }, z.core.$strip>>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
            src: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>>;
        name: z.ZodString;
        title: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    toolChoice: z.ZodOptional<z.ZodObject<{
        mode: z.ZodOptional<z.ZodEnum<{
            required: "required";
            auto: "auto";
            none: "none";
        }>>;
    }, z.core.$strip>>;
}, z.core.$loose>;
/**
 * A request from the server to sample an LLM via the client. The client has full discretion over which model to select. The client should also inform the user before beginning sampling, to allow them to inspect the request (human in the loop) and decide whether to approve it.
 */
export declare const CreateMessageRequestSchema: z.ZodObject<{
    method: z.ZodLiteral<"sampling/createMessage">;
    params: z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        messages: z.ZodArray<z.ZodObject<{
            role: z.ZodEnum<{
                user: "user";
                assistant: "assistant";
            }>;
            content: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
                type: z.ZodLiteral<"text">;
                text: z.ZodString;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"image">;
                data: z.ZodString;
                mimeType: z.ZodString;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"audio">;
                data: z.ZodString;
                mimeType: z.ZodString;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"tool_use">;
                name: z.ZodString;
                id: z.ZodString;
                input: z.ZodObject<{}, z.core.$loose>;
                _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            }, z.core.$loose>, z.ZodObject<{
                type: z.ZodLiteral<"tool_result">;
                toolUseId: z.ZodString;
                content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
                    type: z.ZodLiteral<"text">;
                    text: z.ZodString;
                    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"image">;
                    data: z.ZodString;
                    mimeType: z.ZodString;
                    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"audio">;
                    data: z.ZodString;
                    mimeType: z.ZodString;
                    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                }, z.core.$strip>, z.ZodObject<{
                    uri: z.ZodString;
                    description: z.ZodOptional<z.ZodString>;
                    mimeType: z.ZodOptional<z.ZodString>;
                    _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
                    icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
                        src: z.ZodString;
                        mimeType: z.ZodOptional<z.ZodString>;
                        sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strip>>>;
                    name: z.ZodString;
                    title: z.ZodOptional<z.ZodString>;
                    type: z.ZodLiteral<"resource_link">;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"resource">;
                    resource: z.ZodUnion<readonly [z.ZodObject<{
                        uri: z.ZodString;
                        mimeType: z.ZodOptional<z.ZodString>;
                        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                        text: z.ZodString;
                    }, z.core.$strip>, z.ZodObject<{
                        uri: z.ZodString;
                        mimeType: z.ZodOptional<z.ZodString>;
                        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                        blob: z.ZodString;
                    }, z.core.$strip>]>;
                    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                }, z.core.$strip>]>>>;
                structuredContent: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
                isError: z.ZodOptional<z.ZodBoolean>;
                _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            }, z.core.$loose>]>, z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                type: z.ZodLiteral<"text">;
                text: z.ZodString;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"image">;
                data: z.ZodString;
                mimeType: z.ZodString;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"audio">;
                data: z.ZodString;
                mimeType: z.ZodString;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"tool_use">;
                name: z.ZodString;
                id: z.ZodString;
                input: z.ZodObject<{}, z.core.$loose>;
                _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            }, z.core.$loose>, z.ZodObject<{
                type: z.ZodLiteral<"tool_result">;
                toolUseId: z.ZodString;
                content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
                    type: z.ZodLiteral<"text">;
                    text: z.ZodString;
                    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"image">;
                    data: z.ZodString;
                    mimeType: z.ZodString;
                    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"audio">;
                    data: z.ZodString;
                    mimeType: z.ZodString;
                    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                }, z.core.$strip>, z.ZodObject<{
                    uri: z.ZodString;
                    description: z.ZodOptional<z.ZodString>;
                    mimeType: z.ZodOptional<z.ZodString>;
                    _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
                    icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
                        src: z.ZodString;
                        mimeType: z.ZodOptional<z.ZodString>;
                        sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strip>>>;
                    name: z.ZodString;
                    title: z.ZodOptional<z.ZodString>;
                    type: z.ZodLiteral<"resource_link">;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"resource">;
                    resource: z.ZodUnion<readonly [z.ZodObject<{
                        uri: z.ZodString;
                        mimeType: z.ZodOptional<z.ZodString>;
                        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                        text: z.ZodString;
                    }, z.core.$strip>, z.ZodObject<{
                        uri: z.ZodString;
                        mimeType: z.ZodOptional<z.ZodString>;
                        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                        blob: z.ZodString;
                    }, z.core.$strip>]>;
                    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                }, z.core.$strip>]>>>;
                structuredContent: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
                isError: z.ZodOptional<z.ZodBoolean>;
                _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            }, z.core.$loose>]>>]>;
            _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        }, z.core.$loose>>;
        modelPreferences: z.ZodOptional<z.ZodObject<{
            hints: z.ZodOptional<z.ZodArray<z.ZodObject<{
                name: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>>;
            costPriority: z.ZodOptional<z.ZodNumber>;
            speedPriority: z.ZodOptional<z.ZodNumber>;
            intelligencePriority: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
        systemPrompt: z.ZodOptional<z.ZodString>;
        includeContext: z.ZodOptional<z.ZodEnum<{
            none: "none";
            thisServer: "thisServer";
            allServers: "allServers";
        }>>;
        temperature: z.ZodOptional<z.ZodNumber>;
        maxTokens: z.ZodNumber;
        stopSequences: z.ZodOptional<z.ZodArray<z.ZodString>>;
        metadata: z.ZodOptional<z.ZodCustom<object, object>>;
        tools: z.ZodOptional<z.ZodArray<z.ZodObject<{
            description: z.ZodOptional<z.ZodString>;
            inputSchema: z.ZodObject<{
                type: z.ZodLiteral<"object">;
                properties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodCustom<object, object>>>;
                required: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$catchall<z.ZodUnknown>>;
            outputSchema: z.ZodOptional<z.ZodObject<{
                type: z.ZodLiteral<"object">;
                properties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodCustom<object, object>>>;
                required: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$catchall<z.ZodUnknown>>>;
            annotations: z.ZodOptional<z.ZodObject<{
                title: z.ZodOptional<z.ZodString>;
                readOnlyHint: z.ZodOptional<z.ZodBoolean>;
                destructiveHint: z.ZodOptional<z.ZodBoolean>;
                idempotentHint: z.ZodOptional<z.ZodBoolean>;
                openWorldHint: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strip>>;
            execution: z.ZodOptional<z.ZodObject<{
                taskSupport: z.ZodOptional<z.ZodEnum<{
                    optional: "optional";
                    required: "required";
                    forbidden: "forbidden";
                }>>;
            }, z.core.$strip>>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
                src: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strip>>>;
            name: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        toolChoice: z.ZodOptional<z.ZodObject<{
            mode: z.ZodOptional<z.ZodEnum<{
                required: "required";
                auto: "auto";
                none: "none";
            }>>;
        }, z.core.$strip>>;
    }, z.core.$loose>;
}, z.core.$strip>;
/**
 * The client's response to a sampling/create_message request from the server. The client should inform the user before returning the sampled message, to allow them to inspect the response (human in the loop) and decide whether to allow the server to see it.
 */
export declare const CreateMessageResultSchema: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    model: z.ZodString;
    stopReason: z.ZodOptional<z.ZodUnion<[z.ZodEnum<{
        maxTokens: "maxTokens";
        endTurn: "endTurn";
        stopSequence: "stopSequence";
        toolUse: "toolUse";
    }>, z.ZodString]>>;
    role: z.ZodEnum<{
        user: "user";
        assistant: "assistant";
    }>;
    content: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        data: z.ZodString;
        mimeType: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"audio">;
        data: z.ZodString;
        mimeType: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_use">;
        name: z.ZodString;
        id: z.ZodString;
        input: z.ZodObject<{}, z.core.$loose>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"tool_result">;
        toolUseId: z.ZodString;
        content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
            type: z.ZodLiteral<"text">;
            text: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"image">;
            data: z.ZodString;
            mimeType: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"audio">;
            data: z.ZodString;
            mimeType: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            uri: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
                src: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strip>>>;
            name: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
            type: z.ZodLiteral<"resource_link">;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"resource">;
            resource: z.ZodUnion<readonly [z.ZodObject<{
                uri: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                text: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                uri: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                blob: z.ZodString;
            }, z.core.$strip>]>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>]>>>;
        structuredContent: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        isError: z.ZodOptional<z.ZodBoolean>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    }, z.core.$loose>]>, z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        data: z.ZodString;
        mimeType: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"audio">;
        data: z.ZodString;
        mimeType: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_use">;
        name: z.ZodString;
        id: z.ZodString;
        input: z.ZodObject<{}, z.core.$loose>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"tool_result">;
        toolUseId: z.ZodString;
        content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
            type: z.ZodLiteral<"text">;
            text: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"image">;
            data: z.ZodString;
            mimeType: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"audio">;
            data: z.ZodString;
            mimeType: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            uri: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
                src: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strip>>>;
            name: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
            type: z.ZodLiteral<"resource_link">;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"resource">;
            resource: z.ZodUnion<readonly [z.ZodObject<{
                uri: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                text: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                uri: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                blob: z.ZodString;
            }, z.core.$strip>]>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>]>>>;
        structuredContent: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        isError: z.ZodOptional<z.ZodBoolean>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    }, z.core.$loose>]>>]>;
}, z.core.$loose>;
/**
 * Primitive schema definition for boolean fields.
 */
export declare const BooleanSchemaSchema: z.ZodObject<{
    type: z.ZodLiteral<"boolean">;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    default: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
/**
 * Primitive schema definition for string fields.
 */
export declare const StringSchemaSchema: z.ZodObject<{
    type: z.ZodLiteral<"string">;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    minLength: z.ZodOptional<z.ZodNumber>;
    maxLength: z.ZodOptional<z.ZodNumber>;
    format: z.ZodOptional<z.ZodEnum<{
        date: "date";
        uri: "uri";
        email: "email";
        "date-time": "date-time";
    }>>;
    default: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * Primitive schema definition for number fields.
 */
export declare const NumberSchemaSchema: z.ZodObject<{
    type: z.ZodEnum<{
        number: "number";
        integer: "integer";
    }>;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    minimum: z.ZodOptional<z.ZodNumber>;
    maximum: z.ZodOptional<z.ZodNumber>;
    default: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
/**
 * Schema for single-selection enumeration without display titles for options.
 */
export declare const UntitledSingleSelectEnumSchemaSchema: z.ZodObject<{
    type: z.ZodLiteral<"string">;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    enum: z.ZodArray<z.ZodString>;
    default: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * Schema for single-selection enumeration with display titles for each option.
 */
export declare const TitledSingleSelectEnumSchemaSchema: z.ZodObject<{
    type: z.ZodLiteral<"string">;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    oneOf: z.ZodArray<z.ZodObject<{
        const: z.ZodString;
        title: z.ZodString;
    }, z.core.$strip>>;
    default: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * Use TitledSingleSelectEnumSchema instead.
 * This interface will be removed in a future version.
 */
export declare const LegacyTitledEnumSchemaSchema: z.ZodObject<{
    type: z.ZodLiteral<"string">;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    enum: z.ZodArray<z.ZodString>;
    enumNames: z.ZodOptional<z.ZodArray<z.ZodString>>;
    default: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const SingleSelectEnumSchemaSchema: z.ZodUnion<readonly [z.ZodObject<{
    type: z.ZodLiteral<"string">;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    enum: z.ZodArray<z.ZodString>;
    default: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"string">;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    oneOf: z.ZodArray<z.ZodObject<{
        const: z.ZodString;
        title: z.ZodString;
    }, z.core.$strip>>;
    default: z.ZodOptional<z.ZodString>;
}, z.core.$strip>]>;
/**
 * Schema for multiple-selection enumeration without display titles for options.
 */
export declare const UntitledMultiSelectEnumSchemaSchema: z.ZodObject<{
    type: z.ZodLiteral<"array">;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    minItems: z.ZodOptional<z.ZodNumber>;
    maxItems: z.ZodOptional<z.ZodNumber>;
    items: z.ZodObject<{
        type: z.ZodLiteral<"string">;
        enum: z.ZodArray<z.ZodString>;
    }, z.core.$strip>;
    default: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
/**
 * Schema for multiple-selection enumeration with display titles for each option.
 */
export declare const TitledMultiSelectEnumSchemaSchema: z.ZodObject<{
    type: z.ZodLiteral<"array">;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    minItems: z.ZodOptional<z.ZodNumber>;
    maxItems: z.ZodOptional<z.ZodNumber>;
    items: z.ZodObject<{
        anyOf: z.ZodArray<z.ZodObject<{
            const: z.ZodString;
            title: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    default: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
/**
 * Combined schema for multiple-selection enumeration
 */
export declare const MultiSelectEnumSchemaSchema: z.ZodUnion<readonly [z.ZodObject<{
    type: z.ZodLiteral<"array">;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    minItems: z.ZodOptional<z.ZodNumber>;
    maxItems: z.ZodOptional<z.ZodNumber>;
    items: z.ZodObject<{
        type: z.ZodLiteral<"string">;
        enum: z.ZodArray<z.ZodString>;
    }, z.core.$strip>;
    default: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"array">;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    minItems: z.ZodOptional<z.ZodNumber>;
    maxItems: z.ZodOptional<z.ZodNumber>;
    items: z.ZodObject<{
        anyOf: z.ZodArray<z.ZodObject<{
            const: z.ZodString;
            title: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    default: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>]>;
/**
 * Primitive schema definition for enum fields.
 */
export declare const EnumSchemaSchema: z.ZodUnion<readonly [z.ZodObject<{
    type: z.ZodLiteral<"string">;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    enum: z.ZodArray<z.ZodString>;
    enumNames: z.ZodOptional<z.ZodArray<z.ZodString>>;
    default: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodUnion<readonly [z.ZodObject<{
    type: z.ZodLiteral<"string">;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    enum: z.ZodArray<z.ZodString>;
    default: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"string">;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    oneOf: z.ZodArray<z.ZodObject<{
        const: z.ZodString;
        title: z.ZodString;
    }, z.core.$strip>>;
    default: z.ZodOptional<z.ZodString>;
}, z.core.$strip>]>, z.ZodUnion<readonly [z.ZodObject<{
    type: z.ZodLiteral<"array">;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    minItems: z.ZodOptional<z.ZodNumber>;
    maxItems: z.ZodOptional<z.ZodNumber>;
    items: z.ZodObject<{
        type: z.ZodLiteral<"string">;
        enum: z.ZodArray<z.ZodString>;
    }, z.core.$strip>;
    default: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"array">;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    minItems: z.ZodOptional<z.ZodNumber>;
    maxItems: z.ZodOptional<z.ZodNumber>;
    items: z.ZodObject<{
        anyOf: z.ZodArray<z.ZodObject<{
            const: z.ZodString;
            title: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    default: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>]>]>;
/**
 * Union of all primitive schema definitions.
 */
export declare const PrimitiveSchemaDefinitionSchema: z.ZodUnion<readonly [z.ZodUnion<readonly [z.ZodObject<{
    type: z.ZodLiteral<"string">;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    enum: z.ZodArray<z.ZodString>;
    enumNames: z.ZodOptional<z.ZodArray<z.ZodString>>;
    default: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodUnion<readonly [z.ZodObject<{
    type: z.ZodLiteral<"string">;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    enum: z.ZodArray<z.ZodString>;
    default: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"string">;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    oneOf: z.ZodArray<z.ZodObject<{
        const: z.ZodString;
        title: z.ZodString;
    }, z.core.$strip>>;
    default: z.ZodOptional<z.ZodString>;
}, z.core.$strip>]>, z.ZodUnion<readonly [z.ZodObject<{
    type: z.ZodLiteral<"array">;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    minItems: z.ZodOptional<z.ZodNumber>;
    maxItems: z.ZodOptional<z.ZodNumber>;
    items: z.ZodObject<{
        type: z.ZodLiteral<"string">;
        enum: z.ZodArray<z.ZodString>;
    }, z.core.$strip>;
    default: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"array">;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    minItems: z.ZodOptional<z.ZodNumber>;
    maxItems: z.ZodOptional<z.ZodNumber>;
    items: z.ZodObject<{
        anyOf: z.ZodArray<z.ZodObject<{
            const: z.ZodString;
            title: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    default: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>]>]>, z.ZodObject<{
    type: z.ZodLiteral<"boolean">;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    default: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"string">;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    minLength: z.ZodOptional<z.ZodNumber>;
    maxLength: z.ZodOptional<z.ZodNumber>;
    format: z.ZodOptional<z.ZodEnum<{
        date: "date";
        uri: "uri";
        email: "email";
        "date-time": "date-time";
    }>>;
    default: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodEnum<{
        number: "number";
        integer: "integer";
    }>;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    minimum: z.ZodOptional<z.ZodNumber>;
    maximum: z.ZodOptional<z.ZodNumber>;
    default: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>]>;
/**
 * Parameters for an `elicitation/create` request for form-based elicitation.
 */
export declare const ElicitRequestFormParamsSchema: z.ZodObject<{
    task: z.ZodOptional<z.ZodObject<{
        /**
         * Time in milliseconds to keep task results available after completion.
         * If null, the task has unlimited lifetime until manually cleaned up.
         */
        ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
        /**
         * Time in milliseconds to wait between task status requests.
         */
        pollInterval: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
         */
        progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
        /**
         * If specified, this request is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    mode: z.ZodOptional<z.ZodLiteral<"form">>;
    message: z.ZodString;
    requestedSchema: z.ZodObject<{
        type: z.ZodLiteral<"object">;
        properties: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodUnion<readonly [z.ZodObject<{
            type: z.ZodLiteral<"string">;
            title: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            enum: z.ZodArray<z.ZodString>;
            enumNames: z.ZodOptional<z.ZodArray<z.ZodString>>;
            default: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>, z.ZodUnion<readonly [z.ZodObject<{
            type: z.ZodLiteral<"string">;
            title: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            enum: z.ZodArray<z.ZodString>;
            default: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"string">;
            title: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            oneOf: z.ZodArray<z.ZodObject<{
                const: z.ZodString;
                title: z.ZodString;
            }, z.core.$strip>>;
            default: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>]>, z.ZodUnion<readonly [z.ZodObject<{
            type: z.ZodLiteral<"array">;
            title: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            minItems: z.ZodOptional<z.ZodNumber>;
            maxItems: z.ZodOptional<z.ZodNumber>;
            items: z.ZodObject<{
                type: z.ZodLiteral<"string">;
                enum: z.ZodArray<z.ZodString>;
            }, z.core.$strip>;
            default: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"array">;
            title: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            minItems: z.ZodOptional<z.ZodNumber>;
            maxItems: z.ZodOptional<z.ZodNumber>;
            items: z.ZodObject<{
                anyOf: z.ZodArray<z.ZodObject<{
                    const: z.ZodString;
                    title: z.ZodString;
                }, z.core.$strip>>;
            }, z.core.$strip>;
            default: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>]>]>, z.ZodObject<{
            type: z.ZodLiteral<"boolean">;
            title: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            default: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"string">;
            title: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            minLength: z.ZodOptional<z.ZodNumber>;
            maxLength: z.ZodOptional<z.ZodNumber>;
            format: z.ZodOptional<z.ZodEnum<{
                date: "date";
                uri: "uri";
                email: "email";
                "date-time": "date-time";
            }>>;
            default: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodEnum<{
                number: "number";
                integer: "integer";
            }>;
            title: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            minimum: z.ZodOptional<z.ZodNumber>;
            maximum: z.ZodOptional<z.ZodNumber>;
            default: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>]>>;
        required: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>;
}, z.core.$loose>;
/**
 * Parameters for an `elicitation/create` request for URL-based elicitation.
 */
export declare const ElicitRequestURLParamsSchema: z.ZodObject<{
    task: z.ZodOptional<z.ZodObject<{
        /**
         * Time in milliseconds to keep task results available after completion.
         * If null, the task has unlimited lifetime until manually cleaned up.
         */
        ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
        /**
         * Time in milliseconds to wait between task status requests.
         */
        pollInterval: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
         */
        progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
        /**
         * If specified, this request is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    mode: z.ZodLiteral<"url">;
    message: z.ZodString;
    elicitationId: z.ZodString;
    url: z.ZodString;
}, z.core.$loose>;
/**
 * The parameters for a request to elicit additional information from the user via the client.
 */
export declare const ElicitRequestParamsSchema: z.ZodUnion<readonly [z.ZodObject<{
    task: z.ZodOptional<z.ZodObject<{
        /**
         * Time in milliseconds to keep task results available after completion.
         * If null, the task has unlimited lifetime until manually cleaned up.
         */
        ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
        /**
         * Time in milliseconds to wait between task status requests.
         */
        pollInterval: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
         */
        progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
        /**
         * If specified, this request is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    mode: z.ZodOptional<z.ZodLiteral<"form">>;
    message: z.ZodString;
    requestedSchema: z.ZodObject<{
        type: z.ZodLiteral<"object">;
        properties: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodUnion<readonly [z.ZodObject<{
            type: z.ZodLiteral<"string">;
            title: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            enum: z.ZodArray<z.ZodString>;
            enumNames: z.ZodOptional<z.ZodArray<z.ZodString>>;
            default: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>, z.ZodUnion<readonly [z.ZodObject<{
            type: z.ZodLiteral<"string">;
            title: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            enum: z.ZodArray<z.ZodString>;
            default: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"string">;
            title: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            oneOf: z.ZodArray<z.ZodObject<{
                const: z.ZodString;
                title: z.ZodString;
            }, z.core.$strip>>;
            default: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>]>, z.ZodUnion<readonly [z.ZodObject<{
            type: z.ZodLiteral<"array">;
            title: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            minItems: z.ZodOptional<z.ZodNumber>;
            maxItems: z.ZodOptional<z.ZodNumber>;
            items: z.ZodObject<{
                type: z.ZodLiteral<"string">;
                enum: z.ZodArray<z.ZodString>;
            }, z.core.$strip>;
            default: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"array">;
            title: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            minItems: z.ZodOptional<z.ZodNumber>;
            maxItems: z.ZodOptional<z.ZodNumber>;
            items: z.ZodObject<{
                anyOf: z.ZodArray<z.ZodObject<{
                    const: z.ZodString;
                    title: z.ZodString;
                }, z.core.$strip>>;
            }, z.core.$strip>;
            default: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>]>]>, z.ZodObject<{
            type: z.ZodLiteral<"boolean">;
            title: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            default: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"string">;
            title: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            minLength: z.ZodOptional<z.ZodNumber>;
            maxLength: z.ZodOptional<z.ZodNumber>;
            format: z.ZodOptional<z.ZodEnum<{
                date: "date";
                uri: "uri";
                email: "email";
                "date-time": "date-time";
            }>>;
            default: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodEnum<{
                number: "number";
                integer: "integer";
            }>;
            title: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            minimum: z.ZodOptional<z.ZodNumber>;
            maximum: z.ZodOptional<z.ZodNumber>;
            default: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>]>>;
        required: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>;
}, z.core.$loose>, z.ZodObject<{
    task: z.ZodOptional<z.ZodObject<{
        /**
         * Time in milliseconds to keep task results available after completion.
         * If null, the task has unlimited lifetime until manually cleaned up.
         */
        ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
        /**
         * Time in milliseconds to wait between task status requests.
         */
        pollInterval: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
         */
        progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
        /**
         * If specified, this request is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    mode: z.ZodLiteral<"url">;
    message: z.ZodString;
    elicitationId: z.ZodString;
    url: z.ZodString;
}, z.core.$loose>]>;
/**
 * A request from the server to elicit user input via the client.
 * The client should present the message and form fields to the user (form mode)
 * or navigate to a URL (URL mode).
 */
export declare const ElicitRequestSchema: z.ZodObject<{
    method: z.ZodLiteral<"elicitation/create">;
    params: z.ZodUnion<readonly [z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        mode: z.ZodOptional<z.ZodLiteral<"form">>;
        message: z.ZodString;
        requestedSchema: z.ZodObject<{
            type: z.ZodLiteral<"object">;
            properties: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodUnion<readonly [z.ZodObject<{
                type: z.ZodLiteral<"string">;
                title: z.ZodOptional<z.ZodString>;
                description: z.ZodOptional<z.ZodString>;
                enum: z.ZodArray<z.ZodString>;
                enumNames: z.ZodOptional<z.ZodArray<z.ZodString>>;
                default: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>, z.ZodUnion<readonly [z.ZodObject<{
                type: z.ZodLiteral<"string">;
                title: z.ZodOptional<z.ZodString>;
                description: z.ZodOptional<z.ZodString>;
                enum: z.ZodArray<z.ZodString>;
                default: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"string">;
                title: z.ZodOptional<z.ZodString>;
                description: z.ZodOptional<z.ZodString>;
                oneOf: z.ZodArray<z.ZodObject<{
                    const: z.ZodString;
                    title: z.ZodString;
                }, z.core.$strip>>;
                default: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>]>, z.ZodUnion<readonly [z.ZodObject<{
                type: z.ZodLiteral<"array">;
                title: z.ZodOptional<z.ZodString>;
                description: z.ZodOptional<z.ZodString>;
                minItems: z.ZodOptional<z.ZodNumber>;
                maxItems: z.ZodOptional<z.ZodNumber>;
                items: z.ZodObject<{
                    type: z.ZodLiteral<"string">;
                    enum: z.ZodArray<z.ZodString>;
                }, z.core.$strip>;
                default: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"array">;
                title: z.ZodOptional<z.ZodString>;
                description: z.ZodOptional<z.ZodString>;
                minItems: z.ZodOptional<z.ZodNumber>;
                maxItems: z.ZodOptional<z.ZodNumber>;
                items: z.ZodObject<{
                    anyOf: z.ZodArray<z.ZodObject<{
                        const: z.ZodString;
                        title: z.ZodString;
                    }, z.core.$strip>>;
                }, z.core.$strip>;
                default: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strip>]>]>, z.ZodObject<{
                type: z.ZodLiteral<"boolean">;
                title: z.ZodOptional<z.ZodString>;
                description: z.ZodOptional<z.ZodString>;
                default: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"string">;
                title: z.ZodOptional<z.ZodString>;
                description: z.ZodOptional<z.ZodString>;
                minLength: z.ZodOptional<z.ZodNumber>;
                maxLength: z.ZodOptional<z.ZodNumber>;
                format: z.ZodOptional<z.ZodEnum<{
                    date: "date";
                    uri: "uri";
                    email: "email";
                    "date-time": "date-time";
                }>>;
                default: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodEnum<{
                    number: "number";
                    integer: "integer";
                }>;
                title: z.ZodOptional<z.ZodString>;
                description: z.ZodOptional<z.ZodString>;
                minimum: z.ZodOptional<z.ZodNumber>;
                maximum: z.ZodOptional<z.ZodNumber>;
                default: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>]>>;
            required: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>;
    }, z.core.$loose>, z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        mode: z.ZodLiteral<"url">;
        message: z.ZodString;
        elicitationId: z.ZodString;
        url: z.ZodString;
    }, z.core.$loose>]>;
}, z.core.$strip>;
/**
 * Parameters for a `notifications/elicitation/complete` notification.
 *
 * @category notifications/elicitation/complete
 */
export declare const ElicitationCompleteNotificationParamsSchema: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    elicitationId: z.ZodString;
}, z.core.$loose>;
/**
 * A notification from the server to the client, informing it of a completion of an out-of-band elicitation request.
 *
 * @category notifications/elicitation/complete
 */
export declare const ElicitationCompleteNotificationSchema: z.ZodObject<{
    method: z.ZodLiteral<"notifications/elicitation/complete">;
    params: z.ZodObject<{
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        elicitationId: z.ZodString;
    }, z.core.$loose>;
}, z.core.$strip>;
/**
 * The client's response to an elicitation/create request from the server.
 */
export declare const ElicitResultSchema: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    action: z.ZodEnum<{
        cancel: "cancel";
        accept: "accept";
        decline: "decline";
    }>;
    content: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodArray<z.ZodString>]>>>;
}, z.core.$loose>;
/**
 * A reference to a resource or resource template definition.
 */
export declare const ResourceTemplateReferenceSchema: z.ZodObject<{
    type: z.ZodLiteral<"ref/resource">;
    uri: z.ZodString;
}, z.core.$strip>;
/**
 * @deprecated Use ResourceTemplateReferenceSchema instead
 */
export declare const ResourceReferenceSchema: z.ZodObject<{
    type: z.ZodLiteral<"ref/resource">;
    uri: z.ZodString;
}, z.core.$strip>;
/**
 * Identifies a prompt.
 */
export declare const PromptReferenceSchema: z.ZodObject<{
    type: z.ZodLiteral<"ref/prompt">;
    name: z.ZodString;
}, z.core.$strip>;
/**
 * Parameters for a `completion/complete` request.
 */
export declare const CompleteRequestParamsSchema: z.ZodObject<{
    task: z.ZodOptional<z.ZodObject<{
        /**
         * Time in milliseconds to keep task results available after completion.
         * If null, the task has unlimited lifetime until manually cleaned up.
         */
        ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
        /**
         * Time in milliseconds to wait between task status requests.
         */
        pollInterval: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
         */
        progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
        /**
         * If specified, this request is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    ref: z.ZodUnion<readonly [z.ZodObject<{
        type: z.ZodLiteral<"ref/prompt">;
        name: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"ref/resource">;
        uri: z.ZodString;
    }, z.core.$strip>]>;
    argument: z.ZodObject<{
        name: z.ZodString;
        value: z.ZodString;
    }, z.core.$strip>;
    context: z.ZodOptional<z.ZodObject<{
        arguments: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, z.core.$strip>>;
}, z.core.$loose>;
/**
 * A request from the client to the server, to ask for completion options.
 */
export declare const CompleteRequestSchema: z.ZodObject<{
    method: z.ZodLiteral<"completion/complete">;
    params: z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        ref: z.ZodUnion<readonly [z.ZodObject<{
            type: z.ZodLiteral<"ref/prompt">;
            name: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"ref/resource">;
            uri: z.ZodString;
        }, z.core.$strip>]>;
        argument: z.ZodObject<{
            name: z.ZodString;
            value: z.ZodString;
        }, z.core.$strip>;
        context: z.ZodOptional<z.ZodObject<{
            arguments: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        }, z.core.$strip>>;
    }, z.core.$loose>;
}, z.core.$strip>;
export declare function assertCompleteRequestPrompt(request: CompleteRequest): asserts request is CompleteRequestPrompt;
export declare function assertCompleteRequestResourceTemplate(request: CompleteRequest): asserts request is CompleteRequestResourceTemplate;
/**
 * The server's response to a completion/complete request
 */
export declare const CompleteResultSchema: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    completion: z.ZodObject<{
        /**
         * An array of completion values. Must not exceed 100 items.
         */
        values: z.ZodArray<z.ZodString>;
        /**
         * The total number of completion options available. This can exceed the number of values actually sent in the response.
         */
        total: z.ZodOptional<z.ZodNumber>;
        /**
         * Indicates whether there are additional completion options beyond those provided in the current response, even if the exact total is unknown.
         */
        hasMore: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$loose>;
}, z.core.$loose>;
/**
 * Represents a root directory or file that the server can operate on.
 */
export declare const RootSchema: z.ZodObject<{
    uri: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
/**
 * Sent from the server to request a list of root URIs from the client.
 */
export declare const ListRootsRequestSchema: z.ZodObject<{
    params: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, the caller is requesting that the receiver create a task to represent the request.
         * Task creation parameters are now at the top level instead of in _meta.
         */
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        /**
         * See [General fields: `_meta`](/specification/draft/basic/index#meta) for notes on `_meta` usage.
         */
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    method: z.ZodLiteral<"roots/list">;
}, z.core.$strip>;
/**
 * The client's response to a roots/list request from the server.
 */
export declare const ListRootsResultSchema: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    roots: z.ZodArray<z.ZodObject<{
        uri: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>>;
}, z.core.$loose>;
/**
 * A notification from the client to the server, informing it that the list of roots has changed.
 */
export declare const RootsListChangedNotificationSchema: z.ZodObject<{
    params: z.ZodOptional<z.ZodObject<{
        /**
         * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
         * for notes on _meta usage.
         */
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    method: z.ZodLiteral<"notifications/roots/list_changed">;
}, z.core.$strip>;
export declare const ClientRequestSchema: z.ZodUnion<readonly [z.ZodObject<{
    params: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, the caller is requesting that the receiver create a task to represent the request.
         * Task creation parameters are now at the top level instead of in _meta.
         */
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        /**
         * See [General fields: `_meta`](/specification/draft/basic/index#meta) for notes on `_meta` usage.
         */
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    method: z.ZodLiteral<"ping">;
}, z.core.$strip>, z.ZodObject<{
    method: z.ZodLiteral<"initialize">;
    params: z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        protocolVersion: z.ZodString;
        capabilities: z.ZodObject<{
            experimental: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodCustom<object, object>>>;
            sampling: z.ZodOptional<z.ZodObject<{
                context: z.ZodOptional<z.ZodCustom<object, object>>;
                tools: z.ZodOptional<z.ZodCustom<object, object>>;
            }, z.core.$strip>>;
            elicitation: z.ZodOptional<z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodIntersection<z.ZodObject<{
                form: z.ZodOptional<z.ZodIntersection<z.ZodObject<{
                    applyDefaults: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strip>, z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
                url: z.ZodOptional<z.ZodCustom<object, object>>;
            }, z.core.$strip>, z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>>;
            roots: z.ZodOptional<z.ZodObject<{
                listChanged: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strip>>;
            tasks: z.ZodOptional<z.ZodObject<{
                list: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
                cancel: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
                requests: z.ZodOptional<z.ZodObject<{
                    sampling: z.ZodOptional<z.ZodObject<{
                        createMessage: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
                    }, z.core.$loose>>;
                    elicitation: z.ZodOptional<z.ZodObject<{
                        create: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
                    }, z.core.$loose>>;
                }, z.core.$loose>>;
            }, z.core.$loose>>;
        }, z.core.$strip>;
        clientInfo: z.ZodObject<{
            version: z.ZodString;
            websiteUrl: z.ZodOptional<z.ZodString>;
            icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
                src: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strip>>>;
            name: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$loose>;
}, z.core.$strip>, z.ZodObject<{
    method: z.ZodLiteral<"completion/complete">;
    params: z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        ref: z.ZodUnion<readonly [z.ZodObject<{
            type: z.ZodLiteral<"ref/prompt">;
            name: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"ref/resource">;
            uri: z.ZodString;
        }, z.core.$strip>]>;
        argument: z.ZodObject<{
            name: z.ZodString;
            value: z.ZodString;
        }, z.core.$strip>;
        context: z.ZodOptional<z.ZodObject<{
            arguments: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        }, z.core.$strip>>;
    }, z.core.$loose>;
}, z.core.$strip>, z.ZodObject<{
    method: z.ZodLiteral<"logging/setLevel">;
    params: z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        level: z.ZodEnum<{
            error: "error";
            debug: "debug";
            info: "info";
            notice: "notice";
            warning: "warning";
            critical: "critical";
            alert: "alert";
            emergency: "emergency";
        }>;
    }, z.core.$loose>;
}, z.core.$strip>, z.ZodObject<{
    method: z.ZodLiteral<"prompts/get">;
    params: z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        name: z.ZodString;
        arguments: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, z.core.$loose>;
}, z.core.$strip>, z.ZodObject<{
    params: z.ZodOptional<z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        cursor: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    method: z.ZodLiteral<"prompts/list">;
}, z.core.$strip>, z.ZodObject<{
    params: z.ZodOptional<z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        cursor: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    method: z.ZodLiteral<"resources/list">;
}, z.core.$strip>, z.ZodObject<{
    params: z.ZodOptional<z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        cursor: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    method: z.ZodLiteral<"resources/templates/list">;
}, z.core.$strip>, z.ZodObject<{
    method: z.ZodLiteral<"resources/read">;
    params: z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        uri: z.ZodString;
    }, z.core.$loose>;
}, z.core.$strip>, z.ZodObject<{
    method: z.ZodLiteral<"resources/subscribe">;
    params: z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        uri: z.ZodString;
    }, z.core.$loose>;
}, z.core.$strip>, z.ZodObject<{
    method: z.ZodLiteral<"resources/unsubscribe">;
    params: z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        uri: z.ZodString;
    }, z.core.$loose>;
}, z.core.$strip>, z.ZodObject<{
    method: z.ZodLiteral<"tools/call">;
    params: z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        name: z.ZodString;
        arguments: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$loose>;
}, z.core.$strip>, z.ZodObject<{
    params: z.ZodOptional<z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        cursor: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    method: z.ZodLiteral<"tools/list">;
}, z.core.$strip>, z.ZodObject<{
    method: z.ZodLiteral<"tasks/get">;
    params: z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        taskId: z.ZodString;
    }, z.core.$loose>;
}, z.core.$strip>, z.ZodObject<{
    method: z.ZodLiteral<"tasks/result">;
    params: z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        taskId: z.ZodString;
    }, z.core.$loose>;
}, z.core.$strip>, z.ZodObject<{
    params: z.ZodOptional<z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        cursor: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    method: z.ZodLiteral<"tasks/list">;
}, z.core.$strip>]>;
export declare const ClientNotificationSchema: z.ZodUnion<readonly [z.ZodObject<{
    method: z.ZodLiteral<"notifications/cancelled">;
    params: z.ZodObject<{
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        requestId: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
        reason: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>;
}, z.core.$strip>, z.ZodObject<{
    method: z.ZodLiteral<"notifications/progress">;
    params: z.ZodObject<{
        progressToken: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
        progress: z.ZodNumber;
        total: z.ZodOptional<z.ZodNumber>;
        message: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    params: z.ZodOptional<z.ZodObject<{
        /**
         * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
         * for notes on _meta usage.
         */
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    method: z.ZodLiteral<"notifications/initialized">;
}, z.core.$strip>, z.ZodObject<{
    params: z.ZodOptional<z.ZodObject<{
        /**
         * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
         * for notes on _meta usage.
         */
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    method: z.ZodLiteral<"notifications/roots/list_changed">;
}, z.core.$strip>, z.ZodObject<{
    method: z.ZodLiteral<"notifications/tasks/status">;
    params: z.ZodObject<{
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        taskId: z.ZodString;
        status: z.ZodEnum<{
            working: "working";
            input_required: "input_required";
            completed: "completed";
            failed: "failed";
            cancelled: "cancelled";
        }>;
        ttl: z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>;
        createdAt: z.ZodString;
        lastUpdatedAt: z.ZodString;
        pollInterval: z.ZodOptional<z.ZodNumber>;
        statusMessage: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>]>;
export declare const ClientResultSchema: z.ZodUnion<readonly [z.ZodObject<{
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on _meta usage.
     */
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
}, z.core.$strict>, z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    model: z.ZodString;
    stopReason: z.ZodOptional<z.ZodUnion<[z.ZodEnum<{
        maxTokens: "maxTokens";
        endTurn: "endTurn";
        stopSequence: "stopSequence";
        toolUse: "toolUse";
    }>, z.ZodString]>>;
    role: z.ZodEnum<{
        user: "user";
        assistant: "assistant";
    }>;
    content: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        data: z.ZodString;
        mimeType: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"audio">;
        data: z.ZodString;
        mimeType: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_use">;
        name: z.ZodString;
        id: z.ZodString;
        input: z.ZodObject<{}, z.core.$loose>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"tool_result">;
        toolUseId: z.ZodString;
        content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
            type: z.ZodLiteral<"text">;
            text: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"image">;
            data: z.ZodString;
            mimeType: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"audio">;
            data: z.ZodString;
            mimeType: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            uri: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
                src: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strip>>>;
            name: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
            type: z.ZodLiteral<"resource_link">;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"resource">;
            resource: z.ZodUnion<readonly [z.ZodObject<{
                uri: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                text: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                uri: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                blob: z.ZodString;
            }, z.core.$strip>]>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>]>>>;
        structuredContent: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        isError: z.ZodOptional<z.ZodBoolean>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    }, z.core.$loose>]>, z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        data: z.ZodString;
        mimeType: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"audio">;
        data: z.ZodString;
        mimeType: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_use">;
        name: z.ZodString;
        id: z.ZodString;
        input: z.ZodObject<{}, z.core.$loose>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"tool_result">;
        toolUseId: z.ZodString;
        content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
            type: z.ZodLiteral<"text">;
            text: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"image">;
            data: z.ZodString;
            mimeType: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"audio">;
            data: z.ZodString;
            mimeType: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            uri: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
                src: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strip>>>;
            name: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
            type: z.ZodLiteral<"resource_link">;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"resource">;
            resource: z.ZodUnion<readonly [z.ZodObject<{
                uri: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                text: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                uri: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                blob: z.ZodString;
            }, z.core.$strip>]>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>]>>>;
        structuredContent: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        isError: z.ZodOptional<z.ZodBoolean>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    }, z.core.$loose>]>>]>;
}, z.core.$loose>, z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    action: z.ZodEnum<{
        cancel: "cancel";
        accept: "accept";
        decline: "decline";
    }>;
    content: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodArray<z.ZodString>]>>>;
}, z.core.$loose>, z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    roots: z.ZodArray<z.ZodObject<{
        uri: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>>;
}, z.core.$loose>, z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    taskId: z.ZodString;
    status: z.ZodEnum<{
        working: "working";
        input_required: "input_required";
        completed: "completed";
        failed: "failed";
        cancelled: "cancelled";
    }>;
    ttl: z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>;
    createdAt: z.ZodString;
    lastUpdatedAt: z.ZodString;
    pollInterval: z.ZodOptional<z.ZodNumber>;
    statusMessage: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    nextCursor: z.ZodOptional<z.ZodString>;
    tasks: z.ZodArray<z.ZodObject<{
        taskId: z.ZodString;
        status: z.ZodEnum<{
            working: "working";
            input_required: "input_required";
            completed: "completed";
            failed: "failed";
            cancelled: "cancelled";
        }>;
        ttl: z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>;
        createdAt: z.ZodString;
        lastUpdatedAt: z.ZodString;
        pollInterval: z.ZodOptional<z.ZodNumber>;
        statusMessage: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$loose>, z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    task: z.ZodObject<{
        taskId: z.ZodString;
        status: z.ZodEnum<{
            working: "working";
            input_required: "input_required";
            completed: "completed";
            failed: "failed";
            cancelled: "cancelled";
        }>;
        ttl: z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>;
        createdAt: z.ZodString;
        lastUpdatedAt: z.ZodString;
        pollInterval: z.ZodOptional<z.ZodNumber>;
        statusMessage: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$loose>]>;
export declare const ServerRequestSchema: z.ZodUnion<readonly [z.ZodObject<{
    params: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, the caller is requesting that the receiver create a task to represent the request.
         * Task creation parameters are now at the top level instead of in _meta.
         */
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        /**
         * See [General fields: `_meta`](/specification/draft/basic/index#meta) for notes on `_meta` usage.
         */
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    method: z.ZodLiteral<"ping">;
}, z.core.$strip>, z.ZodObject<{
    method: z.ZodLiteral<"sampling/createMessage">;
    params: z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        messages: z.ZodArray<z.ZodObject<{
            role: z.ZodEnum<{
                user: "user";
                assistant: "assistant";
            }>;
            content: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
                type: z.ZodLiteral<"text">;
                text: z.ZodString;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"image">;
                data: z.ZodString;
                mimeType: z.ZodString;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"audio">;
                data: z.ZodString;
                mimeType: z.ZodString;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"tool_use">;
                name: z.ZodString;
                id: z.ZodString;
                input: z.ZodObject<{}, z.core.$loose>;
                _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            }, z.core.$loose>, z.ZodObject<{
                type: z.ZodLiteral<"tool_result">;
                toolUseId: z.ZodString;
                content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
                    type: z.ZodLiteral<"text">;
                    text: z.ZodString;
                    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"image">;
                    data: z.ZodString;
                    mimeType: z.ZodString;
                    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"audio">;
                    data: z.ZodString;
                    mimeType: z.ZodString;
                    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                }, z.core.$strip>, z.ZodObject<{
                    uri: z.ZodString;
                    description: z.ZodOptional<z.ZodString>;
                    mimeType: z.ZodOptional<z.ZodString>;
                    _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
                    icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
                        src: z.ZodString;
                        mimeType: z.ZodOptional<z.ZodString>;
                        sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strip>>>;
                    name: z.ZodString;
                    title: z.ZodOptional<z.ZodString>;
                    type: z.ZodLiteral<"resource_link">;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"resource">;
                    resource: z.ZodUnion<readonly [z.ZodObject<{
                        uri: z.ZodString;
                        mimeType: z.ZodOptional<z.ZodString>;
                        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                        text: z.ZodString;
                    }, z.core.$strip>, z.ZodObject<{
                        uri: z.ZodString;
                        mimeType: z.ZodOptional<z.ZodString>;
                        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                        blob: z.ZodString;
                    }, z.core.$strip>]>;
                    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                }, z.core.$strip>]>>>;
                structuredContent: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
                isError: z.ZodOptional<z.ZodBoolean>;
                _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            }, z.core.$loose>]>, z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                type: z.ZodLiteral<"text">;
                text: z.ZodString;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"image">;
                data: z.ZodString;
                mimeType: z.ZodString;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"audio">;
                data: z.ZodString;
                mimeType: z.ZodString;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"tool_use">;
                name: z.ZodString;
                id: z.ZodString;
                input: z.ZodObject<{}, z.core.$loose>;
                _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            }, z.core.$loose>, z.ZodObject<{
                type: z.ZodLiteral<"tool_result">;
                toolUseId: z.ZodString;
                content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
                    type: z.ZodLiteral<"text">;
                    text: z.ZodString;
                    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"image">;
                    data: z.ZodString;
                    mimeType: z.ZodString;
                    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"audio">;
                    data: z.ZodString;
                    mimeType: z.ZodString;
                    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                }, z.core.$strip>, z.ZodObject<{
                    uri: z.ZodString;
                    description: z.ZodOptional<z.ZodString>;
                    mimeType: z.ZodOptional<z.ZodString>;
                    _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
                    icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
                        src: z.ZodString;
                        mimeType: z.ZodOptional<z.ZodString>;
                        sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strip>>>;
                    name: z.ZodString;
                    title: z.ZodOptional<z.ZodString>;
                    type: z.ZodLiteral<"resource_link">;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"resource">;
                    resource: z.ZodUnion<readonly [z.ZodObject<{
                        uri: z.ZodString;
                        mimeType: z.ZodOptional<z.ZodString>;
                        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                        text: z.ZodString;
                    }, z.core.$strip>, z.ZodObject<{
                        uri: z.ZodString;
                        mimeType: z.ZodOptional<z.ZodString>;
                        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                        blob: z.ZodString;
                    }, z.core.$strip>]>;
                    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                }, z.core.$strip>]>>>;
                structuredContent: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
                isError: z.ZodOptional<z.ZodBoolean>;
                _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            }, z.core.$loose>]>>]>;
            _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        }, z.core.$loose>>;
        modelPreferences: z.ZodOptional<z.ZodObject<{
            hints: z.ZodOptional<z.ZodArray<z.ZodObject<{
                name: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>>;
            costPriority: z.ZodOptional<z.ZodNumber>;
            speedPriority: z.ZodOptional<z.ZodNumber>;
            intelligencePriority: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
        systemPrompt: z.ZodOptional<z.ZodString>;
        includeContext: z.ZodOptional<z.ZodEnum<{
            none: "none";
            thisServer: "thisServer";
            allServers: "allServers";
        }>>;
        temperature: z.ZodOptional<z.ZodNumber>;
        maxTokens: z.ZodNumber;
        stopSequences: z.ZodOptional<z.ZodArray<z.ZodString>>;
        metadata: z.ZodOptional<z.ZodCustom<object, object>>;
        tools: z.ZodOptional<z.ZodArray<z.ZodObject<{
            description: z.ZodOptional<z.ZodString>;
            inputSchema: z.ZodObject<{
                type: z.ZodLiteral<"object">;
                properties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodCustom<object, object>>>;
                required: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$catchall<z.ZodUnknown>>;
            outputSchema: z.ZodOptional<z.ZodObject<{
                type: z.ZodLiteral<"object">;
                properties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodCustom<object, object>>>;
                required: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$catchall<z.ZodUnknown>>>;
            annotations: z.ZodOptional<z.ZodObject<{
                title: z.ZodOptional<z.ZodString>;
                readOnlyHint: z.ZodOptional<z.ZodBoolean>;
                destructiveHint: z.ZodOptional<z.ZodBoolean>;
                idempotentHint: z.ZodOptional<z.ZodBoolean>;
                openWorldHint: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strip>>;
            execution: z.ZodOptional<z.ZodObject<{
                taskSupport: z.ZodOptional<z.ZodEnum<{
                    optional: "optional";
                    required: "required";
                    forbidden: "forbidden";
                }>>;
            }, z.core.$strip>>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
                src: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strip>>>;
            name: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        toolChoice: z.ZodOptional<z.ZodObject<{
            mode: z.ZodOptional<z.ZodEnum<{
                required: "required";
                auto: "auto";
                none: "none";
            }>>;
        }, z.core.$strip>>;
    }, z.core.$loose>;
}, z.core.$strip>, z.ZodObject<{
    method: z.ZodLiteral<"elicitation/create">;
    params: z.ZodUnion<readonly [z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        mode: z.ZodOptional<z.ZodLiteral<"form">>;
        message: z.ZodString;
        requestedSchema: z.ZodObject<{
            type: z.ZodLiteral<"object">;
            properties: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodUnion<readonly [z.ZodObject<{
                type: z.ZodLiteral<"string">;
                title: z.ZodOptional<z.ZodString>;
                description: z.ZodOptional<z.ZodString>;
                enum: z.ZodArray<z.ZodString>;
                enumNames: z.ZodOptional<z.ZodArray<z.ZodString>>;
                default: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>, z.ZodUnion<readonly [z.ZodObject<{
                type: z.ZodLiteral<"string">;
                title: z.ZodOptional<z.ZodString>;
                description: z.ZodOptional<z.ZodString>;
                enum: z.ZodArray<z.ZodString>;
                default: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"string">;
                title: z.ZodOptional<z.ZodString>;
                description: z.ZodOptional<z.ZodString>;
                oneOf: z.ZodArray<z.ZodObject<{
                    const: z.ZodString;
                    title: z.ZodString;
                }, z.core.$strip>>;
                default: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>]>, z.ZodUnion<readonly [z.ZodObject<{
                type: z.ZodLiteral<"array">;
                title: z.ZodOptional<z.ZodString>;
                description: z.ZodOptional<z.ZodString>;
                minItems: z.ZodOptional<z.ZodNumber>;
                maxItems: z.ZodOptional<z.ZodNumber>;
                items: z.ZodObject<{
                    type: z.ZodLiteral<"string">;
                    enum: z.ZodArray<z.ZodString>;
                }, z.core.$strip>;
                default: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"array">;
                title: z.ZodOptional<z.ZodString>;
                description: z.ZodOptional<z.ZodString>;
                minItems: z.ZodOptional<z.ZodNumber>;
                maxItems: z.ZodOptional<z.ZodNumber>;
                items: z.ZodObject<{
                    anyOf: z.ZodArray<z.ZodObject<{
                        const: z.ZodString;
                        title: z.ZodString;
                    }, z.core.$strip>>;
                }, z.core.$strip>;
                default: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strip>]>]>, z.ZodObject<{
                type: z.ZodLiteral<"boolean">;
                title: z.ZodOptional<z.ZodString>;
                description: z.ZodOptional<z.ZodString>;
                default: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"string">;
                title: z.ZodOptional<z.ZodString>;
                description: z.ZodOptional<z.ZodString>;
                minLength: z.ZodOptional<z.ZodNumber>;
                maxLength: z.ZodOptional<z.ZodNumber>;
                format: z.ZodOptional<z.ZodEnum<{
                    date: "date";
                    uri: "uri";
                    email: "email";
                    "date-time": "date-time";
                }>>;
                default: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodEnum<{
                    number: "number";
                    integer: "integer";
                }>;
                title: z.ZodOptional<z.ZodString>;
                description: z.ZodOptional<z.ZodString>;
                minimum: z.ZodOptional<z.ZodNumber>;
                maximum: z.ZodOptional<z.ZodNumber>;
                default: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>]>>;
            required: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>;
    }, z.core.$loose>, z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        mode: z.ZodLiteral<"url">;
        message: z.ZodString;
        elicitationId: z.ZodString;
        url: z.ZodString;
    }, z.core.$loose>]>;
}, z.core.$strip>, z.ZodObject<{
    params: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, the caller is requesting that the receiver create a task to represent the request.
         * Task creation parameters are now at the top level instead of in _meta.
         */
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        /**
         * See [General fields: `_meta`](/specification/draft/basic/index#meta) for notes on `_meta` usage.
         */
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    method: z.ZodLiteral<"roots/list">;
}, z.core.$strip>, z.ZodObject<{
    method: z.ZodLiteral<"tasks/get">;
    params: z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        taskId: z.ZodString;
    }, z.core.$loose>;
}, z.core.$strip>, z.ZodObject<{
    method: z.ZodLiteral<"tasks/result">;
    params: z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        taskId: z.ZodString;
    }, z.core.$loose>;
}, z.core.$strip>, z.ZodObject<{
    params: z.ZodOptional<z.ZodObject<{
        task: z.ZodOptional<z.ZodObject<{
            /**
             * Time in milliseconds to keep task results available after completion.
             * If null, the task has unlimited lifetime until manually cleaned up.
             */
            ttl: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
            /**
             * Time in milliseconds to wait between task status requests.
             */
            pollInterval: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        _meta: z.ZodOptional<z.ZodObject<{
            /**
             * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
             */
            progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            /**
             * If specified, this request is related to the provided task.
             */
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        cursor: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    method: z.ZodLiteral<"tasks/list">;
}, z.core.$strip>]>;
export declare const ServerNotificationSchema: z.ZodUnion<readonly [z.ZodObject<{
    method: z.ZodLiteral<"notifications/cancelled">;
    params: z.ZodObject<{
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        requestId: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
        reason: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>;
}, z.core.$strip>, z.ZodObject<{
    method: z.ZodLiteral<"notifications/progress">;
    params: z.ZodObject<{
        progressToken: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
        progress: z.ZodNumber;
        total: z.ZodOptional<z.ZodNumber>;
        message: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    method: z.ZodLiteral<"notifications/message">;
    params: z.ZodObject<{
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        level: z.ZodEnum<{
            error: "error";
            debug: "debug";
            info: "info";
            notice: "notice";
            warning: "warning";
            critical: "critical";
            alert: "alert";
            emergency: "emergency";
        }>;
        logger: z.ZodOptional<z.ZodString>;
        data: z.ZodUnknown;
    }, z.core.$loose>;
}, z.core.$strip>, z.ZodObject<{
    method: z.ZodLiteral<"notifications/resources/updated">;
    params: z.ZodObject<{
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        uri: z.ZodString;
    }, z.core.$loose>;
}, z.core.$strip>, z.ZodObject<{
    params: z.ZodOptional<z.ZodObject<{
        /**
         * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
         * for notes on _meta usage.
         */
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    method: z.ZodLiteral<"notifications/resources/list_changed">;
}, z.core.$strip>, z.ZodObject<{
    params: z.ZodOptional<z.ZodObject<{
        /**
         * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
         * for notes on _meta usage.
         */
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    method: z.ZodLiteral<"notifications/tools/list_changed">;
}, z.core.$strip>, z.ZodObject<{
    params: z.ZodOptional<z.ZodObject<{
        /**
         * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
         * for notes on _meta usage.
         */
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    method: z.ZodLiteral<"notifications/prompts/list_changed">;
}, z.core.$strip>, z.ZodObject<{
    method: z.ZodLiteral<"notifications/tasks/status">;
    params: z.ZodObject<{
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        taskId: z.ZodString;
        status: z.ZodEnum<{
            working: "working";
            input_required: "input_required";
            completed: "completed";
            failed: "failed";
            cancelled: "cancelled";
        }>;
        ttl: z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>;
        createdAt: z.ZodString;
        lastUpdatedAt: z.ZodString;
        pollInterval: z.ZodOptional<z.ZodNumber>;
        statusMessage: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    method: z.ZodLiteral<"notifications/elicitation/complete">;
    params: z.ZodObject<{
        _meta: z.ZodOptional<z.ZodObject<{
            "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
                taskId: z.ZodString;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        elicitationId: z.ZodString;
    }, z.core.$loose>;
}, z.core.$strip>]>;
export declare const ServerResultSchema: z.ZodUnion<readonly [z.ZodObject<{
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on _meta usage.
     */
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
}, z.core.$strict>, z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    protocolVersion: z.ZodString;
    capabilities: z.ZodObject<{
        experimental: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodCustom<object, object>>>;
        logging: z.ZodOptional<z.ZodCustom<object, object>>;
        completions: z.ZodOptional<z.ZodCustom<object, object>>;
        prompts: z.ZodOptional<z.ZodObject<{
            listChanged: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>>;
        resources: z.ZodOptional<z.ZodObject<{
            subscribe: z.ZodOptional<z.ZodBoolean>;
            listChanged: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>>;
        tools: z.ZodOptional<z.ZodObject<{
            listChanged: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>>;
        tasks: z.ZodOptional<z.ZodObject<{
            list: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            cancel: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            requests: z.ZodOptional<z.ZodObject<{
                tools: z.ZodOptional<z.ZodObject<{
                    call: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
                }, z.core.$loose>>;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
    }, z.core.$loose>;
    serverInfo: z.ZodObject<{
        version: z.ZodString;
        websiteUrl: z.ZodOptional<z.ZodString>;
        icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
            src: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>>;
        name: z.ZodString;
        title: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    instructions: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    completion: z.ZodObject<{
        /**
         * An array of completion values. Must not exceed 100 items.
         */
        values: z.ZodArray<z.ZodString>;
        /**
         * The total number of completion options available. This can exceed the number of values actually sent in the response.
         */
        total: z.ZodOptional<z.ZodNumber>;
        /**
         * Indicates whether there are additional completion options beyond those provided in the current response, even if the exact total is unknown.
         */
        hasMore: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$loose>;
}, z.core.$loose>, z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    description: z.ZodOptional<z.ZodString>;
    messages: z.ZodArray<z.ZodObject<{
        role: z.ZodEnum<{
            user: "user";
            assistant: "assistant";
        }>;
        content: z.ZodUnion<readonly [z.ZodObject<{
            type: z.ZodLiteral<"text">;
            text: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"image">;
            data: z.ZodString;
            mimeType: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"audio">;
            data: z.ZodString;
            mimeType: z.ZodString;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
            uri: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
            icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
                src: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strip>>>;
            name: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
            type: z.ZodLiteral<"resource_link">;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"resource">;
            resource: z.ZodUnion<readonly [z.ZodObject<{
                uri: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                text: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                uri: z.ZodString;
                mimeType: z.ZodOptional<z.ZodString>;
                _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                blob: z.ZodString;
            }, z.core.$strip>]>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>]>;
    }, z.core.$strip>>;
}, z.core.$loose>, z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    nextCursor: z.ZodOptional<z.ZodString>;
    prompts: z.ZodArray<z.ZodObject<{
        description: z.ZodOptional<z.ZodString>;
        arguments: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            required: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>>>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
            src: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>>;
        name: z.ZodString;
        title: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$loose>, z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    nextCursor: z.ZodOptional<z.ZodString>;
    resources: z.ZodArray<z.ZodObject<{
        uri: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        mimeType: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
            src: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>>;
        name: z.ZodString;
        title: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$loose>, z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    nextCursor: z.ZodOptional<z.ZodString>;
    resourceTemplates: z.ZodArray<z.ZodObject<{
        uriTemplate: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        mimeType: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
            src: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>>;
        name: z.ZodString;
        title: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$loose>, z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    contents: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        uri: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        uri: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        blob: z.ZodString;
    }, z.core.$strip>]>>;
}, z.core.$loose>, z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        data: z.ZodString;
        mimeType: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"audio">;
        data: z.ZodString;
        mimeType: z.ZodString;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
        uri: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        mimeType: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
            src: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>>;
        name: z.ZodString;
        title: z.ZodOptional<z.ZodString>;
        type: z.ZodLiteral<"resource_link">;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"resource">;
        resource: z.ZodUnion<readonly [z.ZodObject<{
            uri: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            text: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            uri: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            blob: z.ZodString;
        }, z.core.$strip>]>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>]>>>;
    structuredContent: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    isError: z.ZodOptional<z.ZodBoolean>;
}, z.core.$loose>, z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    nextCursor: z.ZodOptional<z.ZodString>;
    tools: z.ZodArray<z.ZodObject<{
        description: z.ZodOptional<z.ZodString>;
        inputSchema: z.ZodObject<{
            type: z.ZodLiteral<"object">;
            properties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodCustom<object, object>>>;
            required: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$catchall<z.ZodUnknown>>;
        outputSchema: z.ZodOptional<z.ZodObject<{
            type: z.ZodLiteral<"object">;
            properties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodCustom<object, object>>>;
            required: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$catchall<z.ZodUnknown>>>;
        annotations: z.ZodOptional<z.ZodObject<{
            title: z.ZodOptional<z.ZodString>;
            readOnlyHint: z.ZodOptional<z.ZodBoolean>;
            destructiveHint: z.ZodOptional<z.ZodBoolean>;
            idempotentHint: z.ZodOptional<z.ZodBoolean>;
            openWorldHint: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>>;
        execution: z.ZodOptional<z.ZodObject<{
            taskSupport: z.ZodOptional<z.ZodEnum<{
                optional: "optional";
                required: "required";
                forbidden: "forbidden";
            }>>;
        }, z.core.$strip>>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
            src: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>>;
        name: z.ZodString;
        title: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$loose>, z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    taskId: z.ZodString;
    status: z.ZodEnum<{
        working: "working";
        input_required: "input_required";
        completed: "completed";
        failed: "failed";
        cancelled: "cancelled";
    }>;
    ttl: z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>;
    createdAt: z.ZodString;
    lastUpdatedAt: z.ZodString;
    pollInterval: z.ZodOptional<z.ZodNumber>;
    statusMessage: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    nextCursor: z.ZodOptional<z.ZodString>;
    tasks: z.ZodArray<z.ZodObject<{
        taskId: z.ZodString;
        status: z.ZodEnum<{
            working: "working";
            input_required: "input_required";
            completed: "completed";
            failed: "failed";
            cancelled: "cancelled";
        }>;
        ttl: z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>;
        createdAt: z.ZodString;
        lastUpdatedAt: z.ZodString;
        pollInterval: z.ZodOptional<z.ZodNumber>;
        statusMessage: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$loose>, z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
        /**
         * If specified, this result is related to the provided task.
         */
        "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    task: z.ZodObject<{
        taskId: z.ZodString;
        status: z.ZodEnum<{
            working: "working";
            input_required: "input_required";
            completed: "completed";
            failed: "failed";
            cancelled: "cancelled";
        }>;
        ttl: z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>;
        createdAt: z.ZodString;
        lastUpdatedAt: z.ZodString;
        pollInterval: z.ZodOptional<z.ZodNumber>;
        statusMessage: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$loose>]>;
export declare class McpError extends Error {
    readonly code: number;
    readonly data?: unknown;
    constructor(code: number, message: string, data?: unknown);
    /**
     * Factory method to create the appropriate error type based on the error code and data
     */
    static fromError(code: number, message: string, data?: unknown): McpError;
}
/**
 * Specialized error type when a tool requires a URL mode elicitation.
 * This makes it nicer for the client to handle since there is specific data to work with instead of just a code to check against.
 */
export declare class UrlElicitationRequiredError extends McpError {
    constructor(elicitations: ElicitRequestURLParams[], message?: string);
    get elicitations(): ElicitRequestURLParams[];
}
type Primitive = string | number | boolean | bigint | null | undefined;
type Flatten<T> = T extends Primitive ? T : T extends Array<infer U> ? Array<Flatten<U>> : T extends Set<infer U> ? Set<Flatten<U>> : T extends Map<infer K, infer V> ? Map<Flatten<K>, Flatten<V>> : T extends object ? {
    [K in keyof T]: Flatten<T[K]>;
} : T;
type Infer<Schema extends z.ZodTypeAny> = Flatten<z.infer<Schema>>;
/**
 * Headers that are compatible with both Node.js and the browser.
 */
export type IsomorphicHeaders = Record<string, string | string[] | undefined>;
/**
 * Information about the incoming request.
 */
export interface RequestInfo {
    /**
     * The headers of the request.
     */
    headers: IsomorphicHeaders;
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
}
export type ProgressToken = Infer<typeof ProgressTokenSchema>;
export type Cursor = Infer<typeof CursorSchema>;
export type Request = Infer<typeof RequestSchema>;
export type RequestMeta = Infer<typeof RequestMetaSchema>;
export type Notification = Infer<typeof NotificationSchema>;
export type Result = Infer<typeof ResultSchema>;
export type RequestId = Infer<typeof RequestIdSchema>;
export type JSONRPCRequest = Infer<typeof JSONRPCRequestSchema>;
export type JSONRPCNotification = Infer<typeof JSONRPCNotificationSchema>;
export type JSONRPCResponse = Infer<typeof JSONRPCResponseSchema>;
export type JSONRPCError = Infer<typeof JSONRPCErrorSchema>;
export type JSONRPCMessage = Infer<typeof JSONRPCMessageSchema>;
export type RequestParams = Infer<typeof BaseRequestParamsSchema>;
export type NotificationParams = Infer<typeof NotificationsParamsSchema>;
export type EmptyResult = Infer<typeof EmptyResultSchema>;
export type CancelledNotificationParams = Infer<typeof CancelledNotificationParamsSchema>;
export type CancelledNotification = Infer<typeof CancelledNotificationSchema>;
export type Icon = Infer<typeof IconSchema>;
export type Icons = Infer<typeof IconsSchema>;
export type BaseMetadata = Infer<typeof BaseMetadataSchema>;
export type Implementation = Infer<typeof ImplementationSchema>;
export type ClientCapabilities = Infer<typeof ClientCapabilitiesSchema>;
export type InitializeRequestParams = Infer<typeof InitializeRequestParamsSchema>;
export type InitializeRequest = Infer<typeof InitializeRequestSchema>;
export type ServerCapabilities = Infer<typeof ServerCapabilitiesSchema>;
export type InitializeResult = Infer<typeof InitializeResultSchema>;
export type InitializedNotification = Infer<typeof InitializedNotificationSchema>;
export type PingRequest = Infer<typeof PingRequestSchema>;
export type Progress = Infer<typeof ProgressSchema>;
export type ProgressNotificationParams = Infer<typeof ProgressNotificationParamsSchema>;
export type ProgressNotification = Infer<typeof ProgressNotificationSchema>;
export type Task = Infer<typeof TaskSchema>;
export type TaskCreationParams = Infer<typeof TaskCreationParamsSchema>;
export type RelatedTaskMetadata = Infer<typeof RelatedTaskMetadataSchema>;
export type CreateTaskResult = Infer<typeof CreateTaskResultSchema>;
export type TaskStatusNotificationParams = Infer<typeof TaskStatusNotificationParamsSchema>;
export type TaskStatusNotification = Infer<typeof TaskStatusNotificationSchema>;
export type GetTaskRequest = Infer<typeof GetTaskRequestSchema>;
export type GetTaskResult = Infer<typeof GetTaskResultSchema>;
export type GetTaskPayloadRequest = Infer<typeof GetTaskPayloadRequestSchema>;
export type ListTasksRequest = Infer<typeof ListTasksRequestSchema>;
export type ListTasksResult = Infer<typeof ListTasksResultSchema>;
export type CancelTaskRequest = Infer<typeof CancelTaskRequestSchema>;
export type CancelTaskResult = Infer<typeof CancelTaskResultSchema>;
export type PaginatedRequestParams = Infer<typeof PaginatedRequestParamsSchema>;
export type PaginatedRequest = Infer<typeof PaginatedRequestSchema>;
export type PaginatedResult = Infer<typeof PaginatedResultSchema>;
export type ResourceContents = Infer<typeof ResourceContentsSchema>;
export type TextResourceContents = Infer<typeof TextResourceContentsSchema>;
export type BlobResourceContents = Infer<typeof BlobResourceContentsSchema>;
export type Resource = Infer<typeof ResourceSchema>;
export type ResourceTemplate = Infer<typeof ResourceTemplateSchema>;
export type ListResourcesRequest = Infer<typeof ListResourcesRequestSchema>;
export type ListResourcesResult = Infer<typeof ListResourcesResultSchema>;
export type ListResourceTemplatesRequest = Infer<typeof ListResourceTemplatesRequestSchema>;
export type ListResourceTemplatesResult = Infer<typeof ListResourceTemplatesResultSchema>;
export type ResourceRequestParams = Infer<typeof ResourceRequestParamsSchema>;
export type ReadResourceRequestParams = Infer<typeof ReadResourceRequestParamsSchema>;
export type ReadResourceRequest = Infer<typeof ReadResourceRequestSchema>;
export type ReadResourceResult = Infer<typeof ReadResourceResultSchema>;
export type ResourceListChangedNotification = Infer<typeof ResourceListChangedNotificationSchema>;
export type SubscribeRequestParams = Infer<typeof SubscribeRequestParamsSchema>;
export type SubscribeRequest = Infer<typeof SubscribeRequestSchema>;
export type UnsubscribeRequestParams = Infer<typeof UnsubscribeRequestParamsSchema>;
export type UnsubscribeRequest = Infer<typeof UnsubscribeRequestSchema>;
export type ResourceUpdatedNotificationParams = Infer<typeof ResourceUpdatedNotificationParamsSchema>;
export type ResourceUpdatedNotification = Infer<typeof ResourceUpdatedNotificationSchema>;
export type PromptArgument = Infer<typeof PromptArgumentSchema>;
export type Prompt = Infer<typeof PromptSchema>;
export type ListPromptsRequest = Infer<typeof ListPromptsRequestSchema>;
export type ListPromptsResult = Infer<typeof ListPromptsResultSchema>;
export type GetPromptRequestParams = Infer<typeof GetPromptRequestParamsSchema>;
export type GetPromptRequest = Infer<typeof GetPromptRequestSchema>;
export type TextContent = Infer<typeof TextContentSchema>;
export type ImageContent = Infer<typeof ImageContentSchema>;
export type AudioContent = Infer<typeof AudioContentSchema>;
export type ToolUseContent = Infer<typeof ToolUseContentSchema>;
export type ToolResultContent = Infer<typeof ToolResultContentSchema>;
export type EmbeddedResource = Infer<typeof EmbeddedResourceSchema>;
export type ResourceLink = Infer<typeof ResourceLinkSchema>;
export type ContentBlock = Infer<typeof ContentBlockSchema>;
export type PromptMessage = Infer<typeof PromptMessageSchema>;
export type GetPromptResult = Infer<typeof GetPromptResultSchema>;
export type PromptListChangedNotification = Infer<typeof PromptListChangedNotificationSchema>;
export type ToolAnnotations = Infer<typeof ToolAnnotationsSchema>;
export type ToolExecution = Infer<typeof ToolExecutionSchema>;
export type Tool = Infer<typeof ToolSchema>;
export type ListToolsRequest = Infer<typeof ListToolsRequestSchema>;
export type ListToolsResult = Infer<typeof ListToolsResultSchema>;
export type CallToolRequestParams = Infer<typeof CallToolRequestParamsSchema>;
export type CallToolResult = Infer<typeof CallToolResultSchema>;
export type CompatibilityCallToolResult = Infer<typeof CompatibilityCallToolResultSchema>;
export type CallToolRequest = Infer<typeof CallToolRequestSchema>;
export type ToolListChangedNotification = Infer<typeof ToolListChangedNotificationSchema>;
export type LoggingLevel = Infer<typeof LoggingLevelSchema>;
export type SetLevelRequestParams = Infer<typeof SetLevelRequestParamsSchema>;
export type SetLevelRequest = Infer<typeof SetLevelRequestSchema>;
export type LoggingMessageNotificationParams = Infer<typeof LoggingMessageNotificationParamsSchema>;
export type LoggingMessageNotification = Infer<typeof LoggingMessageNotificationSchema>;
export type ToolChoice = Infer<typeof ToolChoiceSchema>;
export type ModelHint = Infer<typeof ModelHintSchema>;
export type ModelPreferences = Infer<typeof ModelPreferencesSchema>;
export type SamplingMessageContentBlock = Infer<typeof SamplingMessageContentBlockSchema>;
export type SamplingMessage = Infer<typeof SamplingMessageSchema>;
export type CreateMessageRequestParams = Infer<typeof CreateMessageRequestParamsSchema>;
export type CreateMessageRequest = Infer<typeof CreateMessageRequestSchema>;
export type CreateMessageResult = Infer<typeof CreateMessageResultSchema>;
export type BooleanSchema = Infer<typeof BooleanSchemaSchema>;
export type StringSchema = Infer<typeof StringSchemaSchema>;
export type NumberSchema = Infer<typeof NumberSchemaSchema>;
export type EnumSchema = Infer<typeof EnumSchemaSchema>;
export type UntitledSingleSelectEnumSchema = Infer<typeof UntitledSingleSelectEnumSchemaSchema>;
export type TitledSingleSelectEnumSchema = Infer<typeof TitledSingleSelectEnumSchemaSchema>;
export type LegacyTitledEnumSchema = Infer<typeof LegacyTitledEnumSchemaSchema>;
export type UntitledMultiSelectEnumSchema = Infer<typeof UntitledMultiSelectEnumSchemaSchema>;
export type TitledMultiSelectEnumSchema = Infer<typeof TitledMultiSelectEnumSchemaSchema>;
export type SingleSelectEnumSchema = Infer<typeof SingleSelectEnumSchemaSchema>;
export type MultiSelectEnumSchema = Infer<typeof MultiSelectEnumSchemaSchema>;
export type PrimitiveSchemaDefinition = Infer<typeof PrimitiveSchemaDefinitionSchema>;
export type ElicitRequestParams = Infer<typeof ElicitRequestParamsSchema>;
export type ElicitRequestFormParams = Infer<typeof ElicitRequestFormParamsSchema>;
export type ElicitRequestURLParams = Infer<typeof ElicitRequestURLParamsSchema>;
export type ElicitRequest = Infer<typeof ElicitRequestSchema>;
export type ElicitationCompleteNotificationParams = Infer<typeof ElicitationCompleteNotificationParamsSchema>;
export type ElicitationCompleteNotification = Infer<typeof ElicitationCompleteNotificationSchema>;
export type ElicitResult = Infer<typeof ElicitResultSchema>;
export type ResourceTemplateReference = Infer<typeof ResourceTemplateReferenceSchema>;
/**
 * @deprecated Use ResourceTemplateReference instead
 */
export type ResourceReference = ResourceTemplateReference;
export type PromptReference = Infer<typeof PromptReferenceSchema>;
export type CompleteRequestParams = Infer<typeof CompleteRequestParamsSchema>;
export type CompleteRequest = Infer<typeof CompleteRequestSchema>;
export type CompleteRequestResourceTemplate = ExpandRecursively<CompleteRequest & {
    params: CompleteRequestParams & {
        ref: ResourceTemplateReference;
    };
}>;
export type CompleteRequestPrompt = ExpandRecursively<CompleteRequest & {
    params: CompleteRequestParams & {
        ref: PromptReference;
    };
}>;
export type CompleteResult = Infer<typeof CompleteResultSchema>;
export type Root = Infer<typeof RootSchema>;
export type ListRootsRequest = Infer<typeof ListRootsRequestSchema>;
export type ListRootsResult = Infer<typeof ListRootsResultSchema>;
export type RootsListChangedNotification = Infer<typeof RootsListChangedNotificationSchema>;
export type ClientRequest = Infer<typeof ClientRequestSchema>;
export type ClientNotification = Infer<typeof ClientNotificationSchema>;
export type ClientResult = Infer<typeof ClientResultSchema>;
export type ServerRequest = Infer<typeof ServerRequestSchema>;
export type ServerNotification = Infer<typeof ServerNotificationSchema>;
export type ServerResult = Infer<typeof ServerResultSchema>;
export {};
//# sourceMappingURL=types.d.ts.map