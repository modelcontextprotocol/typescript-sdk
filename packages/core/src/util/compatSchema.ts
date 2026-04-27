/**
 * Helpers for the Zod-schema form of `setRequestHandler` / `setNotificationHandler`.
 *
 * v1 accepted a Zod object whose `.shape.method` is `z.literal('<method>')`.
 * v2 also accepts the method string directly. These helpers detect the schema
 * form and extract the literal so the dispatcher can route to the correct path.
 */

/**
 * Minimal structural type for a v1-style Zod request/notification schema: an
 * object schema whose `.shape.method` is a string literal. The `method` literal
 * is checked at runtime; the type-level constraint is intentionally loose
 * because zod v4's `ZodLiteral` doesn't surface `.value` in its declared type
 * (only at runtime).
 */
export interface ZodLikeRequestSchema {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    shape: any;
    parse(input: unknown): unknown;
}

/** True if `arg` looks like a Zod object schema (has `.shape` and `.parse`). */
export function isZodLikeSchema(arg: unknown): arg is ZodLikeRequestSchema {
    return typeof arg === 'object' && arg !== null && 'shape' in arg && typeof (arg as { parse?: unknown }).parse === 'function';
}

/**
 * Extracts the string value from a Zod-like schema's `shape.method` literal.
 * Throws if no string `method` literal is present.
 */
export function extractMethodLiteral(schema: ZodLikeRequestSchema): string {
    const methodField = (schema.shape as Record<string, unknown> | undefined)?.method as
        | { value?: unknown; def?: { values?: unknown[] } }
        | undefined;
    const value = methodField?.value ?? methodField?.def?.values?.[0];
    if (typeof value !== 'string') {
        throw new TypeError('Schema passed to setRequestHandler/setNotificationHandler is missing a string `method` literal');
    }
    return value;
}

/**
 * True if `arg` looks like a result schema passed positionally to
 * `request()` / `callTool()` / `mcpReq.send()`. Detects either the
 * Standard Schema marker (`~standard`) or a Zod-style `parse` function so the
 * v1 schema-argument form is recognised regardless of zod major version.
 */
export function isResultSchemaLike(arg: unknown): arg is object {
    return arg != null && typeof arg === 'object' && ('~standard' in arg || typeof (arg as { parse?: unknown }).parse === 'function');
}
