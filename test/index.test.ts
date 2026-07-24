import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as rootExport from '../src/index.js';

// Regression tests for #2273: package.json advertises a root `.` export, so a
// root source entry must exist and re-export the shared protocol surface.
describe('root package export', () => {
    it('exposes the shared protocol types and schemas', () => {
        expect(rootExport.LATEST_PROTOCOL_VERSION).toBeDefined();
        expect(rootExport.CallToolResultSchema).toBeDefined();
        expect(rootExport.JSONRPCMessageSchema).toBeDefined();
    });

    it('exposes the in-memory transport', () => {
        expect(rootExport.InMemoryTransport).toBeTypeOf('function');
    });

    it('matches the paths advertised in the package.json exports map', () => {
        const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
        const root = pkg.exports['.'];
        // The `.` export must keep pointing at the root index build outputs
        // that src/index.ts produces.
        expect(root.import).toBe('./dist/esm/index.js');
        expect(root.require).toBe('./dist/cjs/index.js');
        expect(root.types).toBe('./dist/esm/index.d.ts');
    });
});
