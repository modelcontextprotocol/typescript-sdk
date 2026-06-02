import type { Readable, Writable } from 'node:stream';

import type { JSONRPCMessage, JSONRPCRequest, StatelessHandlers, Transport } from '@modelcontextprotocol/core';
import {
    INTERNAL_ERROR,
    isJSONRPCRequest,
    isStatefulProtocolVersion,
    PROTOCOL_VERSION_META_KEY,
    ReadBuffer,
    serializeMessage,
    SUPPORTED_PROTOCOL_VERSIONS
} from '@modelcontextprotocol/core';
import { process } from '@modelcontextprotocol/server/_shims';

/**
 * Server transport for stdio: this communicates with an MCP client by reading from the current process' `stdin` and writing to `stdout`.
 *
 * This transport is only available in Node.js environments.
 *
 * @example
 * ```ts source="./stdio.examples.ts#StdioServerTransport_basicUsage"
 * const server = new McpServer({ name: 'my-server', version: '1.0.0' });
 * const transport = new StdioServerTransport();
 * await server.connect(transport);
 * ```
 */
export class StdioServerTransport implements Transport {
    private _readBuffer: ReadBuffer = new ReadBuffer();
    private _started = false;
    private _closed = false;
    private _supportedProtocolVersions: string[] = SUPPORTED_PROTOCOL_VERSIONS;

    /**
     * Hook for the stateless (draft-protocol-version) request path. Set
     * internally by `Server.connect()` so this transport can route requests
     * claiming a draft protocol version to the server's stateless dispatch
     * instead of the `onmessage` path. Optional on the {@linkcode Transport}
     * contract; only concrete server transports read it.
     * @internal
     */
    private _statelessHandlers?: StatelessHandlers;

    constructor(
        private _stdin: Readable = process.stdin,
        private _stdout: Writable = process.stdout
    ) {}

    /**
     * Sets the supported protocol versions for stateless routing.
     * Called by the server during {@linkcode server/server.Server.connect | connect()} to pass its supported versions.
     */
    setSupportedProtocolVersions(versions: string[]): void {
        this._supportedProtocolVersions = versions;
    }

    /** @internal */
    setStatelessHandlers(handlers: StatelessHandlers): void {
        this._statelessHandlers = handlers;
    }

    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    // Arrow functions to bind `this` properly, while maintaining function identity.
    _ondata = (chunk: Buffer) => {
        this._readBuffer.append(chunk);
        this.processReadBuffer();
    };
    _onerror = (error: Error) => {
        this.onerror?.(error);
    };
    _onstdouterror = (error: Error) => {
        this.onerror?.(error);
        this.close().catch(() => {
            // Ignore errors during close — we're already in an error path
        });
    };

    /**
     * Starts listening for messages on `stdin`.
     */
    async start(): Promise<void> {
        if (this._started) {
            throw new Error(
                'StdioServerTransport already started! If using Server class, note that connect() calls start() automatically.'
            );
        }

        this._started = true;
        this._stdin.on('data', this._ondata);
        this._stdin.on('error', this._onerror);
        this._stdout.on('error', this._onstdouterror);
    }

    private processReadBuffer() {
        while (true) {
            try {
                const message = this._readBuffer.readMessage();
                if (message === null) {
                    break;
                }

                // stdio has no session header: a request's _meta version claim is the routing
                // signal, dual-keyed on the server opting in to non-stateful versions. Requests only.
                const handlers = this._statelessHandlers;
                if (handlers && isJSONRPCRequest(message) && this.claimsRoutableStatelessVersion(message)) {
                    void this.dispatchStatelessRequest(message, handlers);
                } else {
                    this.onmessage?.(message);
                }
            } catch (error) {
                this.onerror?.(error as Error);
            }
        }
    }

    /**
     * Whether `request` claims (via `params._meta`, see
     * {@linkcode PROTOCOL_VERSION_META_KEY}) a non-stateful (per-request)
     * protocol version AND this transport's server has opted in by listing at
     * least one such version as supported — the same dual-key rule the
     * Streamable HTTP transport applies to sessionless requests. Claims of
     * versions the server does not list are still routed when it has opted in:
     * the dispatch answers them with `-32004` (UnsupportedProtocolVersionError).
     */
    private claimsRoutableStatelessVersion(request: JSONRPCRequest): boolean {
        const version = request.params?._meta?.[PROTOCOL_VERSION_META_KEY];
        return (
            typeof version === 'string' &&
            !isStatefulProtocolVersion(version) &&
            this._supportedProtocolVersions.some(supported => !isStatefulProtocolVersion(supported))
        );
    }

    /**
     * Serves one request routed to the stateless dispatch path: forwards it to
     * the installed dispatch handler and writes the returned response to
     * stdout. Request-scoped notifications the handler emits are written to
     * stdout before the response. Detached from the read loop (request→response,
     * never blocks `onmessage` traffic); never throws — `dispatch()` maps
     * handler failures to error responses, so a rejection is an internal fault
     * answered with a generic error that leaks nothing, the request id echoed.
     */
    private async dispatchStatelessRequest(request: JSONRPCRequest, handlers: StatelessHandlers): Promise<void> {
        try {
            const response = await handlers.dispatch(request, {
                sendNotification: notification => this.send(notification)
            });
            await this.send(response);
        } catch (error) {
            this.onerror?.(error as Error);
            try {
                await this.send({ jsonrpc: '2.0', id: request.id, error: { code: INTERNAL_ERROR, message: 'Internal error' } });
            } catch (sendError) {
                this.onerror?.(sendError as Error);
            }
        }
    }

    async close(): Promise<void> {
        if (this._closed) {
            return;
        }
        this._closed = true;

        // Remove our event listeners first
        this._stdin.off('data', this._ondata);
        this._stdin.off('error', this._onerror);
        this._stdout.off('error', this._onstdouterror);

        // Check if we were the only data listener
        const remainingDataListeners = this._stdin.listenerCount('data');
        if (remainingDataListeners === 0) {
            // Only pause stdin if we were the only listener
            // This prevents interfering with other parts of the application that might be using stdin
            this._stdin.pause();
        }

        // Clear the buffer and notify closure
        this._readBuffer.clear();
        this.onclose?.();
    }

    send(message: JSONRPCMessage): Promise<void> {
        if (this._closed) {
            return Promise.reject(new Error('StdioServerTransport is closed'));
        }
        return new Promise((resolve, reject) => {
            const json = serializeMessage(message);

            let settled = false;
            const onError = (error: Error) => {
                if (settled) return;
                settled = true;
                this._stdout.off('error', onError);
                this._stdout.off('drain', onDrain);
                reject(error);
            };
            const onDrain = () => {
                if (settled) return;
                settled = true;
                this._stdout.off('error', onError);
                this._stdout.off('drain', onDrain);
                resolve();
            };

            this._stdout.once('error', onError);

            if (this._stdout.write(json)) {
                if (settled) return;
                settled = true;
                this._stdout.off('error', onError);
                resolve();
            } else if (!settled) {
                this._stdout.once('drain', onDrain);
            }
        });
    }
}
