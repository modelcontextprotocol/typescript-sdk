/**
 * Simple task streaming client demonstrating partial result consumption.
 *
 * This client connects to simpleTaskStreaming.ts and demonstrates:
 * - Invoking a tool as a task-augmented request via `callToolStream`
 * - Subscribing to partial results with `subscribeTaskPartials`
 * - Displaying streaming text as tokens arrive
 * - Retrieving the canonical final result via `tasks/result`
 *
 * Wire-format trace (JSON-RPC messages on the wire):
 *
 *   → {"jsonrpc":"2.0","id":1,"method":"tools/call",
 *       "params":{"name":"generate","arguments":{"prompt":"Tell me about TypeScript"},
 *                 "_meta":{"task":{"ttl":60000}}}}
 *
 *   ← {"jsonrpc":"2.0","id":1,"result":{
 *       "task":{"taskId":"<id>","status":"working","ttl":60000,...}}}
 *
 *   ← {"jsonrpc":"2.0","method":"notifications/tasks/partial",
 *       "params":{"taskId":"<id>","content":[{"type":"text","text":"TypeScript"}],"seq":0}}
 *   ← {"jsonrpc":"2.0","method":"notifications/tasks/partial",
 *       "params":{"taskId":"<id>","content":[{"type":"text","text":" is"}],"seq":1}}
 *   ...more partials with incrementing seq...
 *
 *   ← {"jsonrpc":"2.0","method":"notifications/tasks/status",
 *       "params":{"taskId":"<id>","status":"completed",...}}
 *
 *   → {"jsonrpc":"2.0","id":2,"method":"tasks/result","params":{"taskId":"<id>"}}
 *   ← {"jsonrpc":"2.0","id":2,"result":{
 *       "content":[{"type":"text","text":"TypeScript is a strongly typed..."}],
 *       "isError":false}}
 *
 * Run with: npx tsx examples/client/src/simpleTaskStreamingClient.ts
 * (Requires simpleTaskStreaming.ts server running on port 8000)
 */

import type { CallToolResult, TaskPartialNotificationParams, TextContent } from '@modelcontextprotocol/client';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

function getTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
    const textContent = result.content.find((c): c is TextContent => c.type === 'text');
    return textContent?.text ?? '(no text)';
}

async function run(url: string): Promise<void> {
    console.log('Task Streaming Client');
    console.log('=====================');
    console.log(`Connecting to ${url}...\n`);

    // Create client with task streaming capability declared.
    // This tells the server we can handle `notifications/tasks/partial`.
    const client = new Client(
        { name: 'simple-task-streaming-client', version: '1.0.0' },
        {
            capabilities: {
                tasks: {
                    streaming: { partial: {} }
                }
            }
        }
    );

    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
    console.log('Connected!\n');

    // List available tools
    const toolsResult = await client.listTools();
    console.log(`Available tools: ${toolsResult.tools.map(t => t.name).join(', ')}\n`);

    // ========================================================================
    // Demo: invoke the "generate" tool and stream partial results
    // ========================================================================

    const prompts = ['Tell me about TypeScript', 'What is MCP?', 'Explain streaming'];

    for (const prompt of prompts) {
        console.log(`--- Generating: "${prompt}" ---`);

        // Collect partial tokens for display
        const partialTokens: string[] = [];
        let unsubscribe: (() => void) | undefined;

        // Use callToolStream to invoke the tool as a task-augmented request.
        // This yields messages for the full lifecycle: taskCreated → taskStatus → result.
        const stream = client.experimental.tasks.callToolStream({ name: 'generate', arguments: { prompt } }, { task: { ttl: 60_000 } });

        for await (const message of stream) {
            switch (message.type) {
                case 'taskCreated': {
                    const taskId = message.task.taskId;
                    console.log(`  Task created: ${taskId}`);

                    // Subscribe to partial results for this task.
                    // The handler fires for each `notifications/tasks/partial` notification.
                    unsubscribe = client.experimental.tasks.subscribeTaskPartials(taskId, (params: TaskPartialNotificationParams) => {
                        // Extract text from the content blocks
                        for (const block of params.content) {
                            if (block.type === 'text') {
                                partialTokens.push(block.text);
                                // Print tokens inline as they arrive
                                process.stdout.write(block.text);
                            }
                        }
                    });
                    break;
                }

                case 'taskStatus': {
                    // Task status updates (working → completed)
                    if (message.task.status === 'completed') {
                        // Newline after streaming tokens
                        if (partialTokens.length > 0) {
                            process.stdout.write('\n');
                        }
                        console.log(`  Task status: ${message.task.status}`);
                    }
                    break;
                }

                case 'result': {
                    // The canonical result from tasks/result — this is the source of truth.
                    // Per SEP-0000, the final result is independent of partial notifications.
                    const toolResult = message.result as CallToolResult;
                    const finalText = getTextContent(toolResult);

                    console.log(`  Final result: "${finalText}"`);

                    // Show that partials were received
                    if (partialTokens.length > 0) {
                        const streamedText = partialTokens.join('');
                        console.log(`  Streamed ${partialTokens.length} partial tokens`);
                        console.log(`  Streamed text matches final: ${streamedText === finalText}`);
                    } else {
                        console.log('  (No partial tokens received — server or client may lack streaming capability)');
                    }

                    // Clean up the subscription
                    unsubscribe?.();
                    break;
                }

                case 'error': {
                    console.error(`  Error: ${message.error}`);
                    unsubscribe?.();
                    break;
                }
            }
        }

        console.log();
    }

    // Cleanup
    console.log('Demo complete. Closing connection...');
    await transport.close();
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

try {
    await run(url);
} catch (error) {
    console.error('Error running client:', error);
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1);
}
