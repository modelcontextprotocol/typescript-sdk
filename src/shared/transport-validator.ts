/*

Proposal:
- Validate streamable http inside transport code itself.
- Validate protocol-level messages as a wrapper around Transport interface.

*/

import { JSONRPCMessage, MessageExtraInfo } from "src/types.js"
import { Transport, TransportSendOptions } from "./transport.js"

export type ProtocolLog = {
    version?: string,
    // startTimestamp?: number,
    // endTimestamp?: number,
    events: ({
        type: 'sent',
        timestamp: number,
        message: JSONRPCMessage,
        options?: TransportSendOptions,
    } | {
        type: 'received',
        timestamp: number,
        message: JSONRPCMessage,
        extra?: MessageExtraInfo,
    } | {
        type: 'start' | 'close',
        timestamp: number,
    } | {
        type: 'error',
        timestamp: number,
        error: Error,
    })[],
};

export type ProtocolChecker = (log: ProtocolLog) => void;

// type StreamableHttpLog = {

// }


class ProtocolValidator implements Transport {
    private log: ProtocolLog = {
        events: []
    }

    constructor(private transport: Transport, private checkers: ProtocolChecker[], private now = () => Date.now()) {
        transport.onmessage = (message, extra) => {
            this.addEvent({
                type: 'received',
                timestamp: this.now(),
                message,
                extra,
            });
            this.onmessage?.(message, extra);
        };
        transport.onerror = (error) => {
            this.addEvent({
                type: 'error',
                timestamp: this.now(),
                error,
            });
            this.onerror?.(error);
        };
        transport.onclose = () => {
            this.addEvent({
                type: 'close',
                timestamp: this.now(),
            });
            this.onclose?.();
        };
    }

    private check() {
        for (const checker of this.checkers) {
            checker(this.log);
        }
    }

    private addEvent(event: ProtocolLog['events'][number]) {
        this.log.events.push(event);
        this.check();
    }

    start(): Promise<void> {
        this.addEvent({
            type: 'start',
            timestamp: this.now(),
        });
        return this.transport.start()
    }

    send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
        this.addEvent({
            type: 'sent',
            timestamp: this.now(),
            message,
            options,
        });
        return this.transport.send(message, options)
    }

    close(): Promise<void> {
        throw new Error("Method not implemented.")
    }

    onclose?: (() => void) | undefined
    onerror?: ((error: Error) => void) | undefined
    onmessage?: ((message: JSONRPCMessage, extra?: MessageExtraInfo) => void) | undefined

    sessionId?: string | undefined

    setProtocolVersion?: ((version: string) => void) | undefined
}