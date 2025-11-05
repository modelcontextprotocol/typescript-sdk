#!/usr/bin/env node

/**
 * Simple test for File Creation Server using direct MCP calls
 */

import { Client } from '../client/index.js';
import { StdioClientTransport } from '../client/stdio.js';

async function testFileServer() {
    console.log('🧪 Testing File Creation Server');
    console.log('='.repeat(50));

    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { tools: { streaming: {} } } });

    // Connect to server via stdio
    const transport = new StdioClientTransport({
        command: 'node',
        args: ['src/examples/fileCreationServer.ts'],
        stderr: 'inherit'
    });

    try {
        console.log('🔌 Connecting to server...');
        await client.connect(transport);

        // List tools
        console.log('\n📋 Available tools:');
        const tools = await client.listTools();
        tools.tools.forEach(tool => {
            console.log(`   • ${tool.name}: ${tool.description}`);
        });

        console.log('\n' + '='.repeat(50));
        console.log('📝 Creating file with streaming...');

        // Test streaming file creation
        const streamResult = await client.streamTool({
            name: 'create_file',
            arguments: {
                filepath: '/tmp/streaming_demo.md',
                chunkSize: 30,
                delayMs: 100
            }
        });

        console.log(`🚀 Stream opened: ${streamResult.callId}`);

        // Send content chunks
        const chunks = [
            '# Streaming Demo\n\n',
            'This file was created ',
            'using MCP streaming ',
            'functionality.\n\n',
            '## Features\n',
            '- Real-time display\n',
            '- Progress tracking\n',
            '- Chunk processing\n',
            '- Visual feedback\n\n',
            'Generated at: ' + new Date().toISOString() + '\n'
        ];

        for (let i = 0; i < chunks.length; i++) {
            const isLast = i === chunks.length - 1;
            await client.sendStreamChunk(streamResult.callId, 'content', chunks[i], isLast);
            console.log(`📤 Sent chunk ${i + 1}: ${chunks[i].length} bytes`);

            if (!isLast) {
                await new Promise(resolve => setTimeout(resolve, 150));
            }
        }

        console.log('\n✅ Stream completed!');

        // Read the created file
        console.log('\n📖 Reading created file...');
        const readResult = await client.callTool({
            name: 'read_file',
            arguments: {
                filepath: '/tmp/streaming_demo.md'
            }
        });

        if (readResult.content && Array.isArray(readResult.content) && readResult.content[0]) {
            console.log('📄 File contents:');
            console.log(readResult.content[0].text);
        }
    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await client.close();
    }
}

testFileServer().catch(console.error);
