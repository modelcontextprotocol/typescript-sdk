#!/usr/bin/env node

/**
 * Simple standalone test to demonstrate file creation streaming
 */

import { writeFile, readFile } from 'node:fs/promises';

async function demonstrateStreaming(): Promise<void> {
    console.log('📝 Demonstrating File Creation Streaming');
    console.log('='.repeat(50));

    const filepath = '/tmp/streaming_demo.md';
    const content = `# Streaming Demo

This file demonstrates how streaming works in MCP.

## Features:
- ✨ Real-time display
- 📊 Progress tracking
- 🔄 Chunk-based processing
- ⚡ Visual feedback

## Generated Content:
This content was written in chunks to demonstrate streaming capabilities of MCP protocol.

Generated at: ${new Date().toISOString()}
`;

    const chunkSize = 50;
    let offset = 0;
    let chunkIndex = 0;

    console.log(`📊 Creating file: ${filepath}`);
    console.log(`📏 Total content: ${content.length} bytes`);
    console.log(`🔢 Chunk size: ${chunkSize} bytes`);
    console.log('─'.repeat(50));

    while (offset < content.length) {
        const chunk = content.slice(offset, offset + chunkSize);
        const isLastChunk = offset + chunkSize >= content.length;

        // Display chunk info
        console.log(`🔤 Chunk ${++chunkIndex}: ${chunk.length} bytes`);
        if (chunk.trim()) {
            console.log(`📄 ${chunk.trim()}`);
        }

        // Write chunk to file
        await writeFile(filepath, chunk, { flag: offset === 0 ? 'w' : 'a' });

        // Progress indicator
        const progress = Math.round(((offset + chunk.length) / content.length) * 100);
        console.log(`📈 Progress: ${progress}% (${offset + chunk.length}/${content.length} bytes)`);

        if (!isLastChunk) {
            console.error('⏳ Waiting for next chunk...');
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        offset += chunkSize;
    }

    console.error('─'.repeat(50));
    console.log('✅ File creation complete!');

    // Read and display the created file
    try {
        const createdContent = await readFile(filepath, 'utf-8');
        console.log('\n📖 Created file contents:');
        console.log('─'.repeat(30));
        console.log(createdContent);
        console.log('─'.repeat(30));
    } catch (error) {
        console.error('❌ Error reading file:', (error as Error).message);
    }
}

demonstrateStreaming().catch(console.error);
