import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { Client } from '../../src/client/index.js';
import { StdioClientTransport } from '../../src/client/stdio.js';
import { Server } from '../../src/server/index.js';
import { StdioServerTransport } from '../../src/server/stdio.js';
import { LoggingMessageNotificationSchema } from '../../src/types.js';

const FIXTURES_DIR = path.resolve(__dirname, '../../src/__fixtures__');

describe('Process cleanup', () => {
    vi.setConfig({ testTimeout: 5000 }); // 5 second timeout

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
        client.setNotificationHandler(LoggingMessageNotificationSchema, notification => {
            console.debug('server log: ' + notification.params.data);
        });
        const serverPid = transport.pid!;

        await client.close();

        // A short delay to allow the close event to propagate
        await new Promise(resolve => setTimeout(resolve, 50));

        try {
            process.kill(serverPid, 9);
            throw new Error('Expected server to be dead but it is alive');
        } catch (err: unknown) {
            // 'ESRCH' the process doesn't exist
            if (err && typeof err === 'object' && 'code' in err && err.code === 'ESRCH') {
                // success
            } else throw err;
        }
    });
});
