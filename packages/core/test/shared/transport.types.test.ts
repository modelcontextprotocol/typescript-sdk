/**
 * Compile-time type checks for the Transport interface.
 *
 * Verifies that a class declaring optional callback properties as `T | undefined`
 * (the pattern required by `exactOptionalPropertyTypes: true`) is assignable to
 * Transport without TS2420 errors.
 *
 * See: https://github.com/modelcontextprotocol/typescript-sdk/issues/1314
 */
import { test } from 'vitest';

import type { Transport } from '../../src/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '../../src/types/types.js';

// A concrete class that uses the explicit `| undefined` union form for optional callbacks.
// With the old Transport interface (no `| undefined` on callbacks), this class would produce
// TS2420 under `exactOptionalPropertyTypes: true`.
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

test('Transport allows explicit | undefined on optional callback properties', () => {
    const transport: Transport = new ExplicitUndefinedTransport();
    // The mere fact this file compiles is the assertion.
    // We also verify runtime assignability here.
    expect(transport).toBeDefined();
});
