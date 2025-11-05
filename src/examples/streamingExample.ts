/**
 * Example of streaming tool calls functionality
 * This demonstrates how to use the streaming tool calls feature
 */

import { McpServer } from '../server/mcp.js';
import { Client } from '../client/index.js';
import { InMemoryTransport } from '../inMemory.js';
import { z } from 'zod';

// Create server with streaming tool support
const server = new McpServer({ name: 'streaming-example-server', version: '1.0.0' }, { capabilities: { tools: { streaming: {} } } });

// Register a streaming tool that processes text in chunks
server.registerTool(
    'streaming_processor',
    {
        description: 'A tool that processes streaming text input',
        inputSchema: {
            text: z.string().describe('Text to process'),
            operation: z.enum(['uppercase', 'lowercase', 'reverse']).describe('Operation to perform')
        },
        annotations: {
            streamingArguments: [{ name: 'text', mergeStrategy: 'concatenate' }]
        }
    },
    async args => {
        const { text, operation } = args;
        let result: string;

        switch (operation) {
            case 'uppercase':
                result = text.toUpperCase();
                break;
            case 'lowercase':
                result = text.toLowerCase();
                break;
            case 'reverse':
                result = text.split('').reverse().join('');
                break;
            default:
                result = text;
        }

        return {
            content: [
                {
                    type: 'text',
                    text: `Processed result: ${result}`
                }
            ]
        };
    }
);

async function demonstrateStreaming() {
    // Create linked transports for client-server communication
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    // Create client with streaming capabilities
    const client = new Client({ name: 'streaming-example-client', version: '1.0.0' }, { capabilities: { tools: { streaming: {} } } });

    // Connect both client and server
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    console.log('=== Streaming Tool Calls Example ===\n');

    try {
        // 1. Initiate streaming call
        console.log('1. Initiating streaming tool call...');
        const streamResult = await client.streamTool({
            name: 'streaming_processor',
            arguments: { operation: 'uppercase' }
        });

        console.log(`   Stream opened with ID: ${streamResult.callId}`);
        console.log(`   Status: ${streamResult.status}\n`);

        // 2. Send data in chunks
        console.log('2. Sending text data in chunks...');

        // Send first chunk
        await client.sendStreamChunk(streamResult.callId, 'text', 'Hello, ', false);
        console.log('   Sent chunk: "Hello, "');

        // Send second chunk
        await client.sendStreamChunk(streamResult.callId, 'text', 'Streaming ', false);
        console.log('   Sent chunk: "Streaming "');

        // Send final chunk
        await client.sendStreamChunk(streamResult.callId, 'text', 'World!', true);
        console.log('   Sent final chunk: "World!"\n');

        // 3. Complete the stream
        console.log('3. Completing stream...');
        await client.completeStream(streamResult.callId);
        console.log('   Stream completed successfully!\n');

        console.log('=== Example Complete ===');
        console.log('The text "Hello, Streaming World!" was processed in chunks');
        console.log('and converted to uppercase using the streaming tool.');
    } catch (error) {
        console.error('Error during streaming example:', error);
    } finally {
        // Clean up connections
        await client.close();
        await server.close();
    }
}

demonstrateStreaming().catch(console.error);
