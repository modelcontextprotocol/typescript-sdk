import path from 'node:path';
import url from 'node:url';

import type { JSONRPCMessage } from '@modelcontextprotocol/core';

import { StdioClientTransport } from '../../src/client/modernStdio.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const fixture = (name: string) => path.resolve(__dirname, '__fixtures__', name);

describe('StdioClientTransport (version probing)', () => {
    vi.setConfig({ testTimeout: 10_000 });

    let transport: StdioClientTransport;

    afterEach(async () => {
        await transport?.close();
    });

    it('probe succeeds and enters modern mode', async () => {
        transport = new StdioClientTransport({
            command: 'node',
            args: [fixture('modernServer.mjs')]
        });
        await transport.start();

        expect(transport.mode).toBe('modern');
        expect(transport.getDiscoverResult()).toBeDefined();
        expect(transport.getDiscoverResult()!.serverInfo.name).toBe('modern-fixture');
        expect(transport.getDiscoverResult()!.supportedVersions).toContain('2026-06-30');
    });

    it('probe returns error and falls back to legacy mode', async () => {
        transport = new StdioClientTransport({
            command: 'node',
            args: [fixture('legacyServer.mjs')]
        });
        await transport.start();

        expect(transport.mode).toBe('legacy');
        expect(transport.getDiscoverResult()).toBeUndefined();
    });

    it('probe times out and falls back to legacy mode', async () => {
        transport = new StdioClientTransport({
            command: 'node',
            args: [fixture('silentServer.mjs')],
            probeTimeoutMs: 200
        });
        await transport.start();

        expect(transport.mode).toBe('legacy');
        expect(transport.getDiscoverResult()).toBeUndefined();
    });

    it('forceLegacy skips probe even when server supports modern', async () => {
        transport = new StdioClientTransport({
            command: 'node',
            args: [fixture('modernServer.mjs')],
            forceLegacy: true
        });
        await transport.start();

        expect(transport.mode).toBe('legacy');
        expect(transport.getDiscoverResult()).toBeUndefined();
    });

    it('pid is available after start', async () => {
        transport = new StdioClientTransport({
            command: 'node',
            args: [fixture('modernServer.mjs')]
        });
        await transport.start();

        expect(transport.pid).toBeGreaterThan(0);
    });

    it('close during probe resolves start with legacy mode', async () => {
        transport = new StdioClientTransport({
            command: 'node',
            args: [fixture('silentServer.mjs')],
            probeTimeoutMs: 10_000
        });

        const startPromise = transport.start();
        setTimeout(() => transport.close(), 50);
        await startPromise;

        expect(transport.mode).toBe('legacy');
    });

    it('buffered messages during probe are flushed when onmessage is set', async () => {
        transport = new StdioClientTransport({
            command: 'node',
            args: [fixture('modernServerWithExtra.mjs')]
        });
        await transport.start();
        expect(transport.mode).toBe('modern');

        const flushed: JSONRPCMessage[] = [];
        await new Promise<void>(resolve => {
            transport.onmessage = (msg: JSONRPCMessage) => {
                flushed.push(msg);
                resolve();
            };
            // If nothing arrives within a short window, resolve anyway
            setTimeout(resolve, 500);
        });

        expect(flushed.length).toBeGreaterThanOrEqual(1);
        const notification = flushed[0] as { method?: string; params?: { data?: string } };
        expect(notification.method).toBe('notifications/message');
        expect(notification.params?.data).toBe('buffered-message');
    });

    it('second start call is a no-op', async () => {
        transport = new StdioClientTransport({
            command: 'node',
            args: [fixture('modernServer.mjs')]
        });
        await transport.start();
        expect(transport.mode).toBe('modern');

        // Calling start again should not throw or change mode
        await transport.start();
        expect(transport.mode).toBe('modern');
    });
});
