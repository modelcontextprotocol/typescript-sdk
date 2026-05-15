/**
 * Type-checked examples for `stdio.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import { McpServer } from './mcp.js';
import { LegacyStdioServerTransport } from './stdio.js';

/**
 * Example: Basic stdio transport usage.
 */
async function LegacyStdioServerTransport_basicUsage() {
    //#region LegacyStdioServerTransport_basicUsage
    const server = new McpServer({ name: 'my-server', version: '1.0.0' });
    const transport = new LegacyStdioServerTransport();
    await server.connect(transport);
    //#endregion LegacyStdioServerTransport_basicUsage
}
