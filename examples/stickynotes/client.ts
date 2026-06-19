/**
 * Drives the sticky-notes board end to end: add two notes, list/read their
 * resources, remove one, then — on the 2025-era leg — attempt `remove_all`
 * three ways (cancel, accept-unchecked, accept-confirmed) to prove the board is
 * cleared only on an explicit confirmation.
 */
import { check, connectFromArgs, eraLeg, runClient } from '../harness.js';

interface AddResult {
    id: string;
    uri: string;
}
interface RemoveAllResult {
    status: string;
    removed: number;
}

runClient('stickynotes', async () => {
    // connectFromArgs picks transport (default: spawn ./server.ts over stdio; --http <url>) and era (--legacy) from argv. Your code would construct a Client and connect over your chosen transport directly.
    const client = await connectFromArgs(import.meta.dirname, { capabilities: { elicitation: { form: {} } } });
    let elicitAnswer: 'cancel' | 'unchecked' | 'confirm' = 'cancel';
    client.setRequestHandler('elicitation/create', async () => {
        if (elicitAnswer === 'cancel') return { action: 'cancel' };
        return { action: 'accept', content: { confirm: elicitAnswer === 'confirm' } };
    });

    // ADD two notes.
    const first = await client.callTool({ name: 'add_note', arguments: { text: 'Buy milk' } });
    const firstNote = first.structuredContent as unknown as AddResult;
    check.match(firstNote.uri, /^note:\/\/\//);
    const second = await client.callTool({ name: 'add_note', arguments: { text: 'Walk the dog' } });
    const secondNote = second.structuredContent as unknown as AddResult;
    check.notEqual(firstNote.id, secondNote.id);

    // LIST/READ — both notes should be listable resources.
    const list = await client.listResources();
    const noteUris = new Set(list.resources.filter(r => r.uri.startsWith('note:///')).map(r => r.uri));
    check.ok(noteUris.has(firstNote.uri) && noteUris.has(secondNote.uri));
    const read = await client.readResource({ uri: firstNote.uri });
    const readContent = read.contents[0];
    check.equal(readContent && 'text' in readContent ? readContent.text : '', 'Buy milk');

    // REMOVE ONE.
    const removed = await client.callTool({ name: 'remove_note', arguments: { id: firstNote.id } });
    check.equal((removed.structuredContent as { removed?: boolean } | undefined)?.removed, true);
    const after = await client.listResources();
    check.ok(!after.resources.some(r => r.uri === firstNote.uri));

    // The elicitation-confirmed `remove_all` path is 2025-era only: push-style
    // server→client requests need the `initialize` handshake to advertise the
    // elicitation capability and a long-lived bidirectional connection (stdio,
    // or the harness's sessionful http/legacy arm). On a 2026-07-28 connection
    // there is no server→client request channel — the equivalent is
    // multi-round-trip `inputRequired` (see ../elicitation/).
    if (eraLeg() === 'modern') {
        const removedSecond = await client.callTool({ name: 'remove_note', arguments: { id: secondNote.id } });
        check.equal((removedSecond.structuredContent as { removed?: boolean } | undefined)?.removed, true);
        const afterClear = await client.listResources();
        check.equal(afterClear.resources.filter(r => r.uri.startsWith('note:///')).length, 0);
        await client.close();
        return;
    }

    // CANCEL — board untouched.
    elicitAnswer = 'cancel';
    const cancelled = await client.callTool({ name: 'remove_all' });
    check.equal((cancelled.structuredContent as unknown as RemoveAllResult).status, 'cancelled');
    const afterCancel = await client.listResources();
    check.ok(afterCancel.resources.some(r => r.uri === secondNote.uri));

    // UNCHECKED — accept with confirm:false → declined, board untouched.
    elicitAnswer = 'unchecked';
    const declined = await client.callTool({ name: 'remove_all' });
    check.equal((declined.structuredContent as unknown as RemoveAllResult).status, 'declined');

    // CONFIRM — accept with confirm:true → cleared.
    elicitAnswer = 'confirm';
    const cleared = await client.callTool({ name: 'remove_all' });
    check.equal((cleared.structuredContent as unknown as RemoveAllResult).status, 'cleared');
    check.equal((cleared.structuredContent as unknown as RemoveAllResult).removed, 1);
    const afterClear = await client.listResources();
    check.equal(afterClear.resources.filter(r => r.uri.startsWith('note:///')).length, 0);

    // EMPTY — a follow-up remove_all reports 'empty' without eliciting.
    const empty = await client.callTool({ name: 'remove_all' });
    check.equal((empty.structuredContent as unknown as RemoveAllResult).status, 'empty');

    await client.close();
});
