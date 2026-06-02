/**
 * Safety guards applied before a JSON Schema is compiled into a validator.
 *
 * SEP-2106 widens tool `inputSchema`/`outputSchema` to the full JSON Schema 2020-12 vocabulary.
 * Two abuse vectors come with that flexibility, and this module addresses both before a schema —
 * which may originate from an untrusted peer (e.g. a server's advertised tool definitions) — is
 * handed to a validator:
 *
 * 1. **`$ref` SSRF / fetch-DoS.** JSON Schema 2020-12 allows `$ref` to point at an absolute URI.
 *    A naive validator that dereferences such a reference over the network gives an attacker a
 *    server-side request-forgery primitive. We never dereference non-local references; any
 *    `$ref`/`$dynamicRef` that is not a same-document reference (i.e. does not begin with `#`,
 *    such as `#/$defs/Foo` or `#anchor`) is rejected outright.
 * 2. **Composition resource use.** Composition keywords (`anyOf`/`oneOf`/`allOf`/`if`/`then`/`else`)
 *    and `$defs` enable pathologically expensive schemas. We bound the maximum nesting depth and the
 *    total number of (sub)schema objects so a malicious tool definition cannot act as a CPU-DoS
 *    vector against the validator.
 *
 * Consumers whose legitimate schemas exceed these (generous) defaults can supply their own
 * `jsonSchemaValidator` implementation, which is the documented extension point and is not subject
 * to these guards.
 */

/** Maximum allowed nesting depth of a JSON Schema before it is rejected. */
export const DEFAULT_MAX_SCHEMA_DEPTH = 64;

/** Maximum allowed total number of (sub)schema objects before a JSON Schema is rejected. */
export const DEFAULT_MAX_SUBSCHEMA_COUNT = 10_000;

/** Tunable limits for {@link assertSchemaSafeToCompile}. */
export interface SchemaSafetyLimits {
    /** Maximum nesting depth (default {@link DEFAULT_MAX_SCHEMA_DEPTH}). */
    maxDepth?: number;
    /** Maximum total number of (sub)schema objects (default {@link DEFAULT_MAX_SUBSCHEMA_COUNT}). */
    maxSubschemas?: number;
}

/** A `$ref`/`$dynamicRef` is "local" only when it targets the same document (begins with `#`). */
function isSameDocumentReference(ref: string): boolean {
    return ref.startsWith('#');
}

/**
 * Throws if a JSON Schema is unsafe to compile — either because it carries a non-local
 * `$ref`/`$dynamicRef` (which we refuse to dereference) or because it exceeds the configured
 * composition bounds. Safe schemas return normally.
 *
 * @param schema - the JSON Schema (or subschema) to inspect.
 * @param limits - optional overrides for the depth / subschema-count caps.
 * @throws Error when a non-same-document reference is present, or a bound is exceeded.
 */
export function assertSchemaSafeToCompile(schema: unknown, limits: SchemaSafetyLimits = {}): void {
    const maxDepth = limits.maxDepth ?? DEFAULT_MAX_SCHEMA_DEPTH;
    const maxSubschemas = limits.maxSubschemas ?? DEFAULT_MAX_SUBSCHEMA_COUNT;
    let subschemaCount = 0;

    const walk = (node: unknown, depth: number): void => {
        if (depth > maxDepth) {
            throw new Error(
                `JSON Schema is too deeply nested (exceeds max depth ${maxDepth}); refusing to compile to avoid excessive validation cost.`
            );
        }

        if (Array.isArray(node)) {
            for (const item of node) {
                walk(item, depth + 1);
            }
            return;
        }

        if (node === null || typeof node !== 'object') {
            return;
        }

        subschemaCount += 1;
        if (subschemaCount > maxSubschemas) {
            throw new Error(
                `JSON Schema has too many subschemas (exceeds max ${maxSubschemas}); refusing to compile to avoid excessive validation cost.`
            );
        }

        for (const [key, value] of Object.entries(node)) {
            if ((key === '$ref' || key === '$dynamicRef') && typeof value === 'string' && !isSameDocumentReference(value)) {
                throw new Error(
                    `JSON Schema contains a non-local "${key}" ("${value}"). External reference dereferencing is disabled; ` +
                        `only same-document references (e.g. "#/$defs/Foo" or "#anchor") are supported.`
                );
            }
            walk(value, depth + 1);
        }
    };

    walk(schema, 0);
}
