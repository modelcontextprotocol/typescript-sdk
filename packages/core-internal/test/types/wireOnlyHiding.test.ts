/**
 * Public-face hiding pins: wire-only members and task vocabulary.
 *
 * Two contracts, enforced at the type level:
 *
 * 1. Wire-only members are absent from every public result type. `resultType`
 *    is the 2026-07-28 wire discrimination field; the SDK consumes it at the
 *    protocol layer and the public types do not declare it. The wire schemas
 *    keep modeling it internally (also pinned here, so the internal surface
 *    cannot drift silently either).
 *
 * 2. Task types are importable, deprecated wire vocabulary that appears in NO
 *    API signature: the typed method surface (RequestMethod/RequestTypeMap/
 *    ResultTypeMap/NotificationTypeMap and everything built on them) offers
 *    no task method, and the only public declarations naming task types are
 *    the deprecated vocabulary cluster itself plus the exclusion helpers that
 *    subtract the task methods from the maps.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, expectTypeOf, test } from 'vitest';
import type * as z from 'zod/v4';

import type {
    CallToolResult,
    CancelTaskResult,
    CompleteResult,
    CreateMessageResult,
    CreateMessageResultWithTools,
    CreateTaskResult,
    ElicitResult,
    EmptyResult,
    GetTaskResult,
    InitializeResult,
    JSONRPCResultResponse,
    ListRootsResult,
    ListTasksResult,
    ListToolsResult,
    NotificationMethod,
    ReadResourceResult,
    RequestMethod,
    RequestTypeMap,
    Result,
    ResultTypeMap,
    Task,
    TaskAugmentedRequestParams
} from '../../src/types/types';
import { CallToolResultSchema, ResultSchema } from '../../src/types/schemas';

/** Declared (non-index-signature) keys of T. */
type KnownKeyOf<T> = keyof { [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K] };

type DeclaresResultType<T> = 'resultType' extends KnownKeyOf<T> ? true : false;

describe('wire-only members are hidden from the public result types', () => {
    test('no public result type declares resultType', () => {
        expectTypeOf<DeclaresResultType<Result>>().toEqualTypeOf<false>();
        expectTypeOf<DeclaresResultType<EmptyResult>>().toEqualTypeOf<false>();
        expectTypeOf<DeclaresResultType<InitializeResult>>().toEqualTypeOf<false>();
        expectTypeOf<DeclaresResultType<CallToolResult>>().toEqualTypeOf<false>();
        expectTypeOf<DeclaresResultType<ListToolsResult>>().toEqualTypeOf<false>();
        expectTypeOf<DeclaresResultType<ReadResourceResult>>().toEqualTypeOf<false>();
        expectTypeOf<DeclaresResultType<CompleteResult>>().toEqualTypeOf<false>();
        expectTypeOf<DeclaresResultType<CreateMessageResult>>().toEqualTypeOf<false>();
        expectTypeOf<DeclaresResultType<CreateMessageResultWithTools>>().toEqualTypeOf<false>();
        expectTypeOf<DeclaresResultType<ElicitResult>>().toEqualTypeOf<false>();
        expectTypeOf<DeclaresResultType<ListRootsResult>>().toEqualTypeOf<false>();
        // Deprecated task results are public vocabulary and equally stripped.
        expectTypeOf<DeclaresResultType<CreateTaskResult>>().toEqualTypeOf<false>();
        expectTypeOf<DeclaresResultType<GetTaskResult>>().toEqualTypeOf<false>();
        // The response envelope embeds the public Result, not the wire shape.
        expectTypeOf<DeclaresResultType<JSONRPCResultResponse['result']>>().toEqualTypeOf<false>();

        // Value-assignability is untouched: handler-built results may still
        // carry the member through the loose index signature (raw bytes can
        // always carry it; the protocol layer owns it).
        const handlerBuilt: CallToolResult = { content: [], resultType: 'complete' };
        expect(handlerBuilt).toBeDefined();
    });

    test('no neutral schema models resultType any more (the masking surface is dead)', () => {
        // Q1 increment 2 (ledgered): the shared schema set carried an
        // optional resultType on every result parse — the masking surface.
        // Post-split, NO neutral schema declares it; the member exists only
        // inside the 2026-era wire codec module. Changeset:
        // codec-split-wire-break.
        expectTypeOf<DeclaresResultType<z.output<typeof ResultSchema>>>().toEqualTypeOf<false>();
        expectTypeOf<DeclaresResultType<z.output<typeof CallToolResultSchema>>>().toEqualTypeOf<false>();
    });
});

describe('task vocabulary is importable but in no API signature', () => {
    test('the typed method surface offers no task method', () => {
        expectTypeOf<Extract<RequestMethod, `tasks/${string}`>>().toEqualTypeOf<never>();
        expectTypeOf<Extract<keyof RequestTypeMap, `tasks/${string}`>>().toEqualTypeOf<never>();
        expectTypeOf<Extract<keyof ResultTypeMap, `tasks/${string}`>>().toEqualTypeOf<never>();
        expectTypeOf<Extract<NotificationMethod, `notifications/tasks/${string}`>>().toEqualTypeOf<never>();
    });

    test('method-keyed results are plain (no unreachable task members)', () => {
        expectTypeOf<ResultTypeMap['tools/call']>().toEqualTypeOf<CallToolResult>();
        expectTypeOf<ResultTypeMap['elicitation/create']>().toEqualTypeOf<ElicitResult>();
        expectTypeOf<ResultTypeMap['sampling/createMessage']>().toEqualTypeOf<CreateMessageResult | CreateMessageResultWithTools>();
    });

    test('task types stay importable as wire vocabulary', () => {
        // The type-only imports above are the proof; spot-check their shapes.
        expectTypeOf<Task['taskId']>().toEqualTypeOf<string>();
        expectTypeOf<CreateTaskResult['task']>().toEqualTypeOf<Task>();
        expectTypeOf<KnownKeyOf<TaskAugmentedRequestParams>>().toEqualTypeOf<'task' | '_meta'>();
        expectTypeOf<DeclaresResultType<ListTasksResult>>().toEqualTypeOf<false>();
        expectTypeOf<DeclaresResultType<CancelTaskResult>>().toEqualTypeOf<false>();
    });

    test('every task type export is tagged @deprecated at the source', () => {
        const source = readFileSync(join(__dirname, '..', '..', 'src', 'types', 'types.ts'), 'utf8');
        const taskExports = [...source.matchAll(/export type (\w*Task\w*) /g)].map(match => match[1]);
        expect(taskExports.length).toBeGreaterThanOrEqual(17);
        for (const name of taskExports) {
            const declaration = source.indexOf(`export type ${name} `);
            const preceding = source.slice(Math.max(0, declaration - 400), declaration);
            expect(preceding, `'${name}' must carry an @deprecated tag`).toContain('@deprecated');
        }

        const guards = readFileSync(join(__dirname, '..', '..', 'src', 'types', 'guards.ts'), 'utf8');
        const guardDecl = guards.indexOf('export const isTaskAugmentedRequestParams');
        expect(guards.slice(Math.max(0, guardDecl - 500), guardDecl)).toContain('@deprecated');
    });

    test('the task Zod schemas and the related-task meta key carry @deprecated too', () => {
        // The migration docs claim the FULL task wire surface is deprecated —
        // schemas and constants included, not just the inferred types. The
        // task MESSAGE schemas live in the 2025-era wire module since the
        // codec split (Q1 increment 2); the param-side carriers stay in the
        // neutral file. Both homes are scanned — the combined surface is the
        // same ≥19 schemas the docs claim covers.
        const neutral = readFileSync(join(__dirname, '..', '..', 'src', 'types', 'schemas.ts'), 'utf8');
        const wire2025 = readFileSync(join(__dirname, '..', '..', 'src', 'wire', 'rev2025-11-25', 'schemas.ts'), 'utf8');
        let total = 0;
        for (const schemas of [neutral, wire2025]) {
            const schemaExports = [...schemas.matchAll(/export const (\w*Tasks?\w*Schema) /g)].map(match => match[1]);
            total += schemaExports.length;
            for (const name of schemaExports) {
                const declaration = schemas.indexOf(`export const ${name} `);
                const preceding = schemas.slice(Math.max(0, declaration - 400), declaration);
                expect(preceding, `'${name}' must carry an @deprecated tag`).toContain('@deprecated');
            }
        }
        expect(total).toBeGreaterThanOrEqual(19);
        const schemas = neutral;

        // The `tasks` capability keys on both capability objects.
        for (const member of ['tasks: ClientTasksCapabilitySchema.optional()', 'tasks: ServerTasksCapabilitySchema.optional()']) {
            const declaration = schemas.indexOf(member);
            expect(declaration, `capability member '${member}' must exist`).toBeGreaterThan(-1);
            expect(schemas.slice(Math.max(0, declaration - 300), declaration), `'${member}' must carry an @deprecated tag`).toContain(
                '@deprecated'
            );
        }

        const constants = readFileSync(join(__dirname, '..', '..', 'src', 'types', 'constants.ts'), 'utf8');
        const keyDecl = constants.indexOf('export const RELATED_TASK_META_KEY');
        expect(constants.slice(Math.max(0, keyDecl - 300), keyDecl)).toContain('@deprecated');
    });
});

// A generated-declaration scan (no task type name in any public signature) used
// to live here; the type-level exclusion tests above pin the same contract
// directly against the source types, so the substance stays covered.
