/**
 * Auto-answers form and URL elicitations on either protocol era and asserts
 * the tool's text reflects the elicitation outcome.
 *
 * On the 2025-era leg (`--legacy`) the server pushes `elicitation/create`
 * requests and a `notifications/elicitation/complete` notification, and the
 * `confirm_payment` tool throws a typed `UrlElicitationRequiredError` the
 * client catches. On the 2026-07-28 leg the same `elicitation/create`
 * handler is dispatched by the auto-fulfilment engine for the embedded
 * `inputRequired` requests; there is no throw-style or complete-notification
 * surface on that era, so those assertions are gated to the legacy leg.
 */
import type { ElicitRequestURLParams, ElicitResult } from '@modelcontextprotocol/client';
import { UrlElicitationRequiredError } from '@modelcontextprotocol/client';

import { check, connectFromArgs, eraLeg, runClient } from '../harness.js';

runClient('elicitation', async () => {
    // connectFromArgs picks transport (default: spawn ./server.ts over stdio; --http <url>) and era (--legacy) from argv. Your code would construct a Client and connect over your chosen transport directly.
    const client = await connectFromArgs(import.meta.dirname, { capabilities: { elicitation: { form: {}, url: {} } } });

    // URL-mode requests on the 2025 era carry an `elicitationId`; the client
    // waits for `notifications/elicitation/complete` with that id (the
    // out-of-band "the user finished the URL flow" signal) before answering.
    const completed = new Map<string, () => void>();
    client.setNotificationHandler('notifications/elicitation/complete', notification => {
        const id = (notification.params as { elicitationId: string }).elicitationId;
        completed.get(id)?.();
    });

    let formAction: 'accept' | 'decline' = 'accept';
    client.setRequestHandler('elicitation/create', async (request): Promise<ElicitResult> => {
        const params = request.params as { mode?: 'form' | 'url'; requestedSchema?: { properties?: Record<string, unknown> } } & Partial<
            Pick<ElicitRequestURLParams, 'url' | 'elicitationId'>
        >;
        if (params.mode === 'url') {
            // A real client would open `params.url` in a browser here. On the
            // 2025 era it then waits for the matching complete notification
            // before resolving; on the 2026 era there is no elicitationId and
            // the client answers as soon as the user finishes.
            check.ok(params.url?.startsWith('https://example.com/'));
            if (params.elicitationId) {
                await new Promise<void>(resolve => completed.set(params.elicitationId as string, resolve));
            }
            return { action: 'accept' };
        }
        if (params.requestedSchema?.properties?.['destination']) {
            return { action: 'accept', content: { destination: 'Tokyo' } };
        }
        if (params.requestedSchema?.properties?.['departure']) {
            return { action: 'accept', content: { departure: '2026-09-01', nights: 7 } };
        }
        check.ok(params.requestedSchema?.properties?.['username'], 'elicitation should carry the requestedSchema');
        if (formAction === 'decline') return { action: 'decline' };
        return { action: 'accept', content: { username: 'alice', email: 'alice@example.com', plan: 'pro' } };
    });

    // ---- Form mode (accept then decline) -------------------------------------
    const accepted = await client.callTool({ name: 'register_user' });
    check.match(
        accepted.content?.[0]?.type === 'text' ? accepted.content[0].text : '',
        /registered alice <alice@example.com> \(plan: pro\)/
    );

    formAction = 'decline';
    const declined = await client.callTool({ name: 'register_user' });
    check.match(declined.content?.[0]?.type === 'text' ? declined.content[0].text : '', /registration decline/);

    // ---- Multi-step form (two chained elicitations inside one tool call) -----
    const trip = await client.callTool({ name: 'plan_trip' });
    check.match(trip.content?.[0]?.type === 'text' ? trip.content[0].text : '', /trip planned: Tokyo on 2026-09-01 for 7 nights/);

    // ---- URL mode (push-style on 2025, inputRequired.elicitUrl on 2026) ------
    const linked = await client.callTool({ name: 'link_account', arguments: { provider: 'github' } });
    check.match(linked.content?.[0]?.type === 'text' ? linked.content[0].text : '', /linked github/);

    // ---- URL mode (throw-style — 2025-era only) ------------------------------
    if (eraLeg() === 'legacy') {
        let caught: UrlElicitationRequiredError | undefined;
        try {
            await client.callTool({ name: 'confirm_payment', arguments: { cartId: 'cart-42' } });
        } catch (error) {
            check.ok(error instanceof UrlElicitationRequiredError, 'expected UrlElicitationRequiredError');
            caught = error as UrlElicitationRequiredError;
        }
        check.ok(caught, 'confirm_payment should throw UrlElicitationRequiredError on the 2025 era');
        check.equal(caught?.elicitations.length, 1);
        check.match(caught?.elicitations[0]?.url ?? '', /confirm-payment\?cart=cart-42/);
    }

    await client.close();
});
