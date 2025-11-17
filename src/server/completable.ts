import { ZodTypeAny } from 'zod';

export enum McpZodTypeKind {
    Completable = 'McpCompletable'
}

export type CompleteCallback<T extends ZodTypeAny = ZodTypeAny> = (
    value: T extends { _zod: { input: infer I } } ? I : unknown,
    context?: {
        arguments?: Record<string, string>;
    }
) => Array<T extends { _zod: { input: infer I } } ? I : unknown> | Promise<Array<T extends { _zod: { input: infer I } } ? I : unknown>>;

export interface CompletableDef<T extends ZodTypeAny = ZodTypeAny> {
    type: T;
    complete: CompleteCallback<T>;
    typeName: McpZodTypeKind.Completable;
}

export class Completable<T extends ZodTypeAny> {
    readonly _zod: T['_zod'] & { def: CompletableDef<T> };

    /** @deprecated Use `.def` instead */
    get _def(): CompletableDef<T> {
        return this._zod.def;
    }

    get def(): CompletableDef<T> {
        return this._zod.def;
    }

    constructor(def: CompletableDef<T>) {
        // Delegate most operations to the wrapped type while preserving completion callback
        const wrapped = def.type;
        this._zod = {
            ...wrapped._zod,
            def,
            input: wrapped._zod?.input,
            output: wrapped._zod?.output
        } as T['_zod'] & { def: CompletableDef<T> };
    }

    unwrap(): T {
        return this._zod.def.type;
    }

    parse(data: unknown, params?: Parameters<T['parse']>[1]): ReturnType<T['parse']> {
        return this._zod.def.type.parse(data, params) as ReturnType<T['parse']>;
    }

    safeParse(data: unknown, params?: Parameters<T['safeParse']>[1]): ReturnType<T['safeParse']> {
        return this._zod.def.type.safeParse(data, params) as ReturnType<T['safeParse']>;
    }

    parseAsync(data: unknown, params?: Parameters<T['parseAsync']>[1]): ReturnType<T['parseAsync']> {
        return this._zod.def.type.parseAsync(data, params) as ReturnType<T['parseAsync']>;
    }

    safeParseAsync(data: unknown, params?: Parameters<T['safeParseAsync']>[1]): ReturnType<T['safeParseAsync']> {
        return this._zod.def.type.safeParseAsync(data, params) as ReturnType<T['safeParseAsync']>;
    }

    get description(): string | undefined {
        return this._zod.def.type.description;
    }

    static create = <T extends ZodTypeAny>(
        type: T,
        params: {
            complete: CompleteCallback<T>;
        }
    ): Completable<T> => {
        return new Completable({
            type,
            typeName: McpZodTypeKind.Completable,
            complete: params.complete
        });
    };
}

/**
 * Wraps a Zod type to provide autocompletion capabilities. Useful for, e.g., prompt arguments in MCP.
 */
export function completable<T extends ZodTypeAny>(schema: T, complete: CompleteCallback<T>): Completable<T> {
    return Completable.create(schema, { complete });
}
