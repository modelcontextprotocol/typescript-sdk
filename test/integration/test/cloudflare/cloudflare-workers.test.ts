/**
 * Cloudflare Workers integration test
 *
 * This test verifies that the MCP server package works in Cloudflare Workers
 * WITHOUT the nodejs_compat flag, using runtime shims for cross-platform compatibility.
 *
 * TODO: Add similar integration tests for:
 * - Deno (https://deno.land/)
 * - Bun (https://bun.sh/)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess, execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const WORKER_PORT = 8787;
const TEST_TIMEOUT = 120000;

describe('Cloudflare Workers compatibility (no nodejs_compat)', () => {
    let wranglerProcess: ChildProcess | null = null;
    let tempDir: string;

    beforeAll(async () => {
        // Create temp directory for the test worker
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-worker-test-'));

        // Get the path to the server package
        const serverPkgPath = path.resolve(__dirname, '../../../../packages/server');

        // Pack the server package to get a proper tarball (pnpm pack resolves catalog: deps)
        const packOutput = execSync('pnpm pack --pack-destination ' + tempDir, {
            cwd: serverPkgPath,
            encoding: 'utf-8',
        });

        // Find the tarball path (last line of output)
        const tarballPath = packOutput.trim().split('\n').pop()!;
        const tarballName = path.basename(tarballPath);

        // Create package.json pointing to the tarball
        const pkgJson = {
            name: 'cf-worker-test',
            private: true,
            type: 'module',
            dependencies: {
                '@modelcontextprotocol/server': `file:./${tarballName}`,
                '@cfworker/json-schema': '^4.1.1',
            },
            devDependencies: {
                wrangler: '^4.0.0',
            },
        };
        fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

        // Create wrangler.jsonc WITHOUT nodejs_compat
        const wranglerConfig = {
            $schema: 'node_modules/wrangler/config-schema.json',
            name: 'cf-worker-test',
            main: 'src/index.js',
            compatibility_date: '2026-02-03',
            // NOTE: nodejs_compat is intentionally NOT included
            // The MCP server should work with runtime shims that use Web APIs
        };
        fs.writeFileSync(
            path.join(tempDir, 'wrangler.jsonc'),
            JSON.stringify(wranglerConfig, null, 2) +
                '\n// nodejs_compat is intentionally NOT included to verify Web API shims work\n'
        );

        // Create src directory
        fs.mkdirSync(path.join(tempDir, 'src'));

        // Create worker source
        const workerSource = `
import { McpServer, CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server';

export default {
    async fetch(request, env, ctx) {
        const validator = new CfWorkerJsonSchemaValidator();
        const validatorName = validator.constructor.name;
        const isCfWorkerValidator = validatorName === 'CfWorkerJsonSchemaValidator';

        const schema = {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
        };
        const validate = validator.getValidator(schema);

        const validResult = validate({ name: 'test' });
        const invalidResult = validate({ notName: 'test' });

        let serverCreated = false;
        try {
            new McpServer({ name: 'test', version: '1.0.0' });
            serverCreated = true;
        } catch {
            // Server creation failed
        }

        const results = {
            validatorName,
            isCfWorkerJsonSchemaValidator: isCfWorkerValidator,
            validDataPasses: validResult.valid,
            invalidDataFails: !invalidResult.valid,
            serverCreated,
            success: isCfWorkerValidator && validResult.valid && !invalidResult.valid && serverCreated,
        };

        return new Response(JSON.stringify(results, null, 2), {
            headers: { 'Content-Type': 'application/json' },
        });
    },
};
`;
        fs.writeFileSync(path.join(tempDir, 'src', 'index.js'), workerSource.trim());

        // Install dependencies using npm
        try {
            execSync('npm install', { cwd: tempDir, stdio: 'pipe', timeout: 60000 });
        } catch (error) {
            console.error('npm install failed:', error);
            throw error;
        }

        // Start wrangler dev server
        wranglerProcess = spawn('npx', ['wrangler', 'dev', '--local', '--port', String(WORKER_PORT)], {
            cwd: tempDir,
            shell: true,
            stdio: 'pipe',
        });

        // Wait for server to be ready
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Wrangler startup timeout')), 30000);

            let stdoutData = '';
            let stderrData = '';

            wranglerProcess!.stdout?.on('data', (data) => {
                stdoutData += data.toString();
                if (stdoutData.includes('Ready on') || stdoutData.includes('Listening on')) {
                    clearTimeout(timeout);
                    setTimeout(resolve, 1000);
                }
            });

            wranglerProcess!.stderr?.on('data', (data) => {
                stderrData += data.toString();
                // Check for fatal errors that indicate the worker won't start
                if (stderrData.includes('No such module "node:')) {
                    clearTimeout(timeout);
                    reject(new Error(`Worker failed to start - missing Node.js module: ${stderrData}`));
                }
            });

            wranglerProcess!.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });

            wranglerProcess!.on('close', (code) => {
                if (code !== 0 && code !== null) {
                    clearTimeout(timeout);
                    reject(new Error(`Wrangler exited with code ${code}. stderr: ${stderrData}`));
                }
            });
        });
    }, TEST_TIMEOUT);

    afterAll(async () => {
        if (wranglerProcess) {
            wranglerProcess.kill('SIGTERM');
            await new Promise<void>((resolve) => {
                wranglerProcess!.on('close', () => resolve());
                setTimeout(resolve, 5000);
            });
        }

        // Cleanup temp directory
        if (tempDir) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch {
                // Ignore cleanup errors
            }
        }
    });

    it('should use CfWorkerJsonSchemaValidator in workerd environment', async () => {
        const response = await fetch(`http://127.0.0.1:${WORKER_PORT}/`);
        expect(response.ok).toBe(true);

        const data = (await response.json()) as {
            validatorName: string;
            isCfWorkerJsonSchemaValidator: boolean;
            validDataPasses: boolean;
            invalidDataFails: boolean;
            serverCreated: boolean;
            success: boolean;
        };

        expect(data.validatorName).toBe('CfWorkerJsonSchemaValidator');
        expect(data.isCfWorkerJsonSchemaValidator).toBe(true);
        expect(data.validDataPasses).toBe(true);
        expect(data.invalidDataFails).toBe(true);
        expect(data.serverCreated).toBe(true);
        expect(data.success).toBe(true);
    });
});
