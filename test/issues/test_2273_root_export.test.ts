/**
 * Regression test for https://github.com/modelcontextprotocol/typescript-sdk/issues/2273
 *
 * `package.json` advertises a root `.` export that maps to
 * `dist/{esm,cjs}/index.{js,d.ts}`, but v1.x had no `src/index.ts`, so `tsc`
 * emitted nothing for the root and importing `@modelcontextprotocol/sdk` failed
 * with `ERR_MODULE_NOT_FOUND` before any consumer code ran.
 *
 * This exercises the root barrel directly (the same module `tsc` compiles into
 * the advertised dist files): it must resolve and re-export the shared protocol
 * surface and the in-memory transport.
 */

import { describe, it, expect } from 'vitest';
import * as root from '../../src/index.js';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, JSONRPC_VERSION, InMemoryTransport } from '../../src/index.js';

describe('root package export (#2273)', () => {
    it('re-exports the shared protocol constants', () => {
        expect(LATEST_PROTOCOL_VERSION).toBe('2025-11-25');
        expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(LATEST_PROTOCOL_VERSION);
        expect(JSONRPC_VERSION).toBe('2.0');
    });

    it('re-exports the in-memory transport as a working class', () => {
        expect(typeof InMemoryTransport).toBe('function');
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        expect(clientTransport).toBeInstanceOf(InMemoryTransport);
        expect(serverTransport).toBeInstanceOf(InMemoryTransport);
    });

    it('re-exports a non-empty protocol surface', () => {
        expect(Object.keys(root).length).toBeGreaterThan(0);
    });
});
