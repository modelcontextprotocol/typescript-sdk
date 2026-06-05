import type { JSONRPCMessage, MessageExtraInfo, Transport, TransportSendOptions } from '@modelcontextprotocol/core';

/**
 * In-memory Transport adapter for the legacy bridge.
 *
 * Messages pass by reference — no serialization. The router injects incoming
 * messages via {@linkcode injectIncoming}, and Protocol sends responses via
 * {@linkcode send}, which fires {@linkcode onOutgoing}.
 */
export class BridgeTransport implements Transport {
    onmessage?: ((message: JSONRPCMessage, extra?: MessageExtraInfo) => void) | undefined;
    onclose?: (() => void) | undefined;
    onerror?: ((error: Error) => void) | undefined;
    onOutgoing?: (message: JSONRPCMessage) => void;

    async start(): Promise<void> {}

    /**
     * Injects an incoming message from the legacy router into the Protocol layer.
     */
    injectIncoming(message: JSONRPCMessage, extra?: MessageExtraInfo): void {
        this.onmessage?.(message, extra);
    }

    async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
        this.onOutgoing?.(message);
    }

    async close(): Promise<void> {
        this.onclose?.();
    }
}
