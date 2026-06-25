import type { ElicitInputFormParams, ElicitRequestFormParams, StandardSchemaWithJSON } from '@modelcontextprotocol/core-internal';
import {
    ElicitRequestFormParamsSchema,
    parseSchema,
    ProtocolError,
    ProtocolErrorCode,
    standardSchemaToJsonSchema
} from '@modelcontextprotocol/core-internal';

export type NormalizedElicitInputFormParams = {
    params: ElicitRequestFormParams;
    standardSchema?: StandardSchemaWithJSON;
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ZOD_REDUNDANT_FORMAT_PATTERNS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ['email', new Set([String.raw`^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$`])],
    [
        'date',
        new Set([
            String.raw`^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))$`
        ])
    ],
    [
        'date-time',
        new Set([
            String.raw`^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z))$`
        ])
    ]
]);

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

    return ZOD_REDUNDANT_FORMAT_PATTERNS.get(parsed.format)?.has(original.pattern) === true;
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
            if (isRedundantFormatPattern(original, parsed, key)) {
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

export function normalizeElicitInputFormParams(
    params: ElicitRequestFormParams | ElicitInputFormParams<StandardSchemaWithJSON>
): NormalizedElicitInputFormParams {
    const formParams =
        params.mode === 'form' ? (params as ElicitRequestFormParams) : { ...(params as ElicitRequestFormParams), mode: 'form' as const };

    if (isElicitInputSchema(formParams.requestedSchema)) {
        const standardSchema = formParams.requestedSchema;
        const normalizedParams = {
            ...formParams,
            requestedSchema: standardSchemaToJsonSchema(standardSchema, 'input')
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
