/**
 * SEP-2792 i18n Example Client
 *
 * Demonstrates per-request language negotiation from the client side.
 * Connects to the i18n example server and exercises three language scenarios:
 *   1. "en" — explicit English
 *   2. "fr-CA,fr;q=0.9,en;q=0.5" — French Canadian with fallback
 *   3. "ja" — Japanese (forces fallback to server default)
 *
 * Run with HTTP:   tsx src/i18nClient.ts http
 * Run with stdio:  tsx src/i18nClient.ts stdio
 */

import { ACCEPT_LANGUAGE_META, Client, CONTENT_LANGUAGE_META, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const TEST_LANGUAGES = ['en', 'fr-CA,fr;q=0.9,en;q=0.5', 'ja'];

async function runWithTransport(
    transport: InstanceType<typeof StreamableHTTPClientTransport> | InstanceType<typeof StdioClientTransport>
): Promise<void> {
    const client = new Client({ name: 'i18n-example-client', version: '1.0.0' });
    await client.connect(transport);

    console.log('=== SEP-2792 i18n Client Demo ===\n');

    for (const lang of TEST_LANGUAGES) {
        console.log(`--- Accept-Language: "${lang}" ---`);

        // List tools with language preference
        const listResult = await client.listTools({
            _meta: { [ACCEPT_LANGUAGE_META]: lang }
        });

        const tool = listResult.tools[0];
        const listContentLang = listResult._meta?.[CONTENT_LANGUAGE_META];
        console.log(`  tools/list → title: "${tool?.title}", description: "${tool?.description}"`);
        console.log(`              contentLanguage: "${listContentLang}"`);

        // Call the tool with language preference
        const callResult = await client.callTool({
            name: 'get_greeting',
            arguments: { name: 'World' },
            _meta: { [ACCEPT_LANGUAGE_META]: lang }
        });

        const text = callResult.content?.[0]?.type === 'text' ? callResult.content[0].text : '(no text)';
        const callContentLang = callResult._meta?.[CONTENT_LANGUAGE_META];
        console.log(`  tools/call → text: "${text}"`);
        console.log(`              contentLanguage: "${callContentLang}"`);
        console.log('');
    }

    await client.close();
}

// ---------- Main ----------

const mode = process.argv[2] || 'stdio';
if (mode === 'http') {
    const url = process.env.MCP_URL ?? 'http://localhost:3456/mcp';
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await runWithTransport(transport);
} else {
    const transport = new StdioClientTransport({
        command: 'tsx',
        args: [new URL('../../../server/src/i18nExample.ts', import.meta.url).pathname, 'stdio']
    });
    await runWithTransport(transport);
}
