import * as z from 'zod/v4';

import { ProtocolErrorCode } from '../types/enums';
import { ProtocolError } from '../types/errors';
import { ElicitRequestFormParamsSchema } from '../types/schemas';
import type { ElicitRequestFormParams } from '../types/types';
import { parseSchema } from '../util/schema';
import type { StandardSchemaWithJSON } from '../util/standardSchema';
import { standardSchemaToJsonSchema } from '../util/standardSchema';
import type { ElicitInputFormParams } from './protocol';

export type NormalizedElicitInputFormParams = {
    params: ElicitRequestFormParams;
    standardSchema?: StandardSchemaWithJSON;
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A `pattern` emitted beside a supported `format` is redundant — zod realizes every format
// check as a regex — and is dropped so the wire schema stays within the elicitation subset.
// The reference patterns are derived from the installed zod at runtime rather than vendored
// as string literals: zod's format regexes change across in-range releases, so a vendored
// copy would start rejecting schemas produced by any newer zod while CI (lockfile-pinned)
// stays green. A pattern the installed zod would not emit for that format — e.g. a
// customized `z.email({ pattern })` — still rejects, because the wire schema cannot carry it.
// Residual limitation: if the app resolves a second zod copy whose regexes differ from this
// package's resolved zod, its emissions won't match the reference and reject (fail closed);
// zod is a peer dependency precisely so installs dedupe to one copy.
// Derivation is cheap (a handful of toJSONSchema calls) and only runs when a stripped
// `pattern` sits beside a matching `format`, so no caching.

function zodEmittedPattern(schema: z.ZodType): string | undefined {
    // Conversion options must stay in lockstep with standardSchemaToJsonSchema (which
    // produced the pattern under comparison via `~standard.jsonSchema.input`).
    const jsonSchema = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>;
    return typeof jsonSchema.pattern === 'string' ? jsonSchema.pattern : undefined;
}

const DATETIME_FRACTION_DIGITS = /\\\.\\d\{(\d+)\}/;

function datetimeReferenceSchemas(pattern: string): z.ZodType[] {
    // The emitted pattern depends on the authoring options (offset/local/precision); the
    // fraction-digit count recovered from the pattern under test keeps the candidate set
    // finite. Duplicate candidates are fine — the result feeds a Set.
    const fractionDigits = DATETIME_FRACTION_DIGITS.exec(pattern);
    const precisions: Array<number | undefined> = [undefined, -1, 0];
    if (fractionDigits) {
        precisions.push(Number(fractionDigits[1]));
    }
    return [false, true].flatMap(local =>
        [false, true].flatMap(offset => precisions.map(precision => z.iso.datetime({ local, offset, precision })))
    );
}

function referencePatternsForFormat(format: string, pattern: string): ReadonlySet<string> {
    let referenceSchemas: z.ZodType[];
    switch (format) {
        case 'email': {
            referenceSchemas = [z.email()];
            break;
        }
        case 'uri': {
            referenceSchemas = [z.url()];
            break;
        }
        case 'date': {
            referenceSchemas = [z.iso.date()];
            break;
        }
        case 'date-time': {
            referenceSchemas = datetimeReferenceSchemas(pattern);
            break;
        }
        default: {
            referenceSchemas = [];
        }
    }
    return new Set(referenceSchemas.map(schema => zodEmittedPattern(schema)).filter((emitted): emitted is string => emitted !== undefined));
}

function isRedundantFormatPattern(original: Record<string, unknown>, parsed: Record<string, unknown>, key: string): boolean {
    if (
        key !== 'pattern' ||
        typeof original.pattern !== 'string' ||
        parsed.type !== 'string' ||
        typeof parsed.format !== 'string' ||
        original.format !== parsed.format
    ) {
        return false;
    }

    return referencePatternsForFormat(parsed.format, original.pattern).has(original.pattern);
}

const ANNOTATION_ONLY_JSON_SCHEMA_KEYWORDS = new Set(['$comment', 'deprecated', 'examples', 'readOnly', 'writeOnly']);

function isAnnotationOnlyJsonSchemaKeyword(key: string): boolean {
    return ANNOTATION_ONLY_JSON_SCHEMA_KEYWORDS.has(key) || key.startsWith('x-');
}

// The spec declares a closed shape for the `requestedSchema` root: `$schema`, `type`,
// `properties` and `required` only. The wire schema cannot enforce that (its root is a
// catchall so hand-authored extensions stay wire-legal), and the stripped-keys diff below
// never fires for root keys the catchall retains — so converted Standard Schemas are pruned
// here: annotation-only root keywords are dropped, anything else unknown rejects (e.g.
// `z.strictObject()` emits a root `additionalProperties: false`). The keyword set is derived
// from the wire schema so it tracks spec revisions; `$schema` is spec-declared but absent
// from the wire schema's declared keys (the catchall admits it).
const ELICITATION_ROOT_KEYWORDS = new Set(['$schema', ...Object.keys(ElicitRequestFormParamsSchema.shape.requestedSchema.shape)]);
const ROOT_ANNOTATION_KEYWORDS = new Set(['title', 'description']);

function pruneElicitationSchemaRoot(schema: Record<string, unknown>): Record<string, unknown> {
    const requestedSchema: Record<string, unknown> = {};
    const unsupportedKeys: string[] = [];
    for (const [key, value] of Object.entries(schema)) {
        if (ELICITATION_ROOT_KEYWORDS.has(key)) {
            requestedSchema[key] = value;
        } else if (!ROOT_ANNOTATION_KEYWORDS.has(key) && !isAnnotationOnlyJsonSchemaKeyword(key)) {
            unsupportedKeys.push(key);
        }
    }
    if (unsupportedKeys.length > 0) {
        throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Elicitation requestedSchema contains unsupported JSON Schema keyword(s) after Standard Schema conversion: ${unsupportedKeys.join(', ')}`
        );
    }
    return requestedSchema;
}

function findStrippedJsonSchemaPaths(original: unknown, parsed: unknown, path = ''): string[] {
    if (Array.isArray(original) && Array.isArray(parsed)) {
        return original.flatMap((item, index) => findStrippedJsonSchemaPaths(item, parsed[index], `${path}[${index}]`));
    }

    if (!isJsonObject(original) || !isJsonObject(parsed)) {
        return [];
    }

    return Object.entries(original).flatMap(([key, value]) => {
        const childPath = path ? `${path}.${key}` : key;
        if (!Object.prototype.hasOwnProperty.call(parsed, key)) {
            if (isRedundantFormatPattern(original, parsed, key) || isAnnotationOnlyJsonSchemaKeyword(key)) {
                return [];
            }
            return [childPath];
        }
        return findStrippedJsonSchemaPaths(value, parsed[key], childPath);
    });
}

function isElicitInputSchema(
    schema: ElicitRequestFormParams['requestedSchema'] | StandardSchemaWithJSON
): schema is StandardSchemaWithJSON {
    return typeof schema === 'object' && schema !== null && '~standard' in schema;
}

function convertStandardElicitationSchema(standardSchema: StandardSchemaWithJSON): Record<string, unknown> {
    try {
        return standardSchemaToJsonSchema(standardSchema, 'input');
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Elicitation requestedSchema must describe an object with flat primitive properties: ${detail}`
        );
    }
}

export function normalizeElicitInputFormParams(
    params: ElicitRequestFormParams | ElicitInputFormParams<StandardSchemaWithJSON>
): NormalizedElicitInputFormParams {
    const formParams =
        params.mode === 'form' ? (params as ElicitRequestFormParams) : { ...(params as ElicitRequestFormParams), mode: 'form' as const };

    if (isElicitInputSchema(formParams.requestedSchema)) {
        const standardSchema = formParams.requestedSchema;
        const normalizedParams = {
            ...formParams,
            requestedSchema: pruneElicitationSchemaRoot(convertStandardElicitationSchema(standardSchema))
        };
        const parsedParams = parseSchema(ElicitRequestFormParamsSchema, normalizedParams);
        if (!parsedParams.success) {
            throw new ProtocolError(
                ProtocolErrorCode.InvalidParams,
                `Elicitation requestedSchema only supports flat primitive properties (string, number, integer, boolean, and string enums): ${parsedParams.error.message}`
            );
        }
        const strippedSchemaPaths = findStrippedJsonSchemaPaths(normalizedParams.requestedSchema, parsedParams.data.requestedSchema);
        if (strippedSchemaPaths.length > 0) {
            throw new ProtocolError(
                ProtocolErrorCode.InvalidParams,
                `Elicitation requestedSchema contains unsupported JSON Schema keyword(s) after Standard Schema conversion: ${strippedSchemaPaths.join(', ')}`
            );
        }
        return { params: parsedParams.data, standardSchema };
    }

    return { params: formParams };
}
