import { Readable, Writable } from 'stream';
import { Client } from '../client/index.js';
import { StdioClientTransport } from '../client/stdio.js';
import { Server } from '../server/index.js';
import { StdioServerTransport } from '../server/stdio.js';

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
            command: process.argv0,
            args: ['test-server.js'],
            cwd: __dirname
        });

        let onCloseWasCalled = 0;
        client.onclose = () => {
            onCloseWasCalled++;
        };

        await client.connect(transport);
        await client.close();

        // A short delay to allow the close event to propagate
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(onCloseWasCalled).toBe(1);
    });
});
