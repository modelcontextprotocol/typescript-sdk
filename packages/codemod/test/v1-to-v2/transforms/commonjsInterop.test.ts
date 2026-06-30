import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';

import { commonjsInteropTransform } from '../../../src/migrations/v1-to-v2/transforms/commonjsInterop';
import type { TransformContext } from '../../../src/types';
import { DiagnosticLevel } from '../../../src/types';

function apply(code: string, moduleSystem: TransformContext['moduleSystem']): { text: string; changes: number } {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('test.ts', code);
    const result = commonjsInteropTransform.apply(sourceFile, { projectType: 'server', moduleSystem });
    return { text: sourceFile.getFullText(), changes: result.changesCount };
}

describe('commonjs-interop transform — no-op cases', () => {
    it('no-op for ESM target', () => {
        const code = `import { Server } from "@modelcontextprotocol/server";\nasync function f() { return new Server(); }\n`;
        const { text, changes } = apply(code, 'esm');
        expect(changes).toBe(0);
        expect(text).toContain('import { Server }');
    });

    it('no-op when only type-only v2 imports', () => {
        const code = `import type { CallToolResult } from "@modelcontextprotocol/server";\nconst x: CallToolResult = {} as CallToolResult;\n`;
        const { text, changes } = apply(code, 'commonjs');
        expect(changes).toBe(0);
        expect(text).toContain('import type { CallToolResult }');
    });

    it('no-op when no v2 imports at all', () => {
        const code = `import { readFileSync } from "node:fs";\nreadFileSync("x");\n`;
        const { changes } = apply(code, 'commonjs');
        expect(changes).toBe(0);
    });
});

function applyFull(code: string, moduleSystem: TransformContext['moduleSystem']) {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('test.ts', code);
    const result = commonjsInteropTransform.apply(sourceFile, { projectType: 'server', moduleSystem });
    return { text: sourceFile.getFullText(), result };
}

describe('commonjs-interop transform — convertibility & diagnostics', () => {
    it('diagnoses a value used in a sync constructor (not await-safe)', () => {
        const code = [
            `import { Server } from "@modelcontextprotocol/server";`,
            `class Host {`,
            `  server: Server;`,
            `  constructor() { this.server = new Server(); }`,
            `}`,
            ''
        ].join('\n');
        const { text, result } = applyFull(code, 'commonjs');
        // unchanged file
        expect(text).toContain('import { Server }');
        // one action-required diagnostic on the import line
        expect(result.diagnostics.length).toBe(1);
        expect(result.diagnostics[0]!.level).toBe(DiagnosticLevel.Warning);
        expect(result.diagnostics[0]!.insertComment).toBe(true);
        expect(result.diagnostics[0]!.message).toMatch(/ESM-only/);
    });

    it('reports convertible=true when all value usages are in async functions (no rewrite yet)', () => {
        const code = [
            `import { CallToolResultSchema } from "@modelcontextprotocol/core";`,
            `async function f(res: { body: { result: unknown } }) {`,
            `  return CallToolResultSchema.parse(res.body.result);`,
            `}`,
            ''
        ].join('\n');
        const { result } = applyFull(code, 'commonjs');
        // No diagnostics for a convertible file (rewrite lands in Task 4).
        expect(result.diagnostics.length).toBe(0);
    });

    it('emits a single advisory for unknown module system', () => {
        const code = `import { Server } from "@modelcontextprotocol/server";\nasync function f() { return new Server(); }\n`;
        const { result } = applyFull(code, 'unknown');
        expect(result.diagnostics.length).toBe(1);
        expect(result.diagnostics[0]!.message).toMatch(/could not determine|couldn't determine|unknown module/i);
    });

    it('treats a type-position usage as erased (convertible despite a type annotation)', () => {
        // The type annotation references a *separate* type-only import, so the value symbol `Server`
        // is used purely as a value (async-safe) and remains convertible. (A symbol used as BOTH a value
        // and a type is instead diagnosed — see the value-vs-type edge cases below.)
        const code = [
            `import { Server } from "@modelcontextprotocol/server";`,
            `import type { CallToolResult } from "@modelcontextprotocol/server";`,
            `let held: CallToolResult | undefined;`, // type usage of a type-only symbol — erased
            `async function f() { held = undefined; return new Server(); }`, // value usage — async-safe
            ''
        ].join('\n');
        const { result } = applyFull(code, 'commonjs');
        expect(result.diagnostics.length).toBe(0); // convertible
    });
});

describe('commonjs-interop transform — rewrite', () => {
    it('converts an async-only value import to a dynamic import()', () => {
        const code = [
            `import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/core";`,
            `class C {`,
            `  async listTools() { return ListToolsResultSchema.parse({}); }`,
            `  async callTool() { return CallToolResultSchema.parse({}); }`,
            `}`,
            ''
        ].join('\n');
        const { text } = applyFull(code, 'commonjs');
        // static value import removed
        expect(text).not.toMatch(/^import \{ CallToolResultSchema/m);
        // helper present
        expect(text).toContain('new Function("s", "return import(s)")');
        // type-only namespace import keeps the package a runner-recognized import DECLARATION (erased at runtime)
        expect(text).toMatch(/import type \* as \w+ from ["']@modelcontextprotocol\/core["']/);
        // typed module promise references that type binding (a `typeof <identifier>`, not `typeof import(...)`),
        // with the dynamic call arg still the package string
        expect(text).toMatch(/_mcpDynImport<typeof _Mcp\w+>\(["']@modelcontextprotocol\/core["']\)/);
        expect(text).not.toContain('typeof import(');
        // per-async-function destructures (only the symbols used in each)
        expect(text).toContain('const { ListToolsResultSchema } = await');
        expect(text).toContain('const { CallToolResultSchema } = await');
        // call sites unchanged
        expect(text).toContain('ListToolsResultSchema.parse({})');
        expect(text).toContain('CallToolResultSchema.parse({})');
    });

    it('keeps a type-only sibling import intact while converting the value import', () => {
        const code = [
            `import { Server } from "@modelcontextprotocol/server";`,
            `import type { CallToolResult } from "@modelcontextprotocol/server";`,
            `async function start(): Promise<CallToolResult | undefined> { const s = new Server(); return undefined; }`,
            ''
        ].join('\n');
        const { text } = applyFull(code, 'commonjs');
        expect(text).toContain('import type { CallToolResult }');
        expect(text).not.toMatch(/^import \{ Server \}/m);
        expect(text).toContain('const { Server } = await');
    });

    it('keeps an inline type sibling importable while converting the value sibling', () => {
        const code = [
            `import { Server, type CallToolResult } from "@modelcontextprotocol/server";`,
            `async function start(): Promise<CallToolResult | undefined> { const s = new Server(); return undefined; }`,
            ''
        ].join('\n');
        const { text } = applyFull(code, 'commonjs');
        // The inline `type CallToolResult` sibling survives as a type-only import.
        expect(text).toContain('import { type CallToolResult }');
        // The value `Server` is no longer statically imported; it loads dynamically.
        expect(text).not.toMatch(/^import \{ Server/m);
        expect(text).toContain('const { Server } = await');
    });

    // Regression (post-merge): the runner derives each manifest's v2 deps from the POST-transform import
    // DECLARATIONS (packages/codemod/src/runner.ts). The earlier inline `typeof import("pkg")` form is an
    // ImportTypeNode — not a declaration — and `_mcpDynImport("pkg")` is a plain call, so the converted
    // package (e.g. @modelcontextprotocol/core) was dropped from package.json → TS2307 at install even though
    // it is still used at runtime. The type-only namespace import keeps it a recognizable, runtime-erased
    // declaration that getImportDeclarations() detects.
    it('emits the converted package as an import DECLARATION the runner detects as a v2 dependency', () => {
        const code = [
            `import { CallToolResultSchema } from "@modelcontextprotocol/core";`,
            `async function f() { return CallToolResultSchema.parse({}); }`,
            ''
        ].join('\n');
        const { text } = applyFull(code, 'commonjs');
        expect(text).toMatch(/import type \* as \w+ from ["']@modelcontextprotocol\/core["']/);

        // Mirror the runner's getImportDeclarations()-based detection over the converted output.
        const probe = new Project({ useInMemoryFileSystem: true });
        const detected = probe
            .createSourceFile('out.ts', text)
            .getImportDeclarations()
            .map(d => d.getModuleSpecifierValue());
        expect(detected).toContain('@modelcontextprotocol/core');
    });
});

describe('commonjs-interop transform — edge cases', () => {
    it('converts a namespace value import to a whole-namespace destructure', () => {
        const code = [
            `import * as mcp from "@modelcontextprotocol/core";`,
            `async function f() { return mcp.CallToolResultSchema.parse({}); }`,
            ''
        ].join('\n');
        const { text } = applyFull(code, 'commonjs');
        expect(text).not.toContain('import * as mcp');
        expect(text).toContain('const mcp = await _mcpCore;');
        expect(text).toContain('mcp.CallToolResultSchema.parse({})');
    });

    it('preserves an alias in the destructure', () => {
        const code = [
            `import { CallToolResultSchema as CTR } from "@modelcontextprotocol/core";`,
            `async function f() { return CTR.parse({}); }`,
            ''
        ].join('\n');
        const { text } = applyFull(code, 'commonjs');
        expect(text).toContain('const { CallToolResultSchema: CTR } = await _mcpCore;');
        expect(text).toContain('CTR.parse({})');
    });

    it('is idempotent — a second pass makes no changes', () => {
        const code = [
            `import { CallToolResultSchema } from "@modelcontextprotocol/core";`,
            `async function f() { return CallToolResultSchema.parse({}); }`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sf = project.createSourceFile('t.ts', code);
        const ctx: TransformContext = { projectType: 'server', moduleSystem: 'commonjs' };
        commonjsInteropTransform.apply(sf, ctx);
        const afterFirst = sf.getFullText();
        const second = commonjsInteropTransform.apply(sf, ctx);
        expect(second.changesCount).toBe(0);
        expect(sf.getFullText()).toBe(afterFirst);
    });

    it('diagnoses (does not convert) an expression-bodied async arrow', () => {
        const code = [
            `import { CallToolResultSchema } from "@modelcontextprotocol/core";`,
            `export const parse = async (b: unknown) => CallToolResultSchema.parse(b);`,
            ''
        ].join('\n');
        const { text, result } = applyFull(code, 'commonjs');
        expect(text).toContain('import { CallToolResultSchema }'); // unchanged
        expect(result.diagnostics.length).toBe(1);
        expect(result.diagnostics[0]!.insertComment).toBe(true);
    });

    it('diagnoses a default import (v2 has no default export form)', () => {
        const code = [`import core from "@modelcontextprotocol/core";`, `async function f() { return core; }`, ''].join('\n');
        const { text, result } = applyFull(code, 'commonjs');
        expect(text).toContain('import core from'); // unchanged
        expect(result.diagnostics.length).toBe(1);
        // Distinct, accurate reason (not the generic "synchronous context" message).
        expect(result.diagnostics[0]!.message).toMatch(/default import/i);
        expect(result.diagnostics[0]!.message).not.toMatch(/synchronous context/i);
    });

    it('diagnoses a v2 value re-export (cannot be made dynamic)', () => {
        const code = `export { Server } from "@modelcontextprotocol/server";\n`;
        const { text, result } = applyFull(code, 'commonjs');
        expect(text).toContain('export { Server } from'); // unchanged
        expect(result.diagnostics.length).toBe(1);
        expect(result.diagnostics[0]!.message).toMatch(/re-export/i);
    });

    it('diagnoses (does not convert) a v2 value used as an async parameter default', () => {
        // The default `x = CallToolResultSchema` evaluates in parameter scope, outside the body block,
        // so a body-level `const { CallToolResultSchema } = await …;` cannot satisfy it -> must be diagnosed.
        const code = [
            `import { CallToolResultSchema } from "@modelcontextprotocol/core";`,
            `export async function f(x = CallToolResultSchema): Promise<unknown> { return (x as { parse(v: unknown): unknown }).parse({}); }`,
            ''
        ].join('\n');
        const { text, result } = applyFull(code, 'commonjs');
        expect(text).toContain('import { CallToolResultSchema }'); // unchanged — diagnosed, not converted
        expect(text).not.toContain('new Function'); // never converted to a dynamic import
        expect(result.diagnostics.length).toBe(1);
    });

    // ── Value-vs-type import handling (regression: firebase-tools broke when a value-syntax import was
    //    used only as a type — the static import was removed and the surviving type annotations broke with
    //    TS2304, plus a dead dynamic-import promise was emitted). The transform keys off value USAGE now.
    it('leaves a value-syntax import used only as a type as a static import (no-op)', () => {
        const code = [
            `import { CallToolResult } from "@modelcontextprotocol/server";`,
            `export function f(): CallToolResult { return {} as CallToolResult; }`,
            ''
        ].join('\n');
        const { text, result } = applyFull(code, 'commonjs');
        // No value reference -> TS erases the import -> nothing to convert and nothing to diagnose.
        expect(result.changesCount).toBe(0);
        expect(text).toContain('import { CallToolResult }'); // static import left intact
        expect(text).not.toContain('new Function'); // never converted to a dynamic import
        expect(result.diagnostics.length).toBe(0);
    });

    it('retains a type-only-used named sibling statically while converting the value sibling', () => {
        const code = [
            `import { CallToolResultSchema, CallToolResult } from "@modelcontextprotocol/core";`,
            `export async function f(): Promise<CallToolResult> { return CallToolResultSchema.parse({}) as CallToolResult; }`,
            ''
        ].join('\n');
        const { text } = applyFull(code, 'commonjs');
        // The value symbol is converted to a dynamic import (the only package promise, and it is awaited).
        expect(text).toContain('new Function("s", "return import(s)")');
        expect(text).toMatch(/_mcpDynImport<typeof _Mcp\w+>\(["']@modelcontextprotocol\/core["']\)/);
        expect(text).toContain('const { CallToolResultSchema } = await _mcpCore');
        // The type-only-used sibling is RETAINED as a static @modelcontextprotocol/core import (TS elides it).
        expect(text).toMatch(/import \{ CallToolResult \} from ["']@modelcontextprotocol\/core["']/);
        expect(text).toContain('CallToolResult');
        // The value symbol is no longer statically imported; the type symbol is NOT in the dynamic destructure.
        expect(text).not.toMatch(/import \{[^}]*CallToolResultSchema/);
    });

    it('diagnoses (does not convert) a symbol used as both a value and a type', () => {
        const code = [
            `import { Server } from "@modelcontextprotocol/server";`,
            `let s: Server | undefined;`,
            `export async function f(): Promise<unknown> { s = new Server(); return s; }`,
            ''
        ].join('\n');
        const { text, result } = applyFull(code, 'commonjs');
        expect(text).toContain('import { Server }'); // unchanged — diagnosed, not converted
        expect(text).not.toContain('new Function'); // converting would orphan the `: Server` type usage
        expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
    });
});
