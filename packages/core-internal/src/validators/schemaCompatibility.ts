import type { JsonSchemaType } from './types';

const DATA_VALUE_KEYWORDS = new Set(['const', 'default', 'enum', 'examples']);
const SCHEMA_MAP_KEYWORDS = new Set(['$defs', 'definitions', 'dependencies', 'dependentSchemas', 'patternProperties', 'properties']);
const SCHEMA_ARRAY_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const SCHEMA_VALUE_KEYWORDS = new Set([
    'additionalProperties',
    'contains',
    'else',
    'if',
    'items',
    'not',
    'propertyNames',
    'then',
    'unevaluatedItems',
    'unevaluatedProperties'
]);

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function escapeJsonPointerSegment(segment: string): string {
    return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function childPointer(path: string, segment: string | number): string {
    return `${path}/${escapeJsonPointerSegment(String(segment))}`;
}

function rewriteLocalJsonPointerRef(ref: string, refRewrites: Map<string, string>): string {
    if (!ref.startsWith('#/')) {
        return ref;
    }

    const pointer = ref.slice(1);
    for (const [from, to] of refRewrites) {
        if (pointer === from) {
            return `#${to}`;
        }
        if (pointer.startsWith(`${from}/`)) {
            return `#${to}${pointer.slice(from.length)}`;
        }
    }

    return ref;
}

function collectTupleRefRewrites(schema: unknown, path: string, refRewrites: Map<string, string>): void {
    if (schema === true || schema === false || !isJsonObject(schema)) {
        return;
    }

    if (Array.isArray(schema.items)) {
        refRewrites.set(childPointer(path, 'items'), childPointer(path, 'prefixItems'));
    }

    for (const [key, value] of Object.entries(schema)) {
        if (Array.isArray(value)) {
            for (const [index, child] of value.entries()) {
                collectTupleRefRewrites(child, childPointer(childPointer(path, key), index), refRewrites);
            }
        } else {
            collectTupleRefRewrites(value, childPointer(path, key), refRewrites);
        }
    }
}

function normalizeSchemaObject(schema: Record<string, unknown>, path: string, refRewrites: Map<string, string>): Record<string, unknown> {
    const tupleItems = Array.isArray(schema.items) ? schema.items : undefined;
    const normalized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(schema)) {
        if ((key === 'items' || key === 'additionalItems') && tupleItems !== undefined) {
            continue;
        }

        if ((key === '$ref' || key === '$dynamicRef') && typeof value === 'string') {
            normalized[key] = rewriteLocalJsonPointerRef(value, refRewrites);
        } else if (DATA_VALUE_KEYWORDS.has(key)) {
            normalized[key] = value;
        } else if (SCHEMA_MAP_KEYWORDS.has(key) && isJsonObject(value)) {
            normalized[key] = Object.fromEntries(
                Object.entries(value).map(([childKey, childValue]) => [
                    childKey,
                    normalizeSchema(childValue, childPointer(childPointer(path, key), childKey), refRewrites)
                ])
            );
        } else if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
            normalized[key] = value.map((child, index) =>
                normalizeSchema(child, childPointer(childPointer(path, key), index), refRewrites)
            );
        } else if (SCHEMA_VALUE_KEYWORDS.has(key)) {
            normalized[key] = normalizeSchema(value, childPointer(path, key), refRewrites);
        } else {
            normalized[key] = value;
        }
    }

    if (tupleItems !== undefined) {
        if (!('prefixItems' in normalized)) {
            normalized.prefixItems = tupleItems.map((item, index) =>
                normalizeSchema(item, childPointer(childPointer(path, 'prefixItems'), index), refRewrites)
            );
        }

        if ('additionalItems' in schema && schema.additionalItems !== true) {
            normalized.items = normalizeSchema(schema.additionalItems, childPointer(path, 'items'), refRewrites);
        }
    }

    return normalized;
}

function normalizeSchema(schema: unknown, path: string, refRewrites: Map<string, string>): unknown {
    if (schema === true || schema === false) {
        return schema;
    }

    if (Array.isArray(schema)) {
        return schema.map((item, index) => normalizeSchema(item, childPointer(path, index), refRewrites));
    }

    if (!isJsonObject(schema)) {
        return schema;
    }

    return normalizeSchemaObject(schema, path, refRewrites);
}

/**
 * JSON Schema 2020-12 replaced draft-07 tuple syntax (`items: [...]` plus
 * `additionalItems`) with `prefixItems` plus `items`. Normalize the legacy
 * tuple form before handing schemas to 2020-12 validators so older advertised
 * tool schemas remain callable.
 */
export function normalizeLegacyTupleSchema(schema: JsonSchemaType): JsonSchemaType {
    const refRewrites = new Map<string, string>();
    collectTupleRefRewrites(schema, '', refRewrites);
    return normalizeSchema(schema, '', refRewrites) as JsonSchemaType;
}
