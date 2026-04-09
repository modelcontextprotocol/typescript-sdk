import { SdkError, SdkErrorCode } from '../errors/sdkErrors.js';
import type { JSONObject, Result } from '../types/types.js';
import type { AnySchema, SchemaOutput } from '../util/schema.js';
import { parseSchema } from '../util/schema.js';
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
 * Options for {@linkcode Client.extension} / {@linkcode Server.extension}.
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
 * Obtained via {@linkcode Client.extension} or {@linkcode Server.extension}. Creating a handle
 * declares the extension in `capabilities.extensions[id]` so it is advertised during `initialize`.
 * Handlers registered through the handle are thus structurally guaranteed to belong to a declared
 * extension.
 *
 * Send-side methods respect `enforceStrictCapabilities`: when strict, sending throws if the peer
 * did not advertise the same extension ID; when lax (the default), sends proceed regardless and
 * {@linkcode getPeerSettings} returns `undefined`.
 */
export class ExtensionHandle<Local extends JSONObject, Peer = JSONObject, ContextT extends BaseContext = BaseContext> {
    private _peerSettingsCache?: { value: Peer | undefined };

    /**
     * @internal Use {@linkcode Client.extension} or {@linkcode Server.extension} to construct.
     */
    constructor(
        private readonly _host: ExtensionHost<ContextT>,
        /** The SEP-2133 extension identifier (e.g. `io.modelcontextprotocol/ui`). */
        public readonly id: string,
        /** The local settings object advertised in `capabilities.extensions[id]`. */
        public readonly settings: Local,
        private readonly _getPeerExtensionSettings: () => JSONObject | undefined,
        private readonly _enforceStrictCapabilities: boolean,
        private readonly _peerSchema?: AnySchema
    ) {}

    /**
     * Returns the peer's `capabilities.extensions[id]` settings, or `undefined` if the peer did not
     * advertise this extension or (when `peerSchema` was provided) if the peer's blob fails
     * validation. The result is parsed once and cached.
     */
    getPeerSettings(): Peer | undefined {
        if (this._peerSettingsCache) {
            return this._peerSettingsCache.value;
        }
        const raw = this._getPeerExtensionSettings();
        if (raw === undefined) {
            // Don't cache: peer may not have connected yet.
            return undefined;
        }
        let value: Peer | undefined;
        if (this._peerSchema === undefined) {
            value = raw as Peer;
        } else {
            const parsed = parseSchema(this._peerSchema, raw);
            if (parsed.success) {
                value = parsed.data as Peer;
            } else {
                console.warn(
                    `[ExtensionHandle] Peer's capabilities.extensions["${this.id}"] failed schema validation: ${parsed.error.message}`
                );
                value = undefined;
            }
        }
        this._peerSettingsCache = { value };
        return value;
    }

    /**
     * Registers a request handler for a custom method belonging to this extension. Delegates to
     * {@linkcode Protocol.setCustomRequestHandler | setCustomRequestHandler}; the collision guard
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
     * to {@linkcode Protocol.setCustomNotificationHandler | setCustomNotificationHandler}.
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
    sendRequest<R extends AnySchema>(
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
    sendNotification(method: string, params?: Record<string, unknown>, options?: NotificationOptions): Promise<void> {
        this._assertPeerCapability(method);
        return this._host.sendCustomNotification(method, params, options);
    }

    private _assertPeerCapability(method: string): void {
        if (this._enforceStrictCapabilities && this._getPeerExtensionSettings() === undefined) {
            throw new SdkError(
                SdkErrorCode.CapabilityNotSupported,
                `Peer does not support extension "${this.id}" (required for ${method})`
            );
        }
    }
}
