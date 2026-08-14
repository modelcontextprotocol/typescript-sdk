import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';

import { completableNestingTransform } from '../../../src/migrations/v1-to-v2/transforms/completableNesting';
import type { TransformContext } from '../../../src/types';
import { DiagnosticLevel } from '../../../src/types';

const ctx: TransformContext = { projectType: 'server' };

function apply(code: string): { text: string; result: ReturnType<typeof completableNestingTransform.apply> } {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('test.ts', code);
    const result = completableNestingTransform.apply(sourceFile, ctx);
    return { text: sourceFile.getFullText(), result };
}

const IMPORT = `import { completable } from '@modelcontextprotocol/server';\n`;

describe('completable optional-nesting inversion', () => {
    it('hoists a postfix .optional() outside the completable call', () => {
        const { text, result } = apply(IMPORT + `const arg = completable(z.string().optional(), cb);\n`);
        expect(text).toContain('completable(z.string(), cb).optional()');
        expect(result.changesCount).toBe(1);
        expect(result.diagnostics.some(d => d.level === DiagnosticLevel.Info)).toBe(true);
    });

    it('hoists the z.optional(inner) factory form', () => {
        const { text, result } = apply(IMPORT + `const arg = completable(z.optional(z.string()), cb);\n`);
        expect(text).toContain('completable(z.string(), cb).optional()');
        expect(result.changesCount).toBe(1);
    });

    it('handles an aliased completable import', () => {
        const code = `import { completable as c } from '@modelcontextprotocol/server';\nconst arg = c(z.string().optional(), cb);\n`;
        const { text } = apply(code);
        expect(text).toContain('c(z.string(), cb).optional()');
    });

    it('handles namespace-qualified calls', () => {
        const code = `import * as mcp from '@modelcontextprotocol/server';\nconst arg = mcp.completable(z.string().optional(), cb);\n`;
        const { text } = apply(code);
        expect(text).toContain('mcp.completable(z.string(), cb).optional()');
    });

    it('still matches the v1 specifier when run in isolation', () => {
        const code = `import { completable } from '@modelcontextprotocol/sdk/server/completable.js';\nconst arg = completable(z.string().optional(), cb);\n`;
        const { text } = apply(code);
        expect(text).toContain('completable(z.string(), cb).optional()');
    });

    it('leaves the already-correct nesting untouched', () => {
        const code = IMPORT + `const arg = completable(z.string(), cb).optional();\n`;
        const { text, result } = apply(code);
        expect(text).toBe(code);
        expect(result.changesCount).toBe(0);
    });

    it('leaves plain (non-optional) schema arguments untouched', () => {
        const code = IMPORT + `const arg = completable(z.enum(['a', 'b']), cb);\n`;
        const { text, result } = apply(code);
        expect(text).toBe(code);
        expect(result.changesCount).toBe(0);
        expect(result.diagnostics).toEqual([]);
    });

    it('flags .nullish() with the concrete nullable+optional rewrite', () => {
        const { text, result } = apply(IMPORT + `const arg = completable(z.string().nullish(), cb);\n`);
        expect(text).toContain('completable(z.string().nullish(), cb)');
        expect(result.changesCount).toBe(0);
        const diag = result.diagnostics.find(d => d.insertComment);
        expect(diag?.message).toContain('completable(schema.nullable(), cb).optional()');
    });

    it('leaves wrappers that keep working in v2 (.default) untouched with no diagnostics', () => {
        const code = IMPORT + `const arg = completable(z.enum(['a', 'b']).default('a'), cb);\n`;
        const { text, result } = apply(code);
        expect(text).toBe(code);
        expect(result.changesCount).toBe(0);
        expect(result.diagnostics).toEqual([]);
    });

    it('flags an optional buried below the chain tail (.optional().describe())', () => {
        const code = IMPORT + `const arg = completable(z.string().optional().describe('country'), cb);\n`;
        const { text, result } = apply(code);
        expect(text).toBe(code);
        const diag = result.diagnostics.find(d => d.insertComment);
        expect(diag?.message).toContain('inside its method chain');
    });

    it('flags a factory-form optional buried below the chain tail', () => {
        const code = IMPORT + `const arg = completable(z.optional(z.string()).meta({ a: 1 }), cb);\n`;
        const { result } = apply(code);
        expect(result.diagnostics.some(d => d.insertComment)).toBe(true);
    });

    it('notes a by-reference schema argument once per file without a marker', () => {
        const code = IMPORT + `const arg1 = completable(schemaA, cb);\nconst arg2 = completable(schemaB, cb);\n`;
        const { result } = apply(code);
        const warnings = result.diagnostics.filter(d => d.level === DiagnosticLevel.Warning);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!.insertComment).toBeUndefined();
        expect(warnings[0]!.message).toContain('by reference');
    });

    it('ignores completable from non-MCP modules', () => {
        const code = `import { completable } from 'other-lib';\nconst arg = completable(z.string().optional(), cb);\n`;
        const { text, result } = apply(code);
        expect(text).toBe(code);
        expect(result.changesCount).toBe(0);
    });

    it('rewrites multiple calls in one file', () => {
        const code = IMPORT + `const a = completable(z.string().optional(), cbA);\nconst b = completable(z.number().optional(), cbB);\n`;
        const { text, result } = apply(code);
        expect(text).toContain('completable(z.string(), cbA).optional()');
        expect(text).toContain('completable(z.number(), cbB).optional()');
        expect(result.changesCount).toBe(2);
    });

    it('unwraps parentheses around the first argument', () => {
        const { text } = apply(IMPORT + `const arg = completable((z.string().optional()), cb);\n`);
        expect(text).toContain('completable(z.string(), cb).optional()');
    });
});

describe('opaque schema note flag', () => {
    it('marks the by-reference schema note advisory-only', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [`import { completable } from '@modelcontextprotocol/server';`, `completable(citySchema, complete);`, ''].join('\n')
        );
        const result = completableNestingTransform.apply(sourceFile, { projectType: 'server' });
        const note = result.diagnostics.find(d => d.message.includes('by reference'));
        expect(note).toBeDefined();
        expect(note?.advisoryOnly).toBe(true);
    });
});
