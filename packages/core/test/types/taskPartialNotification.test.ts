import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
    ClientTasksCapabilitySchema,
    ContentBlockSchema,
    ServerNotificationSchema,
    ServerTasksCapabilitySchema,
    TaskPartialNotificationParamsSchema,
    TaskPartialNotificationSchema,
    ToolExecutionSchema
} from '../../src/types/schemas.js';
import { isSpecType, specTypeSchemas } from '../../src/types/specTypeSchema.js';

// ---------------------------------------------------------------------------
// 7.1 — Schema validation tests
// ---------------------------------------------------------------------------

describe('TaskPartialNotificationParamsSchema', () => {
    it('accepts a valid payload', () => {
        const result = TaskPartialNotificationParamsSchema.safeParse({
            taskId: 'task-1',
            content: [{ type: 'text', text: 'hello' }],
            seq: 0
        });
        expect(result.success).toBe(true);
    });

    it('accepts a payload with seq > 0', () => {
        const result = TaskPartialNotificationParamsSchema.safeParse({
            taskId: 'task-1',
            content: [{ type: 'text', text: 'chunk' }],
            seq: 42
        });
        expect(result.success).toBe(true);
    });

    it('accepts a payload with multiple content blocks', () => {
        const result = TaskPartialNotificationParamsSchema.safeParse({
            taskId: 'task-1',
            content: [
                { type: 'text', text: 'hello' },
                { type: 'text', text: 'world' }
            ],
            seq: 0
        });
        expect(result.success).toBe(true);
    });

    it('accepts a payload with optional _meta field', () => {
        const result = TaskPartialNotificationParamsSchema.safeParse({
            taskId: 'task-1',
            content: [{ type: 'text', text: 'hello' }],
            seq: 0,
            _meta: { custom: 'value' }
        });
        expect(result.success).toBe(true);
    });

    // --- Rejection tests (Requirement 12.2) ---

    it('rejects a payload with missing taskId', () => {
        const result = TaskPartialNotificationParamsSchema.safeParse({
            content: [{ type: 'text', text: 'hello' }],
            seq: 0
        });
        expect(result.success).toBe(false);
    });

    it('rejects a payload with missing content', () => {
        const result = TaskPartialNotificationParamsSchema.safeParse({
            taskId: 'task-1',
            seq: 0
        });
        expect(result.success).toBe(false);
    });

    it('rejects a payload with missing seq', () => {
        const result = TaskPartialNotificationParamsSchema.safeParse({
            taskId: 'task-1',
            content: [{ type: 'text', text: 'hello' }]
        });
        expect(result.success).toBe(false);
    });

    // --- Empty content (Requirement 12.3) ---

    it('rejects a payload with empty content array', () => {
        const result = TaskPartialNotificationParamsSchema.safeParse({
            taskId: 'task-1',
            content: [],
            seq: 0
        });
        expect(result.success).toBe(false);
    });

    // --- Negative seq (Requirement 12.4) ---

    it('rejects a payload with negative seq', () => {
        const result = TaskPartialNotificationParamsSchema.safeParse({
            taskId: 'task-1',
            content: [{ type: 'text', text: 'hello' }],
            seq: -1
        });
        expect(result.success).toBe(false);
    });

    // --- Non-integer seq (Requirement 12.5) ---

    it('rejects a payload with non-integer seq (1.5)', () => {
        const result = TaskPartialNotificationParamsSchema.safeParse({
            taskId: 'task-1',
            content: [{ type: 'text', text: 'hello' }],
            seq: 1.5
        });
        expect(result.success).toBe(false);
    });

    it('rejects a payload with non-integer seq (0.1)', () => {
        const result = TaskPartialNotificationParamsSchema.safeParse({
            taskId: 'task-1',
            content: [{ type: 'text', text: 'hello' }],
            seq: 0.1
        });
        expect(result.success).toBe(false);
    });

    it('rejects a payload with empty taskId', () => {
        const result = TaskPartialNotificationParamsSchema.safeParse({
            taskId: '',
            content: [{ type: 'text', text: 'hello' }],
            seq: 0
        });
        expect(result.success).toBe(false);
    });
});

describe('TaskPartialNotificationSchema', () => {
    it('validates a full JSON-RPC notification envelope', () => {
        const result = TaskPartialNotificationSchema.safeParse({
            method: 'notifications/tasks/partial',
            params: {
                taskId: 'task-1',
                content: [{ type: 'text', text: 'hello' }],
                seq: 0
            }
        });
        expect(result.success).toBe(true);
    });

    it('rejects a notification with wrong method', () => {
        const result = TaskPartialNotificationSchema.safeParse({
            method: 'notifications/tasks/status',
            params: {
                taskId: 'task-1',
                content: [{ type: 'text', text: 'hello' }],
                seq: 0
            }
        });
        expect(result.success).toBe(false);
    });

    it('rejects a notification with invalid params', () => {
        const result = TaskPartialNotificationSchema.safeParse({
            method: 'notifications/tasks/partial',
            params: {
                taskId: 'task-1',
                content: [],
                seq: 0
            }
        });
        expect(result.success).toBe(false);
    });
});

describe('ServerNotificationSchema includes TaskPartialNotification', () => {
    it('accepts a valid TaskPartialNotification', () => {
        const result = ServerNotificationSchema.safeParse({
            method: 'notifications/tasks/partial',
            params: {
                taskId: 'task-1',
                content: [{ type: 'text', text: 'hello' }],
                seq: 0
            }
        });
        expect(result.success).toBe(true);
    });
});

describe('ServerTasksCapabilitySchema accepts streaming.partial', () => {
    it('accepts streaming.partial as an empty object', () => {
        const result = ServerTasksCapabilitySchema.safeParse({
            streaming: { partial: {} }
        });
        expect(result.success).toBe(true);
    });

    it('accepts streaming without partial', () => {
        const result = ServerTasksCapabilitySchema.safeParse({
            streaming: {}
        });
        expect(result.success).toBe(true);
    });

    it('accepts capabilities without streaming', () => {
        const result = ServerTasksCapabilitySchema.safeParse({
            list: {}
        });
        expect(result.success).toBe(true);
    });
});

describe('ClientTasksCapabilitySchema accepts streaming.partial', () => {
    it('accepts streaming.partial as an empty object', () => {
        const result = ClientTasksCapabilitySchema.safeParse({
            streaming: { partial: {} }
        });
        expect(result.success).toBe(true);
    });

    it('accepts streaming without partial', () => {
        const result = ClientTasksCapabilitySchema.safeParse({
            streaming: {}
        });
        expect(result.success).toBe(true);
    });

    it('accepts capabilities without streaming', () => {
        const result = ClientTasksCapabilitySchema.safeParse({
            list: {}
        });
        expect(result.success).toBe(true);
    });
});

describe('ToolExecutionSchema accepts streamPartial', () => {
    it('accepts streamPartial: true', () => {
        const result = ToolExecutionSchema.safeParse({
            taskSupport: 'required',
            streamPartial: true
        });
        expect(result.success).toBe(true);
    });

    it('accepts streamPartial: false', () => {
        const result = ToolExecutionSchema.safeParse({
            taskSupport: 'optional',
            streamPartial: false
        });
        expect(result.success).toBe(true);
    });

    it('accepts without streamPartial (optional field)', () => {
        const result = ToolExecutionSchema.safeParse({
            taskSupport: 'required'
        });
        expect(result.success).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// 7.2 — Property test: Schema round-trip preservation (Property 1)
// ---------------------------------------------------------------------------

// Feature: task-streaming-partial-results-sdk, Property 1: Schema round-trip preservation
describe('Property 1: Schema round-trip preservation', () => {
    // Arbitrary for a valid TextContent block (simplest ContentBlock variant)
    const textContentArb = fc.record({
        type: fc.constant('text' as const),
        text: fc.string()
    });

    // Arbitrary for valid TaskPartialNotificationParams
    const taskPartialParamsArb = fc.record({
        taskId: fc.string({ minLength: 1 }),
        content: fc.array(textContentArb, { minLength: 1 }),
        seq: fc.nat()
    });

    it('round-trips through TaskPartialNotificationParamsSchema', () => {
        fc.assert(
            fc.property(taskPartialParamsArb, params => {
                const parsed = TaskPartialNotificationParamsSchema.safeParse(params);
                expect(parsed.success).toBe(true);
                if (parsed.success) {
                    expect(parsed.data.taskId).toBe(params.taskId);
                    expect(parsed.data.seq).toBe(params.seq);
                    expect(parsed.data.content).toHaveLength(params.content.length);
                    for (let i = 0; i < params.content.length; i++) {
                        const expected = params.content[i]!;
                        expect(parsed.data.content[i]).toMatchObject(expected);
                    }
                }
            }),
            { numRuns: 100 }
        );
    });

    it('round-trips through ContentBlockSchema for each content item', () => {
        fc.assert(
            fc.property(textContentArb, block => {
                const parsed = ContentBlockSchema.safeParse(block);
                expect(parsed.success).toBe(true);
                if (parsed.success) {
                    expect(parsed.data).toMatchObject(block);
                }
            }),
            { numRuns: 100 }
        );
    });
});

// ---------------------------------------------------------------------------
// 7.4 — Schema registry entries
// ---------------------------------------------------------------------------

describe('specTypeSchemas registry for TaskPartialNotification', () => {
    it('TaskPartialNotificationParams exists and validates correctly', () => {
        expect(specTypeSchemas.TaskPartialNotificationParams).toBeDefined();
        const result = specTypeSchemas.TaskPartialNotificationParams['~standard'].validate({
            taskId: 'task-1',
            content: [{ type: 'text', text: 'hello' }],
            seq: 0
        });
        expect((result as { issues?: unknown }).issues).toBeUndefined();
    });

    it('TaskPartialNotificationParams rejects invalid payloads', () => {
        const result = specTypeSchemas.TaskPartialNotificationParams['~standard'].validate({
            taskId: '',
            content: [],
            seq: -1
        });
        expect((result as { issues?: readonly unknown[] }).issues?.length).toBeGreaterThan(0);
    });

    it('TaskPartialNotification exists and validates correctly', () => {
        expect(specTypeSchemas.TaskPartialNotification).toBeDefined();
        const result = specTypeSchemas.TaskPartialNotification['~standard'].validate({
            method: 'notifications/tasks/partial',
            params: {
                taskId: 'task-1',
                content: [{ type: 'text', text: 'hello' }],
                seq: 0
            }
        });
        expect((result as { issues?: unknown }).issues).toBeUndefined();
    });

    it('TaskPartialNotification rejects invalid payloads', () => {
        const result = specTypeSchemas.TaskPartialNotification['~standard'].validate({
            method: 'notifications/tasks/partial',
            params: {
                taskId: 'task-1',
                content: [],
                seq: 0
            }
        });
        expect((result as { issues?: readonly unknown[] }).issues?.length).toBeGreaterThan(0);
    });
});

describe('isSpecType guards for TaskPartialNotification', () => {
    it('isSpecType.TaskPartialNotificationParams accepts valid values', () => {
        expect(
            isSpecType.TaskPartialNotificationParams({
                taskId: 'task-1',
                content: [{ type: 'text', text: 'hello' }],
                seq: 0
            })
        ).toBe(true);
    });

    it('isSpecType.TaskPartialNotificationParams rejects invalid values', () => {
        expect(isSpecType.TaskPartialNotificationParams({ taskId: '', content: [], seq: -1 })).toBe(false);
        expect(isSpecType.TaskPartialNotificationParams(null)).toBe(false);
        expect(isSpecType.TaskPartialNotificationParams('string')).toBe(false);
    });

    it('isSpecType.TaskPartialNotification accepts valid values', () => {
        expect(
            isSpecType.TaskPartialNotification({
                method: 'notifications/tasks/partial',
                params: {
                    taskId: 'task-1',
                    content: [{ type: 'text', text: 'hello' }],
                    seq: 0
                }
            })
        ).toBe(true);
    });

    it('isSpecType.TaskPartialNotification rejects invalid values', () => {
        expect(
            isSpecType.TaskPartialNotification({
                method: 'notifications/tasks/partial',
                params: { taskId: '', content: [], seq: -1 }
            })
        ).toBe(false);
        expect(isSpecType.TaskPartialNotification(null)).toBe(false);
    });
});
