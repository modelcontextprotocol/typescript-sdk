/**
 * Self-contained test bodies for the legacy HTTP+SSE transport surface.
 *
 * The interaction matrix exercises the legacy transport as the 'sse' column via
 * wire(); this file holds the SSE-specific surface requirements that are not
 * per-cell matrix behaviors.
 */

import { expect } from 'vitest';

import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

verifies('transport:sse:server-transport', async (_args: TestArgs) => {
    // The server half of the legacy SSE transport must be on the public server-side surface for SSE deployments to be hosted on the SDK alone.
    const surfaces = await Promise.all([
        import('@modelcontextprotocol/server'),
        import('@modelcontextprotocol/node'),
        import('@modelcontextprotocol/express'),
        import('@modelcontextprotocol/server-legacy/sse')
    ]);
    const exported = surfaces.flatMap(surface => Object.keys(surface));
    const sseServerExports = exported.filter(name => /sse/i.test(name) && /server/i.test(name));
    expect(sseServerExports.length).toBeGreaterThan(0);
});
