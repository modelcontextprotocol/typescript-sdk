import { SdkError, SdkErrorCode } from '../errors/sdkErrors.js';
import type { JSONObject, Result } from '../types/types.js';
import type { AnySchema, SchemaOutput } from '../util/schema.js';
import type { BaseContext, NotificationOptions, RequestOptions } from './protocol.js';

/**
 * The subset of `Client`/`Server` that {@linkcode ExtensionHandle} delegates to.
 *
 * @internal
 */
export interface ExtensionHost<ContextT extends BaseContext> {
    setCustomRequestHandler<P extends AnySchema>(
        method: string,
        paramsSchema: P,
        handler: (params: SchemaOutput<P>, ctx: ContextT) => Result | Promise<Result>
    ): void;
    setCustomNotificationHandler<P extends AnySchema>(
        method: string,
        paramsSchema: P,
        handler: (params: SchemaOutput<P>) => void | Promise<void>
    ): void;
    sendCustomRequest<R extends AnySchema>(
        method: string,
        params: Record<string, unknown> | undefined,
        resultSchema: R,
        options?: RequestOptions
    ): Promise<SchemaOutput<R>>;
    sendCustomNotification(method: string, params?: Record<string, unknown>, options?: NotificationOptions): Promise<void>;
}

/**
 * Options for {@linkcode @modelcontextprotocol/client!client/client.Client#extension | Client.extension} /
 * {@linkcode @modelcontextprotocol/server!server/server.Server#extension | Server.extension}.
 */
export interface ExtensionOptions<P extends AnySchema> {
    /**
     * Schema to validate the peer's `capabilities.extensions[id]` blob against. When provided,
     * {@linkcode ExtensionHandle.getPeerSettings | getPeerSettings()} returns the parsed value
     * (typed as `SchemaOutput<P>`) or `undefined` if the peer's blob does not match.
     */
    peerSchema: P;
}

/**
 * A scoped handle for registering and sending custom JSON-RPC methods belonging to a single
 * SEP-2133 extension.
 *
 * Obtained via {@linkcode @modelcontextprotocol/client!client/client.Client#extension | Client.extension} or
 * {@linkcode @modelcontextprotocol/server!server/server.Server#extension | Server.extension}. Creating a handle
 * declares the extension in `capabilities.extensions[id]` so it is advertised during `initialize`.
 * Handlers registered through the handle are thus structurally guaranteed to belong to a declared
 * extension.
 *
 * Send-side methods respect `enforceStrictCapabilities`: when strict, sending throws if the peer
 * did not advertise the same extension ID; when lax (the default), sends proceed regardless and
 * {@linkcode getPeerSettings} returns `undefined`.
 */
export class ExtensionHandle<Local extends JSONObject, Peer = JSONObject, ContextT extends BaseContext = BaseContext> {
    /**
     * @internal Use `Client.extension()` or `Server.extension()` to construct.
     */
    constructor(
        private readonly _host: ExtensionHost<ContextT>,
        /** The SEP-2133 extension identifier (e.g. `io.modelcontextprotocol/ui`). */
        public readonly id: string,
        /** The local settings object advertised in `capabilities.extensions[id]`. */
        public readonly settings: Local,
        private readonly _getPeerExtensionSettings: () => JSONObject | undefined,
        private readonly _getPeerCapabilitiesPresent: () => boolean,
        private readonly _getEnforceStrictCapabilities: () => boolean,
        private readonly _peerSchema?: AnySchema
    ) {}

    /**
     * Returns the peer's `capabilities.extensions[id]` settings, or `undefined` if the peer did not
     * advertise this extension or (when `peerSchema` was provided) if the peer's blob fails
     * validation. Reads the current peer capabilities on each call (no caching), so it reflects
     * reconnects.
     */
    getPeerSettings(): Peer | undefined {
        const raw = this._getPeerExtensionSettings();
        if (raw === undefined) {
            return undefined;
        }
        if (this._peerSchema === undefined) {
            return raw as Peer;
        }
        const result = this._peerSchema['~standard'].validate(raw);
        if (result instanceof Promise) {
            console.warn(
                `[ExtensionHandle] peerSchema for extension "${this.id}" has async validation; getPeerSettings() returns the raw (unvalidated) blob.`
            );
            return raw as Peer;
        }
        if (result.issues && result.issues.length > 0) {
            console.warn(
                `[ExtensionHandle] Peer's capabilities.extensions["${this.id}"] failed schema validation: ${result.issues.map(i => i.message).join(', ')}`
            );
            return undefined;
        }
        return (result as { value: Peer }).value;
    }

    /**
     * Registers a request handler for a custom method belonging to this extension. Delegates to
     * the underlying `setCustomRequestHandler`; the collision guard
     * against standard MCP methods applies.
     */
    setRequestHandler<P extends AnySchema>(
        method: string,
        paramsSchema: P,
        handler: (params: SchemaOutput<P>, ctx: ContextT) => Result | Promise<Result>
    ): void {
        this._host.setCustomRequestHandler(method, paramsSchema, handler);
    }

    /**
     * Registers a notification handler for a custom method belonging to this extension. Delegates
     * to the underlying `setCustomNotificationHandler`.
     */
    setNotificationHandler<P extends AnySchema>(
        method: string,
        paramsSchema: P,
        handler: (params: SchemaOutput<P>) => void | Promise<void>
    ): void {
        this._host.setCustomNotificationHandler(method, paramsSchema, handler);
    }

    /**
     * Sends a custom request belonging to this extension and waits for a response.
     *
     * When `enforceStrictCapabilities` is enabled and the peer did not advertise
     * `capabilities.extensions[id]`, throws {@linkcode SdkError} with
     * {@linkcode SdkErrorCode.CapabilityNotSupported}.
     */
    async sendRequest<R extends AnySchema>(
        method: string,
        params: Record<string, unknown> | undefined,
        resultSchema: R,
        options?: RequestOptions
    ): Promise<SchemaOutput<R>> {
        this._assertPeerCapability(method);
        return this._host.sendCustomRequest(method, params, resultSchema, options);
    }

    /**
     * Sends a custom notification belonging to this extension.
     *
     * When `enforceStrictCapabilities` is enabled and the peer did not advertise
     * `capabilities.extensions[id]`, throws {@linkcode SdkError} with
     * {@linkcode SdkErrorCode.CapabilityNotSupported}.
     */
    async sendNotification(method: string, params?: Record<string, unknown>, options?: NotificationOptions): Promise<void> {
        this._assertPeerCapability(method);
        return this._host.sendCustomNotification(method, params, options);
    }

    private _assertPeerCapability(method: string): void {
        // If peer capabilities are not yet populated (pre-connect), defer to the
        // NotConnected error from the underlying send path rather than misreporting
        // CapabilityNotSupported.
        if (!this._getPeerCapabilitiesPresent()) return;
        if (this._getEnforceStrictCapabilities() && this._getPeerExtensionSettings() === undefined) {
            throw new SdkError(
                SdkErrorCode.CapabilityNotSupported,
                `Peer does not support extension "${this.id}" (required for ${method})`
            );
        }
    }
}
