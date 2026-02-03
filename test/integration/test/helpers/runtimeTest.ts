/**
 * Shared utilities for runtime integration tests (Cloudflare Workers, Deno, Bun).
 */

import type { ChildProcess } from 'node:child_process';
import { execSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

/** Common MCP server setup code - registers a greet tool */
export const MCP_SERVER_SETUP = `
const server = new McpServer({ name: "test-server", version: "1.0.0" });

server.registerTool("greet", {
    description: "Greet someone"
}, async (args) => ({
    content: [{ type: "text", text: "Hello, " + (args.name || "World") + "!" }]
}));

const transport = new WebStandardStreamableHTTPServerTransport();
await server.connect(transport);
`.trim();

export interface RuntimeTestConfig {
    name: string;
    port: number;
    /** Check if runtime is available, return false to skip */
    checkAvailable: () => boolean;
    /** Extra dependencies beyond @modelcontextprotocol/server */
    extraDeps?: Record<string, string>;
    /** Extra dev dependencies */
    extraDevDeps?: Record<string, string>;
    /** Extra config files to write */
    extraFiles?: Record<string, string>;
    /** Generate the full server source code */
    generateServerSource: (port: number) => string;
    /** Spawn command and args */
    spawnCommand: string[];
    /** Pattern to detect server is ready in stdout */
    readyPattern: RegExp;
    /** Optional pattern in stderr that indicates fatal error */
    fatalErrorPattern?: RegExp;
    /** Timeout for server startup in ms */
    startupTimeout?: number;
    /** Extra delay after ready pattern detected */
    readyDelay?: number;
}

export interface RuntimeTestEnv {
    tempDir: string;
    process: ChildProcess;
    port: number;
    cleanup: () => Promise<void>;
}

/** Type assertion helper for test environment initialization */
export function assertEnvInitialized(env: RuntimeTestEnv | null): asserts env is RuntimeTestEnv {
    if (!env) {
        throw new Error('Test environment not initialized');
    }
}

export function isRuntimeAvailable(command: string): boolean {
    try {
        execSync(`${command} --version`, { stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

export async function setupRuntimeTest(config: RuntimeTestConfig): Promise<RuntimeTestEnv | null> {
    if (!config.checkAvailable()) {
        console.log(`${config.name} is not installed, skipping test`);
        return null;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${config.name.toLowerCase()}-test-`));

    // Pack server package
    const serverPkgPath = path.resolve(__dirname, '../../../../packages/server');
    const packOutput = execSync(`pnpm pack --pack-destination ${tempDir}`, {
        cwd: serverPkgPath,
        encoding: 'utf8'
    });
    const tarballName = path.basename(packOutput.trim().split('\n').pop()!);

    // Write package.json
    const pkgJson = {
        name: `${config.name.toLowerCase()}-test`,
        private: true,
        type: 'module',
        dependencies: {
            '@modelcontextprotocol/server': `file:./${tarballName}`,
            ...config.extraDeps
        },
        ...(config.extraDevDeps && { devDependencies: config.extraDevDeps })
    };
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

    // Write extra config files
    if (config.extraFiles) {
        for (const [filename, content] of Object.entries(config.extraFiles)) {
            const filePath = path.join(tempDir, filename);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, content);
        }
    }

    // Write server source
    const serverSource = config.generateServerSource(config.port);
    fs.writeFileSync(path.join(tempDir, 'server.ts'), serverSource);

    // Install dependencies
    execSync('npm install', { cwd: tempDir, stdio: 'pipe', timeout: 60_000 });

    // Start server
    const [cmd, ...args] = config.spawnCommand;
    const proc = spawn(cmd, args, {
        cwd: tempDir,
        shell: true,
        stdio: 'pipe'
    });

    // Wait for ready
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`${config.name} startup timeout`)), config.startupTimeout ?? 30_000);
        let stderrData = '';

        proc.stdout?.on('data', data => {
            if (config.readyPattern.test(data.toString())) {
                clearTimeout(timeout);
                setTimeout(resolve, config.readyDelay ?? 500);
            }
        });

        proc.stderr?.on('data', data => {
            stderrData += data.toString();
            if (config.fatalErrorPattern?.test(stderrData)) {
                clearTimeout(timeout);
                reject(new Error(`${config.name} fatal error: ${stderrData}`));
            }
        });

        proc.on('error', err => {
            clearTimeout(timeout);
            reject(err);
        });

        proc.on('close', code => {
            if (code !== 0 && code !== null) {
                clearTimeout(timeout);
                reject(new Error(`${config.name} exited with code ${code}. stderr: ${stderrData}`));
            }
        });
    });

    const cleanup = async () => {
        proc.kill('SIGTERM');
        await new Promise<void>(resolve => {
            proc.on('close', () => resolve());
            setTimeout(resolve, 5000);
        });
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    };

    return { tempDir, process: proc, port: config.port, cleanup };
}

export async function testMcpConnection(port: number): Promise<void> {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/`));

    await client.connect(transport);

    const result = await client.callTool({ name: 'greet', arguments: { name: 'World' } });
    const expectedContent = [{ type: 'text', text: 'Hello, World!' }];
    const actualJson = JSON.stringify(result.content);
    const expectedJson = JSON.stringify(expectedContent);

    if (actualJson !== expectedJson) {
        throw new Error(`Unexpected result: ${actualJson}`);
    }

    await client.close();
}
