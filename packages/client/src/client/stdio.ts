import type { ChildProcess, IOType } from 'node:child_process';
import process from 'node:process';
import type { Stream } from 'node:stream';
import { PassThrough } from 'node:stream';

import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/core-internal';
import { ReadBuffer, SdkError, SdkErrorCode, serializeMessage } from '@modelcontextprotocol/core-internal';
import spawn from 'cross-spawn';

export type StdioServerParameters = {
    /**
     * The executable to run to start the server.
     */
    command: string;

    /**
     * Command line arguments to pass to the executable.
     */
    args?: string[];

    /**
     * The environment to use when spawning the process.
     *
     * If not specified, the result of {@linkcode getDefaultEnvironment} will be used.
     */
    env?: Record<string, string>;

    /**
     * How to handle stderr of the child process. This matches the semantics of Node's `child_process.spawn`.
     *
     * The default is `"inherit"`, meaning messages to stderr will be printed to the parent process's stderr.
     */
    stderr?: IOType | Stream | number;

    /**
     * The working directory to use when spawning the process.
     *
     * If not specified, the current working directory will be inherited.
     */
    cwd?: string;

    /**
     * Maximum size of the read buffer in bytes. If a single message exceeds
     * this size the transport will emit an error and close.
     *
     * Defaults to 10 MB.
     */
    maxBufferSize?: number;
};

/**
 * Environment variables to inherit by default, if an environment is not explicitly given.
 */
export const DEFAULT_INHERITED_ENV_VARS =
    process.platform === 'win32'
        ? [
              'APPDATA',
              'COMSPEC',
              'HOMEDRIVE',
              'HOMEPATH',
              'LOCALAPPDATA',
              'PATH',
              'PATHEXT',
              'PROCESSOR_ARCHITECTURE',
              'PROGRAMDATA',
              'PROGRAMFILES',
              'PROGRAMFILES(X86)',
              'PROGRAMW6432',
              'SYSTEMDRIVE',
              'SYSTEMROOT',
              'TEMP',
              'USERNAME',
              'USERPROFILE',
              'WINDIR'
          ]
        : /* list inspired by the default env inheritance of sudo */
          ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];

/**
 * Returns a default environment object including only environment variables deemed safe to inherit.
 */
export function getDefaultEnvironment(): Record<string, string> {
    const env: Record<string, string> = {};

    for (const key of DEFAULT_INHERITED_ENV_VARS) {
        const value = process.env[key];
        if (value === undefined) {
            continue;
        }

        if (value.startsWith('()')) {
            // Skip functions, which are a security risk.
            continue;
        }

        env[key] = value;
    }

    return env;
}

/**
 * Client transport for stdio: this will connect to a server by spawning a process and communicating with it over stdin/stdout.
 *
 * This transport is only available in Node.js environments.
 */
export class StdioClientTransport implements Transport {
    private _process?: ChildProcess;
    private _readBuffer: ReadBuffer;
    private _serverParams: StdioServerParameters;
    private _stderrStream: PassThrough | null = null;
    private _stdoutDataHandler?: (chunk: Buffer) => void;
    private _stdoutErrorHandler?: (error: Error) => void;
    private _stdinErrorHandler?: (error: Error) => void;
    private _pendingDrainWaiters: Array<() => void> = [];
    private _drainHandler?: () => void;
    private _drainStream?: Stream;

    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    constructor(server: StdioServerParameters) {
        this._serverParams = server;
        this._readBuffer = new ReadBuffer({ maxBufferSize: server.maxBufferSize });
        if (server.stderr === 'pipe' || server.stderr === 'overlapped') {
            this._stderrStream = new PassThrough();
        }
    }

    /**
     * Starts the server process and prepares to communicate with it.
     */
    async start(): Promise<void> {
        if (this._process) {
            throw new Error(
                'StdioClientTransport already started! If using Client class, note that connect() calls start() automatically.'
            );
        }

        return new Promise((resolve, reject) => {
            this._process = spawn(this._serverParams.command, this._serverParams.args ?? [], {
                // merge default env with server env because mcp server needs some env vars
                env: {
                    ...getDefaultEnvironment(),
                    ...this._serverParams.env
                },
                stdio: ['pipe', 'pipe', this._serverParams.stderr ?? 'inherit'],
                shell: false,
                windowsHide: process.platform === 'win32',
                cwd: this._serverParams.cwd
            });

            this._process.on('error', error => {
                reject(error);
                this.onerror?.(error);
            });

            this._process.on('spawn', () => {
                resolve();
            });

            this._process.on('exit', () => {
                // Settle at exit, not just close: 'close' can lag behind if a grandchild inherits the child's stdio.
                this.settlePendingSends();
            });

            this._process.on('close', _code => {
                this._process = undefined;
                this.onclose?.();
                this.settlePendingSends();
            });

            this._stdinErrorHandler = error => {
                this.onerror?.(error);
            };
            this._process.stdin?.on('error', this._stdinErrorHandler);

            this._stdoutDataHandler = chunk => {
                try {
                    this._readBuffer.append(chunk);
                    this.processReadBuffer();
                } catch (error) {
                    this.onerror?.(error as Error);
                    this.close().catch(() => {});
                }
            };
            this._process.stdout?.on('data', this._stdoutDataHandler);

            this._stdoutErrorHandler = error => {
                this.onerror?.(error);
            };
            this._process.stdout?.on('error', this._stdoutErrorHandler);

            if (this._stderrStream && this._process.stderr) {
                this._process.stderr.pipe(this._stderrStream);
            }
        });
    }

    /**
     * The `stderr` stream of the child process, if {@linkcode StdioServerParameters.stderr} was set to `"pipe"` or `"overlapped"`.
     *
     * If `stderr` piping was requested, a `PassThrough` stream is returned _immediately_, allowing callers to
     * attach listeners before the `start` method is invoked. This prevents loss of any early
     * error output emitted by the child process.
     */
    get stderr(): Stream | null {
        if (this._stderrStream) {
            return this._stderrStream;
        }

        return this._process?.stderr ?? null;
    }

    /**
     * The child process pid spawned by this transport.
     *
     * This is only available after the transport has been started.
     */
    get pid(): number | null {
        return this._process?.pid ?? null;
    }

    private processReadBuffer() {
        while (true) {
            try {
                const message = this._readBuffer.readMessage();
                if (message === null) {
                    break;
                }

                this.onmessage?.(message);
            } catch (error) {
                this.onerror?.(error as Error);
            }
        }
    }

    /**
     * Reap a disposable probe sibling (see the version-negotiation sibling
     * flow): signal-first teardown awaiting process `exit` — never the `close`
     * event, so a helper process holding the child's stdio pipes can never
     * block disposal. Not part of the public transport lifecycle.
     *
     * @internal
     */
    private async _dispose(): Promise<void> {
        const proc = this._process;
        this._process = undefined;
        this.settlePendingSends();
        if (proc && proc.exitCode === null && proc.signalCode === null) {
            const exited = new Promise<void>(resolve => proc.once('exit', () => resolve()));
            try {
                proc.stdin?.end();
            } catch {
                // ignore
            }
            try {
                proc.kill('SIGTERM');
            } catch {
                // ignore
            }
            await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1000).unref())]);
            if (proc.exitCode === null && proc.signalCode === null) {
                try {
                    proc.kill('SIGKILL');
                } catch {
                    // ignore
                }
            }
            await exited;
        }
        // The child is gone — release the PARENT-side pipe handles too. A helper
        // process holding the inherited write ends would otherwise keep them (and
        // with them the host's event loop: stdout carries a flowing 'data'
        // listener from start()) alive until the helper exits.
        try {
            proc?.stdout?.destroy();
        } catch {
            // ignore
        }
        try {
            proc?.stdin?.destroy();
        } catch {
            // ignore
        }
        try {
            proc?.stderr?.destroy();
        } catch {
            // ignore
        }
        this._readBuffer.clear();
    }

    async close(): Promise<void> {
        if (this._process) {
            const processToClose = this._process;
            this._process = undefined;

            // Detach the listeners installed in start() so late stdout cannot reach the JSON-RPC
            // parser. The stderr pass-through is deliberately left attached until the child has
            // fully shut down below, so stderr the child emits while dying still reaches consumers.
            if (this._stdoutDataHandler) {
                processToClose.stdout?.removeListener('data', this._stdoutDataHandler);
                this._stdoutDataHandler = undefined;
            }
            if (this._stdoutErrorHandler) {
                processToClose.stdout?.removeListener('error', this._stdoutErrorHandler);
                this._stdoutErrorHandler = undefined;
            }
            if (this._stdinErrorHandler) {
                processToClose.stdin?.removeListener('error', this._stdinErrorHandler);
                this._stdinErrorHandler = undefined;
            }
            // Keep no-op error handlers so late errors cannot throw uncaught.
            processToClose.stdin?.on('error', () => {});
            processToClose.stdout?.on('error', () => {});
            processToClose.stderr?.on('error', () => {});

            const closePromise = new Promise<void>(resolve => {
                processToClose.once('close', () => {
                    resolve();
                });
            });

            try {
                processToClose.stdin?.end();
            } catch {
                // ignore
            }

            await Promise.race([closePromise, new Promise(resolve => setTimeout(resolve, 2000).unref())]);

            if (processToClose.exitCode === null) {
                try {
                    processToClose.kill('SIGTERM');
                } catch {
                    // ignore
                }

                await Promise.race([closePromise, new Promise(resolve => setTimeout(resolve, 2000).unref())]);
            }

            if (processToClose.exitCode === null) {
                try {
                    processToClose.kill('SIGKILL');
                } catch {
                    // ignore
                }
            }

            // The child is gone: tear down the stderr pass-through so a shared stream the caller piped
            // it into deterministically drops its pipe/drain listeners, even when the child never
            // exited cleanly (e.g. a grandchild kept the child's stderr write-end open).
            if (this._stderrStream) {
                try {
                    processToClose.stderr?.unpipe(this._stderrStream);
                } catch {
                    // ignore
                }
                this._stderrStream.end();
            }

            // A pending send may still wait on a 'drain' the dead process will never emit.
            this.settlePendingSends();
        }

        this._readBuffer.clear();
    }

    /**
     * Sends a JSON-RPC message to the server over stdin.
     *
     * Resolves once the message bytes are handed to the stdin stream (`stdin.write()` accepts
     * them) — not when the child reads or processes them. That holds on the happy path and when
     * the process dies while a back-pressured send is still pending, which then resolves rather
     * than rejects: the bytes were accepted and delivery past exit is out of scope. Use
     * `onclose` — which fires exactly once — to learn the connection is gone. Rejects
     * `NotConnected` if the process is not running or has already exited.
     */
    send(message: JSONRPCMessage): Promise<void> {
        return new Promise(resolve => {
            const proc = this._process;
            if (!proc?.stdin) {
                throw new SdkError(SdkErrorCode.NotConnected, 'Not connected');
            }
            // The process may have exited while its 'close' is still pending (e.g. a grandchild
            // holds its stdio); a send then would register a drain waiter only 'close' could
            // settle. Reject as not connected instead, matching the post-close() path. (!= null
            // treats a missing exitCode/signalCode as "not yet exited", not a dead process.)
            if (proc.exitCode != null || proc.signalCode != null) {
                throw new SdkError(SdkErrorCode.NotConnected, 'Not connected');
            }

            const json = serializeMessage(message);
            if (proc.stdin.write(json)) {
                resolve();
                return;
            } else if (this._pendingDrainWaiters.length === 0) {
                // Share one 'drain' wait so back-pressure cannot accumulate listeners on stdin.
                this._drainStream = proc.stdin;
                this._drainHandler = () => {
                    this._drainHandler = undefined;
                    this._drainStream = undefined;
                    const waiters = this._pendingDrainWaiters;
                    this._pendingDrainWaiters = [];
                    for (const wait of waiters) {
                        wait();
                    }
                };
                this._drainStream.once('drain', this._drainHandler);
            }
            this._pendingDrainWaiters.push(resolve);
        });
    }

    /**
     * Resolve the send() promises still waiting on a stdin 'drain' that the process
     * will no longer emit once it is gone. They resolve rather than reject: the bytes
     * were already handed to stdin.write(), so delivery past process exit is out of scope
     * — use onclose to learn the connection is gone.
     *
     * @internal
     */
    private settlePendingSends() {
        const waiters = this._pendingDrainWaiters;
        this._pendingDrainWaiters = [];
        for (const wait of waiters) {
            wait();
        }
        // The shared 'drain' wait may still be attached to a stdin the process will never drain;
        // drop it so it does not linger on a dead stream.
        if (this._drainHandler && this._drainStream) {
            this._drainStream.removeListener('drain', this._drainHandler);
            this._drainHandler = undefined;
            this._drainStream = undefined;
        }
    }
}
