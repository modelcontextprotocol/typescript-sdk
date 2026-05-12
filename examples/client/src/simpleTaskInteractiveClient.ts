/**
 * Simple interactive task client demonstrating elicitation and sampling responses.
 *
 * This client connects to simpleTaskInteractive.ts server and demonstrates:
 * - Handling elicitation requests (y/n confirmation)
 * - Handling sampling requests (returns a hardcoded haiku)
 * - Using task-based tool execution with streaming
 */

import { createInterface } from 'node:readline';

import type { CreateMessageRequest, CreateMessageResult, TextContent } from '@modelcontextprotocol/client';
import { Client, ProtocolError, ProtocolErrorCode, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

// Create readline interface for user input
const readline = createInterface({
    input: process.stdin,
    output: process.stdout
});

function question(prompt: string): Promise<string> {
    return new Promise(resolve => {
        readline.question(prompt, answer => {
            resolve(answer.trim());
        });
    });
}

function getTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
    const textContent = result.content.find((c): c is TextContent => c.type === 'text');
    return textContent?.text ?? '(no text)';
}

async function elicitationCallback(params: {
    mode?: string;
    message: string;
    requestedSchema?: object;
}): Promise<{ action: 'accept' | 'cancel' | 'decline'; content?: Record<string, string | number | boolean | string[]> }> {
    console.log(`\n[Elicitation] Server asks: ${params.message}`);

    // Simple terminal prompt for y/n
    const response = await question('Your response (y/n): ');
    const confirmed = ['y', 'yes', 'true', '1'].includes(response.toLowerCase());

    console.log(`[Elicitation] Responding with: confirm=${confirmed}`);
    return { action: 'accept', content: { confirm: confirmed } };
}

async function samplingCallback(params: CreateMessageRequest['params']): Promise<CreateMessageResult> {
    // Get the prompt from the first message
    let prompt = 'unknown';
    if (params.messages && params.messages.length > 0) {
        const firstMessage = params.messages[0]!;
        const content = firstMessage.content;
        if (typeof content === 'object' && !Array.isArray(content) && content.type === 'text' && 'text' in content) {
            prompt = content.text;
        } else if (Array.isArray(content)) {
            const textPart = content.find(c => c.type === 'text' && 'text' in c);
            if (textPart && 'text' in textPart) {
                prompt = textPart.text;
            }
        }
    }

    console.log(`\n[Sampling] Server requests LLM completion for: ${prompt}`);

    // Return a hardcoded haiku (in real use, call your LLM here)
    const haiku = `Cherry blossoms fall
Softly on the quiet pond
Spring whispers goodbye`;

    console.log('[Sampling] Responding with haiku');
    return {
        model: 'mock-haiku-model',
        role: 'assistant',
        content: { type: 'text', text: haiku }
    };
}

async function run(url: string): Promise<void> {
    console.log('Simple Task Interactive Client');
    console.log('==============================');
    console.log(`Connecting to ${url}...`);

    // Create client with elicitation and sampling capabilities
    const client = new Client(
        { name: 'simple-task-interactive-client', version: '1.0.0' },
        {
            capabilities: {
                elicitation: { form: {} },
                sampling: {}
            }
        }
    );

    // Set up elicitation request handler
    client.setRequestHandler('elicitation/create', async request => {
        if (request.params.mode && request.params.mode !== 'form') {
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unsupported elicitation mode: ${request.params.mode}`);
        }
        return elicitationCallback(request.params);
    });

    // Set up sampling request handler
    client.setRequestHandler('sampling/createMessage', async request => {
        return samplingCallback(request.params) as unknown as ReturnType<typeof samplingCallback>;
    });

    // Connect to server
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
    console.log('Connected!\n');

    // List tools
    const toolsResult = await client.listTools();
    console.log(`Available tools: ${toolsResult.tools.map(t => t.name).join(', ')}`);

    // TODO(F3): re-enable interactive task demos via tasksPlugin (SEP-2663).
    // The 2025-11 callToolStream API is removed by R0; the demos below were the
    // streaming consumer of that API and are disabled until the F3 rewrite.
    void client;
    void getTextContent;
    console.log('\nInteractive task demo disabled pending tasksPlugin (SEP-2663). See TODO(F3).');

    // Cleanup
    console.log('\nDemo complete. Closing connection...');
    await transport.close();
    readline.close();
}

// Parse command line arguments
const args = process.argv.slice(2);
let url = 'http://localhost:8000/mcp';

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
        url = args[i + 1]!;
        i++;
    }
}

// Run the client
try {
    await run(url);
} catch (error) {
    console.error('Error running client:', error);
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1);
}
