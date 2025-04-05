import { Transport } from "./shared/transport.js";
import { JSONRPCMessage, JSONRPCMessageSchema } from "./types.js";

/**
 * Transport implementation that uses the browser's MessageChannel API for communication
 * between different browser contexts (iframes, workers, tabs, windows, etc.).
 */
export class BrowserContextTransport implements Transport {
	private _port: MessagePort;
	private _started = false;
	private _closed = false;
	
	sessionId: string;

	onmessage?: (message: JSONRPCMessage) => void;
	onerror?: (error: Error) => void;
	onclose?: () => void;

	/**
	 * Creates a new BrowserContextTransport using an existing MessagePort.
	 * 
	 * @param port The MessagePort to use for communication.
	 * @param sessionId Optional session ID. If not provided, one will be generated.
	 */
	constructor(port: MessagePort, sessionId?: string) {
		if (!port) {
			throw new Error("MessagePort is required");
		}
		
		this._port = port;
		this.sessionId = sessionId || this.generateId();

		// Set up event listeners
		this._port.onmessage = (event) => {
			try {
				const message = JSONRPCMessageSchema.parse(event.data);
				this.onmessage?.(message);
			} catch (error) {
				const parseError = new Error(`Failed to parse message: ${error}`);
				this.onerror?.(parseError);
			}
		};

		this._port.onmessageerror = (event) => {
			const messageError = new Error(`MessagePort error: ${JSON.stringify(event)}`);
			this.onerror?.(messageError);
		};
	}

	/**
	 * Internal method to generate a session ID.
	 * This is separated so it can be used by static methods.
	 */
	private static generateSessionId(): string {
		// Use the standard crypto API for UUID generation if available
		if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
			return crypto.randomUUID();
		}
		
		// Fallback for environments where crypto.randomUUID is not available
		// Current timestamp as prefix (in base 36 for shorter string)
		const timePrefix = Date.now().toString(36);
		const randomSuffix = Math.random().toString(36).substring(2, 10);
		return `${timePrefix}-${randomSuffix}`;
	}

	/**
	 * Generates a simple unique identifier using timestamp and random values.
	 * This is not a true UUID but is sufficient for session identification.
	 */
	private generateId(): string {
		return BrowserContextTransport.generateSessionId();
	}

	/**
	 * Starts processing messages on the transport.
	 * This starts the underlying MessagePort if it hasn't been started yet.
	 * 
	 * @throws Error if the transport is already started or has been closed.
	 */
	async start(): Promise<void> {
		if (this._started) {
			throw new Error(
				"BrowserContextTransport already started! If using Client or Server class, note that connect() calls start() automatically."
			);
		}
		
		if (this._closed) {
			throw new Error("Cannot start a closed BrowserContextTransport");
		}
		
		this._started = true;
		this._port.start();
	}

	/**
	 * Sends a JSON-RPC message over the MessagePort.
	 * 
	 * @param message The JSON-RPC message to send.
	 * @throws Error if the transport is closed or the message cannot be sent.
	 */
	async send(message: JSONRPCMessage): Promise<void> {
		if (this._closed) {
			throw new Error("Cannot send on a closed BrowserContextTransport");
		}
		
		return new Promise((resolve, reject) => {
			try {
				this._port.postMessage(message);
				resolve();
			} catch (error) {
				const sendError = error instanceof Error ? error : new Error(String(error));
				this.onerror?.(sendError);
				reject(sendError);
			}
		});
	}

	/**
	 * Closes the MessagePort and marks the transport as closed.
	 * This method will call onclose if it's defined.
	 */
	async close(): Promise<void> {
		if (this._closed) {
			return;
		}
		
		this._closed = true;
		this._port.close();
		this.onclose?.();
	}

	/**
	 * Creates a pair of linked BrowserContextTransport instances that can communicate with each other.
	 * One should be passed to a Client and one to a Server.
	 * Both instances will share the same session ID.
	 * 
	 * @returns A tuple containing two BrowserContextTransport instances
	 */
	static createChannelPair(): [BrowserContextTransport, BrowserContextTransport] {
		const channel = new MessageChannel();
		// Generate a single session ID for both transport instances
		const sessionId = BrowserContextTransport.generateSessionId();
		
		return [
			new BrowserContextTransport(channel.port1, sessionId),
			new BrowserContextTransport(channel.port2, sessionId),
		];
	}
} 