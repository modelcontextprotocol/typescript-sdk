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

    // Demo 1: Elicitation (confirm_delete)
    console.log('\n--- Demo 1: Elicitation ---');
    console.log('Calling confirm_delete tool...');

    const confirmStream = client.experimental.tasks.callToolStream(
        { name: 'confirm_delete', arguments: { filename: 'important.txt' } },
        { task: { ttl: 60_000 } }
    );

    for await (const message of confirmStream) {
        switch (message.type) {
            case 'taskCreated': {
                console.log(`Task created: ${message.task.taskId}`);
                break;
            }
            case 'taskStatus': {
                console.log(`Task status: ${message.task.status}`);
                break;
            }
            case 'result': {
                console.log(`Result: ${getTextContent(message.result)}`);
                break;
            }
            case 'error': {
                console.error(`Error: ${message.error}`);
                break;
            }
        }
    }

    // Demo 2: Sampling (write_haiku)
    console.log('\n--- Demo 2: Sampling ---');
    console.log('Calling write_haiku tool...');

    const haikuStream = client.experimental.tasks.callToolStream(
        { name: 'write_haiku', arguments: { topic: 'autumn leaves' } },
        { task: { ttl: 60_000 } }
    );

    for await (const message of haikuStream) {
        switch (message.type) {
            case 'taskCreated': {
                console.log(`Task created: ${message.task.taskId}`);
                break;
            }
            case 'taskStatus': {
                console.log(`Task status: ${message.task.status}`);
                break;
            }
            case 'result': {
                console.log(`Result:\n${getTextContent(message.result)}`);
                break;
            }
            case 'error': {
                console.error(`Error: ${message.error}`);
                break;
            }
        }
    }

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
