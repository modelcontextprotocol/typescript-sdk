#!/usr/bin/env node

/**
 * Comprehensive End-to-End Streaming Test
 * Tests the complete streaming tool execution flow
 */

import { McpServer } from '../server/mcp.js';
import { Client } from '../client/index.js';
import { InMemoryTransport } from '../inMemory.js';
import { z } from 'zod';

async function testCompleteStreamingFlow(): Promise<void> {
    console.log('🧪 Testing Complete End-to-End Streaming Flow');
    console.log('='.repeat(60));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    // Create server with streaming tool
    const server = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: { streaming: {} } } });

    // Register a streaming tool
    server.registerTool(
        'streaming_echo',
        {
            description: 'Echoes back the streamed content',
            inputSchema: {
                message: z.string().describe('Message to echo back'),
                count: z.number().optional().describe('Number of times to repeat')
            },
            annotations: {
                streamingArguments: [
                    { name: 'message', mergeStrategy: 'concatenate' },
                    { name: 'count', mergeStrategy: 'last' }
                ]
            }
        },
        async args => {
            const message = args.message || 'No message';
            const count = args.count || 1;
            const repeatedMessage = message.repeat(count);

            return {
                content: [
                    {
                        type: 'text',
                        text: `Echoed: ${repeatedMessage}`
                    }
                ]
            };
        }
    );

    // Create client with streaming capabilities
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { tools: { streaming: {} } } });

    try {
        // Connect both client and server
        await server.connect(serverTransport);
        await client.connect(clientTransport);

        console.log('✅ Connected client and server');

        // Test 1: Start streaming tool call
        console.log('\n📡 Starting streaming tool call...');
        const streamResult = await client.streamTool({
            name: 'streaming_echo',
            arguments: { count: 3 }
        });

        if (!streamResult.callId || !streamResult.status) {
            throw new Error('Invalid stream result');
        }

        console.log(`✅ Stream started: ${streamResult.callId}`);

        // Test 2: Send chunks
        console.log('\n📦 Sending chunks...');
        await client.sendStreamChunk(streamResult.callId, 'message', 'Hello ');
        await client.sendStreamChunk(streamResult.callId, 'message', 'Streaming ');
        await client.sendStreamChunk(streamResult.callId, 'message', 'World!', true);

        console.log('✅ Chunks sent successfully');

        // Test 3: Complete stream and wait for result
        console.log('\n🏁 Completing stream...');
        await client.completeStream(streamResult.callId);

        console.log('✅ Stream completed');

        // Wait a bit for result notification
        await new Promise(resolve => setTimeout(resolve, 100));

        console.log('\n🎉 Complete streaming flow test passed!');
    } catch (error) {
        console.error('❌ Test failed:', error);
        throw error;
    } finally {
        // Cleanup
        try {
            await client.close();
            await server.close();
            console.log('✅ Cleaned up connections');
        } catch (cleanupError) {
            console.error('⚠️ Cleanup error:', cleanupError);
        }
    }
}

// Run the test
testCompleteStreamingFlow().catch(console.error);
