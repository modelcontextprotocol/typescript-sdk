/**
 * Compile-time type checks for the Transport interface.
 *
 * Verifies that a class declaring optional Transport properties as `T | undefined`
 * (the pattern required by `exactOptionalPropertyTypes: true`) is assignable to
 * Transport without TS2420 errors when compiled with the dedicated
 * exact-optional typecheck config.
 *
 * See: https://github.com/modelcontextprotocol/typescript-sdk/issues/1314
 */
import { test } from 'vitest';

import type { Transport } from '../../src/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '../../src/types/index.js';

// A concrete class that uses the explicit `| undefined` union form for optional Transport members.
// With the old Transport interface (no `| undefined` on these members), this class would produce
// TS2420 under `exactOptionalPropertyTypes: true` when compiled by tsconfig.exact-optional.json.
class ExplicitUndefinedTransport implements Transport {
    sessionId?: string | undefined;
    onclose?: (() => void) | undefined;
    onerror?: ((error: Error) => void) | undefined;
    onmessage?: (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void) | undefined;
    setProtocolVersion?: ((version: string) => void) | undefined;
    setSupportedProtocolVersions?: ((versions: string[]) => void) | undefined;

    async start(): Promise<void> {}
    async close(): Promise<void> {}
    async send(_message: JSONRPCMessage): Promise<void> {}
}

test('Transport allows explicit | undefined on optional members', () => {
    const transport: Transport = new ExplicitUndefinedTransport();
    // The mere fact this file compiles is the assertion.
    // We also verify runtime assignability here.
    expect(transport).toBeDefined();
});
