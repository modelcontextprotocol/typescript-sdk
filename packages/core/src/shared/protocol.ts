/**
 * v1-compat module. The types live in {@link ./context.ts}; the runtime lives in
 * {@link Dispatcher} + {@link StreamDriver}. The {@link Protocol} class here is
 * a thin wrapper that composes those two so that v1 code subclassing `Protocol`
 * keeps working.
 */

import { SdkError, SdkErrorCode } from '../errors/sdkErrors.js';
import type {
    JSONRPCRequest,
    MessageExtraInfo,
    Notification,
    NotificationMethod,
    NotificationTypeMap,
    Request,
    RequestMethod,
    RequestTypeMap,
    Result,
    ResultTypeMap
} from '../types/index.js';
import { getResultSchema, SUPPORTED_PROTOCOL_VERSIONS } from '../types/index.js';
import type { AnySchema, SchemaOutput } from '../util/schema.js';
import type { BaseContext, NotificationOptions, Outbound, ProtocolOptions, RequestEnv, RequestOptions } from './context.js';
import type { DispatchMiddleware } from './dispatcher.js';
import { Dispatcher } from './dispatcher.js';
import { StreamDriver } from './streamDriver.js';
import { NullTaskManager, TaskManager } from './taskManager.js';
import type { Transport } from './transport.js';

export * from './context.js';

/**
 * v1-compat MCP protocol base. New code should use {@linkcode McpServer} (which
 * extends {@linkcode Dispatcher}) or {@linkcode Client}. This class composes a
 * {@linkcode Dispatcher} (handler registry + dispatch) and a
 * {@linkcode StreamDriver} (per-connection state) to preserve the v1 surface.
 */
export abstract class Protocol<ContextT extends BaseContext> {
    private _outbound?: Outbound;
    private readonly _dispatcher: Dispatcher<ContextT>;

    protected _supportedProtocolVersions: string[];

    /**
     * Callback for when the connection is closed for any reason.
     *
     * This is invoked when {@linkcode Protocol.close | close()} is called as well.
     */
    onclose?: () => void;

    /**
     * Callback for when an error occurs.
     *
     * Note that errors are not necessarily fatal; they are used for reporting any kind of exceptional condition out of band.
     */
    onerror?: (error: Error) => void;

    constructor(private _options?: ProtocolOptions) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias, unicorn/no-this-assignment
        const self = this;
        this._dispatcher = new (class extends Dispatcher<ContextT> {
            protected override buildContext(base: BaseContext, env: RequestEnv & { _transportExtra?: MessageExtraInfo }): ContextT {
                return self.buildContext(base, env._transportExtra);
            }
        })();
        this._supportedProtocolVersions = _options?.supportedProtocolVersions ?? SUPPORTED_PROTOCOL_VERSIONS;
        this._ownTaskManager = _options?.tasks ? new TaskManager(_options.tasks) : new NullTaskManager();
        this._ownTaskManager.attachTo(this._dispatcher, {
            channel: () => this._outbound,
            reportError: e => this.onerror?.(e),
            enforceStrictCapabilities: this._options?.enforceStrictCapabilities === true,
            assertTaskCapability: m => this.assertTaskCapability(m),
            assertTaskHandlerCapability: m => this.assertTaskHandlerCapability(m)
        });
    }

    private readonly _ownTaskManager: TaskManager;

    /** Register a {@linkcode DispatchMiddleware} on the inner dispatcher. */
    use(mw: DispatchMiddleware): this {
        this._dispatcher.use(mw);
        return this;
    }

    // ───────────────────────────────────────────────────────────────────────
    // Subclass hooks (v1 signatures)
    // ───────────────────────────────────────────────────────────────────────

    /**
     * Subclasses override to enrich the handler context. v1 signature; the
     * {@linkcode MessageExtraInfo} is forwarded from the transport.
     */
    protected buildContext(ctx: BaseContext, _transportInfo?: MessageExtraInfo): ContextT {
        return ctx as ContextT;
    }

    /** Override to enforce capabilities. Default is a no-op. */
    protected assertCapabilityForMethod(_method: RequestMethod): void {}
    /** Override to enforce capabilities. Default is a no-op. */
    protected assertNotificationCapability(_method: NotificationMethod): void {}
    /** Override to enforce capabilities. Default is a no-op. */
    protected assertRequestHandlerCapability(_method: string): void {}
    /** Override to enforce capabilities. Default is a no-op. */
    protected assertTaskCapability(_method: string): void {}
    /** Override to enforce capabilities. Default is a no-op. */
    protected assertTaskHandlerCapability(_method: string): void {}

    // ───────────────────────────────────────────────────────────────────────
    // Handler registration (delegates to Dispatcher)
    // ───────────────────────────────────────────────────────────────────────

    setRequestHandler<M extends RequestMethod>(
        method: M,
        handler: (request: RequestTypeMap[M], ctx: ContextT) => Result | Promise<Result>
    ): void {
        this.assertRequestHandlerCapability(method);
        this._dispatcher.setRequestHandler(method, handler);
    }

    removeRequestHandler(method: string): void {
        this._dispatcher.removeRequestHandler(method);
    }

    assertCanSetRequestHandler(method: string): void {
        this._dispatcher.assertCanSetRequestHandler(method);
    }

    setNotificationHandler<M extends NotificationMethod>(
        method: M,
        handler: (notification: NotificationTypeMap[M]) => void | Promise<void>
    ): void {
        this._dispatcher.setNotificationHandler(method, handler);
    }

    removeNotificationHandler(method: string): void {
        this._dispatcher.removeNotificationHandler(method);
    }

    get fallbackRequestHandler(): ((request: JSONRPCRequest, ctx: ContextT) => Promise<Result>) | undefined {
        return this._dispatcher.fallbackRequestHandler;
    }
    set fallbackRequestHandler(h) {
        this._dispatcher.fallbackRequestHandler = h;
    }

    get fallbackNotificationHandler(): ((notification: Notification) => Promise<void>) | undefined {
        return this._dispatcher.fallbackNotificationHandler;
    }
    set fallbackNotificationHandler(h) {
        this._dispatcher.fallbackNotificationHandler = h;
    }

    // ───────────────────────────────────────────────────────────────────────
    // Connection (delegates to StreamDriver)
    // ───────────────────────────────────────────────────────────────────────

    /**
     * Connects to a transport. Creates a fresh {@linkcode StreamDriver} per call,
     * so re-connecting (the v1 stateful-SHTTP pattern) is supported.
     */
    async connect(transport: Transport): Promise<void> {
        const driver = new StreamDriver(this._dispatcher, transport, {
            supportedProtocolVersions: this._supportedProtocolVersions,
            debouncedNotificationMethods: this._options?.debouncedNotificationMethods,
            buildEnv: (extra, base) => ({ ...base, _transportExtra: extra }),
            taskManager: this._ownTaskManager
        });
        this._outbound = driver;
        driver.onclose = () => {
            if (this._outbound === driver) this._outbound = undefined;
            this.onclose?.();
        };
        driver.onerror = error => this.onerror?.(error);
        await driver.start();
    }

    /**
     * Closes the connection.
     */
    async close(): Promise<void> {
        await this._outbound?.close();
    }

    /** @deprecated Protocol is no longer coupled to a specific transport. Returns the underlying pipe only when connected via {@linkcode StreamDriver}. */
    get transport(): Transport | undefined {
        return (this._outbound as { pipe?: Transport } | undefined)?.pipe;
    }

    get taskManager(): TaskManager {
        return this._ownTaskManager;
    }

    /**
     * Sends a request and waits for a response.
     */
    request<M extends RequestMethod>(
        request: { method: M; params?: Record<string, unknown> },
        options?: RequestOptions
    ): Promise<ResultTypeMap[M]> {
        const resultSchema = getResultSchema(request.method);
        return this._requestWithSchema(request as Request, resultSchema, options) as Promise<ResultTypeMap[M]>;
    }

    /**
     * Sends a request and waits for a response, using the provided schema for validation.
     */
    protected _requestWithSchema<T extends AnySchema>(
        request: Request,
        resultSchema: T,
        options?: RequestOptions
    ): Promise<SchemaOutput<T>> {
        if (!this._outbound) {
            return Promise.reject(new SdkError(SdkErrorCode.NotConnected, 'Not connected'));
        }
        if (this._options?.enforceStrictCapabilities === true) {
            this.assertCapabilityForMethod(request.method as RequestMethod);
        }
        return this._outbound.request(request, resultSchema, options);
    }

    /**
     * Emits a notification, which is a one-way message that does not expect a response.
     */
    async notification(notification: Notification, options?: NotificationOptions): Promise<void> {
        if (!this._outbound) {
            throw new SdkError(SdkErrorCode.NotConnected, 'Not connected');
        }
        this.assertNotificationCapability(notification.method as NotificationMethod);
        return this._outbound.notification(notification, options);
    }

    // ───────────────────────────────────────────────────────────────────────
    // Test-compat accessors. v1 tests reach into these privates; proxy them to
    // the driver so the test corpus keeps passing without rewrites.
    // ───────────────────────────────────────────────────────────────────────

    /** @internal v1 tests reach into this. */
    protected get _taskManager(): TaskManager {
        return this._ownTaskManager;
    }

    /** @internal v1 tests reach into this. */
    protected get _responseHandlers(): Map<number, (r: unknown) => void> | undefined {
        return (this._outbound as unknown as { _responseHandlers?: Map<number, (r: unknown) => void> })?._responseHandlers;
    }
}
