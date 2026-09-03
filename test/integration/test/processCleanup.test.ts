import { spawn } from 'node:child_process';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

// Use the local fixtures directory alongside this test file
const FIXTURES_DIR = path.resolve(__dirname, './__fixtures__');

describe('Process cleanup', () => {
    vi.setConfig({ testTimeout: 15_000 }); // 15 second timeout (needs margin for CI; close() alone can take ~4s for hanging servers)

    it('server should exit cleanly after closing transport', async () => {
        const server = new Server(
            {
                name: 'test-server',
                version: '1.0.0'
            },
            {
                capabilities: {}
            }
        );

        const mockReadable = new Readable({
                read() {
                    this.push(null); // signal EOF
                }
            }),
            mockWritable = new Writable({
                write(chunk, encoding, callback) {
                    callback();
                }
            });

        // Attach mock streams to process for the server transport
        const transport = new StdioServerTransport(mockReadable, mockWritable);
        await server.connect(transport);

        // Close the transport
        await transport.close();

        // ensure a proper disposal mock streams
        mockReadable.destroy();
        mockWritable.destroy();

        // If we reach here without hanging, the test passes
        // The test runner will fail if the process hangs
        expect(true).toBe(true);
    });

    it('onclose should be called exactly once', async () => {
        const client = new Client({
            name: 'test-client',
            version: '1.0.0'
        });

        const transport = new StdioClientTransport({
            command: 'node',
            args: ['--import', 'tsx', 'testServer.ts'],
            cwd: FIXTURES_DIR
        });

        await client.connect(transport);

        let onCloseWasCalled = 0;
        client.onclose = () => {
            onCloseWasCalled++;
        };

        await client.close();

        // A short delay to allow the close event to propagate
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(onCloseWasCalled).toBe(1);
    });

    it('server process should exit on its own when the client closes stdin', async () => {
        // Regression test for zombie stdio servers: when the client drops its end of
        // the pipe (window closed, session restarted) without sending any signal, the
        // server must notice stdin EOF, close its transport, and fire `onclose` so the
        // server can release its keep-alive handles and the process exits naturally.
        const child = spawn('node', ['--import', 'tsx', 'serverWithKeepAlive.ts'], {
            cwd: FIXTURES_DIR,
            stdio: ['pipe', 'pipe', 'inherit']
        });

        const exited = new Promise<number | null>(resolve => {
            child.on('exit', code => resolve(code));
        });

        // Confirm the server is up by completing an initialize round-trip over raw stdio.
        const initialized = new Promise<void>(resolve => {
            child.stdout.on('data', () => resolve());
        });
        child.stdin.write(
            JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-06-18',
                    capabilities: {},
                    clientInfo: { name: 'stdin-eof-test', version: '1.0.0' }
                }
            }) + '\n'
        );
        await initialized;

        // Hang up: close our end of the pipe without any signal.
        child.stdin.end();

        // The server must exit on its own — no SIGTERM/SIGKILL involved. Bound the
        // wait so a regression fails the test instead of leaking the child.
        const exitCode = await Promise.race([exited, new Promise<'zombie'>(resolve => setTimeout(() => resolve('zombie'), 8000))]);
        if (exitCode === 'zombie') {
            child.kill('SIGKILL');
        }
        expect(exitCode).toBe(0);
    });

    it('should exit cleanly for a server that hangs', async () => {
        const client = new Client({
            name: 'test-client',
            version: '1.0.0'
        });

        const transport = new StdioClientTransport({
            command: 'node',
            args: ['--import', 'tsx', 'serverThatHangs.ts'],
            cwd: FIXTURES_DIR
        });

        await client.connect(transport);
        await client.setLoggingLevel('debug');
        client.setNotificationHandler('notifications/message', notification => {
            console.debug('server log: ' + notification.params.data);
        });
        const serverPid = transport.pid!;

        await client.close();

        // A short delay to allow the close event to propagate
        await new Promise(resolve => setTimeout(resolve, 50));

        try {
            process.kill(serverPid, 9);
            throw new Error('Expected server to be dead but it is alive');
        } catch (error: unknown) {
            // 'ESRCH' the process doesn't exist
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') {
                // success
            } else throw error;
        }
    });
});
