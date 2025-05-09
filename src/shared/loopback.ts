/**
 * LoopbackTransport: Custom MCP Transport Implementation
 *
 * This custom transport complies with the MCP custom transport requirements:
 *
 * - The JSON-RPC message format (for requests, responses, and notifications) is preserved,
 *   ensuring that all communication over this transport adheres to MCP's expected message schema.
 *
 * - The transport lifecycle follows MCP's guidelines:
 *   - Connection Establishment: The `connect()` method creates a bidirectional binding between two transport instances.
 *   - Message Exchange: The `send()` method delivers messages asynchronously using a callback mechanism.
 *   - Teardown: The `close()` method gracefully terminates the connection, ensuring all associated resources are released.
 *
 * Example Usage:
 *
 *   // Create your normal server and client instances.
 *   const server = new Server( ...server options... );
 *   const client = new Client( ...client options... );
 *
 *   // Create transport instances.
 *   const clientTransport = new LoopbackTransport();
 *   const serverTransport = new LoopbackTransport();
 *
 *   // Connect the transports.
 *   clientTransport.connect(serverTransport);
 *
 *   // Attach the transport to the server and client.
 *   await server.connect(serverTransport);
 *   await client.connect(clientTransport);
 *
 *   // At this point the client is connected to the server via the loopback transport.
 */
import {JSONRPCMessage, JSONRPCNotification, JSONRPCRequest, JSONRPCResponse} from "../types.js";
import {Transport} from "./transport.js";

type Message = JSONRPCRequest | JSONRPCResponse | JSONRPCNotification;
export type ClientOrServer = 'client' | 'server' | 'unknown';
export type LoopbackTransportConfig = {
    /** If you give this debugging is easier, and it is included in the debug log. Should be client or server */
    name?: ClientOrServer
    /** If true then debug messages will appear in the console */
    debug?: boolean
    /** If true then messages are 'serialised/deserialised'. This means the server gets a totally different copy. While this slows things down it more closely duplicates the behavior of the other transports*/
    stringifyMessage?: boolean
}

export class LoopbackTransport implements Transport {
    private _config: LoopbackTransportConfig | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any  -- We really want any here. It's 'just debugging' We know almost nothing about what is passed, and don't need to
    debug: (...args: any[]) => void = (...args) => {
        if (this._config?.debug)
            if (this._config.name)
                console.log(`LoopbackTransport`, this._config?.name, args)
            else
                console.log(`LoopbackTransport`, args)
    }

    constructor(config: LoopbackTransportConfig = {name: 'unknown'}) {
        this._config = config;
    }


    /**
     * Handlers set by the protocol implementation.
     * MCP requires that the transport invoke these callbacks appropriately to manage the lifecycle:
     * - onmessage: Called when a JSON-RPC message (request, response, or notification) is received.
     * - onclose: Called when the transport is closed.
     * - onerror: Called when an error occurs during transport operations.
     */
    onmessage?: (msg: JSONRPCMessage) => void;
    onclose?: () => void;
    onerror?: (error: Error) => void;

    /**
     * For debugging and logging purposes, each connection is assigned a unique sessionId.
     * This helps identify MCP client/session pairs in multi-connection scenarios.
     */
    sessionId: string | undefined = undefined;

    // Direct reference to the connected peer transport.
    private peer?: LoopbackTransport;

    /**
     * Establishes a bidirectional connection with another LoopbackTransport instance.
     *
     * @param peer - The peer transport to connect to.
     * @throws Error if either transport is already connected.
     *
     * The connection establishment pattern is documented as follows:
     * - Both transports receive the same sessionId.
     * - The instance's peer references are mutually set.
     */
    connect(peer: LoopbackTransport) {
        this.debug(this, peer);
        // Safety check: ensure that neither transport is already connected.
        if (!peer) throw new Error("Peer argument is not valid" + `${JSON.stringify(peer)}`);
        if (this.peer || peer.peer) throw new Error("One of the transports is already connected");
        this.sessionId = generateSessionId();
        peer.sessionId = this.sessionId;
        this.peer = peer;
        peer.peer = this;
    }

    /**
     * Prepares the transport for operation by validating that it has an onmessage handler
     * and that it is connected to a peer. This method complies with MCP's lifecycle requirements.
     *
     * @throws Error if onmessage is not registered or if there is no peer connection.
     */
    async start(): Promise<void> {
        this.debug('start', this);
        if (this.onmessage === undefined) throw new Error('Cannot start without being registered to a protocol');
        if (this.peer === undefined) throw new Error('Cannot start without connect');
        // Transport is now ready for message exchange.
    }

    /**
     * Sends a JSON-RPC message (request, response, or notification) to the connected peer.
     *
     * MCP requires that the JSON-RPC message format is preserved in transmission.
     * This implementation delivers the message asynchronously to simulate network delay.
     *
     * @param message - The JSON-RPC message to send.
     * @throws Error if the peer transport's onmessage handler is not set.
     */
    async send(message: Message): Promise<void> {
        this.debug('send', message);
        if (!this.peer?.onmessage) {
            // If this error is thrown, it indicates that the server transport has not been connected to the server
            // You need to execute some code like 'server.connect(serverTransport)' before this is called.throw new Error("Peer transport has no onmessage handler set. Have connected the server to the server transport?");
            throw new Error("Peer transport has no onmessage handler set. Have you connected the server to the server transport?");
        }
        // Asynchronously deliver the message to simulate a real-world transport.
        try {
            if (this._config?.stringifyMessage) {
                message = JSON.parse(JSON.stringify(message));
            }
        } catch (e) {
            const newError = new Error(`Error stringifying message: ${e}`);
            this.onerror?.(newError);
            throw newError;
        }
        setTimeout(() => this.peer!.onmessage!(message), 0);
    }

    /**
     * Closes the transport, calling the onclose handler and cleaning up the session state.
     *
     * In line with MCP lifecycle requirements, closing a transport should release all resources
     * and propagate the close event to the connected peer.
     */
    async close(): Promise<void> {
        this.debug('close')
        if (!this.peer) {
            this.debug('close called, but already closed. Not an error');
            return
        }
        this.onclose?.();
        this.sessionId = undefined;
        const peer = this.peer;
        this.peer = undefined;
        // Propagate the close event to the peer, if any.
        peer?.close();
    }
}

/**
 * Generates a unique session ID.
 *
 * Example usage: const id = generateSessionId()
 *
 * This helper function first attempts to use the secure native `crypto.randomUUID` API
 * (available in Node.js and modern browsers). If unavailable, it falls back to a simple
 * concatenation of the current timestamp (provided by the `now` function) and a random
 * number (provided by the `random` function). This approach is sufficient for creating a unique,
 * non-user-facing session identifier.
 *
 * The parameters only exist to help with testing. They should only be used when testing (and
 * they make the tests trivial instead of awkward).
 *
 * @param uuid - A function that returns a random string (usually a uuid). This might not exist in older browsers.
 *               Defaults to `crypto.randomUUID`.
 * @param now - A function that returns the current timestamp in milliseconds. Defaults to `Date.now`.
 * @param random - A function that returns a random number between 0 and 1. Defaults to `Math.random`.
 * @returns A unique session identifier string.
 *
 */
export function generateSessionId(
    uuid: () => string | undefined = () => crypto?.randomUUID(),
    now: () => number = Date.now,
    random: () => number = Math.random,
): string {
    const result = uuid();
    if (result) return result;
    // Fallback: generate a session ID using the provided now and random functions.
    return `${now()}${Math.floor(random() * 1e8)}`;
}
