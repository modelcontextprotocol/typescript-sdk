#!/usr/bin/env node

/**
 * Simple Client Streaming API Tests
 */

import { Client } from '../client/index.js';
import { InMemoryTransport } from '../inMemory.js';

async function testClientStreamingAPI(): Promise<void> {
    console.log('🧪 Testing Client Streaming API');
    console.log('='.repeat(50));

    let testsPassed = 0;
    let testsTotal = 0;

    function test(name: string, testFn: () => Promise<void>): void {
        testsTotal++;
        testFn()
            .then(() => {
                console.log(`✅ ${name}`);
                testsPassed++;
            })
            .catch(error => {
                console.log(`❌ ${name}: ${(error as Error).message}`);
            });
    }

    const { McpServer } = await import('../server/mcp.js');

    // Test 1: Stream tool call with streaming server
    test('Stream tool call with streaming server', async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { tools: { streaming: {} } } });

        const server = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: { streaming: {} } } });

        await server.connect(serverTransport);
        await client.connect(clientTransport);

        const streamResult = await client.streamTool({ name: 'test_tool', arguments: {} });

        if (!streamResult.callId || !streamResult.status) {
            throw new Error('Invalid stream result');
        }

        await client.close();
        await server.close();
    });

    // Test 2: Send stream chunks
    test('Send stream chunks successfully', async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { tools: { streaming: {} } } });

        const server = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: { streaming: {} } } });

        await server.connect(serverTransport);
        await client.connect(clientTransport);

        const streamResult = await client.streamTool({ name: 'test_tool', arguments: {} });

        // Send chunks without throwing errors
        await client.sendStreamChunk(streamResult.callId, 'data', 'chunk1');
        await client.sendStreamChunk(streamResult.callId, 'data', 'chunk2');
        await client.sendStreamChunk(streamResult.callId, 'data', 'chunk3', true);

        await client.completeStream(streamResult.callId);

        await client.close();
        await server.close();
    });

    // Test 3: streamToolComplete convenience method
    test('streamToolComplete convenience method', async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { tools: { streaming: {} } } });

        const server = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: { streaming: {} } } });

        await server.connect(serverTransport);
        await client.connect(clientTransport);

        const callId = await client.streamToolComplete('test_tool', {
            text: 'Hello World',
            number: 42
        });

        if (!callId || !callId.startsWith('stream_')) {
            throw new Error('Invalid call ID returned');
        }

        await client.close();
        await server.close();
    });

    // Wait for all tests to complete
    await new Promise(resolve => setTimeout(resolve, 200));

    console.log(`\n📊 Client API Test Results: ${testsPassed}/${testsTotal} passed`);

    if (testsPassed === testsTotal) {
        console.log('🎉 All Client API tests passed!');
    } else {
        console.log(`❌ ${testsTotal - testsPassed} tests failed`);
        process.exit(1);
    }
}

testClientStreamingAPI().catch(console.error);
