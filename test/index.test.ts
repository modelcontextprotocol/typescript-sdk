import { describe, expect, it } from 'vitest';

import { Client, ErrorCode, InMemoryTransport, LATEST_PROTOCOL_VERSION, McpError, Server } from '../src/index.js';

describe('root package exports', () => {
    it('re-exports the package root public API', () => {
        expect(Client).toBeTypeOf('function');
        expect(Server).toBeTypeOf('function');
        expect(InMemoryTransport.createLinkedPair).toBeTypeOf('function');
        expect(LATEST_PROTOCOL_VERSION).toBeTypeOf('string');

        const error = new McpError(ErrorCode.InvalidRequest, 'bad request');
        expect(error.code).toBe(ErrorCode.InvalidRequest);
    });
});
