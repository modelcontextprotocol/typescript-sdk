import { StdioClientTransport, getDefaultEnvironment } from '../../src/client/stdio.js';
import spawn from 'cross-spawn';
import { JSONRPCMessage } from '../../src/types.js';
import { ChildProcess } from 'node:child_process';
import { Mock, MockedFunction } from 'vitest';

// mock cross-spawn
vi.mock('cross-spawn');
const mockSpawn = spawn as unknown as MockedFunction<typeof spawn>;

describe('StdioClientTransport using cross-spawn', () => {
    beforeEach(() => {
        // mock cross-spawn's return value
        mockSpawn.mockImplementation(() => {
            const mockProcess: {
                on: Mock;
                stdin?: { on: Mock; write: Mock };
                stdout?: { on: Mock };
                stderr?: null;
            } = {
                on: vi.fn((event: string, callback: () => void) => {
                    if (event === 'spawn') {
                        callback();
                    }
                    return mockProcess;
                }),
                stdin: {
                    on: vi.fn(),
                    write: vi.fn().mockReturnValue(true)
                },
                stdout: {
                    on: vi.fn()
                },
                stderr: null
            };
            return mockProcess as unknown as ChildProcess;
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('should call cross-spawn correctly', async () => {
        const transport = new StdioClientTransport({
            command: 'test-command',
            args: ['arg1', 'arg2']
        });

        await transport.start();

        // verify spawn is called correctly
        expect(mockSpawn).toHaveBeenCalledWith(
            'test-command',
            ['arg1', 'arg2'],
            expect.objectContaining({
                shell: false
            })
        );
    });

    test('should pass environment variables correctly', async () => {
        const customEnv = { TEST_VAR: 'test-value' };
        const transport = new StdioClientTransport({
            command: 'test-command',
            env: customEnv
        });

        await transport.start();

        // verify environment variables are merged correctly
        expect(mockSpawn).toHaveBeenCalledWith(
            'test-command',
            [],
            expect.objectContaining({
                env: {
                    ...getDefaultEnvironment(),
                    ...customEnv
                }
            })
        );
    });

    test('should use default environment when env is undefined', async () => {
        const transport = new StdioClientTransport({
            command: 'test-command',
            env: undefined
        });

        await transport.start();

        // verify default environment is used
        expect(mockSpawn).toHaveBeenCalledWith(
            'test-command',
            [],
            expect.objectContaining({
                env: getDefaultEnvironment()
            })
        );
    });

    test('should send messages correctly', async () => {
        const transport = new StdioClientTransport({
            command: 'test-command'
        });

        // get the mock process object
        const mockProcess: {
            on: Mock;
            stdin: {
                on: Mock;
                write: Mock;
                once: Mock;
            };
            stdout: {
                on: Mock;
            };
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

        mockSpawn.mockReturnValue(mockProcess as unknown as ChildProcess);

        await transport.start();

        // 关键修复：确保 jsonrpc 是字面量 "2.0"
        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            id: 'test-id',
            method: 'test-method'
        };

        await transport.send(message);

        // verify message is sent correctly
        expect(mockProcess.stdin.write).toHaveBeenCalled();
    });
});
