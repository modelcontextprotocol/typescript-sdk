import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { getMigration } from '../src/migrations/index';
import { run } from '../src/runner';
import { CODEMOD_ERROR_PREFIX } from '../src/utils/diagnostics';

const migration = getMigration('v1-to-v2')!;

let tempDir: string;

function createTempDir(): string {
    tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-codemod-comment-test-'));
    return tempDir;
}

afterEach(() => {
    if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
    }
});

describe('comment insertion', () => {
    it('inserts @mcp-codemod-error comment above an action-required location', () => {
        const dir = createTempDir();
        // handler with custom schema identifier triggers actionRequired in handlerRegistration
        const input = [
            `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `import { MyCustomSchema } from '@modelcontextprotocol/sdk/types.js';`,
            ``,
            `const server = new McpServer({ name: 'test', version: '1.0' });`,
            `server.setRequestHandler(MyCustomSchema, async (req, extra) => {`,
            `    return {};`,
            `});`,
            ``
        ].join('\n');
        writeFileSync(path.join(dir, 'server.ts'), input);

        const result = run(migration, { targetDir: dir });

        const output = readFileSync(path.join(dir, 'server.ts'), 'utf8');
        expect(output).toContain(CODEMOD_ERROR_PREFIX);
        expect(result.commentCount).toBeGreaterThan(0);
    });

    it('does not insert comments on dry-run', () => {
        const dir = createTempDir();
        const input = [
            `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `import { MyCustomSchema } from '@modelcontextprotocol/sdk/types.js';`,
            ``,
            `const server = new McpServer({ name: 'test', version: '1.0' });`,
            `server.setRequestHandler(MyCustomSchema, async (req, extra) => {`,
            `    return {};`,
            `});`,
            ``
        ].join('\n');
        writeFileSync(path.join(dir, 'server.ts'), input);

        const result = run(migration, { targetDir: dir, dryRun: true });

        const output = readFileSync(path.join(dir, 'server.ts'), 'utf8');
        expect(output).not.toContain(CODEMOD_ERROR_PREFIX);
        expect(output).toBe(input);
        expect(result.commentCount).toBe(0);
    });

    it('does not insert comments for regular warnings (verification-type)', () => {
        const dir = createTempDir();
        // ErrorCode split produces verification warnings, not actionRequired
        const input = [
            `import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `const code = ErrorCode.InvalidParams;`,
            `const timeout = ErrorCode.RequestTimeout;`,
            ``
        ].join('\n');
        writeFileSync(path.join(dir, 'server.ts'), input);

        const result = run(migration, { targetDir: dir });

        const output = readFileSync(path.join(dir, 'server.ts'), 'utf8');
        expect(output).not.toContain(CODEMOD_ERROR_PREFIX);
        expect(result.commentCount).toBe(0);
    });

    it('inserts multiple comments in one file in correct positions', () => {
        const dir = createTempDir();
        // Two custom-schema handler registrations on different lines trigger two actionRequired diagnostics
        const input = [
            `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `const server = new McpServer({ name: 'test', version: '1.0' });`,
            `server.setRequestHandler(FooSchema, async () => ({}));`,
            `server.setRequestHandler(BarSchema, async () => ({}));`,
            ``
        ].join('\n');
        writeFileSync(path.join(dir, 'server.ts'), input);

        const result = run(migration, { targetDir: dir });

        const output = readFileSync(path.join(dir, 'server.ts'), 'utf8');
        const commentLines = output.split('\n').filter(l => l.includes(CODEMOD_ERROR_PREFIX));
        expect(commentLines.length).toBe(2);
        expect(result.commentCount).toBe(2);
    });

    it('preserves indentation of the target line', () => {
        const dir = createTempDir();
        const input = [
            `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `function register(server: McpServer) {`,
            `    server.setRequestHandler(FooSchema, async () => ({}));`,
            `}`,
            ``
        ].join('\n');
        writeFileSync(path.join(dir, 'server.ts'), input);

        run(migration, { targetDir: dir });

        const output = readFileSync(path.join(dir, 'server.ts'), 'utf8');
        const commentLine = output.split('\n').find(l => l.includes(CODEMOD_ERROR_PREFIX))!;
        expect(commentLine).toMatch(/^    \/\*/);
    });

    it('does not duplicate comments on re-run (idempotency)', () => {
        const dir = createTempDir();
        const input = [
            `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `const server = new McpServer({ name: 'test', version: '1.0' });`,
            `server.setRequestHandler(FooSchema, async () => ({}));`,
            ``
        ].join('\n');
        writeFileSync(path.join(dir, 'server.ts'), input);

        run(migration, { targetDir: dir });
        const afterFirst = readFileSync(path.join(dir, 'server.ts'), 'utf8');
        const firstCount = afterFirst.split('\n').filter(l => l.includes(CODEMOD_ERROR_PREFIX)).length;

        // Run again on the already-transformed file
        run(migration, { targetDir: dir });
        const afterSecond = readFileSync(path.join(dir, 'server.ts'), 'utf8');
        const secondCount = afterSecond.split('\n').filter(l => l.includes(CODEMOD_ERROR_PREFIX)).length;

        expect(firstCount).toBe(1);
        expect(secondCount).toBe(firstCount);
    });

    it('sanitizes */ in diagnostic messages', () => {
        const dir = createTempDir();
        // The handler diagnostic message doesn't contain */, but we verify the comment is well-formed
        const input = [
            `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `const server = new McpServer({ name: 'test', version: '1.0' });`,
            `server.setRequestHandler(FooSchema, async () => ({}));`,
            ``
        ].join('\n');
        writeFileSync(path.join(dir, 'server.ts'), input);

        run(migration, { targetDir: dir });

        const output = readFileSync(path.join(dir, 'server.ts'), 'utf8');
        const commentLine = output.split('\n').find(l => l.includes(CODEMOD_ERROR_PREFIX))!;
        // Comment must be well-formed: starts with /* and ends with */
        expect(commentLine.trim()).toMatch(/^\/\*.*\*\/$/);
    });

    it('places comments at correct line after import-path transform shifts lines', () => {
        const dir = createTempDir();
        // Import rewrite adds new import lines (splitting into multiple packages),
        // then handler transform emits actionRequired. The comment must land at the correct post-shift line.
        const input = [
            `import { McpServer, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            ``,
            `const server = new McpServer({ name: 'test', version: '1.0' });`,
            `server.setRequestHandler(FooSchema, async () => ({}));`,
            ``
        ].join('\n');
        writeFileSync(path.join(dir, 'server.ts'), input);

        run(migration, { targetDir: dir });

        const output = readFileSync(path.join(dir, 'server.ts'), 'utf8');
        const lines = output.split('\n');
        const commentIdx = lines.findIndex(l => l.includes(CODEMOD_ERROR_PREFIX));
        expect(commentIdx).toBeGreaterThan(-1);
        // The comment should be directly above the handler line (which may have moved)
        const nextLine = lines[commentIdx + 1]!;
        expect(nextLine).toContain('setRequestHandler');
    });

    it('reports a diagnostic line matching the saved file when a dropped shebang is restored', () => {
        const dir = createTempDir();
        // The imports transform drops the leading `#!` shebang (it is leading trivia of the first
        // import); the runner restores it before saving. The reported diagnostic line must account for
        // the restored shebang, i.e. point at the line it actually occupies in the saved file — not the
        // shebang-stripped text it was resolved against.
        const input = [
            `#!/usr/bin/env node`,
            ``,
            `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `const server = new McpServer({ name: 'test', version: '1.0' });`,
            `server.setRequestHandler(FooSchema, async () => ({}));`,
            ``
        ].join('\n');
        writeFileSync(path.join(dir, 'cli.ts'), input);

        const result = run(migration, { targetDir: dir });

        const output = readFileSync(path.join(dir, 'cli.ts'), 'utf8');
        // Shebang survived the migration...
        expect(output.startsWith('#!/usr/bin/env node\n')).toBe(true);
        // ...and the comment-bearing diagnostic's reported line points exactly at its inserted
        // @mcp-codemod-error comment in the saved file (regression guard: without the shebang
        // adjustment the line is N=2 too high and lands on unrelated code).
        const diag = result.diagnostics.find(d => d.insertComment)!;
        expect(diag).toBeDefined();
        const outputLines = output.split('\n');
        expect(outputLines[diag.line - 1]).toContain(CODEMOD_ERROR_PREFIX);
    });

    it('merges same-line diagnostics into a single comment', () => {
        const dir = createTempDir();
        // Two custom-schema handler registrations on the SAME physical line -> two same-line diagnostics
        const input = [
            `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `const server = new McpServer({ name: 'test', version: '1.0' });`,
            `server.setRequestHandler(FooSchema, async () => ({})); server.setRequestHandler(BarSchema, async () => ({}));`,
            ``
        ].join('\n');
        writeFileSync(path.join(dir, 'server.ts'), input);

        const result = run(migration, { targetDir: dir });

        const output = readFileSync(path.join(dir, 'server.ts'), 'utf8');
        const commentLines = output.split('\n').filter(l => l.includes(CODEMOD_ERROR_PREFIX));
        expect(commentLines.length).toBe(1);
        expect(commentLines[0]).toContain(' | ');
        expect(result.commentCount).toBe(1);
    });

    it('skips comment insertion when target line is inside a template literal', () => {
        const dir = createTempDir();
        const input = [
            "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
            "const server = new McpServer({ name: 'test', version: '1.0' });",
            'const msg = `',
            '  Result: ${server.setRequestHandler(FooSchema, async () => ({}))}',
            '`;',
            ''
        ].join('\n');
        writeFileSync(path.join(dir, 'server.ts'), input);

        const result = run(migration, { targetDir: dir });

        const output = readFileSync(path.join(dir, 'server.ts'), 'utf8');
        // The diagnostic should still be reported
        expect(result.diagnostics.some(d => d.insertComment)).toBe(true);
        // But no comment should be injected inside the template literal
        expect(result.commentCount).toBe(0);
        // Verify the template literal is not corrupted
        expect(output).not.toContain('/* ' + CODEMOD_ERROR_PREFIX);
    });

    it('skips comment insertion when target line is inside template text after interpolation', () => {
        const dir = createTempDir();
        // TemplateMiddle: text between two ${} spans
        const input = [
            "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
            "const server = new McpServer({ name: 'test', version: '1.0' });",
            'const msg = `${somePrefix}',
            '  A: ${server.setRequestHandler(FooSchema, async () => ({}))}',
            '  B: ${server.setRequestHandler(BarSchema, async () => ({}))}',
            '`;',
            ''
        ].join('\n');
        writeFileSync(path.join(dir, 'server.ts'), input);

        const result = run(migration, { targetDir: dir });

        const output = readFileSync(path.join(dir, 'server.ts'), 'utf8');
        expect(result.diagnostics.filter(d => d.insertComment).length).toBeGreaterThanOrEqual(2);
        expect(result.commentCount).toBe(0);
        expect(output).not.toContain('/* ' + CODEMOD_ERROR_PREFIX);
    });

    it('still inserts comment when diagnostic line merely contains a template literal', () => {
        const dir = createTempDir();
        // The handler call and template are on the same line, but lineStart is at "server",
        // which is outside the template literal.
        const input = [
            "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
            "const server = new McpServer({ name: 'test', version: '1.0' });",
            'server.setRequestHandler(FooSchema, async () => ({ msg: `template ${data}` }));',
            ''
        ].join('\n');
        writeFileSync(path.join(dir, 'server.ts'), input);

        const result = run(migration, { targetDir: dir });

        const output = readFileSync(path.join(dir, 'server.ts'), 'utf8');
        expect(result.diagnostics.some(d => d.insertComment)).toBe(true);
        expect(result.commentCount).toBeGreaterThan(0);
        const lines = output.split('\n');
        const commentIdx = lines.findIndex(l => l.includes(CODEMOD_ERROR_PREFIX));
        expect(commentIdx).toBeGreaterThan(-1);
        expect(lines[commentIdx]!.trim()).toMatch(/^\/\*.*\*\/$/);
    });

    it('handles CRLF line endings without corrupting the file', () => {
        const dir = createTempDir();
        const input = [
            `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `const server = new McpServer({ name: 'test', version: '1.0' });`,
            `server.setRequestHandler(FooSchema, async () => ({}));`,
            ``
        ].join('\r\n');
        writeFileSync(path.join(dir, 'server.ts'), input);

        run(migration, { targetDir: dir });

        const output = readFileSync(path.join(dir, 'server.ts'), 'utf8');
        expect(output).toContain(CODEMOD_ERROR_PREFIX);
        const lines = output.split(/\r?\n/);
        const commentIdx = lines.findIndex(l => l.includes(CODEMOD_ERROR_PREFIX));
        expect(commentIdx).toBeGreaterThan(-1);
        expect(lines[commentIdx]!.trim()).toMatch(/^\/\*.*\*\/$/);
        expect(lines[commentIdx + 1]).toContain('setRequestHandler');
    });
});
