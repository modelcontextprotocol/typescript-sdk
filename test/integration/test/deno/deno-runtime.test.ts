/**
 * Deno runtime integration test
 *
 * This test verifies that the MCP server package works in Deno runtime
 * using node_modules and the default Node.js-compatible shims.
 *
 * Deno has good Node.js compatibility, so it should use the default shims
 * (AjvJsonSchemaValidator) rather than the Cloudflare Workers shims.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess, execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const DENO_PORT = 8789;
const TEST_TIMEOUT = 120000;

describe('Deno runtime compatibility', () => {
    let denoProcess: ChildProcess | null = null;
    let tempDir: string;

    beforeAll(async () => {
        // Check if Deno is installed
        try {
            execSync('deno --version', { stdio: 'pipe' });
        } catch {
            console.log('Deno is not installed, skipping test');
            return;
        }

        // Create temp directory for the test project
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deno-mcp-test-'));

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

        // Create package.json pointing to the tarball (Deno can use node_modules)
        // Include both ajv (for Node.js-compatible validation) and @cfworker/json-schema
        // (because the bundled code may reference it at module resolution time)
        const pkgJson = {
            name: 'deno-mcp-test',
            private: true,
            type: 'module',
            dependencies: {
                '@modelcontextprotocol/server': `file:./${tarballName}`,
                '@cfworker/json-schema': '^4.1.1',
                ajv: '^8.17.1',
                'ajv-formats': '^3.0.1',
            },
        };
        fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

        // Create a simple Deno server script that tests MCP functionality
        // Using bare import from node_modules (configured via deno.json)
        const serverSource = `
// Deno server script that tests MCP SDK compatibility
import { McpServer, AjvJsonSchemaValidator } from "@modelcontextprotocol/server";

const PORT = ${DENO_PORT};

// Test JSON Schema validation with AjvJsonSchemaValidator (default for Node.js-compatible runtimes)
const validator = new AjvJsonSchemaValidator();
const validatorName = validator.constructor.name;
const isAjvValidator = validatorName === 'AjvJsonSchemaValidator';

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
let serverError: string | null = null;
try {
    const server = new McpServer({ name: 'deno-test-server', version: '1.0.0' });
    serverCreated = true;
} catch (e) {
    serverCreated = false;
    serverError = e instanceof Error ? e.message : String(e);
}

const results = {
    runtime: 'deno',
    denoVersion: Deno.version.deno,
    validatorName,
    isAjvJsonSchemaValidator: isAjvValidator,
    validDataPasses: validResult.valid,
    invalidDataFails: !invalidResult.valid,
    serverCreated,
    serverError,
    success: isAjvValidator && validResult.valid && !invalidResult.valid && serverCreated,
};

console.log('MCP SDK Test Results:', JSON.stringify(results, null, 2));
console.log('Server starting on port', PORT);

Deno.serve({ port: PORT }, (_req) => {
    return new Response(JSON.stringify(results, null, 2), {
        headers: { 'Content-Type': 'application/json' },
    });
});
`;
        fs.writeFileSync(path.join(tempDir, 'server.ts'), serverSource.trim());

        // Create deno.json configuration to use node_modules with "byonm" (bring your own node_modules)
        const denoConfig = {
            nodeModulesDir: 'manual',
            unstable: ['byonm'],
        };
        fs.writeFileSync(path.join(tempDir, 'deno.json'), JSON.stringify(denoConfig, null, 2));

        // Install dependencies using npm (Deno will read from node_modules)
        try {
            execSync('npm install', { cwd: tempDir, stdio: 'pipe', timeout: 60000 });
        } catch (error) {
            console.error('npm install failed:', error);
            throw error;
        }

        // Start Deno server with necessary permissions
        denoProcess = spawn(
            'deno',
            ['run', '--allow-net', '--allow-read', '--allow-env', 'server.ts'],
            {
                cwd: tempDir,
                shell: true,
                stdio: 'pipe',
            }
        );

        // Wait for server to be ready
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Deno startup timeout')), 60000);

            let stdoutData = '';
            let stderrData = '';

            denoProcess!.stdout?.on('data', (data) => {
                stdoutData += data.toString();
                console.log('[Deno stdout]:', data.toString());
                if (stdoutData.includes('Server starting on port') || stdoutData.includes('Listening on')) {
                    clearTimeout(timeout);
                    // Give the server a moment to fully start
                    setTimeout(resolve, 2000);
                }
            });

            denoProcess!.stderr?.on('data', (data) => {
                stderrData += data.toString();
                console.log('[Deno stderr]:', data.toString());
            });

            denoProcess!.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });

            denoProcess!.on('close', (code) => {
                if (code !== 0 && code !== null) {
                    clearTimeout(timeout);
                    reject(new Error(`Deno exited with code ${code}. stderr: ${stderrData}`));
                }
            });
        });
    }, TEST_TIMEOUT);

    afterAll(async () => {
        if (denoProcess) {
            denoProcess.kill('SIGTERM');
            await new Promise<void>((resolve) => {
                denoProcess!.on('close', () => resolve());
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

    it('should use AjvJsonSchemaValidator in Deno environment', async () => {
        // Check if Deno is installed
        try {
            execSync('deno --version', { stdio: 'pipe' });
        } catch {
            console.log('Deno is not installed, skipping test');
            return;
        }

        const response = await fetch(`http://127.0.0.1:${DENO_PORT}/`);
        expect(response.ok).toBe(true);

        const data = (await response.json()) as {
            runtime: string;
            denoVersion: string;
            validatorName: string;
            isAjvJsonSchemaValidator: boolean;
            validDataPasses: boolean;
            invalidDataFails: boolean;
            serverCreated: boolean;
            serverError: string | null;
            success: boolean;
        };

        expect(data.runtime).toBe('deno');
        expect(data.validatorName).toBe('AjvJsonSchemaValidator');
        expect(data.isAjvJsonSchemaValidator).toBe(true);
        expect(data.validDataPasses).toBe(true);
        expect(data.invalidDataFails).toBe(true);
        expect(data.serverCreated).toBe(true);
        expect(data.serverError).toBeNull();
        expect(data.success).toBe(true);
    });
});
