/**
 * SEP-2792 i18n example client — demonstrates per-request language negotiation.
 *
 * Calls the i18n example server with different language preferences, showing:
 * - Setting `acceptLanguage` in request `_meta`
 * - Reading `contentLanguage` from response `_meta`
 * - Fallback behavior for unmatched locales
 * - Mid-conversation language switching over stdio
 */
import { parseExampleArgs } from '@mcp-examples/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
    ACCEPT_LANGUAGE_META,
    CONTENT_LANGUAGE_META
} from '@modelcontextprotocol/server';

async function callGreeting(client: Client, acceptLanguage: string): Promise<void> {
    const result = await client.callTool({
        name: 'get_greeting',
        arguments: {},
        _meta: { [ACCEPT_LANGUAGE_META]: acceptLanguage }
    });

    const content = result.content as Array<{ type: string; text?: string }> | undefined;
    const text = content?.[0]?.type === 'text' ? content[0].text : '(no text)';
    const contentLang = (result as { _meta?: Record<string, unknown> })._meta?.[CONTENT_LANGUAGE_META] ?? '(none)';
    console.log(`  Accept-Language: ${acceptLanguage}`);
    console.log(`  Response text:   ${text}`);
    console.log(`  Content-Language: ${contentLang}`);
    console.log();
}

async function run(): Promise<void> {
    const { transport: mode, port, url } = parseExampleArgs();

    let client: Client;

    if (mode === 'stdio') {
        const transport = new StdioClientTransport({
            command: 'tsx',
            args: ['server.ts'],
            cwd: import.meta.dirname
        });
        client = new Client({ name: 'i18n-client', version: '1.0.0' });
        await client.connect(transport);
    } else {
        const transport = new StreamableHTTPClientTransport(new URL(url));
        client = new Client({ name: 'i18n-client', version: '1.0.0' });
        await client.connect(transport);
    }

    console.log('=== SEP-2792 i18n Example ===\n');

    // 1. English (exact match)
    console.log('1. Requesting English:');
    await callGreeting(client, 'en');

    // 2. French-Canadian (RFC 4647 lookup -> fr)
    console.log('2. Requesting French-Canadian (falls back to fr):');
    await callGreeting(client, 'fr-CA, fr;q=0.9, en;q=0.5');

    // 3. German
    console.log('3. Requesting German:');
    await callGreeting(client, 'de-DE');

    // 4. Japanese (unmatched -> falls back to en)
    console.log('4. Requesting Japanese (unmatched, falls back to en):');
    await callGreeting(client, 'ja');

    // 5. Mid-conversation switch: en -> de (demonstrates per-request scope)
    console.log('5. Mid-conversation switch (en then de):');
    await callGreeting(client, 'en');
    await callGreeting(client, 'de');

    await client.close();
    console.log('Done.');
}

run().then(
    () => process.exit(0),
    (err) => { console.error(err); process.exit(1); }
);
