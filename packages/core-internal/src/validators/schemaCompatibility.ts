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

function unescapeJsonPointerSegment(segment: string): string {
    return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

function arrayIndex(segment: string): number | undefined {
    if (!/^(0|[1-9]\d*)$/.test(segment)) {
        return undefined;
    }

    const index = Number(segment);
    return Number.isSafeInteger(index) ? index : undefined;
}

function childAtJsonPointerSegment(node: unknown, segment: string): unknown {
    if (Array.isArray(node)) {
        const index = arrayIndex(segment);
        return index === undefined ? undefined : node[index];
    }

    return isJsonObject(node) ? node[segment] : undefined;
}

function rewriteLocalJsonPointerRef(ref: string, rootSchema: unknown): string {
    if (!ref.startsWith('#/')) {
        return ref;
    }

    const segments = ref
        .slice(2)
        .split('/')
        .map(segment => unescapeJsonPointerSegment(segment));
    const rewritten: string[] = [];
    let node: unknown = rootSchema;

    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        if (segment === undefined) {
            continue;
        }

        if (isJsonObject(node) && Array.isArray(node.items)) {
            const tupleItems = node.items;
            if (segment === 'items') {
                rewritten.push('prefixItems');
                node = tupleItems;

                const nextSegment = segments[i + 1];
                const nextIndex = nextSegment === undefined ? undefined : arrayIndex(nextSegment);
                if (nextSegment !== undefined && nextIndex !== undefined) {
                    rewritten.push(nextSegment);
                    node = tupleItems[nextIndex];
                    i++;
                }
                continue;
            }

            if (segment === 'additionalItems') {
                rewritten.push('items');
                node = node.additionalItems;
                continue;
            }
        }

        rewritten.push(segment);
        node = childAtJsonPointerSegment(node, segment);
    }

    return `#/${rewritten.map(segment => escapeJsonPointerSegment(segment)).join('/')}`;
}

function normalizeSchemaObject(schema: Record<string, unknown>, rootSchema: unknown): Record<string, unknown> {
    const tupleItems = Array.isArray(schema.items) ? schema.items : undefined;
    const normalized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(schema)) {
        if ((key === 'items' || key === 'additionalItems') && tupleItems !== undefined) {
            continue;
        }

        if ((key === '$ref' || key === '$dynamicRef') && typeof value === 'string') {
            normalized[key] = rewriteLocalJsonPointerRef(value, rootSchema);
        } else if (DATA_VALUE_KEYWORDS.has(key)) {
            normalized[key] = value;
        } else if (SCHEMA_MAP_KEYWORDS.has(key) && isJsonObject(value)) {
            normalized[key] = Object.fromEntries(
                Object.entries(value).map(([childKey, childValue]) => [childKey, normalizeSchema(childValue, rootSchema)])
            );
        } else if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
            normalized[key] = value.map(child => normalizeSchema(child, rootSchema));
        } else if (SCHEMA_VALUE_KEYWORDS.has(key)) {
            normalized[key] = normalizeSchema(value, rootSchema);
        } else {
            normalized[key] = value;
        }
    }

    if (tupleItems !== undefined) {
        if (!('prefixItems' in normalized)) {
            normalized.prefixItems = tupleItems.map(item => normalizeSchema(item, rootSchema));
        }

        if ('additionalItems' in schema && schema.additionalItems !== true) {
            normalized.items = normalizeSchema(schema.additionalItems, rootSchema);
        }
    }

    return normalized;
}

function normalizeSchema(schema: unknown, rootSchema: unknown): unknown {
    if (schema === true || schema === false) {
        return schema;
    }

    if (Array.isArray(schema)) {
        return schema.map(item => normalizeSchema(item, rootSchema));
    }

    if (!isJsonObject(schema)) {
        return schema;
    }

    return normalizeSchemaObject(schema, rootSchema);
}

/**
 * JSON Schema 2020-12 replaced draft-07 tuple syntax (`items: [...]` plus
 * `additionalItems`) with `prefixItems` plus `items`. Normalize the legacy
 * tuple form before handing schemas to 2020-12 validators so older advertised
 * tool schemas remain callable.
 */
export function normalizeLegacyTupleSchema(schema: JsonSchemaType): JsonSchemaType {
    return normalizeSchema(schema, schema) as JsonSchemaType;
}
