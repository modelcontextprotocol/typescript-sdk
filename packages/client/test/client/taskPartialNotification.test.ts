import type { JSONRPCMessage, TaskPartialNotificationParams } from '@modelcontextprotocol/core';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core';
import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

import { Client } from '../../src/client/client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a Client connected to a mock server via InMemoryTransport.
 * The mock server responds to `initialize` and `notifications/initialized`
 * so the client completes its handshake. Returns the client and the
 * server-side transport for sending raw notifications.
 */
async function createConnectedClient() {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client(
        { name: 'test-client', version: '1.0.0' },
        {
            capabilities: {
                tasks: {
                    streaming: { partial: {} }
                }
            }
        }
    );

    // Set up mock server to respond to initialize
    serverTransport.onmessage = (message: JSONRPCMessage) => {
        if ('method' in message && message.method === 'initialize' && 'id' in message) {
            serverTransport.send({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                    protocolVersion: LATEST_PROTOCOL_VERSION,
                    capabilities: {
                        tasks: {
                            requests: { tools: { call: {} } },
                            list: {},
                            streaming: { partial: {} }
                        }
                    },
                    serverInfo: { name: 'mock-server', version: '1.0.0' }
                }
            } as JSONRPCMessage);
        }
    };

    await client.connect(clientTransport);

    return { client, clientTransport, serverTransport };
}

/**
 * Sends a raw `notifications/tasks/partial` notification from the server transport
 * to the client. This bypasses any server-side validation, allowing us to test
 * client-side seq logic directly.
 */
async function sendPartialNotification(
    serverTransport: InMemoryTransport,
    taskId: string,
    content: Array<{ type: string; text: string }>,
    seq: number
): Promise<void> {
    await serverTransport.send({
        jsonrpc: '2.0',
        method: 'notifications/tasks/partial',
        params: { taskId, content, seq }
    } as JSONRPCMessage);
}

// ---------------------------------------------------------------------------
// 9.1 — Client subscription tests (Requirements 14.1, 14.2, 14.4, 14.5, 14.6)
// ---------------------------------------------------------------------------

describe('subscribeTaskPartials', () => {
    it('delivers notifications with sequential seq values (0, 1, 2, ...) in order', async () => {
        const { client, serverTransport } = await createConnectedClient();

        const received: TaskPartialNotificationParams[] = [];
        client.experimental.tasks.subscribeTaskPartials('task-1', params => {
            received.push(params);
        });

        await sendPartialNotification(serverTransport, 'task-1', [{ type: 'text', text: 'chunk-0' }], 0);
        await sendPartialNotification(serverTransport, 'task-1', [{ type: 'text', text: 'chunk-1' }], 1);
        await sendPartialNotification(serverTransport, 'task-1', [{ type: 'text', text: 'chunk-2' }], 2);

        expect(received).toHaveLength(3);
        expect(received[0]!.seq).toBe(0);
        expect(received[1]!.seq).toBe(1);
        expect(received[2]!.seq).toBe(2);
        expect(received[0]!.content).toEqual([{ type: 'text', text: 'chunk-0' }]);
        expect(received[1]!.content).toEqual([{ type: 'text', text: 'chunk-1' }]);
        expect(received[2]!.content).toEqual([{ type: 'text', text: 'chunk-2' }]);
        expect(received[0]!.taskId).toBe('task-1');

        await client.close();
    });

    it('discards duplicate notifications (same seq value)', async () => {
        const { client, serverTransport } = await createConnectedClient();

        const received: TaskPartialNotificationParams[] = [];
        client.experimental.tasks.subscribeTaskPartials('task-1', params => {
            received.push(params);
        });

        await sendPartialNotification(serverTransport, 'task-1', [{ type: 'text', text: 'first' }], 0);
        await sendPartialNotification(serverTransport, 'task-1', [{ type: 'text', text: 'duplicate' }], 0);
        await sendPartialNotification(serverTransport, 'task-1', [{ type: 'text', text: 'second' }], 1);

        expect(received).toHaveLength(2);
        expect(received[0]!.content).toEqual([{ type: 'text', text: 'first' }]);
        expect(received[1]!.content).toEqual([{ type: 'text', text: 'second' }]);

        await client.close();
    });

    it('discards notifications with seq less than lastSeq (old duplicates)', async () => {
        const { client, serverTransport } = await createConnectedClient();

        const received: TaskPartialNotificationParams[] = [];
        client.experimental.tasks.subscribeTaskPartials('task-1', params => {
            received.push(params);
        });

        await sendPartialNotification(serverTransport, 'task-1', [{ type: 'text', text: 'a' }], 0);
        await sendPartialNotification(serverTransport, 'task-1', [{ type: 'text', text: 'b' }], 1);
        await sendPartialNotification(serverTransport, 'task-1', [{ type: 'text', text: 'c' }], 2);
        // Send an old seq value
        await sendPartialNotification(serverTransport, 'task-1', [{ type: 'text', text: 'old' }], 1);

        expect(received).toHaveLength(3);
        expect(received.map(r => r.seq)).toEqual([0, 1, 2]);

        await client.close();
    });

    it('cleanup function stops notification delivery', async () => {
        const { client, serverTransport } = await createConnectedClient();

        const received: TaskPartialNotificationParams[] = [];
        const cleanup = client.experimental.tasks.subscribeTaskPartials('task-1', params => {
            received.push(params);
        });

        await sendPartialNotification(serverTransport, 'task-1', [{ type: 'text', text: 'before' }], 0);
        expect(received).toHaveLength(1);

        // Unsubscribe
        cleanup();

        await sendPartialNotification(serverTransport, 'task-1', [{ type: 'text', text: 'after' }], 1);
        expect(received).toHaveLength(1); // No new delivery

        await client.close();
    });

    it('discards notifications for unsubscribed taskIds silently', async () => {
        const { client, serverTransport } = await createConnectedClient();

        const received: TaskPartialNotificationParams[] = [];
        client.experimental.tasks.subscribeTaskPartials('task-1', params => {
            received.push(params);
        });

        // Send notification for a different taskId
        await sendPartialNotification(serverTransport, 'unknown-task-id', [{ type: 'text', text: 'nope' }], 0);

        expect(received).toHaveLength(0);

        await client.close();
    });

    it('routes notifications to correct handlers for multiple concurrent subscriptions', async () => {
        const { client, serverTransport } = await createConnectedClient();

        const received1: TaskPartialNotificationParams[] = [];
        const received2: TaskPartialNotificationParams[] = [];

        client.experimental.tasks.subscribeTaskPartials('task-1', params => {
            received1.push(params);
        });
        client.experimental.tasks.subscribeTaskPartials('task-2', params => {
            received2.push(params);
        });

        // Interleave notifications for both tasks
        await sendPartialNotification(serverTransport, 'task-1', [{ type: 'text', text: 'task1-0' }], 0);
        await sendPartialNotification(serverTransport, 'task-2', [{ type: 'text', text: 'task2-0' }], 0);
        await sendPartialNotification(serverTransport, 'task-1', [{ type: 'text', text: 'task1-1' }], 1);
        await sendPartialNotification(serverTransport, 'task-2', [{ type: 'text', text: 'task2-1' }], 1);

        expect(received1).toHaveLength(2);
        expect(received2).toHaveLength(2);
        expect(received1[0]!.content).toEqual([{ type: 'text', text: 'task1-0' }]);
        expect(received1[1]!.content).toEqual([{ type: 'text', text: 'task1-1' }]);
        expect(received2[0]!.content).toEqual([{ type: 'text', text: 'task2-0' }]);
        expect(received2[1]!.content).toEqual([{ type: 'text', text: 'task2-1' }]);

        await client.close();
    });

    it('delivers notifications with seq gap and logs a warning', async () => {
        const { client, serverTransport } = await createConnectedClient();

        const errors: Error[] = [];
        client.onerror = (err: Error) => errors.push(err);

        const received: TaskPartialNotificationParams[] = [];
        client.experimental.tasks.subscribeTaskPartials('task-1', params => {
            received.push(params);
        });

        // Send seq 0, then skip to seq 3 (gap of 1, 2)
        await sendPartialNotification(serverTransport, 'task-1', [{ type: 'text', text: 'a' }], 0);
        await sendPartialNotification(serverTransport, 'task-1', [{ type: 'text', text: 'b' }], 3);

        expect(received).toHaveLength(2);
        expect(received[0]!.seq).toBe(0);
        expect(received[1]!.seq).toBe(3);

        // Should have logged a warning about the gap
        expect(errors.some(e => e.message.includes('seq gap detected'))).toBe(true);

        await client.close();
    });

    it('warns when first notification has seq > 0', async () => {
        const { client, serverTransport } = await createConnectedClient();

        const errors: Error[] = [];
        client.onerror = (err: Error) => errors.push(err);

        const received: TaskPartialNotificationParams[] = [];
        client.experimental.tasks.subscribeTaskPartials('task-1', params => {
            received.push(params);
        });

        // First notification with seq 5 (missed 0-4)
        await sendPartialNotification(serverTransport, 'task-1', [{ type: 'text', text: 'late' }], 5);

        expect(received).toHaveLength(1);
        expect(received[0]!.seq).toBe(5);

        // Should have logged a warning about missed initial partials
        expect(errors.some(e => e.message.includes('first partial notification has seq=5'))).toBe(true);

        await client.close();
    });

    it('logs error and discards notification with invalid params', async () => {
        const { client, serverTransport } = await createConnectedClient();

        const errors: Error[] = [];
        client.onerror = (err: Error) => errors.push(err);

        const received: TaskPartialNotificationParams[] = [];
        client.experimental.tasks.subscribeTaskPartials('task-1', params => {
            received.push(params);
        });

        // Send notification with invalid params (missing content)
        await serverTransport.send({
            jsonrpc: '2.0',
            method: 'notifications/tasks/partial',
            params: { taskId: 'task-1', seq: 0 }
        } as JSONRPCMessage);

        // The error is caught asynchronously via Promise.catch in Protocol._onnotification
        await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));

        expect(received).toHaveLength(0);
        expect(errors.some(e => e.message.includes('Uncaught error in notification handler'))).toBe(true);

        await client.close();
    });

    it('each subscription has independent seq tracking after re-subscribe', async () => {
        const { client, serverTransport } = await createConnectedClient();

        const received1: TaskPartialNotificationParams[] = [];
        const cleanup1 = client.experimental.tasks.subscribeTaskPartials('task-1', params => {
            received1.push(params);
        });

        await sendPartialNotification(serverTransport, 'task-1', [{ type: 'text', text: 'a' }], 0);
        await sendPartialNotification(serverTransport, 'task-1', [{ type: 'text', text: 'b' }], 1);
        expect(received1).toHaveLength(2);

        // Unsubscribe and re-subscribe (seq tracking resets)
        cleanup1();

        const received2: TaskPartialNotificationParams[] = [];
        client.experimental.tasks.subscribeTaskPartials('task-1', params => {
            received2.push(params);
        });

        // Send seq 0 again — should be accepted since subscription is new
        await sendPartialNotification(serverTransport, 'task-1', [{ type: 'text', text: 'c' }], 0);
        expect(received2).toHaveLength(1);
        expect(received2[0]!.seq).toBe(0);

        await client.close();
    });
});

// ---------------------------------------------------------------------------
// 9.2 — Property test: Notification routing correctness (Property 3)
// ---------------------------------------------------------------------------

// Feature: task-streaming-partial-results-sdk, Property 3: Notification routing correctness
describe('Property 3: Notification routing correctness', () => {
    it('for any set of subscriptions and notifications, each notification is delivered only to the matching handler', async () => {
        const { client, serverTransport } = await createConnectedClient();

        // Arbitrary for a set of distinct taskIds (1–10 subscriptions)
        const taskIdArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/).filter(s => s.length > 0);
        const taskIdSetArb = fc.uniqueArray(taskIdArb, { minLength: 1, maxLength: 10 });

        await fc.assert(
            fc.asyncProperty(taskIdSetArb, fc.integer({ min: 1, max: 20 }), async (taskIds, notificationCount) => {
                // Set up subscriptions for each taskId
                const receivedByTask = new Map<string, TaskPartialNotificationParams[]>();
                const cleanups: Array<() => void> = [];

                for (const taskId of taskIds) {
                    const received: TaskPartialNotificationParams[] = [];
                    receivedByTask.set(taskId, received);
                    cleanups.push(
                        client.experimental.tasks.subscribeTaskPartials(taskId, params => {
                            received.push(params);
                        })
                    );
                }

                // Send random notifications — pick a random taskId for each
                const sentByTask = new Map<string, number>();
                for (const taskId of taskIds) {
                    sentByTask.set(taskId, 0);
                }

                for (let i = 0; i < notificationCount; i++) {
                    const targetTaskId = taskIds[i % taskIds.length]!;
                    const currentSeq = sentByTask.get(targetTaskId)!;
                    sentByTask.set(targetTaskId, currentSeq + 1);

                    await sendPartialNotification(serverTransport, targetTaskId, [{ type: 'text', text: `msg-${i}` }], currentSeq);
                }

                // Verify: each handler received only notifications for its taskId
                for (const taskId of taskIds) {
                    const received = receivedByTask.get(taskId)!;
                    for (const params of received) {
                        expect(params.taskId).toBe(taskId);
                    }
                    // Count should match the number sent to this taskId
                    expect(received.length).toBe(sentByTask.get(taskId));
                }

                // Also verify no notifications were delivered to unsubscribed taskIds
                // by sending a notification for a taskId not in the set
                const unknownTaskId = 'unknown-' + taskIds.join('-');
                await sendPartialNotification(serverTransport, unknownTaskId, [{ type: 'text', text: 'stray' }], 0);
                for (const taskId of taskIds) {
                    const received = receivedByTask.get(taskId)!;
                    expect(received.every(p => p.taskId === taskId)).toBe(true);
                }

                // Clean up subscriptions for next iteration
                for (const cleanup of cleanups) {
                    cleanup();
                }
            }),
            { numRuns: 100 }
        );

        await client.close();
    });
});

// ---------------------------------------------------------------------------
// 9.3 — Property test: Seq-based ordering and deduplication (Property 4)
// ---------------------------------------------------------------------------

// Feature: task-streaming-partial-results-sdk, Property 4: Seq-based ordering and deduplication
describe('Property 4: Seq-based ordering and deduplication', () => {
    it('for any sequence of seq values, correctly delivers, discards duplicates, and warns on gaps', async () => {
        const { client, serverTransport } = await createConnectedClient();

        // Generate a random sequence of seq values (0–100) with possible duplicates and gaps
        const seqSequenceArb = fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 50 });

        await fc.assert(
            fc.asyncProperty(seqSequenceArb, async seqValues => {
                const taskId = 'prop-test-task';

                const delivered: number[] = [];
                const errors: string[] = [];

                // Capture errors/warnings
                client.onerror = (err: Error) => errors.push(err.message);

                const cleanup = client.experimental.tasks.subscribeTaskPartials(taskId, params => {
                    delivered.push(params.seq);
                });

                // Replay the seq sequence
                for (const seq of seqValues) {
                    await sendPartialNotification(serverTransport, taskId, [{ type: 'text', text: `seq-${seq}` }], seq);
                }

                // Compute expected behavior
                let lastSeq = -1;
                const expectedDelivered: number[] = [];
                let expectGapWarnings = 0;
                let expectMissedInitialWarning = false;

                for (const seq of seqValues) {
                    if (seq <= lastSeq) {
                        // Duplicate — should be discarded
                        continue;
                    }

                    if (lastSeq === -1 && seq > 0) {
                        // First notification with seq > 0
                        expectMissedInitialWarning = true;
                    } else if (seq > lastSeq + 1) {
                        // Gap detected
                        expectGapWarnings++;
                    }

                    expectedDelivered.push(seq);
                    lastSeq = seq;
                }

                // Verify delivered notifications match expected
                expect(delivered).toEqual(expectedDelivered);

                // Verify warnings were generated for gaps
                if (expectMissedInitialWarning) {
                    expect(errors.some(e => e.includes('first partial notification has seq='))).toBe(true);
                }
                if (expectGapWarnings > 0) {
                    const gapWarnings = errors.filter(e => e.includes('seq gap detected'));
                    expect(gapWarnings.length).toBe(expectGapWarnings);
                }

                // Clean up for next iteration
                cleanup();
                errors.length = 0;
                client.onerror = undefined;
            }),
            { numRuns: 100 }
        );

        await client.close();
    });

    it('delivered seq values are always strictly increasing', async () => {
        const { client, serverTransport } = await createConnectedClient();

        const seqSequenceArb = fc.array(fc.integer({ min: 0, max: 200 }), { minLength: 1, maxLength: 100 });

        await fc.assert(
            fc.asyncProperty(seqSequenceArb, async seqValues => {
                const taskId = 'monotonic-test';
                const delivered: number[] = [];

                const cleanup = client.experimental.tasks.subscribeTaskPartials(taskId, params => {
                    delivered.push(params.seq);
                });

                for (const seq of seqValues) {
                    await sendPartialNotification(serverTransport, taskId, [{ type: 'text', text: `v-${seq}` }], seq);
                }

                // Verify delivered seq values are strictly increasing
                for (let i = 1; i < delivered.length; i++) {
                    expect(delivered[i]!).toBeGreaterThan(delivered[i - 1]!);
                }

                cleanup();
            }),
            { numRuns: 100 }
        );

        await client.close();
    });

    it('the number of delivered notifications never exceeds the number of unique increasing seq values', async () => {
        const { client, serverTransport } = await createConnectedClient();

        const seqSequenceArb = fc.array(fc.integer({ min: 0, max: 50 }), { minLength: 1, maxLength: 50 });

        await fc.assert(
            fc.asyncProperty(seqSequenceArb, async seqValues => {
                const taskId = 'count-test';
                const delivered: number[] = [];

                const cleanup = client.experimental.tasks.subscribeTaskPartials(taskId, params => {
                    delivered.push(params.seq);
                });

                for (const seq of seqValues) {
                    await sendPartialNotification(serverTransport, taskId, [{ type: 'text', text: `n-${seq}` }], seq);
                }

                // Count unique seq values that would be accepted (strictly increasing from -1)
                let lastSeq = -1;
                let expectedCount = 0;
                for (const seq of seqValues) {
                    if (seq > lastSeq) {
                        expectedCount++;
                        lastSeq = seq;
                    }
                }

                expect(delivered.length).toBe(expectedCount);

                cleanup();
            }),
            { numRuns: 100 }
        );

        await client.close();
    });
});
