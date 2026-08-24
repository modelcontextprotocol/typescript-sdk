import { EventEmitter } from 'node:events';

import type { ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';
import type { Mock, MockedFunction } from 'vitest';

import { StdioClientTransport } from '../../src/client/stdio';

// mock cross-spawn
vi.mock('cross-spawn');
const mockSpawn = spawn as unknown as MockedFunction<typeof spawn>;

describe('StdioClientTransport backpressure', () => {
    let stdin: EventEmitter & { write: Mock };

    beforeEach(() => {
        stdin = new EventEmitter() as EventEmitter & { write: Mock };
        stdin.write = vi.fn().mockReturnValue(false);

        mockSpawn.mockImplementation(() => {
            const mockProcess = {
                on: vi.fn((event: string, callback: () => void) => {
                    if (event === 'spawn') {
                        callback();
                    }
                    return mockProcess;
                }),
                stdin,
                stdout: { on: vi.fn() },
                stderr: null
            };
            return mockProcess as unknown as ChildProcess;
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('shares a single drain listener across concurrent backpressured sends', async () => {
        const transport = new StdioClientTransport({ command: 'test-command' });
        await transport.start();

        const messages = Array.from({ length: 15 }, (_, i) => ({
            jsonrpc: '2.0' as const,
            id: i,
            method: 'ping'
        }));

        const sends = Promise.allSettled(messages.map(m => transport.send(m)));
        await new Promise(resolve => setImmediate(resolve));

        // every message is written immediately, but the backed-up pipe means
        // all sends wait for drain - and they must share ONE listener
        expect(stdin.write).toHaveBeenCalledTimes(15);
        expect(stdin.listenerCount('drain')).toBe(1);

        stdin.emit('drain');

        const results = await sends;
        expect(results.every(r => r.status === 'fulfilled')).toBe(true);
        expect(stdin.listenerCount('drain')).toBe(0);
    });

    test('rejects pending sends when stdin errors instead of hanging', async () => {
        const transport = new StdioClientTransport({ command: 'test-command' });
        await transport.start();

        const sends = Promise.allSettled([
            transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' }),
            transport.send({ jsonrpc: '2.0', id: 2, method: 'ping' })
        ]);
        await new Promise(resolve => setImmediate(resolve));

        stdin.emit('error', new Error('EPIPE'));

        const results = await sends;
        expect(results.every(r => r.status === 'rejected')).toBe(true);
    });
});
