/**
 * Runnable SEP-2792 client showing per-request changes/omission, stdio-neutral
 * `_meta`, Streamable HTTP mirroring, default fallback, stable identifiers, and
 * automatic MRTR elicitation retries.
 */
import { check, parseExampleArgs, siblingPath } from '@mcp-examples/shared';
import { Client, CONTENT_LANGUAGE_META, getContentLanguage, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const { transport, url, era } = parseExampleArgs();
const client = new Client(
    { name: 'i18n-deployment-client', version: '1.0.0' },
    {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: era === 'modern' ? 'auto' : 'legacy' }
    }
);

client.setRequestHandler('elicitation/create', async request => {
    console.log(`  elicitation: ${request.params.message}`);
    return { action: 'accept', content: { approve: true } };
});

await (transport === 'stdio'
    ? client.connect(new StdioClientTransport({ command: 'npx', args: ['-y', 'tsx', siblingPath(import.meta.url, 'server.ts')] }))
    : client.connect(new StreamableHTTPClientTransport(new URL(url))));

const frenchTools = await client.listTools(undefined, { acceptLanguage: 'fr-CA, fr;q=0.9, en;q=0.5' });
check.equal(frenchTools.tools[0]?.name, 'deploy_release');
check.equal(frenchTools.tools[0]?.title, 'Déployer la version');
check.equal(getContentLanguage(frenchTools), 'fr');
console.log(`stable tool name: ${frenchTools.tools[0]?.name}; localized title: ${frenchTools.tools[0]?.title}`);

async function deploy(label: string, expectedLanguage: string, acceptLanguage?: string): Promise<void> {
    const onprogress = (progress: { message?: string; _meta?: Record<string, unknown> }) => {
        // The SDK's MRTR driver can emit local lifecycle progress too. Only the
        // server-authored, language-reported notification demonstrates SEP-2792.
        if (progress.message !== undefined && typeof progress._meta?.[CONTENT_LANGUAGE_META] === 'string') {
            console.log(`  progress: ${progress.message}`);
        }
    };
    const options = acceptLanguage === undefined ? { onprogress } : { acceptLanguage, onprogress };
    const result = await client.callTool(
        {
            name: 'deploy_release',
            arguments: { environment: 'production' }
        },
        options
    );
    check.equal(getContentLanguage(result), expectedLanguage);
    const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '(no text)';
    console.log(`${label}: ${text} [${String(result._meta?.[CONTENT_LANGUAGE_META])}]`);
}

// Consecutive calls on one connection: change, fallback, then omission. No
// preference is retained as transport/session state.
await deploy('English', 'en', 'en');
await deploy('French Canadian lookup', 'fr', 'fr-CA, fr;q=0.9');
await deploy('Unsupported Japanese falls back to server default', 'en', 'ja');
await deploy('Omitted after Japanese still uses server default', 'en');

await client.close();
