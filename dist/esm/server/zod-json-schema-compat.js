// zod-json-schema-compat.ts
// ----------------------------------------------------
// JSON Schema conversion for both Zod v3 and Zod v4 (Mini)
// v3 uses your vendored converter; v4 uses Mini's toJSONSchema
// ----------------------------------------------------
import * as z4mini from 'zod/v4-mini';
import { getObjectShape, safeParse, isZ4Schema, getLiteralValue } from './zod-compat.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
function mapMiniTarget(t) {
    if (!t)
        return 'draft-7';
    if (t === 'jsonSchema7' || t === 'draft-7')
        return 'draft-7';
    if (t === 'jsonSchema2019-09' || t === 'draft-2020-12')
        return 'draft-2020-12';
    return 'draft-7'; // fallback
}
export function toJsonSchemaCompat(schema, opts) {
    var _a, _b, _c;
    if (isZ4Schema(schema)) {
        // v4 branch — use Mini's built-in toJSONSchema
        return z4mini.toJSONSchema(schema, {
            target: mapMiniTarget(opts === null || opts === void 0 ? void 0 : opts.target),
            io: (_a = opts === null || opts === void 0 ? void 0 : opts.pipeStrategy) !== null && _a !== void 0 ? _a : 'input'
        });
    }
    // v3 branch — use vendored converter
    return zodToJsonSchema(schema, {
        strictUnions: (_b = opts === null || opts === void 0 ? void 0 : opts.strictUnions) !== null && _b !== void 0 ? _b : true,
        pipeStrategy: (_c = opts === null || opts === void 0 ? void 0 : opts.pipeStrategy) !== null && _c !== void 0 ? _c : 'input'
    });
}
export function getMethodLiteral(schema) {
    const shape = getObjectShape(schema);
    const methodSchema = shape === null || shape === void 0 ? void 0 : shape.method;
    if (!methodSchema) {
        throw new Error('Schema is missing a method literal');
    }
    const value = getLiteralValue(methodSchema);
    if (typeof value !== 'string') {
        throw new Error('Schema method literal must be a string');
    }
    return value;
}
export function parseWithCompat(schema, data) {
    const result = safeParse(schema, data);
    if (!result.success) {
        throw result.error;
    }
    return result.data;
}
//# sourceMappingURL=zod-json-schema-compat.js.map