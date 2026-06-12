import { vi, describe, test, expect, afterEach } from 'vitest';
import { resolveRequestTimeout } from '../../src/shared/protocol.js';

/**
 * DEFAULT_REQUEST_TIMEOUT_MSEC is computed once at module load via an IIFE,
 * so each scenario needs a fresh import. We use `vi.resetModules()` +
 * dynamic `import()` to re-evaluate the module with different env state.
 *
 * For tests that stub `process` itself (undefined/null), we call
 * `resolveRequestTimeout()` directly — a full dynamic import would fail
 * because transitive dependencies (e.g. zod) also read `process`.
 */

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
});

async function loadDefault(): Promise<number> {
    const mod = await import('../../src/shared/protocol.js');
    return mod.DEFAULT_REQUEST_TIMEOUT_MSEC;
}

describe('DEFAULT_REQUEST_TIMEOUT_MSEC', () => {
    test('falls back to 60_000 when env var is not set', async () => {
        vi.stubEnv('MCP_REQUEST_TIMEOUT_MSEC', '');
        expect(await loadDefault()).toBe(60_000);
    });

    test('uses valid numeric env var', async () => {
        vi.stubEnv('MCP_REQUEST_TIMEOUT_MSEC', '120000');
        expect(await loadDefault()).toBe(120_000);
    });

    test('falls back to 60_000 for empty string', async () => {
        vi.stubEnv('MCP_REQUEST_TIMEOUT_MSEC', '');
        expect(await loadDefault()).toBe(60_000);
    });

    test('falls back to 60_000 for non-numeric string', async () => {
        vi.stubEnv('MCP_REQUEST_TIMEOUT_MSEC', 'abc');
        expect(await loadDefault()).toBe(60_000);
    });

    test('falls back to 60_000 for negative number', async () => {
        vi.stubEnv('MCP_REQUEST_TIMEOUT_MSEC', '-5000');
        expect(await loadDefault()).toBe(60_000);
    });

    test('falls back to 60_000 for zero', async () => {
        vi.stubEnv('MCP_REQUEST_TIMEOUT_MSEC', '0');
        expect(await loadDefault()).toBe(60_000);
    });

    test('falls back to 60_000 for undefined', async () => {
        vi.stubEnv('MCP_REQUEST_TIMEOUT_MSEC', undefined);
        expect(await loadDefault()).toBe(60_000);
    });

    test('falls back to 60_000 for null', async () => {
        // @ts-expect-error -- testing runtime behavior with null
        vi.stubEnv('MCP_REQUEST_TIMEOUT_MSEC', null);
        expect(await loadDefault()).toBe(60_000);
    });

    test('falls back to 60_000 for value exceeding Number.MAX_SAFE_INTEGER', async () => {
        vi.stubEnv('MCP_REQUEST_TIMEOUT_MSEC', '9007199254740993');
        expect(await loadDefault()).toBe(60_000);
    });

    test('caps at 12-hour upper bound', async () => {
        vi.stubEnv('MCP_REQUEST_TIMEOUT_MSEC', '43200001');
        expect(await loadDefault()).toBe(60_000);
    });

    test('accepts exactly 12 hours (43200000)', async () => {
        vi.stubEnv('MCP_REQUEST_TIMEOUT_MSEC', '43200000');
        expect(await loadDefault()).toBe(43_200_000);
    });

    test('falls back to 60_000 for extremely large value', async () => {
        vi.stubEnv('MCP_REQUEST_TIMEOUT_MSEC', '999999999');
        expect(await loadDefault()).toBe(60_000);
    });

    test('falls back to 60_000 when process is undefined', () => {
        vi.stubGlobal('process', undefined);
        expect(resolveRequestTimeout()).toBe(60_000);
    });

    test('falls back to 60_000 when process is null', () => {
        vi.stubGlobal('process', null);
        expect(resolveRequestTimeout()).toBe(60_000);
    });

    test('falls back to 60_000 when process.env is undefined', () => {
        const original = globalThis.process;
        vi.stubGlobal('process', { ...original, env: undefined });
        expect(resolveRequestTimeout()).toBe(60_000);
    });

    test('falls back to 60_000 when process.env is null', () => {
        const original = globalThis.process;
        vi.stubGlobal('process', { ...original, env: null });
        expect(resolveRequestTimeout()).toBe(60_000);
    });
});
