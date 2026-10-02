/**
 * Test harness for the legacy `input_required` shim: wires a server to an
 * in-memory peer that can ANSWER server→client requests (elicitation,
 * sampling, roots), records outbound messages with their transport send
 * options (the relatedRequestId stamp), and resolves originating requests
 * with their eventual responses. Shared by the shim unit suite and the
 * write-once acceptance test.
 */
import type {
    JSONRPCErrorResponse,
    JSONRPCMessage,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResultResponse,
    RequestId
} from '@modelcontextprotocol/core-internal';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core-internal';

import type { McpServer } from '../../src/server/mcp';
import type { Server } from '../../src/server/server';

export type PeerResponder = (
    request: JSONRPCRequest
) => Record<string, unknown> | { __error: { code: number; message: string } } | { __defer: true };

export const legacyInitialize = (id: number, capabilities: Record<string, unknown> = {}): JSONRPCRequest => ({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities, clientInfo: { name: 'legacy-client', version: '1.0.0' } }
});

export function resultOf(message: JSONRPCMessage): Record<string, unknown> {
    return (message as JSONRPCResultResponse).result as unknown as Record<string, unknown>;
}

export function errorOf(message: JSONRPCMessage): { code: number; message: string; data?: unknown } {
    return (message as JSONRPCErrorResponse).error;
}

export function toolText(message: JSONRPCMessage): string {
    const content = resultOf(message).content as Array<{ type: string; text: string }>;
    return content.map(block => block.text).join('\n');
}

export async function wireLegacy(server: McpServer | Server) {
    const [peerTx, serverTx] = InMemoryTransport.createLinkedPair();

    const sent: Array<{ message: JSONRPCMessage; options?: { relatedRequestId?: RequestId } }> = [];
    const originalSend = serverTx.send.bind(serverTx);
    serverTx.send = (message: JSONRPCMessage, options?: { relatedRequestId?: RequestId }) => {
        sent.push({ message, options });
        return originalSend(message, options);
    };

    const responders = new Map<string, PeerResponder>();
    const waiters = new Map<string | number, (message: JSONRPCMessage) => void>();
    const notifications: JSONRPCNotification[] = [];

    peerTx.onmessage = message => {
        const candidate = message as Partial<JSONRPCRequest> & Partial<JSONRPCErrorResponse>;
        if (candidate.method !== undefined && candidate.id !== undefined) {
            // A server→client request: route to the registered responder.
            const responder = responders.get(candidate.method);
            if (responder === undefined) {
                void peerTx.send({
                    jsonrpc: '2.0',
                    id: candidate.id,
                    error: { code: -32_601, message: `peer has no responder for ${candidate.method}` }
                });
                return;
            }
            const outcome = responder(message as JSONRPCRequest);
            if ('__defer' in outcome) {
                // The test answers later via answerFromPeer.
            } else if ('__error' in outcome) {
                void peerTx.send({ jsonrpc: '2.0', id: candidate.id, error: outcome.__error as { code: number; message: string } });
            } else {
                void peerTx.send({ jsonrpc: '2.0', id: candidate.id, result: outcome });
            }
            return;
        }
        if (candidate.method !== undefined) {
            notifications.push(message as JSONRPCNotification);
            return;
        }
        const id = (message as { id?: string | number }).id;
        const waiter = id === undefined ? undefined : waiters.get(id);
        if (id !== undefined && waiter) {
            waiters.delete(id);
            waiter(message);
        }
    };

    await server.connect(serverTx);
    await peerTx.start();

    const request = (message: JSONRPCRequest): Promise<JSONRPCMessage> =>
        new Promise(resolve => {
            waiters.set(message.id, resolve);
            void peerTx.send(message);
        });

    return {
        request,
        respond: (method: string, responder: PeerResponder) => void responders.set(method, responder),
        sent,
        notifications,
        peerRequests: (method: string) => sent.map(entry => entry.message as JSONRPCRequest).filter(message => message.method === method),
        sentOptionsFor: (method: string) =>
            sent.filter(entry => (entry.message as JSONRPCRequest).method === method).map(entry => entry.options),
        answerFromPeer: (id: RequestId, result: Record<string, unknown>) => peerTx.send({ jsonrpc: '2.0', id, result }),
        notifyFromPeer: (notification: JSONRPCNotification) => peerTx.send(notification),
        close: async () => {
            await peerTx.close();
            await serverTx.close();
        }
    };
}
