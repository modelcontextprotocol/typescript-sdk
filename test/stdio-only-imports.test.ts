/**
 * Verifies that the stdio transport source files do not statically import
 * any HTTP/SSE-only optional peer dependencies.
 *
 * The package marks these dependencies as optional in `peerDependenciesMeta`,
 * so stdio-only consumers can install `@modelcontextprotocol/sdk` without them.
 * If a stdio source file ever grows a static import of an HTTP-only package,
 * stdio-only consumers would crash at module-resolution time.
 *
 * See https://github.com/modelcontextprotocol/typescript-sdk/issues/1924.
 */

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// Packages that consumers of stdio-only transports should not be required to install.
const HTTP_ONLY_PEER_DEPS = [
    '@hono/node-server',
    'hono',
    'express',
    'express-rate-limit',
    'cors',
    'eventsource',
    'eventsource-parser',
    'raw-body',
    'content-type',
    'jose'
];

const STDIO_TRANSPORT_FILES = [
    'src/client/stdio.ts',
    'src/server/stdio.ts',
    'src/shared/stdio.ts',
    'src/shared/transport.ts',
    'src/shared/protocol.ts',
    'src/types.ts',
    'src/inMemory.ts'
];

function readSrc(relPath: string): string {
    return readFileSync(join(repoRoot, relPath), 'utf-8');
}

function importsPackage(source: string, pkg: string): boolean {
    // Match common ESM import shapes: `from 'pkg'`, `from "pkg"`, `from 'pkg/sub'`,
    // `import('pkg')`, `require('pkg')`. Avoid matching `pkg-suffix` packages.
    const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?:from|import|require)\\s*\\(?\\s*['"]${escaped}(?:/[^'"]*)?['"]`);
    return pattern.test(source);
}

describe('stdio-only consumers should not need HTTP/SSE peer deps', () => {
    test.each(STDIO_TRANSPORT_FILES)('%s does not statically import any HTTP-only package', file => {
        const source = readSrc(file);
        for (const pkg of HTTP_ONLY_PEER_DEPS) {
            expect(importsPackage(source, pkg), `${file} unexpectedly imports ${pkg}`).toBe(false);
        }
    });
});
