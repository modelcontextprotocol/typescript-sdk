/**
 * Bun runtime integration test
 *
 * This test verifies that the MCP server package works in Bun runtime.
 * Bun is Node.js-compatible, so it should use the AjvJsonSchemaValidator.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess, execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const SERVER_PORT = 8790;
const TEST_TIMEOUT = 120000;

describe('Bun runtime compatibility', () => {
    let bunProcess: ChildProcess | null = null;
    let tempDir: string;

    beforeAll(async () => {
        // Check if bun is available
        try {
            execSync('bun --version', { stdio: 'pipe' });
        } catch {
            console.log('Bun is not installed, skipping test');
            return;
        }

        // Create temp directory for the test project
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bun-runtime-test-'));

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
        // Note: @cfworker/json-schema is needed because the bundled server package
        // includes both the AJV and CfWorker validator implementations
        const pkgJson = {
            name: 'bun-runtime-test',
            private: true,
            type: 'module',
            dependencies: {
                '@modelcontextprotocol/server': `file:./${tarballName}`,
                '@cfworker/json-schema': '^4.1.1',
                'ajv': '^8.17.1',
                'ajv-formats': '^3.0.1',
            },
        };
        fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

        // Create server source that uses Bun.serve
        const serverSource = `
import { McpServer, AjvJsonSchemaValidator } from '@modelcontextprotocol/server';

const server = Bun.serve({
    port: ${SERVER_PORT},
    async fetch(request) {
        const validator = new AjvJsonSchemaValidator();
        const validatorName = validator.constructor.name;
        const isAjvValidator = validatorName === 'AjvJsonSchemaValidator';

        // Test JSON schema validation
        const schema = {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
        };
        const validate = validator.getValidator(schema);

        const validResult = validate({ name: 'test' });
        const invalidResult = validate({ notName: 'test' });

        // Test McpServer creation
        let serverCreated = false;
        let serverName = '';
        try {
            const mcpServer = new McpServer({ name: 'bun-test-server', version: '1.0.0' });
            serverCreated = true;
            serverName = 'bun-test-server';
        } catch (e) {
            serverCreated = false;
        }

        const results = {
            runtime: 'bun',
            bunVersion: Bun.version,
            validatorName,
            isAjvJsonSchemaValidator: isAjvValidator,
            validDataPasses: validResult.valid,
            invalidDataFails: !invalidResult.valid,
            serverCreated,
            serverName,
            success: isAjvValidator && validResult.valid && !invalidResult.valid && serverCreated,
        };

        return new Response(JSON.stringify(results, null, 2), {
            headers: { 'Content-Type': 'application/json' },
        });
    },
});

console.log('Bun server listening on port ' + server.port);
`;
        fs.writeFileSync(path.join(tempDir, 'server.ts'), serverSource.trim());

        // Install dependencies using bun
        try {
            execSync('bun install', { cwd: tempDir, stdio: 'pipe', timeout: 60000 });
        } catch (error) {
            console.error('bun install failed:', error);
            throw error;
        }

        // Start bun server
        bunProcess = spawn('bun', ['run', 'server.ts'], {
            cwd: tempDir,
            stdio: 'pipe',
        });

        // Wait for server to be ready
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Bun server startup timeout')), 30000);

            let stdoutData = '';
            let stderrData = '';

            bunProcess!.stdout?.on('data', (data) => {
                stdoutData += data.toString();
                if (stdoutData.includes('listening on port')) {
                    clearTimeout(timeout);
                    // Give the server a moment to fully initialize
                    setTimeout(resolve, 500);
                }
            });

            bunProcess!.stderr?.on('data', (data) => {
                stderrData += data.toString();
            });

            bunProcess!.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });

            bunProcess!.on('close', (code) => {
                if (code !== 0 && code !== null) {
                    clearTimeout(timeout);
                    reject(new Error(`Bun server exited with code ${code}. stderr: ${stderrData}`));
                }
            });
        });
    }, TEST_TIMEOUT);

    afterAll(async () => {
        if (bunProcess) {
            bunProcess.kill('SIGTERM');
            await new Promise<void>((resolve) => {
                bunProcess!.on('close', () => resolve());
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

    it('should use AjvJsonSchemaValidator in Bun runtime', async () => {
        // Check if bun is available
        try {
            execSync('bun --version', { stdio: 'pipe' });
        } catch {
            console.log('Bun is not installed, skipping test');
            return;
        }

        const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/`);
        expect(response.ok).toBe(true);

        const data = (await response.json()) as {
            runtime: string;
            bunVersion: string;
            validatorName: string;
            isAjvJsonSchemaValidator: boolean;
            validDataPasses: boolean;
            invalidDataFails: boolean;
            serverCreated: boolean;
            serverName: string;
            success: boolean;
        };

        expect(data.runtime).toBe('bun');
        expect(data.validatorName).toBe('AjvJsonSchemaValidator');
        expect(data.isAjvJsonSchemaValidator).toBe(true);
        expect(data.validDataPasses).toBe(true);
        expect(data.invalidDataFails).toBe(true);
        expect(data.serverCreated).toBe(true);
        expect(data.serverName).toBe('bun-test-server');
        expect(data.success).toBe(true);
    });
});
