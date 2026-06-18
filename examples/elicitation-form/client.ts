/**
 * Auto-answers the registration form (accept once, decline once) and asserts
 * the tool's text reflects the elicitation outcome.
 */
import { check, connectFromArgs, runClient } from '../harness.js';

runClient('elicitation-form', async () => {
    // Push-style elicitation is the 2025-era flow (the 2026-07-28 revision uses
    // multi-round-trip `inputRequired` instead — see ../mrtr/). The harness
    // pins this story to the legacy era so `ctx.mcpReq.elicitInput` reaches
    // this handler.
    const client = await connectFromArgs(import.meta.dirname, { capabilities: { elicitation: { form: {} } } });

    let action: 'accept' | 'decline' = 'accept';
    client.setRequestHandler('elicitation/create', async request => {
        const params = request.params as { requestedSchema?: { properties?: Record<string, unknown> } };
        check.ok(params.requestedSchema?.properties?.['username'], 'elicitation should carry the requestedSchema');
        if (action === 'decline') return { action: 'decline' };
        return { action: 'accept', content: { username: 'alice', email: 'alice@example.com', newsletter: true } };
    });

    const accepted = await client.callTool({ name: 'register_user' });
    check.match(accepted.content?.[0]?.type === 'text' ? accepted.content[0].text : '', /registered alice <alice@example.com>/);

    action = 'decline';
    const declined = await client.callTool({ name: 'register_user' });
    check.match(declined.content?.[0]?.type === 'text' ? declined.content[0].text : '', /registration decline/);

    await client.close();
});
