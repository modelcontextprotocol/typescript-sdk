import { Transport } from '../shared/transport.js';
import { JSONRPCMessage, JSONRPCMessageSchema } from '../types.js';

const MAXIMUM_MESSAGE_SIZE = 4 * 1024 * 1024; // 4MB

/**
 * This transport is compatible with Cloudflare Workers and other edge environments
 */
export class SSEEdgeTransport implements Transport {
	private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	readonly stream: ReadableStream<Uint8Array>;
	private closed = false;

	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: (message: JSONRPCMessage) => void;

	/**
	 * Creates a new EdgeSSETransport, which will direct the MPC client to POST messages to messageUrl
	 */
	constructor(
		private messageUrl: string,
		readonly sessionId: string,
	) {
		// Create a readable stream for SSE
		this.stream = new ReadableStream({
			start: (controller) => {
				this.controller = controller;
			},
			cancel: () => {
				this.closed = true;
				this.onclose?.();
			},
		});
	}

	async start(): Promise<void> {
		if (this.closed) {
			throw new Error(
				'SSE transport already closed! If using Server class, note that connect() calls start() automatically.',
			);
		}

		// Make sure the controller exists
		if (!this.controller) {
			throw new Error('Stream controller not initialized');
		}

		// Send the endpoint event
		const endpointMessage = `event: endpoint\ndata: ${encodeURI(this.messageUrl)}?sessionId=${this.sessionId}\n\n`;
		this.controller.enqueue(new TextEncoder().encode(endpointMessage));
	}

	get sseResponse(): Response {
		// Ensure the stream is properly initialized
		if (!this.stream) {
			throw new Error('Stream not initialized');
		}

		// Return a response with the SSE stream
		return new Response(this.stream, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
			},
		});
	}

	/**
	 * Handles incoming Requests
	 */
	async handlePostMessage(req: Request): Promise<Response> {
		if (this.closed || !this.controller) {
			const message = 'SSE connection not established';
			return new Response(message, { status: 500 });
		}

		try {
			const contentType = req.headers.get('content-type') || '';
			if (!contentType.includes('application/json')) {
				throw new Error(`Unsupported content-type: ${contentType}`);
			}

			// Check if the request body is too large
			const contentLength = parseInt(req.headers.get('content-length') || '0', 10);
			if (contentLength > MAXIMUM_MESSAGE_SIZE) {
				throw new Error(`Request body too large: ${contentLength} bytes`);
			}

			// Clone the request before reading the body to avoid stream issues
			const body = await req.json();
			await this.handleMessage(body);
			return new Response('Accepted', { status: 202 });
		} catch (error) {
			this.onerror?.(error as Error);
			return new Response(String(error), { status: 400 });
		}
	}

	/**
	 * Handle a client message, regardless of how it arrived. This can be used to inform the server of messages that arrive via a means different than HTTP POST.
	 */
	async handleMessage(message: unknown): Promise<void> {
		let parsedMessage: JSONRPCMessage;
		try {
			parsedMessage = JSONRPCMessageSchema.parse(message);
		} catch (error) {
			this.onerror?.(error as Error);
			throw error;
		}

		this.onmessage?.(parsedMessage);
	}

	async close(): Promise<void> {
		if (!this.closed && this.controller) {
			this.controller.close();
			this.stream.cancel();
			this.closed = true;
			this.onclose?.();
		}
	}

	async send(message: JSONRPCMessage): Promise<void> {
		if (this.closed || !this.controller) {
			throw new Error('Not connected');
		}

		const messageText = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
		this.controller.enqueue(new TextEncoder().encode(messageText));
	}
}
