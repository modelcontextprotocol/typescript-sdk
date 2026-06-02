import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';

import { errorCodeSemanticsTransform } from '../../../src/migrations/v1-to-v2/transforms/errorCodeSemantics.js';
import type { TransformContext } from '../../../src/types.js';
import { DiagnosticLevel } from '../../../src/types.js';

const ctx: TransformContext = { projectType: 'client' };

function applyTransform(code: string, context: TransformContext = ctx) {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('test.ts', code);
    const result = errorCodeSemanticsTransform.apply(sourceFile, context);
    return { text: sourceFile.getFullText(), result };
}

describe('error-code-semantics transform', () => {
    it('rewrites instanceof ProtocolError guard in the same && chain', () => {
        const input = [
            `import { ProtocolError, SdkErrorCode } from '@modelcontextprotocol/client';`,
            `function handle(e: unknown) {`,
            `    if (e instanceof ProtocolError && e.code === SdkErrorCode.RequestTimeout) {`,
            `        retry();`,
            `    }`,
            `}`,
            ''
        ].join('\n');
        const { text, result } = applyTransform(input);
        expect(text).toContain('e instanceof SdkError && e.code === SdkErrorCode.RequestTimeout');
        expect(text).not.toContain('instanceof ProtocolError');
        expect(result.changesCount).toBeGreaterThan(0);
    });

    it('rewrites instanceof guard in an enclosing if statement', () => {
        const input = [
            `import { ProtocolError, SdkErrorCode } from '@modelcontextprotocol/client';`,
            `function handle(e: unknown) {`,
            `    if (e instanceof ProtocolError) {`,
            `        if (e.code === SdkErrorCode.ConnectionClosed) {`,
            `            reconnect();`,
            `        }`,
            `    }`,
            `}`,
            ''
        ].join('\n');
        const { text } = applyTransform(input);
        expect(text).toContain('e instanceof SdkError');
        expect(text).not.toContain('instanceof ProtocolError');
    });

    it('rewrites pre-rename McpError guard without touching the enum reference', () => {
        const input = [
            `import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `function handle(e: unknown) {`,
            `    if (e instanceof McpError && e.code === ErrorCode.RequestTimeout) {`,
            `        retry();`,
            `    }`,
            `}`,
            ''
        ].join('\n');
        const { text } = applyTransform(input);
        expect(text).toContain('e instanceof SdkError');
        // The enum reference itself belongs to the symbol-renames transform.
        expect(text).toContain('ErrorCode.RequestTimeout');
    });

    it('adds the SdkError import when rewriting a guard', () => {
        const input = [
            `import { ProtocolError, SdkErrorCode } from '@modelcontextprotocol/client';`,
            `declare const e: Error;`,
            `if (e instanceof ProtocolError && e.code === SdkErrorCode.RequestTimeout) { /* retry */ }`,
            ''
        ].join('\n');
        const { text } = applyTransform(input);
        expect(text).toMatch(/import \{[^}]*SdkError\b[^}]*\} from '@modelcontextprotocol\/client'/);
    });

    it('warns when a moved-member comparison has no instanceof guard', () => {
        const input = [
            `import { SdkErrorCode } from '@modelcontextprotocol/client';`,
            `declare const e: { code: unknown };`,
            `const timedOut = e.code === SdkErrorCode.RequestTimeout;`,
            ''
        ].join('\n');
        const { text, result } = applyTransform(input);
        expect(text).toContain('e.code === SdkErrorCode.RequestTimeout');
        const diag = result.diagnostics.find(d => d.level === DiagnosticLevel.Warning && d.message.includes('instanceof SdkError'));
        expect(diag).toBeDefined();
    });

    it('emits an error for an instanceof guard against an unrecognized class', () => {
        const input = [
            `import { SdkErrorCode } from '@modelcontextprotocol/client';`,
            `class CustomError extends Error { code = ''; }`,
            `declare const e: unknown;`,
            `if (e instanceof CustomError && e.code === SdkErrorCode.RequestTimeout) { /* retry */ }`,
            ''
        ].join('\n');
        const { text, result } = applyTransform(input);
        expect(text).toContain('instanceof CustomError');
        const diag = result.diagnostics.find(d => d.level === DiagnosticLevel.Error && d.message.includes('Manual fix'));
        expect(diag).toBeDefined();
    });

    it('leaves an existing instanceof SdkError guard alone', () => {
        const input = [
            `import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';`,
            `declare const e: unknown;`,
            `if (e instanceof SdkError && e.code === SdkErrorCode.RequestTimeout) { /* retry */ }`,
            ''
        ].join('\n');
        const { text, result } = applyTransform(input);
        expect(result.changesCount).toBe(0);
        expect(text).toContain('e instanceof SdkError && e.code === SdkErrorCode.RequestTimeout');
    });

    it('is idempotent', () => {
        const input = [
            `import { ProtocolError, SdkErrorCode } from '@modelcontextprotocol/client';`,
            `declare const e: unknown;`,
            `if (e instanceof ProtocolError && e.code === SdkErrorCode.ConnectionClosed) { /* reconnect */ }`,
            ''
        ].join('\n');
        const { text: first } = applyTransform(input);
        const { text: second, result } = applyTransform(first);
        expect(second).toBe(first);
        expect(result.changesCount).toBe(0);
    });

    it('errors on a switch mixing SdkErrorCode and ProtocolErrorCode cases', () => {
        const input = [
            `import { ProtocolErrorCode, SdkErrorCode } from '@modelcontextprotocol/client';`,
            `declare const e: { code: unknown };`,
            `switch (e.code) {`,
            `    case SdkErrorCode.RequestTimeout:`,
            `        retry();`,
            `        break;`,
            `    case ProtocolErrorCode.InvalidParams:`,
            `        report();`,
            `        break;`,
            `}`,
            ''
        ].join('\n');
        const { result } = applyTransform(input);
        const diag = result.diagnostics.find(d => d.level === DiagnosticLevel.Error && d.message.includes('Split into'));
        expect(diag).toBeDefined();
    });

    it('warns on a switch over moved members only', () => {
        const input = [
            `import { SdkErrorCode } from '@modelcontextprotocol/client';`,
            `declare const e: { code: unknown };`,
            `switch (e.code) {`,
            `    case SdkErrorCode.RequestTimeout:`,
            `        retry();`,
            `        break;`,
            `}`,
            ''
        ].join('\n');
        const { result } = applyTransform(input);
        const diag = result.diagnostics.find(d => d.level === DiagnosticLevel.Warning && d.message.includes('instanceof SdkError'));
        expect(diag).toBeDefined();
    });

    it('warns on maps keyed by a moved member', () => {
        const input = [
            `import { SdkErrorCode } from '@modelcontextprotocol/client';`,
            `const names = {`,
            `    [SdkErrorCode.RequestTimeout]: 'timeout'`,
            `};`,
            ''
        ].join('\n');
        const { result } = applyTransform(input);
        const diag = result.diagnostics.find(d => d.level === DiagnosticLevel.Warning && d.message.includes('string enum'));
        expect(diag).toBeDefined();
    });

    it('flags maps mixing moved members with ProtocolErrorCode keys', () => {
        const input = [
            `import { ProtocolErrorCode, SdkErrorCode } from '@modelcontextprotocol/client';`,
            `const names = {`,
            `    [SdkErrorCode.RequestTimeout]: 'timeout',`,
            `    [ProtocolErrorCode.InvalidParams]: 'invalid params'`,
            `};`,
            ''
        ].join('\n');
        const { result } = applyTransform(input);
        const diag = result.diagnostics.find(d => d.message.includes('split it into separate maps'));
        expect(diag).toBeDefined();
    });

    it('removes the import specifier when the rewritten guard was its last usage', () => {
        const input = [
            `import { ProtocolError, SdkErrorCode } from '@modelcontextprotocol/client';`,
            `function handle(e: unknown) {`,
            `    if (e instanceof ProtocolError && e.code === SdkErrorCode.RequestTimeout) {`,
            `        retry();`,
            `    }`,
            `}`,
            ''
        ].join('\n');
        const { text } = applyTransform(input);
        expect(text).not.toContain('ProtocolError');
        expect(text).toMatch(/import \{[^}]*\bSdkErrorCode\b[^}]*\} from '@modelcontextprotocol\/client'/);
        expect(text).toMatch(/import \{[^}]*\bSdkError\b[^}]*\} from '@modelcontextprotocol\/client'/);
    });

    it('keeps the import when other usages of the error class remain', () => {
        const input = [
            `import { ProtocolError, ProtocolErrorCode, SdkErrorCode } from '@modelcontextprotocol/client';`,
            `function handle(e: unknown) {`,
            `    if (e instanceof ProtocolError && e.code === SdkErrorCode.RequestTimeout) {`,
            `        retry();`,
            `    }`,
            `    throw new ProtocolError(ProtocolErrorCode.InternalError, 'failed');`,
            `}`,
            ''
        ].join('\n');
        const { text } = applyTransform(input);
        expect(text).toContain('e instanceof SdkError');
        expect(text).toMatch(/import \{[^}]*\bProtocolError\b[^}]*\} from '@modelcontextprotocol\/client'/);
        expect(text).toContain(`new ProtocolError(ProtocolErrorCode.InternalError, 'failed')`);
    });

    it('preserves the file header when removing an emptied first-statement import', () => {
        const input = [
            `#!/usr/bin/env node`,
            `// Acme retry helper.`,
            `import { McpError } from '@modelcontextprotocol/sdk/types.js';`,
            `import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `function handle(e: unknown) {`,
            `    if (e instanceof McpError && e.code === ErrorCode.RequestTimeout) {`,
            `        retry();`,
            `    }`,
            `}`,
            ''
        ].join('\n');
        const { text } = applyTransform(input);
        expect(text.startsWith('#!/usr/bin/env node')).toBe(true);
        expect(text).toContain('// Acme retry helper.');
        expect(text).not.toContain('McpError');
        expect(text).toContain('e instanceof SdkError');
        // The enum reference itself is the symbols transform's job and stays.
        expect(text).toContain('ErrorCode.RequestTimeout');
    });

    it('ignores unrelated SdkErrorCode members', () => {
        const input = [
            `import { SdkErrorCode } from '@modelcontextprotocol/client';`,
            `declare const e: { code: unknown };`,
            `const invalid = e.code === SdkErrorCode.InvalidResult;`,
            ''
        ].join('\n');
        const { result } = applyTransform(input);
        expect(result.changesCount).toBe(0);
        expect(result.diagnostics).toHaveLength(0);
    });
});
