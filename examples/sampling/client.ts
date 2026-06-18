/**
 * Advertises the sampling capability, registers a `sampling/createMessage`
 * handler that returns a canned summary, then calls the `summarize` tool and
 * asserts the canned text round-tripped.
 */
import { check, connectFromArgs, runClient } from '../harness.js';

runClient('sampling', async () => {
    // Push-style sampling is a 2025-era flow (and is deprecated as of
    // 2026-07-28). Connect as a plain 2025 client so the server's
    // `ctx.mcpReq.requestSampling` reaches this handler.
    const client = await connectFromArgs(import.meta.dirname, { versionNegotiation: undefined, capabilities: { sampling: {} } });
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
