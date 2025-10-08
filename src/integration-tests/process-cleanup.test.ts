import { describe, it, expect } from 'vitest';
import { Server } from '../server/index.js';
import { StdioServerTransport } from '../server/stdio.js';

describe('Process cleanup', () => {
    it('should exit cleanly after closing transport', { timeout: 5000 }, async () => {
        const server = new Server(
            {
                name: 'test-server',
                version: '1.0.0'
            },
            {
                capabilities: {}
            }
        );

        const transport = new StdioServerTransport();
        await server.connect(transport);

        // Close the transport
        await transport.close();

        // If we reach here without hanging, the test passes
        // The test runner will fail if the process hangs
        expect(true).toBe(true);
    });
});
