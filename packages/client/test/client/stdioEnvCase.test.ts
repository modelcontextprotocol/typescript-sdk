import type { ChildProcess } from 'node:child_process';
import process from 'node:process';

import spawn from 'cross-spawn';
import type { Mock, MockedFunction } from 'vitest';

import { getDefaultEnvironment, mergeSpawnEnv, StdioClientTransport } from '../../src/client/stdio';

// mock cross-spawn
vi.mock('cross-spawn');
const mockSpawn = spawn as unknown as MockedFunction<typeof spawn>;

describe('mergeSpawnEnv', () => {
    test('case-insensitive env: an explicit Path override replaces the inherited PATH', () => {
        const merged = mergeSpawnEnv({ PATH: 'inherited-path', TEMP: 'temp' }, { Path: 'user-path' }, true);

        expect(merged).toEqual({ Path: 'user-path', TEMP: 'temp' });
    });

    test('case-insensitive env: the override keeps the casing the caller chose', () => {
        const merged = mergeSpawnEnv({ path: 'inherited-path' }, { PATH: 'user-path' }, true);

        expect(merged).toEqual({ PATH: 'user-path' });
    });

    test('case-insensitive env: unrelated inherited variables survive', () => {
        const merged = mergeSpawnEnv({ HOME: '/home', PATH: 'inherited-path' }, { JAVA_HOME: '/jdk' }, true);

        expect(merged).toEqual({ HOME: '/home', PATH: 'inherited-path', JAVA_HOME: '/jdk' });
    });

    test('case-sensitive env: PATH and Path are distinct variables and both survive', () => {
        const merged = mergeSpawnEnv({ PATH: 'inherited-path' }, { Path: 'user-path' }, false);

        expect(merged).toEqual({ PATH: 'inherited-path', Path: 'user-path' });
    });
});

describe('StdioClientTransport env case handling', () => {
    beforeEach(() => {
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

    test('a caller-supplied Path is the only PATH-like entry handed to the child on Windows', async () => {
        const transport = new StdioClientTransport({
            command: 'test-command',
            env: { Path: 'user-path' }
        });

        await transport.start();

        const call = mockSpawn.mock.calls.at(0);
        const env = (call?.[2]?.env ?? {}) as Record<string, string>;
        expect(env.Path).toBe('user-path');
        if (process.platform === 'win32') {
            expect(env.PATH).toBeUndefined();
        } else {
            expect(env.PATH).toBe(getDefaultEnvironment().PATH);
        }
    });
});
