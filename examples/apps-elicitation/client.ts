/**
 * Headless host for the app-rendered elicitation server.
 *
 * A graphical host would initialize the resource as an MCP App and forward
 * the unchanged `elicitation/create` request over its App bridge. This
 * deterministic example exercises the surrounding SDK contract: two-sided
 * extension negotiation, same-connection resource loading, and the automatic
 * MRTR retry with `inputResponses`. On the HTTP leg, that retry reaches a fresh
 * per-request server instance, demonstrating that the flow is stateless.
 */
import { check, parseExampleArgs, siblingPath } from '@mcp-examples/shared';
import type { ElicitRequest } from '@modelcontextprotocol/client';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui';
const APP_MIME_TYPE = 'text/html;profile=mcp-app';

const { transport, url } = parseExampleArgs();

const client = new Client(
    { name: 'apps-elicitation-example-client', version: '1.0.0' },
    {
        versionNegotiation: { mode: { pin: '2026-07-28' } },
        capabilities: {
            elicitation: { form: {} },
            extensions: {
                [APPS_EXTENSION_ID]: {
                    mimeTypes: [APP_MIME_TYPE],
                    elicitation: {}
                }
            }
        }
    }
);

client.setRequestHandler('elicitation/create', async request => {
    const typed = request as ElicitRequest;
    check.equal(typed.params.mode, 'form');

    const serverApps = client.getServerCapabilities()?.extensions?.[APPS_EXTENSION_ID] as Record<string, unknown> | undefined;
    check.ok(serverApps?.['elicitation'] !== undefined, 'server must advertise MCP Apps elicitation');

    const resourceUri = (typed.params._meta?.['ui'] as { resourceUri?: unknown } | undefined)?.resourceUri;
    check.ok(typeof resourceUri === 'string' && resourceUri.startsWith('ui://'), 'request must bind an MCP App resource');

    const resource = await client.readResource({ uri: resourceUri as string });
    const html = resource.contents.find(content => 'text' in content && content.mimeType === APP_MIME_TYPE);
    check.ok(html !== undefined && 'text' in html && html.text.includes('Choose a delivery window'));

    // A real host forwards the unchanged request to the initialized App and
    // validates the returned ElicitResult. The example chooses deterministically.
    return { action: 'accept', content: { window: 'morning' } };
});

await client.connect(
    transport === 'stdio'
        ? new StdioClientTransport({ command: 'npx', args: ['-y', 'tsx', siblingPath(import.meta.url, 'server.ts')] })
        : new StreamableHTTPClientTransport(new URL(url))
);

const result = await client.callTool({ name: 'schedule_delivery', arguments: {} });
const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
check.equal(text, 'scheduled:morning');

await client.close();
