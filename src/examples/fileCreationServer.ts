#!/usr/bin/env node

/**
 * Simple File Creation MCP Server (TypeScript Version)
 *
 * This server demonstrates streaming by creating files and displaying
 * their contents in real-time as they are being written.
 */

import { McpServer } from '../server/mcp.js';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

// Create server with streaming capabilities
const server = new McpServer(
    {
        name: 'file-creation-server',
        version: '1.0.0'
    },
    {
        capabilities: {
            tools: {
                streaming: {}
            }
        }
    }
);

// Register streaming file creation tool
server.registerTool(
    'create_file',
    {
        description: 'Create a file with streaming content display',
        inputSchema: {
            filepath: z.string().describe('Path where the file should be created'),
            content: z.string().optional().describe('Content to write (if not provided, generates sample content)'),
            chunkSize: z.number().default(100).describe('Size of each chunk to write'),
            delayMs: z.number().default(50).describe('Delay between chunks in milliseconds (for demo purposes)')
        },
        annotations: {
            streamingArguments: [{ name: 'content', mergeStrategy: 'concatenate' }]
        }
    },
    async args => {
        const { filepath, content, chunkSize, delayMs } = args;

        try {
            // Generate sample content if none provided
            const fileContent = content || generateSampleContent();

            // Create file with streaming simulation
            await createFileWithStreaming(filepath, fileContent, chunkSize, delayMs);

            return {
                content: [
                    {
                        type: 'text',
                        text: `✅ File created successfully: ${filepath}\n📊 Total bytes written: ${fileContent.length}`
                    }
                ]
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `❌ Error creating file: ${error instanceof Error ? error.message : String(error)}`
                    }
                ]
            };
        }
    }
);

// Register file reading tool
server.registerTool(
    'read_file',
    {
        description: 'Read and display file contents',
        inputSchema: {
            filepath: z.string().describe('Path to the file to read')
        }
    },
    async args => {
        try {
            const content = await readFile(args.filepath, 'utf-8');
            return {
                content: [
                    {
                        type: 'text',
                        text: `📄 Contents of ${args.filepath}:\n\n${content}`
                    }
                ]
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `❌ Error reading file: ${error instanceof Error ? error.message : String(error)}`
                    }
                ]
            };
        }
    }
);

/**
 * Generate sample content for demonstration
 */
function generateSampleContent(): string {
    const lines = [
        '# Streaming File Creation Demo',
        '',
        'This file was created using MCP streaming functionality.',
        'Each chunk was written and displayed in real-time.',
        '',
        '## Features Demonstrated:',
        '- ✨ Real-time file writing',
        '- 📊 Progress tracking',
        '- 🔄 Chunk-based processing',
        '- ⚡ Streaming capabilities',
        '',
        '## Sample Data:'
    ];

    // Add some sample data
    for (let i = 1; i <= 20; i++) {
        lines.push(`- Item ${i}: ${randomBytes(8).toString('hex')}`);
    }

    lines.push(
        '',
        '## Summary:',
        `Generated at: ${new Date().toISOString()}`,
        `Total lines: ${lines.length}`,
        '',
        '--- End of demo file ---'
    );

    return lines.join('\n');
}

/**
 * Create file with streaming simulation
 */
async function createFileWithStreaming(filepath: string, content: string, chunkSize: number, delayMs: number): Promise<void> {
    // Write file in chunks to simulate streaming
    let offset = 0;
    let chunkIndex = 0;

    console.error(`📝 Creating file: ${filepath}`);
    console.error(`📊 Content size: ${content.length} bytes, Chunk size: ${chunkSize}`);
    console.error(`⏱️  Delay: ${delayMs}ms between chunks`);
    console.error('─'.repeat(50));

    while (offset < content.length) {
        const chunk = content.slice(offset, offset + chunkSize);
        const isLastChunk = offset + chunkSize >= content.length;

        // Write chunk to stderr so it appears in terminal
        console.error(`🔤 Chunk ${++chunkIndex}: ${chunk.length} bytes`);
        if (chunk.trim()) {
            console.error(`📄 ${chunk.trim()}`);
        }

        // Write to file (append mode)
        await writeFile(filepath, chunk, { flag: offset === 0 ? 'w' : 'a' });

        // Progress indicator
        const progress = Math.round(((offset + chunk.length) / content.length) * 100);
        console.error(`📈 Progress: ${progress}% (${offset + chunk.length}/${content.length} bytes)`);

        if (!isLastChunk) {
            console.error('⏳ Waiting for next chunk...');
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        offset += chunkSize;
    }

    console.error('─'.repeat(50));
    console.error('✅ File creation complete!');
}

// Start the server
console.error('🚀 File Creation MCP Server starting...');
console.error('📋 Available tools:');
console.error('   • create_file - Create files with streaming display');
console.error('   • read_file - Read file contents');
console.error('');
console.error('💡 The server will stay running and accept requests via stdio.');
console.error('🔌 Use any MCP client to connect and start creating files!');
console.error('');

// Connect to stdio transport
import { StdioServerTransport } from '../server/stdio.js';

const transport = new StdioServerTransport();
server.connect(transport).catch(error => {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
});
