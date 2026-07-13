/**
 * In-band input-request vocabulary of the 2026-07-28 revision (SEP-2322
 * multi round-trip requests), dispatch view.
 *
 * The three former server→client wire requests (`elicitation/create`,
 * `sampling/createMessage`, `roots/list`) are NOT wire request methods on
 * this revision — they are demoted to de-JSON-RPC'd payloads embedded in an
 * `input_required` result. The multi-round-trip driver dispatches those
 * embedded payloads to the client's registered handlers through the normal
 * handler machinery, and these are the schemas that dispatch parses them
 * with: lenient where the anchor's wire-true artifacts are strict (an
 * embedded request never carries the per-request `_meta` envelope), exact
 * where the vocabulary forks (the sampling shapes compose the forked
 * SamplingMessage/Tool payloads).
 *
 * Registry membership is intentionally NOT granted here — these methods stay
 * absent from the 2026-era request registry (a peer sending one as a wire
 * request still gets −32601 by absence). Only the codec's
 * `inputRequestSchema`/`inputResponseSchema` accessors expose them.
 */
import * as z from 'zod/v4';

import type { RequestMethod, RequestTypeMap, ResultTypeMap } from '../../types/types';
import { buildSchemas2026 } from './buildSchemas';

/** The embedded input-request methods of the 2026-07-28 revision. */
export const INPUT_REQUEST_METHODS_2026 = ['elicitation/create', 'sampling/createMessage', 'roots/list'] as const;

export type InputRequestMethod2026 = (typeof INPUT_REQUEST_METHODS_2026)[number];

/* The embedded-request maps are built lazily through the era's memoized
 * schema factory (`buildSchemas2026`) so importing this module constructs no
 * zod schemas; the maps themselves are memoized alongside. */
interface InputSchemaMaps {
    /** Dispatch-time (lenient) embedded request schemas, keyed by method. */
    readonly request: Record<InputRequestMethod2026, z.ZodType>;
    /** Embedded (bare) response schemas, keyed by the request method they answer. */
    readonly response: Record<InputRequestMethod2026, z.ZodType>;
}

let maps: InputSchemaMaps | undefined;

function inputSchemaMaps(): InputSchemaMaps {
    if (maps) return maps;
    const s = buildSchemas2026();
    maps = {
        request: {
            'elicitation/create': z.object({
                method: z.literal('elicitation/create'),
                params: s.ElicitRequestParamsSchema
            }),
            'sampling/createMessage': z.object({
                method: z.literal('sampling/createMessage'),
                params: s.CreateMessageRequestParamsSchema
            }),
            'roots/list': z.object({
                method: z.literal('roots/list'),
                params: z.looseObject({}).optional()
            })
        },
        response: {
            'elicitation/create': s.ElicitResultSchema,
            'sampling/createMessage': s.CreateMessageResultSchema,
            'roots/list': s.ListRootsResultSchema
        }
    };
    return maps;
}

export function isInputRequestMethod2026(method: string): method is InputRequestMethod2026 {
    return (INPUT_REQUEST_METHODS_2026 as readonly string[]).includes(method);
}

/**
 * Gets the dispatch (lenient) schema for an embedded input request, or
 * `undefined` for methods that are not in-band vocabulary on this era.
 * The typed overload mirrors `WireCodec.inputRequestSchema`.
 */
export function getInputRequestSchema2026<M extends RequestMethod>(method: M): z.ZodType<RequestTypeMap[M]> | undefined;
export function getInputRequestSchema2026(method: string): z.ZodType | undefined;
export function getInputRequestSchema2026(method: string): z.ZodType | undefined {
    return isInputRequestMethod2026(method) ? inputSchemaMaps().request[method] : undefined;
}

/**
 * Gets the bare embedded-response schema answering an embedded input request,
 * or `undefined` for methods that are not in-band vocabulary on this era.
 */
export function getInputResponseSchema2026<M extends RequestMethod>(method: M): z.ZodType<ResultTypeMap[M]> | undefined;
export function getInputResponseSchema2026(method: string): z.ZodType | undefined;
export function getInputResponseSchema2026(method: string): z.ZodType | undefined {
    return isInputRequestMethod2026(method) ? inputSchemaMaps().response[method] : undefined;
}
