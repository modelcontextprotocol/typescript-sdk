import { describe, expect, test } from 'vitest';

import * as serverIndex from '../src/server/index.js';
import * as serverMcp from '../src/server/mcp.js';
import * as serverStdio from '../src/server/stdio.js';
import * as serverSHttp from '../src/server/streamableHttp.js';
import * as sharedProtocol from '../src/shared/protocol.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '../src/types.js';

describe('@modelcontextprotocol/sdk meta-package v1 paths', () => {
    test('types.js re-exports zod schemas + error aliases', () => {
        expect(CallToolRequestSchema).toBeDefined();
        expect(ListToolsRequestSchema).toBeDefined();
        expect(McpError).toBeDefined();
        expect(ErrorCode.MethodNotFound).toBeDefined();
    });

    test('server/mcp.js exports McpServer', () => {
        expect(serverMcp.McpServer).toBeDefined();
        expect(serverMcp.ResourceTemplate).toBeDefined();
    });

    test('server/index.js exports Server (alias)', () => {
        expect(serverIndex.Server).toBeDefined();
    });

    test('server/stdio.js exports StdioServerTransport', () => {
        expect(serverStdio.StdioServerTransport).toBeDefined();
    });

    test('server/streamableHttp.js exports the v1 alias', () => {
        expect(serverSHttp.StreamableHTTPServerTransport).toBeDefined();
        expect(serverSHttp.NodeStreamableHTTPServerTransport).toBeDefined();
    });

    test('shared/protocol.js exports Protocol + RequestHandlerExtra type alias', () => {
        expect(sharedProtocol.Protocol).toBeDefined();
        expect(sharedProtocol.DEFAULT_REQUEST_TIMEOUT_MSEC).toBeGreaterThan(0);
    });
});
