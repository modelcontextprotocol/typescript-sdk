import * as z from 'zod';

type CompletableMeta = {
    complete: (value: z.$output, context?: { arguments?: Record<string, string> }) => z.$output[] | Promise<z.$output[]>;
};
export const completableRegistry = z.registry<CompletableMeta>();

export function completable<Schema extends z.ZodType, Output = z.output<Schema>>(
    schema: Schema,
    complete: (value: Output, context?: { arguments?: Record<string, string> }) => Output[] | Promise<Output[]>
) {
    // @ts-ignore - `complete` type is not following
    return schema.register(completableRegistry, { complete });
}
