/**
 * App-rendered form elicitation over the 2026-07-28 MRTR flow.
 *
 * The server and client negotiate one feature of the existing
 * `io.modelcontextprotocol/ui` extension. The tool returns an embedded
 * `elicitation/create` request with a complete native schema and an optional
 * `_meta.ui.resourceUri`; no second extension or result type is introduced.
 * The HTTP entry uses a per-request server factory, so its MRTR retry is
 * stateless and carries the answer only through `inputResponses`.
 */
import { serve } from '@hono/node-server';
import { parseExampleArgs } from '@mcp-examples/shared';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import type { CallToolResult, ClientCapabilities, InputRequiredResult } from '@modelcontextprotocol/server';
import { acceptedContent, CLIENT_CAPABILITIES_META_KEY, createMcpHandler, inputRequired, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui';
const APP_MIME_TYPE = 'text/html;profile=mcp-app';
const APP_URI = 'ui://delivery/choose-window.html';

const APP_HTML = `<!doctype html>
<html>
  <body>
    <main>
      <h1>Choose a delivery window</h1>
      <button data-window="morning">Morning</button>
      <button data-window="afternoon">Afternoon</button>
    </main>
  </body>
</html>`;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function supportsAppElicitation(capabilities: ClientCapabilities | undefined): boolean {
    const apps = capabilities?.extensions?.[APPS_EXTENSION_ID];
    if (!isRecord(apps)) return false;
    return (
        capabilities?.elicitation?.form !== undefined &&
        Array.isArray(apps['mimeTypes']) &&
        apps['mimeTypes'].includes(APP_MIME_TYPE) &&
        isRecord(apps['elicitation'])
    );
}

function buildServer(): McpServer {
    const mcp = new McpServer({ name: 'apps-elicitation-example-server', version: '1.0.0' });

    mcp.server.registerCapabilities({
        extensions: {
            [APPS_EXTENSION_ID]: { elicitation: {} }
        }
    });

    mcp.registerResource(
        'delivery-window-app',
        APP_URI,
        {
            description: 'Self-contained MCP App for choosing a delivery window',
            mimeType: APP_MIME_TYPE
        },
        async uri => ({
            contents: [{ uri: uri.href, mimeType: APP_MIME_TYPE, text: APP_HTML }]
        })
    );

    mcp.registerTool(
        'schedule_delivery',
        { description: 'Schedules a delivery after the user chooses a window' },
        async (ctx): Promise<CallToolResult | InputRequiredResult> => {
            const response = acceptedContent<{ window: string }>(ctx.mcpReq.inputResponses, 'delivery-window');
            if (response?.window) {
                return {
                    content: [{ type: 'text', text: `scheduled:${response.window}` }]
                };
            }

            const requestCapabilities = ctx.mcpReq.envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined;
            const useApp = supportsAppElicitation(requestCapabilities);
            return inputRequired({
                inputRequests: {
                    'delivery-window': inputRequired.elicit({
                        message: 'Choose a delivery window',
                        requestedSchema: {
                            type: 'object',
                            properties: {
                                window: {
                                    type: 'string',
                                    oneOf: [
                                        { const: 'morning', title: 'Morning' },
                                        { const: 'afternoon', title: 'Afternoon' }
                                    ]
                                }
                            },
                            required: ['window']
                        },
                        ...(useApp && {
                            _meta: {
                                ui: { resourceUri: APP_URI }
                            }
                        })
                    })
                }
            });
        }
    );

    return mcp;
}

const { transport, port } = parseExampleArgs();

if (transport === 'stdio') {
    void serveStdio(buildServer);
    console.error('[server] serving over stdio');
} else {
    // The modern HTTP path creates a fresh server for every request; the
    // elicitation result survives the MRTR boundary only in inputResponses.
    const handler = createMcpHandler(buildServer);
    const app = createMcpHonoApp();
    app.all('/mcp', c => handler.fetch(c.req.raw));
    serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
        console.error(`[server] listening on http://127.0.0.1:${port}/mcp`);
    });
}
