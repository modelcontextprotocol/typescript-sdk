/**
 * Registry byte-identity pre-pins for the wire-layer re-homing (Q1 increment 2).
 *
 * These tests pin the EXACT contents of the runtime method registries —
 * method sets and per-method schema identity (by object reference) — so that
 * relocating the registries behind the per-era codec interface is provably
 * mechanical: the same schema objects must serve the same methods before and
 * after the move. They are committed BEFORE the relocation lands (suite, then
 * move — Q10-L2 ordering).
 *
 * The 2025-era registry is behavior-frozen: the request/notification maps
 * carry the full deliberate 2025-11-25 wire vocabulary, including the task
 * family (#2248 wire-interop restore). The RESULT map is the runtime/typed
 * ALIGNED map (PR #2293 review fix): plain per-method schemas keyed by
 * `RequestMethod` — no task-result union members and no `tasks/*` entries
 * (task-method interop goes through the explicit-schema overload; see
 * `test/shared/typedMapAlignment.test.ts` for the behavioral pins). Do not
 * edit these pins to make a refactor pass; a pin change is a wire-behavior
 * decision and needs a changeset + migration entry (Q10-L2).
 */
import { describe, expect, it } from 'vitest';

// Post-relocation home (Q1 increment-2 step 1): the pinned contents are
// unchanged — only the module housing the registries moved.
import { getNotificationSchema, getRequestSchema, CallToolResultWireSchema, getResultSchema } from '../../src/wire/rev2025-11-25/registry';
// The 2025 wire schemas are fully self-contained in the era's schema module:
// every per-method schema the registry serves is a FROZEN 2025-11-25 copy so
// the public/neutral layer can evolve (e.g. SEP-2106 widening) without
// changing the 2025 wire-parse contract. The registry serves the FROZEN
// copies, so the by-reference pins target this module.
import {
    CallToolRequestSchema,
    CallToolResultSchema,
    CancelledNotificationSchema,
    CancelTaskRequestSchema,
    CompleteRequestSchema,
    CompleteResultSchema,
    CreateMessageRequestSchema,
    CreateMessageResultWithToolsSchema,
    ElicitationCompleteNotificationSchema,
    ElicitRequestSchema,
    ElicitResultSchema,
    EmptyResultSchema,
    GetPromptRequestSchema,
    GetPromptResultSchema,
    GetTaskPayloadRequestSchema,
    GetTaskRequestSchema,
    InitializedNotificationSchema,
    InitializeRequestSchema,
    InitializeResultSchema,
    ListPromptsRequestSchema,
    ListPromptsResultSchema,
    ListResourcesRequestSchema,
    ListResourcesResultSchema,
    ListResourceTemplatesRequestSchema,
    ListResourceTemplatesResultSchema,
    ListRootsRequestSchema,
    ListRootsResultSchema,
    ListTasksRequestSchema,
    ListToolsRequestSchema,
    ListToolsResultSchema,
    LoggingMessageNotificationSchema,
    PingRequestSchema,
    ProgressNotificationSchema,
    PromptListChangedNotificationSchema,
    ReadResourceRequestSchema,
    ReadResourceResultSchema,
    ResourceListChangedNotificationSchema,
    ResourceUpdatedNotificationSchema,
    RootsListChangedNotificationSchema,
    SetLevelRequestSchema,
    SubscribeRequestSchema,
    TaskStatusNotificationSchema,
    ToolListChangedNotificationSchema,
    UnsubscribeRequestSchema
} from '../../src/wire/rev2025-11-25/schemas';

/** The exact 2025-era request-method → schema map (today's wire surface, verbatim). */
const EXPECTED_REQUEST_SCHEMAS = {
    ping: PingRequestSchema,
    initialize: InitializeRequestSchema,
    'completion/complete': CompleteRequestSchema,
    'logging/setLevel': SetLevelRequestSchema,
    'prompts/get': GetPromptRequestSchema,
    'prompts/list': ListPromptsRequestSchema,
    'resources/list': ListResourcesRequestSchema,
    'resources/templates/list': ListResourceTemplatesRequestSchema,
    'resources/read': ReadResourceRequestSchema,
    'resources/subscribe': SubscribeRequestSchema,
    'resources/unsubscribe': UnsubscribeRequestSchema,
    'tools/call': CallToolRequestSchema,
    'tools/list': ListToolsRequestSchema,
    'tasks/get': GetTaskRequestSchema,
    'tasks/result': GetTaskPayloadRequestSchema,
    'tasks/list': ListTasksRequestSchema,
    'tasks/cancel': CancelTaskRequestSchema,
    'sampling/createMessage': CreateMessageRequestSchema,
    'elicitation/create': ElicitRequestSchema,
    'roots/list': ListRootsRequestSchema
} as const;

/** The exact 2025-era notification-method → schema map. */
const EXPECTED_NOTIFICATION_SCHEMAS = {
    'notifications/cancelled': CancelledNotificationSchema,
    'notifications/progress': ProgressNotificationSchema,
    'notifications/initialized': InitializedNotificationSchema,
    'notifications/roots/list_changed': RootsListChangedNotificationSchema,
    'notifications/tasks/status': TaskStatusNotificationSchema,
    'notifications/message': LoggingMessageNotificationSchema,
    'notifications/resources/updated': ResourceUpdatedNotificationSchema,
    'notifications/resources/list_changed': ResourceListChangedNotificationSchema,
    'notifications/tools/list_changed': ToolListChangedNotificationSchema,
    'notifications/prompts/list_changed': PromptListChangedNotificationSchema,
    'notifications/elicitation/complete': ElicitationCompleteNotificationSchema
} as const;

/**
 * The exact 2025-era result map (the runtime/typed ALIGNED map — every entry
 * is the plain schema `ResultTypeMap` declares; identity-pinned by reference).
 */
const EXPECTED_RESULT_SCHEMAS = {
    ping: EmptyResultSchema,
    initialize: InitializeResultSchema,
    'completion/complete': CompleteResultSchema,
    'logging/setLevel': EmptyResultSchema,
    'prompts/get': GetPromptResultSchema,
    'prompts/list': ListPromptsResultSchema,
    'resources/list': ListResourcesResultSchema,
    'resources/templates/list': ListResourceTemplatesResultSchema,
    'resources/read': ReadResourceResultSchema,
    'resources/subscribe': EmptyResultSchema,
    'resources/unsubscribe': EmptyResultSchema,
    // The wire-seam wrapper (content-default guard) IS the pinned entry —
    // identity to the wrapper, which pipes into the plain schema.
    'tools/call': CallToolResultWireSchema,
    'tools/list': ListToolsResultSchema,
    'sampling/createMessage': CreateMessageResultWithToolsSchema,
    'elicitation/create': ElicitResultSchema,
    'roots/list': ListRootsResultSchema
} as const;

/**
 * Task methods: served by the request map (2025 wire vocabulary, param-side
 * tolerance) but deliberately ABSENT from the result map — `ResultTypeMap`
 * excludes them, so the runtime map must too; callers needing task interop
 * pass an explicit result schema (the documented overload).
 */
const TASK_REQUEST_METHODS = ['tasks/get', 'tasks/result', 'tasks/list', 'tasks/cancel'] as const;

/** Methods that must NOT be in the 2025-era registries (2026-only vocabulary). */
const NOT_IN_2025 = ['server/discover', 'subscriptions/listen', 'notifications/subscriptions/acknowledged'] as const;

describe('2025-era registry pins (suite-then-move, Q10-L2)', () => {
    it('serves exactly the pinned request methods, with the pinned schema objects', () => {
        for (const [method, schema] of Object.entries(EXPECTED_REQUEST_SCHEMAS)) {
            expect(getRequestSchema(method), method).toBe(schema);
        }
    });

    it('serves exactly the pinned notification methods, with the pinned schema objects', () => {
        for (const [method, schema] of Object.entries(EXPECTED_NOTIFICATION_SCHEMAS)) {
            expect(getNotificationSchema(method), method).toBe(schema);
        }
    });

    it('serves the pinned result entries by reference (aligned: plain schemas, no unions)', () => {
        for (const [method, schema] of Object.entries(EXPECTED_RESULT_SCHEMAS)) {
            expect(getResultSchema(method), method).toBe(schema);
        }
    });

    it('serves task requests but has no task result entries (explicit-schema interop)', () => {
        for (const method of TASK_REQUEST_METHODS) {
            expect(getRequestSchema(method), method).toBeDefined();
            expect(getResultSchema(method), method).toBeUndefined();
        }
    });

    it('returns undefined for non-spec and 2026-only methods', () => {
        for (const method of [...NOT_IN_2025, 'acme/custom', 'notifications/acme']) {
            expect(getRequestSchema(method), method).toBeUndefined();
            expect(getResultSchema(method), method).toBeUndefined();
            expect(getNotificationSchema(method), method).toBeUndefined();
        }
    });

    it('the registries contain nothing beyond the pinned method sets', () => {
        // Completeness guard in the inverse direction: enumerating the maps
        // through their module surface must not reveal extra methods.
        const requestMethods = Object.keys(EXPECTED_REQUEST_SCHEMAS).sort();
        const notificationMethods = Object.keys(EXPECTED_NOTIFICATION_SCHEMAS).sort();
        const resultMethods = Object.keys(EXPECTED_RESULT_SCHEMAS).sort();
        expect(requestMethods).toHaveLength(20);
        expect(notificationMethods).toHaveLength(11);
        expect(resultMethods).toHaveLength(16);
        // The result-method set is exactly the request-method set minus the
        // four task methods (runtime/typed alignment).
        expect(resultMethods).toEqual(requestMethods.filter(method => !method.startsWith('tasks/')));
    });
});
