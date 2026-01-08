import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

async function main() {
    const url = new URL('http://localhost:3456/mcp');

    const client = new Client({
        name: 'session-recovery-test-client',
        version: '1.0.0'
    });

    console.log('[CLIENT] Creating transport with session recovery enabled...');

    const transport = new StreamableHTTPClientTransport(url, {
        sessionRecovery: true,
        onSessionRecovery: async (error) => {
            console.log(`[CLIENT] ⚡ Session recovery triggered! Error: ${error.message}`);
            console.log(`[CLIENT] ⚡ Re-initializing client connection...`);
            // Re-initialize the MCP session
            await client.connect(transport);
            console.log(`[CLIENT] ⚡ Re-initialized! New session ID: ${transport.sessionId}`);
        }
    });

    console.log('[CLIENT] Connecting to server...');
    await client.connect(transport);
    console.log(`[CLIENT] Connected! Session ID: ${transport.sessionId}`);

    // First call - should work
    console.log('\n[CLIENT] Making first tool call...');
    const result1 = await client.callTool({ name: 'echo', arguments: { message: 'Hello 1' } });
    console.log(`[CLIENT] Result: ${JSON.stringify(result1)}`);

    // Wait for session to expire (server has 5 second timeout)
    console.log('\n[CLIENT] Waiting 7 seconds for session to expire...');
    await new Promise(resolve => setTimeout(resolve, 7000));

    // Second call - should trigger session recovery
    console.log('\n[CLIENT] Making second tool call (session should have expired)...');
    const result2 = await client.callTool({ name: 'echo', arguments: { message: 'Hello 2' } });
    console.log(`[CLIENT] Result: ${JSON.stringify(result2)}`);
    console.log(`[CLIENT] New session ID: ${transport.sessionId}`);

    // Third call - should work with new session
    console.log('\n[CLIENT] Making third tool call...');
    const result3 = await client.callTool({ name: 'echo', arguments: { message: 'Hello 3' } });
    console.log(`[CLIENT] Result: ${JSON.stringify(result3)}`);

    console.log('\n[CLIENT] ✅ Session recovery test completed successfully!');
    await client.close();
}

main().catch(error => {
    console.error('[CLIENT] ❌ Error:', error);
    process.exit(1);
});
