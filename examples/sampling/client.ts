/**
 * Advertises the sampling capability, registers a `sampling/createMessage`
 * handler that returns a canned summary, then calls the `summarize` tool and
 * asserts the canned text round-tripped.
 *
 * The same handler serves both protocol eras: on the 2025-era leg
 * (`--legacy`) the server pushes `sampling/createMessage` and this handler
 * answers it directly; on the 2026-07-28 leg the auto-fulfilment driver
 * dispatches the embedded `sampling/createMessage` from the server's
 * `inputRequired` result to this same handler, then retries the tool call
 * with the response attached.
 */
import { check, connectFromArgs, runClient } from '../harness.js';

runClient('sampling', async () => {
    // connectFromArgs picks transport (default: spawn ./server.ts over stdio; --http <url>) and era (--legacy) from argv. Your code would construct a Client and connect over your chosen transport directly.
    const client = await connectFromArgs(import.meta.dirname, { capabilities: { sampling: {} } });
    client.setRequestHandler('sampling/createMessage', async () => ({
        role: 'assistant',
        content: { type: 'text', text: '[canned summary]' },
        model: 'stub',
        stopReason: 'endTurn'
    }));

    const result = await client.callTool({ name: 'summarize', arguments: { text: 'hello world' } });
    check.equal(result.content?.[0]?.type === 'text' ? result.content[0].text : '', '[canned summary]');

    await client.close();
});
