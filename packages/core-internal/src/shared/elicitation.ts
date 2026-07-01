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

const ZOD_ISO_DATE_PATTERN = String.raw`(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))`;
const ZOD_ISO_TIME_PREFIX = String.raw`(?:[01]\d|2[0-3]):[0-5]\d`;
const ZOD_ISO_OFFSET_PATTERN = String.raw`([+-](?:[01]\d|2[0-3]):[0-5]\d)`;

const ZOD_REDUNDANT_FORMAT_PATTERNS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ['email', new Set([String.raw`^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$`])],
    [
        'date',
        new Set([
            String.raw`^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))$`
        ])
    ]
]);

const ZOD_DATETIME_ZONE_SUFFIXES = [
    String.raw`(?:Z)`,
    String.raw`(?:Z|)`,
    String.raw`(?:Z|${ZOD_ISO_OFFSET_PATTERN})`,
    String.raw`(?:Z||${ZOD_ISO_OFFSET_PATTERN})`
] as const;

function escapeRegExpLiteral(value: string): string {
    return value.replaceAll(/[.*+?^${}()|[\]\\]/g, match => `\\${match}`);
}

const ZOD_PRECISION_TIME_PATTERN = new RegExp(String.raw`^${escapeRegExpLiteral(String.raw`${ZOD_ISO_TIME_PREFIX}:[0-5]\d\.\d{`)}\d+\}$`);

function isZodIsoDatetimePattern(pattern: string): boolean {
    const prefix = `^${ZOD_ISO_DATE_PATTERN}T(?:`;
    if (!pattern.startsWith(prefix) || !pattern.endsWith(')$')) {
        return false;
    }

    const innerPattern = pattern.slice(prefix.length, -2);
    const zoneSuffix = ZOD_DATETIME_ZONE_SUFFIXES.find(suffix => innerPattern.endsWith(suffix));
    if (!zoneSuffix) {
        return false;
    }

    const timePattern = innerPattern.slice(0, -zoneSuffix.length);
    return (
        timePattern === String.raw`${ZOD_ISO_TIME_PREFIX}` ||
        timePattern === String.raw`${ZOD_ISO_TIME_PREFIX}:[0-5]\d` ||
        timePattern === String.raw`${ZOD_ISO_TIME_PREFIX}(?::[0-5]\d(?:\.\d+)?)?` ||
        ZOD_PRECISION_TIME_PATTERN.test(timePattern)
    );
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

    if (parsed.format === 'date-time') {
        return isZodIsoDatetimePattern(original.pattern);
    }

    return ZOD_REDUNDANT_FORMAT_PATTERNS.get(parsed.format)?.has(original.pattern) === true;
}

const ANNOTATION_ONLY_JSON_SCHEMA_KEYWORDS = new Set(['$comment', 'deprecated', 'examples', 'readOnly', 'writeOnly']);

function isAnnotationOnlyJsonSchemaKeyword(key: string): boolean {
    return ANNOTATION_ONLY_JSON_SCHEMA_KEYWORDS.has(key) || key.startsWith('x-');
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
            requestedSchema: convertStandardElicitationSchema(standardSchema)
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
