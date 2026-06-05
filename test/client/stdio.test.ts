import { JSONRPCMessage } from '../../src/types.js';
import { StdioClientTransport, StdioServerParameters, getDefaultEnvironment } from '../../src/client/stdio.js';

// Configure default server parameters based on OS
// Uses 'more' command for Windows and 'tee' command for Unix/Linux
const getDefaultServerParameters = (): StdioServerParameters => {
    if (process.platform === 'win32') {
        return { command: 'more' };
    }
    return { command: '/usr/bin/tee' };
};

const serverParameters = getDefaultServerParameters();

test('should start then close cleanly', async () => {
    const client = new StdioClientTransport(serverParameters);
    client.onerror = error => {
        throw error;
    };

    let didClose = false;
    client.onclose = () => {
        didClose = true;
    };

    await client.start();
    expect(didClose).toBeFalsy();
    await client.close();
    expect(didClose).toBeTruthy();
});

test('should read messages', async () => {
    const client = new StdioClientTransport(serverParameters);
    client.onerror = error => {
        throw error;
    };

    const messages: JSONRPCMessage[] = [
        {
            jsonrpc: '2.0',
            id: 1,
            method: 'ping'
        },
        {
            jsonrpc: '2.0',
            method: 'notifications/initialized'
        }
    ];

    const readMessages: JSONRPCMessage[] = [];
    const finished = new Promise<void>(resolve => {
        client.onmessage = message => {
            readMessages.push(message);

            if (JSON.stringify(message) === JSON.stringify(messages[1])) {
                resolve();
            }
        };
    });

    await client.start();
    await client.send(messages[0]);
    await client.send(messages[1]);
    await finished;
    expect(readMessages).toEqual(messages);

    await client.close();
});

test('supports subclassing with overridden methods', async () => {
    // Consumers extend StdioClientTransport (constructor calls super(params),
    // methods are overridden); the class must stay subclassable.
    class InstrumentedStdioClientTransport extends StdioClientTransport {
        startCalls = 0;

        constructor(server: StdioServerParameters) {
            super(server);
        }

        override async start(): Promise<void> {
            this.startCalls += 1;
            return super.start();
        }
    }

    const client = new InstrumentedStdioClientTransport(serverParameters);
    expect(client).toBeInstanceOf(StdioClientTransport);
    client.onerror = error => {
        throw error;
    };

    // The subclass instance must function as a working transport end to end.
    const message: JSONRPCMessage = { jsonrpc: '2.0', id: 1, method: 'ping' };
    const received = new Promise<JSONRPCMessage>(resolve => {
        client.onmessage = resolve;
    });

    await client.start();
    expect(client.startCalls).toBe(1);
    expect(client.pid).not.toBeNull();
    await client.send(message);
    expect(await received).toEqual(message);
    await client.close();
});

describe('close() escalation ladder grace periods', () => {
    // Inline child that stays alive after stdin EOF: stdin is drained so 'end'
    // fires and is deliberately ignored, and an interval keeps the loop busy.
    const IGNORE_STDIN_EOF = 'process.stdin.resume(); process.stdin.on("end", () => {}); setInterval(() => {}, 1000);';

    test('close() waits the full ~2s stdin-EOF grace before escalating to SIGTERM', async () => {
        const client = new StdioClientTransport({
            command: 'node',
            args: ['-e', IGNORE_STDIN_EOF]
        });
        await client.start();

        const startedAt = Date.now();
        await client.close();
        const elapsed = Date.now() - startedAt;

        // Rung 1 (stdin EOF) is ignored by the child, so close() must sit out
        // the entire 2s grace before delivering SIGTERM (which the child obeys).
        // A materially shorter grace would signal well-behaved-but-slow servers
        // mid-shutdown.
        expect(elapsed).toBeGreaterThanOrEqual(1_900);
        // ...and SIGTERM ended it within the second grace: surviving to the
        // SIGKILL rung would push the wall time past ~4s.
        expect(elapsed).toBeLessThan(3_500);
    }, 10_000);

    test('close() waits a second ~2s grace between SIGTERM and SIGKILL', async () => {
        const client = new StdioClientTransport({
            command: 'node',
            args: ['-e', `${IGNORE_STDIN_EOF} process.on("SIGTERM", () => {});`]
        });
        await client.start();

        const startedAt = Date.now();
        await client.close();
        const elapsed = Date.now() - startedAt;

        // The child ignores stdin EOF and SIGTERM, so both graces must elapse
        // in full (2s after stdin EOF, then 2s after SIGTERM) before SIGKILL.
        expect(elapsed).toBeGreaterThanOrEqual(3_800);
        expect(elapsed).toBeLessThan(8_000);
    }, 15_000);
});

describe('getDefaultEnvironment', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    test('inherits exactly the documented safelist keys', () => {
        // Frozen copy of the documented safelist — deliberately NOT imported from
        // src, so an edit to DEFAULT_INHERITED_ENV_VARS shows up as a failure here
        // instead of being compared against itself.
        const safelist =
            process.platform === 'win32'
                ? [
                      'APPDATA',
                      'HOMEDRIVE',
                      'HOMEPATH',
                      'LOCALAPPDATA',
                      'PATH',
                      'PROCESSOR_ARCHITECTURE',
                      'SYSTEMDRIVE',
                      'SYSTEMROOT',
                      'TEMP',
                      'USERNAME',
                      'USERPROFILE',
                      'PROGRAMFILES'
                  ]
                : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];
        for (const key of safelist) {
            vi.stubEnv(key, `safe-${key}`);
        }
        vi.stubEnv('STDIO_TEST_SECRET', 'must-not-be-inherited');

        const env = getDefaultEnvironment();

        expect(Object.keys(env).sort()).toEqual([...safelist].sort());
        for (const key of safelist) {
            expect(env[key]).toBe(`safe-${key}`);
        }
    });

    test('skips values that look like exported shell functions', () => {
        vi.stubEnv('PATH', '() { echo pwned; }');
        const env = getDefaultEnvironment();
        expect(env.PATH).toBeUndefined();
    });
});

test('should return child process pid', async () => {
    const client = new StdioClientTransport(serverParameters);

    await client.start();
    expect(client.pid).not.toBeNull();
    await client.close();
    expect(client.pid).toBeNull();
});

test('should respect custom maxBufferSize option', async () => {
    const client = new StdioClientTransport({
        command: 'node',
        args: ['-e', 'process.stdout.write(Buffer.alloc(200, 0x41))'],
        maxBufferSize: 100
    });

    const errorReceived = new Promise<Error>(resolve => {
        client.onerror = resolve;
    });
    const closed = new Promise<void>(resolve => {
        client.onclose = () => resolve();
    });

    await client.start();

    const error = await errorReceived;
    expect(error.message).toMatch(/ReadBuffer exceeded maximum size/);
    await closed;
});

test('should fire onerror and close when ReadBuffer overflows', async () => {
    const client = new StdioClientTransport({
        command: 'node',
        args: ['-e', 'process.stdout.write(Buffer.alloc(11 * 1024 * 1024, 0x41))']
    });

    const errorReceived = new Promise<Error>(resolve => {
        client.onerror = resolve;
    });
    const closed = new Promise<void>(resolve => {
        client.onclose = () => resolve();
    });

    await client.start();

    const error = await errorReceived;
    expect(error.message).toMatch(/ReadBuffer exceeded maximum size/);
    await closed;
});
