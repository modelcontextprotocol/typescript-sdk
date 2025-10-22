import * as z from 'zod/v3';
import type { ZodTypeAny } from 'zod';

import { zodToJsonSchema as fallbackZodToJsonSchema } from '../_vendor/zodToJsonSchema.js';
import type { Options as FallbackOptions } from '../_vendor/Options.js';

type NativeToJsonSchema = (schema: ZodTypeAny, options?: { target?: 'draft-7' }) => unknown;
type ZodNamespace = typeof z;

const fallbackOptions: Partial<FallbackOptions> = {
    strictUnions: true,
    target: 'jsonSchema7'
};

const nativeOptions = {
    target: 'draft-7' as const
};

const getZodNamespace = (): ZodNamespace => {
    const override = (globalThis as { __MCP_ZOD__?: ZodNamespace }).__MCP_ZOD__;
    return override ?? z;
};

const resolveNativeConverter = (): NativeToJsonSchema | undefined => {
    const namespace = getZodNamespace() as unknown as {
        toJSONSchema?: NativeToJsonSchema;
        default?: { toJSONSchema?: NativeToJsonSchema };
    };

    if (typeof namespace.toJSONSchema === 'function') {
        return namespace.toJSONSchema;
    }
    if (namespace.default && typeof namespace.default.toJSONSchema === 'function') {
        return namespace.default.toJSONSchema;
    }

    return undefined;
};

export const usesNativeJsonSchema = (): boolean => resolveNativeConverter() !== undefined;

export const generateJsonSchema = (schema: ZodTypeAny) => {
    const nativeConverter = resolveNativeConverter();
    if (nativeConverter) {
        try {
            return nativeConverter(schema, nativeOptions);
        } catch {
            // Ignore native conversion failures caused by version mismatches and fall back to vendored implementation.
        }
    }

    return (fallbackZodToJsonSchema as unknown as (s: ZodTypeAny, o?: Partial<FallbackOptions> | string) => unknown)(
        schema,
        fallbackOptions
    );
};
