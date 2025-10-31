import { ZodTypeAny, ZodTypeDef, ZodType, ParseInput, ParseReturnType, RawCreateParams, ZodErrorMap, ProcessedCreateParams } from 'zod';

export enum McpZodTypeKind {
    Completable = 'McpCompletable'
}

export type CompleteCallback<T extends ZodTypeAny = ZodTypeAny> = (
    value: T['_input'],
    context?: {
        arguments?: Record<string, string>;
    }
) => T['_input'][] | Promise<T['_input'][]>;

export interface CompletableDef<T extends ZodTypeAny = ZodTypeAny> extends ZodTypeDef {
    type: T;
    complete: CompleteCallback<T>;
    typeName: McpZodTypeKind.Completable;
}

export class Completable<T extends ZodTypeAny> extends ZodType<T['_output'], CompletableDef<T>, T['_input']> {
    _parse(input: ParseInput): ParseReturnType<this['_output']> {
        const { ctx } = this._processInputParams(input);
        const data = ctx.data;
        return this._def.type._parse({
            data,
            path: ctx.path,
            parent: ctx
        });
    }

    unwrap() {
        return this._def.type;
    }

    static create = <T extends ZodTypeAny>(
        type: T,
        params: RawCreateParams & {
            complete: CompleteCallback<T>;
        }
    ): Completable<T> => {
        return new Completable({
            type,
            typeName: McpZodTypeKind.Completable,
            complete: params.complete,
            ...processCreateParams(params)
        });
    };
}

/**
 * Wraps a Zod type to provide autocompletion capabilities. Useful for, e.g., prompt arguments in MCP.
 */
export function completable<T extends ZodTypeAny>(schema: T, complete: CompleteCallback<T>): Completable<T> {
    return Completable.create(schema, { ...schema._def, complete });
}

// Not sure why this isn't exported from Zod:
// https://github.com/colinhacks/zod/blob/f7ad26147ba291cb3fb257545972a8e00e767470/src/types.ts#L130
function processCreateParams(params: RawCreateParams): ProcessedCreateParams {
    if (!params) return {};
    const { errorMap, invalid_type_error, required_error, description } = params;
    if (errorMap && (invalid_type_error || required_error)) {
        throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
    }
    if (errorMap) return { errorMap: errorMap, description };
    const customMap: ZodErrorMap = (iss, ctx) => {
        const { message } = params;

        if (iss.code === 'invalid_enum_value') {
            return { message: message ?? ctx.defaultError };
        }
        if (typeof ctx.data === 'undefined') {
            return { message: message ?? required_error ?? ctx.defaultError };
        }
        if (iss.code !== 'invalid_type') return { message: ctx.defaultError };
        return { message: message ?? invalid_type_error ?? ctx.defaultError };
    };
    return { errorMap: customMap, description };
}
