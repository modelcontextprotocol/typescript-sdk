/**
 * Rejection-side corpus, routed through real dispatch.
 *
 * Accept-only corpora (specCorpus.test.ts) are blind to accept→reject deltas:
 * a schema split or strictness change that turns previously-accepted traffic
 * into rejections (or vice versa) never fails a parse-success fixture. These
 * fixtures therefore drive raw JSON-RPC messages through a connected
 * Protocol — the transport boundary, classification, handler lookup, and
 * per-method parse exactly as production dispatch runs them — and pin the
 * observable outcome of each:
 *
 *  - `error-response`: an error response with the pinned code is sent back
 *  - `onerror`:        no response; the failure surfaces via onerror
 *  - `ignored`:        no response and no onerror (silent drop)
 *  - `result-response`: a result response is sent (accept-side sanity)
 *
 * The fixtures record TODAY's dispatch behavior. When a deliberate change
 * moves the accept/reject line, the affected fixture turns red and must be
 * updated in the same change (with its changeset / migration entry).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { Protocol } from '../../src/shared/protocol.js';
import type { BaseContext } from '../../src/shared/protocol.js';
import { InMemoryTransport } from '../../src/util/inMemory.js';
import type { JSONRPCMessage } from '../../src/types/index.js';

const REJECTION_DIR = join(__dirname, 'fixtures', 'rejection');

interface DispatchFixture {
    description: string;
    message: unknown;
    expect: 'error-response' | 'onerror' | 'ignored' | 'result-response';
    errorCode?: number;
}

class ReceiverProtocol extends Protocol<BaseContext> {
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }
}

interface Outcome {
    responses: JSONRPCMessage[];
    errors: Error[];
}

/** Connect a receiver, inject the raw message from the peer side, observe. */
async function dispatch(message: unknown): Promise<Outcome> {
    const [peerTx, receiverTx] = InMemoryTransport.createLinkedPair();

    const receiver = new ReceiverProtocol();
    const errors: Error[] = [];
    receiver.onerror = error => void errors.push(error);
    // One registered spec handler so the accept-side fixture has a target.
    receiver.setRequestHandler('tools/call', async request => ({
        content: [{ type: 'text', text: String(request.params?.name) }]
    }));
    await receiver.connect(receiverTx);

    const responses: JSONRPCMessage[] = [];
    peerTx.onmessage = received => void responses.push(received);
    await peerTx.start();

    // The InMemoryTransport is typed for valid messages; the cast is the
    // point — raw bytes can always carry these shapes to dispatch.
    await peerTx.send(message as JSONRPCMessage);

    // Dispatch is asynchronous (handlers run in promise chains); settle.
    await new Promise(resolve => setTimeout(resolve, 25));

    await receiver.close();
    return { responses, errors };
}

const fixtureFiles = readdirSync(REJECTION_DIR)
    .filter(file => file.endsWith('.json'))
    .sort();

describe('dispatch-routed corpus (rejection side + accept sanity)', () => {
    test('the corpus is present', () => {
        expect(fixtureFiles.length).toBeGreaterThanOrEqual(13);
    });

    test.each(fixtureFiles)('%s', async file => {
        const fixture = JSON.parse(readFileSync(join(REJECTION_DIR, file), 'utf8')) as DispatchFixture;
        const outcome = await dispatch(fixture.message);

        switch (fixture.expect) {
            case 'error-response': {
                expect(outcome.responses, fixture.description).toHaveLength(1);
                const response = outcome.responses[0] as { error?: { code: number } };
                expect(response.error, `expected an error response: ${fixture.description}`).toBeDefined();
                expect(response.error?.code, fixture.description).toBe(fixture.errorCode);
                break;
            }
            case 'result-response': {
                expect(outcome.responses, fixture.description).toHaveLength(1);
                const response = outcome.responses[0] as { result?: unknown };
                expect(response.result, `expected a result response: ${fixture.description}`).toBeDefined();
                break;
            }
            case 'onerror': {
                expect(outcome.responses, `expected no response: ${fixture.description}`).toHaveLength(0);
                expect(outcome.errors.length, `expected an out-of-band error: ${fixture.description}`).toBeGreaterThan(0);
                break;
            }
            case 'ignored': {
                expect(outcome.responses, `expected no response: ${fixture.description}`).toHaveLength(0);
                expect(outcome.errors, `expected no out-of-band error: ${fixture.description}`).toHaveLength(0);
                break;
            }
        }
    });
});
