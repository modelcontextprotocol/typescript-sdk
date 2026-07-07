import { ProtocolErrorCode } from '../types/enums';
import { ProtocolError } from '../types/errors';
import { ElicitRequestFormParamsSchema } from '../types/schemas';
import type { ElicitRequestFormParams } from '../types/types';
import { parseSchema } from '../util/schema';
import type { StandardSchemaWithJSON } from '../util/standardSchema';
import { isStandardSchemaWithJSON, standardSchemaToJsonSchema } from '../util/standardSchema';

/** Input accepted by `inputRequired.elicit()`. */
export type ElicitInputParams = Omit<ElicitRequestFormParams, 'mode' | 'requestedSchema'> & {
    mode?: 'form';
    requestedSchema: ElicitRequestFormParams['requestedSchema'] | StandardSchemaWithJSON;
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function convertStandardElicitationSchema(schema: StandardSchemaWithJSON): Record<string, unknown> {
    try {
        return standardSchemaToJsonSchema(schema, 'input');
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Elicitation requestedSchema must describe an object with flat primitive properties: ${detail}`
        );
    }
}

const ANNOTATION_ONLY_JSON_SCHEMA_KEYWORDS = new Set(['$comment', 'deprecated', 'examples', 'readOnly', 'writeOnly']);

function isAnnotationOnlyJsonSchemaKeyword(key: string): boolean {
    return ANNOTATION_ONLY_JSON_SCHEMA_KEYWORDS.has(key) || key.startsWith('x-');
}

/**
 * Finds converted keywords that MCP's restricted elicitation schema removed.
 * Annotation-only metadata may be dropped; validation constraints may not be
 * weakened silently.
 */
function findStrippedConstraintPaths(original: unknown, parsed: unknown, path = ''): string[] {
    if (Array.isArray(original) && Array.isArray(parsed)) {
        return original.flatMap((item, index) => findStrippedConstraintPaths(item, parsed[index], `${path}[${index}]`));
    }

    if (!isJsonObject(original) || !isJsonObject(parsed)) {
        return [];
    }

    return Object.entries(original).flatMap(([key, value]) => {
        const childPath = path ? `${path}.${key}` : key;
        if (!Object.prototype.hasOwnProperty.call(parsed, key)) {
            return isAnnotationOnlyJsonSchemaKeyword(key) ? [] : [childPath];
        }
        return findStrippedConstraintPaths(value, parsed[key], childPath);
    });
}

/** Converts an authoring-friendly elicitation input into its wire-ready form. */
export function normalizeElicitInputParams(input: ElicitInputParams): ElicitRequestFormParams {
    if (!isStandardSchemaWithJSON(input.requestedSchema)) {
        return { ...input, mode: 'form', requestedSchema: input.requestedSchema };
    }

    const convertedSchema = convertStandardElicitationSchema(input.requestedSchema);
    const normalized = { ...input, mode: 'form' as const, requestedSchema: convertedSchema };
    const parsed = parseSchema(ElicitRequestFormParamsSchema, normalized);
    if (!parsed.success) {
        throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Elicitation requestedSchema only supports flat primitive properties (string, number, integer, boolean, and string enums): ${parsed.error.message}`
        );
    }

    const strippedConstraints = findStrippedConstraintPaths(convertedSchema, parsed.data.requestedSchema);
    if (strippedConstraints.length > 0) {
        throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Elicitation requestedSchema contains unsupported JSON Schema constraint(s) after Standard Schema conversion: ${strippedConstraints.join(', ')}`
        );
    }

    return parsed.data;
}
