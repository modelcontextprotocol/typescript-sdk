import type { AuthInfo, JSONRPCMessage } from '../src/types/index.js';
import { InMemoryTransport } from '../src/util/inMemory.js';

describe('InMemoryTransport', () => {
    let clientTransport: InMemoryTransport;
    let serverTransport: InMemoryTransport;

    beforeEach(() => {
        [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    });

    test('should create linked pair', () => {
        expect(clientTransport).toBeDefined();
        expect(serverTransport).toBeDefined();
    });

    test('should start without error', async () => {
        await expect(clientTransport.start()).resolves.not.toThrow();
        await expect(serverTransport.start()).resolves.not.toThrow();
    });

    test('should send message from client to server', async () => {
        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'test',
            id: 1
        };

        let receivedMessage: JSONRPCMessage | undefined;
        serverTransport.onmessage = msg => {
            receivedMessage = msg;
        };

        await clientTransport.send(message);
        expect(receivedMessage).toEqual(message);
    });

    test('should send message with auth info from client to server', async () => {
        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'test',
            id: 1
        };

        const authInfo: AuthInfo = {
            token: 'test-token',
            clientId: 'test-client',
            scopes: ['read', 'write'],
            expiresAt: Date.now() / 1000 + 3600
        };

        let receivedMessage: JSONRPCMessage | undefined;
        let receivedAuthInfo: AuthInfo | undefined;
        serverTransport.onmessage = (msg, extra) => {
            receivedMessage = msg;
            receivedAuthInfo = extra?.authInfo;
        };

        await clientTransport.send(message, { authInfo });
        expect(receivedMessage).toEqual(message);
        expect(receivedAuthInfo).toEqual(authInfo);
    });

    test('should send message from server to client', async () => {
        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'test',
            id: 1
        };

        let receivedMessage: JSONRPCMessage | undefined;
        clientTransport.onmessage = msg => {
            receivedMessage = msg;
        };

        await serverTransport.send(message);
        expect(receivedMessage).toEqual(message);
    });

    test('should handle close', async () => {
        let clientClosed = false;
        let serverClosed = false;

        clientTransport.onclose = () => {
            clientClosed = true;
        };

        serverTransport.onclose = () => {
            serverClosed = true;
        };

        await clientTransport.close();
        expect(clientClosed).toBe(true);
        expect(serverClosed).toBe(true);
    });

    test('should throw error when sending after close', async () => {
        await clientTransport.close();
        await expect(clientTransport.send({ jsonrpc: '2.0', method: 'test', id: 1 })).rejects.toThrow('Not connected');
    });

    test('should fire onclose exactly once per transport', async () => {
        let clientCloseCount = 0;
        let serverCloseCount = 0;

        clientTransport.onclose = () => clientCloseCount++;
        serverTransport.onclose = () => serverCloseCount++;

        await clientTransport.close();

        expect(clientCloseCount).toBe(1);
        expect(serverCloseCount).toBe(1);
    });

    test('should handle double close idempotently', async () => {
        let clientCloseCount = 0;
        clientTransport.onclose = () => clientCloseCount++;

        await clientTransport.close();
        await clientTransport.close();

        expect(clientCloseCount).toBe(1);
    });

    test('should handle concurrent close from both sides', async () => {
        let clientCloseCount = 0;
        let serverCloseCount = 0;

        clientTransport.onclose = () => clientCloseCount++;
        serverTransport.onclose = () => serverCloseCount++;

        await Promise.all([clientTransport.close(), serverTransport.close()]);

        expect(clientCloseCount).toBe(1);
        expect(serverCloseCount).toBe(1);
    });

    test('should fire onclose even if peer onclose throws', async () => {
        let clientCloseCount = 0;
        clientTransport.onclose = () => clientCloseCount++;
        serverTransport.onclose = () => {
            throw new Error('boom');
        };

        await expect(clientTransport.close()).rejects.toThrow('boom');
        expect(clientCloseCount).toBe(1);
    });

    test('should queue messages sent before start', async () => {
        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'test',
            id: 1
        };

        let receivedMessage: JSONRPCMessage | undefined;
        serverTransport.onmessage = msg => {
            receivedMessage = msg;
        };

        await clientTransport.send(message);
        await serverTransport.start();
        expect(receivedMessage).toEqual(message);
    });
});
