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

function normalizeSchemaObject(schema: Record<string, unknown>): Record<string, unknown> {
    const tupleItems = Array.isArray(schema.items) ? schema.items : undefined;
    const normalized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(schema)) {
        if ((key === 'items' || key === 'additionalItems') && tupleItems !== undefined) {
            continue;
        }

        if (DATA_VALUE_KEYWORDS.has(key)) {
            normalized[key] = value;
        } else if (SCHEMA_MAP_KEYWORDS.has(key) && isJsonObject(value)) {
            normalized[key] = Object.fromEntries(
                Object.entries(value).map(([childKey, childValue]) => [childKey, normalizeSchema(childValue)])
            );
        } else if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
            normalized[key] = value.map(child => normalizeSchema(child));
        } else if (SCHEMA_VALUE_KEYWORDS.has(key)) {
            normalized[key] = normalizeSchema(value);
        } else {
            normalized[key] = value;
        }
    }

    if (tupleItems !== undefined) {
        if (!('prefixItems' in normalized)) {
            normalized.prefixItems = tupleItems.map(item => normalizeSchema(item));
        }

        if ('additionalItems' in schema && schema.additionalItems !== true) {
            normalized.items = normalizeSchema(schema.additionalItems);
        }
    }

    return normalized;
}

function normalizeSchema(schema: unknown): unknown {
    if (schema === true || schema === false) {
        return schema;
    }

    if (Array.isArray(schema)) {
        return schema.map(item => normalizeSchema(item));
    }

    if (!isJsonObject(schema)) {
        return schema;
    }

    return normalizeSchemaObject(schema);
}

/**
 * JSON Schema 2020-12 replaced draft-07 tuple syntax (`items: [...]` plus
 * `additionalItems`) with `prefixItems` plus `items`. Normalize the legacy
 * tuple form before handing schemas to 2020-12 validators so older advertised
 * tool schemas remain callable.
 */
export function normalizeLegacyTupleSchema(schema: JsonSchemaType): JsonSchemaType {
    return normalizeSchema(schema) as JsonSchemaType;
}
