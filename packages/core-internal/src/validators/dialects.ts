/**
 * Declared-dialect classification shared by the default validator providers.
 */

import type { JsonSchemaType } from './types';

/**
 * Canonical `$schema` URIs per supported dialect (http + https variants, trailing-`#` stripped).
 */
const DRAFT_2020_12_URIS: ReadonlySet<string> = new Set([
    'https://json-schema.org/draft/2020-12/schema',
    'http://json-schema.org/draft/2020-12/schema'
]);
const DRAFT_2019_09_URIS: ReadonlySet<string> = new Set([
    'https://json-schema.org/draft/2019-09/schema',
    'http://json-schema.org/draft/2019-09/schema'
]);
const DRAFT_07_URIS: ReadonlySet<string> = new Set(['https://json-schema.org/draft-07/schema', 'http://json-schema.org/draft-07/schema']);
const DRAFT_06_URIS: ReadonlySet<string> = new Set(['https://json-schema.org/draft-06/schema', 'http://json-schema.org/draft-06/schema']);

/**
 * Dialects the default providers dispatch on. draft-06 maps to `'draft-7'`: draft-07 only adds
 * keywords over draft-06 (`if`/`then`/`else`), and enforcing them on a draft-06 schema is the
 * accepted downlevel.
 */
export type DeclaredDialect = '2020-12' | '2019-09' | 'draft-7';

/**
 * Classify a schema's declared `$schema` dialect. No `$schema` (or a non-string one) means
 * 2020-12. Any other dialect throws a plain `Error` with a clear message rather than letting the
 * engine crash on an opaque internal error or silently mis-validate; `remedy` names the calling
 * provider's escape hatch in that message.
 */
export function declaredDialect(schema: JsonSchemaType, remedy: string): DeclaredDialect {
    if (!('$schema' in schema) || typeof schema.$schema !== 'string') {
        return '2020-12';
    }
    const declared = schema.$schema.replace(/#$/, '');
    if (DRAFT_2020_12_URIS.has(declared)) {
        return '2020-12';
    }
    if (DRAFT_2019_09_URIS.has(declared)) {
        return '2019-09';
    }
    if (DRAFT_07_URIS.has(declared) || DRAFT_06_URIS.has(declared)) {
        return 'draft-7';
    }
    throw new Error(
        `JSON Schema declares an unsupported dialect ("$schema": "${schema.$schema.slice(0, 200)}"). ` +
            `The default validator supports JSON Schema 2020-12, 2019-09, draft-07, and draft-06; ${remedy}`
    );
}
