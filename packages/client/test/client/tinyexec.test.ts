import type { ChildProcess } from 'node:child_process';

import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import { x } from 'tinyexec';
import type { Mock, MockedFunction } from 'vitest';

import { getDefaultEnvironment, StdioClientTransport } from '../../src/client/stdio';

// mock tinyexec
vi.mock('tinyexec');
const mockX = x as unknown as MockedFunction<typeof x>;

function makeMockProcess() {
    const mockProcess: {
        on: Mock;
        stdin: { on: Mock; write: Mock; once: Mock };
        stdout: { on: Mock };
        stderr: null;
    } = {
        on: vi.fn((event: string, callback: () => void) => {
            if (event === 'spawn') {
                callback();
            }
            return mockProcess;
        }),
        stdin: {
            on: vi.fn(),
            write: vi.fn().mockReturnValue(true),
            once: vi.fn()
        },
        stdout: {
            on: vi.fn()
        },
        stderr: null
    };
    return mockProcess;
}

/** The options tinyexec was called with, unwrapped from the `nodeOptions` envelope. */
function spawnOptions() {
    const options = mockX.mock.calls[0]![2]!;
    return { ...options, ...options.nodeOptions };
}

describe('StdioClientTransport using tinyexec', () => {
    beforeEach(() => {
        // mock tinyexec's return value: only `.process` is used by the transport
        mockX.mockImplementation(() => ({ process: makeMockProcess() }) as unknown as ReturnType<typeof x>);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('should call tinyexec correctly', async () => {
        const transport = new StdioClientTransport({
            command: 'test-command',
            args: ['arg1', 'arg2']
        });

        await transport.start();

        // verify x is called correctly
        expect(mockX).toHaveBeenCalledWith('test-command', ['arg1', 'arg2'], expect.anything());
        expect(spawnOptions()).toMatchObject({ shell: false });
    });

    test('should disable tinyexec node_modules/.bin PATH injection', async () => {
        const transport = new StdioClientTransport({ command: 'test-command' });

        await transport.start();

        // nodePath injection would prepend every ancestor node_modules/.bin to the child's PATH,
        // silently changing how the server command resolves.
        expect(spawnOptions()).toMatchObject({ nodePath: false });
    });

    test('should reject when tinyexec does not produce a process', async () => {
        mockX.mockImplementation(() => ({ process: undefined }) as unknown as ReturnType<typeof x>);

        const transport = new StdioClientTransport({ command: 'test-command' });

        await expect(transport.start()).rejects.toThrow(/Failed to spawn server process/);
    });

    test('should pass environment variables correctly', async () => {
        const customEnv = { TEST_VAR: 'test-value' };
        const transport = new StdioClientTransport({
            command: 'test-command',
            env: customEnv
        });

        await transport.start();

        // verify environment variables are merged correctly
        expect(spawnOptions().env).toMatchObject({
            ...getDefaultEnvironment(),
            ...customEnv
        });
    });

    test('should mask non-inherited parent environment variables', async () => {
        vi.stubEnv('STDIO_TINYEXEC_SECRET', 'must-not-be-inherited');

        const transport = new StdioClientTransport({ command: 'test-command' });

        await transport.start();

        // tinyexec merges `process.env` into the child env, so the transport masks every parent
        // key with `undefined` (which Node's spawn drops) to keep the safelist authoritative.
        const env = spawnOptions().env!;
        expect('STDIO_TINYEXEC_SECRET' in env).toBe(true);
        expect(env.STDIO_TINYEXEC_SECRET).toBeUndefined();

        vi.unstubAllEnvs();
    });

    test('should use default environment when env is undefined', async () => {
        const transport = new StdioClientTransport({
            command: 'test-command',
            env: undefined
        });

        await transport.start();

        // verify default environment is used
        expect(spawnOptions().env).toMatchObject(getDefaultEnvironment());
    });

    test('should send messages correctly', async () => {
        const transport = new StdioClientTransport({
            command: 'test-command'
        });

        // get the mock process object
        const mockProcess = makeMockProcess();
        mockX.mockReturnValue({ process: mockProcess } as unknown as ReturnType<typeof x>);

        await transport.start();

        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            id: 'test-id',
            method: 'test-method'
        };

        await transport.send(message);

        // verify message is sent correctly
        expect(mockProcess.stdin.write).toHaveBeenCalled();
    });

    describe('windowsHide', () => {
        const originalPlatform = process.platform;

        afterEach(() => {
            Object.defineProperty(process, 'platform', {
                value: originalPlatform
            });
        });

        test('should set windowsHide to true on Windows', async () => {
            Object.defineProperty(process, 'platform', {
                value: 'win32'
            });

            const transport = new StdioClientTransport({
                command: 'test-command'
            });

            await transport.start();

            expect(spawnOptions()).toMatchObject({ windowsHide: true });
        });

        test('should set windowsHide to false on non-Windows', async () => {
            Object.defineProperty(process, 'platform', {
                value: 'linux'
            });

            const transport = new StdioClientTransport({
                command: 'test-command'
            });

            await transport.start();

            expect(spawnOptions()).toMatchObject({ windowsHide: false });
        });
    });
});
