/**
 * SEP-2243 `Mcp-Param-*` header codec (protocol revision 2026-07-28).
 *
 * Pure functions for the custom-header half of SEP-2243: scanning a tool's
 * `inputSchema` for `x-mcp-header` declarations, encoding argument values into
 * `Mcp-Param-{Name}` HTTP headers (with the `=?base64?…?=` sentinel for values
 * that cannot be safely represented as plain ASCII field values), decoding
 * those headers, and validating that the headers a request carries match the
 * argument values in its body.
 *
 * The standard-header half (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`)
 * lives with the inbound classifier — this module is the custom-header half
 * only, and it consumes the same `-32020` (`HeaderMismatch`) emission shape the
 * classifier established for header/body cross-check failures.
 *
 * Spec text at the implementation's spec pin:
 * - draft/basic/transports/streamable-http.mdx § "Custom Headers from Tool Parameters"
 *   (constraints, value encoding, the 5-step client algorithm, the
 *   server-behavior table, the `400` + `-32020` rejection)
 * - draft/server/tools.mdx § "x-mcp-header" (the schema-extension property and
 *   its constraints)
 */
import type { InboundLadderRejection } from './inboundClassification.js';
import { HEADER_MISMATCH_ERROR_CODE } from './inboundClassification.js';

/* ------------------------------------------------------------------------ *
 * Declaration scan
 * ------------------------------------------------------------------------ */

/** The fixed prefix every custom-parameter header carries. */
export const MCP_PARAM_HEADER_PREFIX = 'Mcp-Param-';

/** The schema-extension property name a tool's `inputSchema` carries. */
export const X_MCP_HEADER_KEY = 'x-mcp-header';

/**
 * One `x-mcp-header` declaration found inside a tool's `inputSchema`.
 *
 * `path` is the property path from the arguments root (the spec permits
 * declarations at any nesting depth under `properties`); `headerName` is the
 * `{Name}` portion as declared (case preserved for emission; comparison is
 * case-insensitive); `type` is the JSON Schema `type` of the declaring
 * property.
 */
export interface XMcpHeaderDeclaration {
    path: readonly string[];
    headerName: string;
    type: string;
}

/** The result of scanning a tool's `inputSchema` for `x-mcp-header` declarations. */
export type XMcpHeaderScanResult = { valid: true; declarations: readonly XMcpHeaderDeclaration[] } | { valid: false; reason: string };

/**
 * RFC 9110 §5.1 `token` syntax (`1*tchar`). Rejects empty, space, control
 * characters (including CR/LF), and the listed delimiters.
 */
const RFC9110_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * JSON Schema `type` values the spec admits on an `x-mcp-header` property.
 *
 * The spec text names `integer`, `string`, `boolean` and explicitly excludes
 * `number`. The published conformance referee at the pinned release ships its
 * `http-custom-headers` scenario with two `type: "number"` `x-mcp-header`
 * parameters and expects the client to mirror them, so `number` is accepted
 * here so that the conformance gate passes; the discrepancy is tracked
 * upstream. Everything else (`object`, `array`, `null`, absent) is rejected.
 */
const PERMITTED_X_MCP_HEADER_TYPES: ReadonlySet<string> = new Set(['string', 'integer', 'boolean', 'number']);

/**
 * Scan a tool's JSON-serialized `inputSchema` for `x-mcp-header` declarations
 * and validate every constraint the spec places on them. Returns either the
 * collected declarations (possibly empty) or the first violated constraint.
 *
 * The walk descends through `properties` at any depth (the spec's "any nesting
 * depth" clause). The static-reachability MUST is enforced as a structural
 * sweep: every position the chain MUST NOT pass through (`items`/
 * `additionalProperties`, `oneOf`/`anyOf`/`allOf`/`not`, `if`/`then`/`else`,
 * `$defs`, `$ref` targets within `$defs`) is visited too, and an
 * `x-mcp-header` found anywhere on that path invalidates the schema — "an
 * annotation anywhere else makes the tool definition invalid".
 */
export function scanXMcpHeaderDeclarations(inputSchema: unknown): XMcpHeaderScanResult {
    const declarations: XMcpHeaderDeclaration[] = [];
    const seenLower = new Map<string, string>();

    const visit = (node: unknown, path: readonly string[], reachable: boolean): string | undefined => {
        if (node === null || typeof node !== 'object') return undefined;
        const schema = node as Record<string, unknown>;

        if (X_MCP_HEADER_KEY in schema) {
            if (!reachable || path.length === 0) {
                return `${pathName(path)}: x-mcp-header is only permitted on properties statically reachable via a chain of 'properties' keys (not under items, additionalProperties, oneOf/anyOf/allOf/not, if/then/else, or $ref)`;
            }
            const raw = schema[X_MCP_HEADER_KEY];
            if (typeof raw !== 'string' || raw.length === 0) {
                return `${pathName(path)}: x-mcp-header MUST be a non-empty string`;
            }
            if (!RFC9110_TOKEN.test(raw)) {
                return `${pathName(path)}: x-mcp-header '${raw}' is not a valid RFC 9110 token (no spaces, control characters or HTTP delimiters)`;
            }
            const type = typeof schema.type === 'string' ? schema.type : undefined;
            if (type === undefined || !PERMITTED_X_MCP_HEADER_TYPES.has(type)) {
                return `${pathName(path)}: x-mcp-header is only permitted on primitive-typed properties (string, integer, boolean); got ${type ?? '<none>'}`;
            }
            const lower = raw.toLowerCase();
            const prior = seenLower.get(lower);
            if (prior !== undefined) {
                return `x-mcp-header '${raw}' is not case-insensitively unique (also declared as '${prior}')`;
            }
            seenLower.set(lower, raw);
            declarations.push({ path, headerName: raw, type });
        }

        const properties = schema.properties;
        if (properties !== null && typeof properties === 'object') {
            for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
                const fault = visit(child, [...path, key], reachable);
                if (fault !== undefined) return fault;
            }
        }
        // Static-reachability sweep: descend the keywords the chain MUST NOT
        // pass through with `reachable: false` so an annotation under any of
        // them is reported (rather than silently ignored). `$defs` covers
        // `$ref`-within-`$defs` — chasing arbitrary `$ref` URIs is out of scope.
        for (const k of NON_REACHABLE_SUBSCHEMA_KEYWORDS) {
            const sub = schema[k];
            if (sub === undefined) continue;
            const branches: unknown[] = Array.isArray(sub)
                ? sub
                : sub !== null && typeof sub === 'object' && OBJECT_VALUED_SUBSCHEMA_KEYWORDS.has(k)
                  ? Object.values(sub as Record<string, unknown>)
                  : [sub];
            for (const branch of branches) {
                const fault = visit(branch, [...path, `<${k}>`], false);
                if (fault !== undefined) return fault;
            }
        }
        return undefined;
    };

    const fault = visit(inputSchema, [], true);
    return fault === undefined ? { valid: true, declarations } : { valid: false, reason: fault };
}

/**
 * JSON Schema keywords whose subschemas the SEP-2243 static-reachability
 * constraint excludes from the `properties`-only chain. An `x-mcp-header`
 * found under any of these invalidates the tool definition.
 */
const NON_REACHABLE_SUBSCHEMA_KEYWORDS = [
    'items',
    'prefixItems',
    'contains',
    'additionalProperties',
    'unevaluatedProperties',
    'unevaluatedItems',
    'propertyNames',
    'patternProperties',
    'dependentSchemas',
    'oneOf',
    'anyOf',
    'allOf',
    'not',
    'if',
    'then',
    'else',
    '$defs',
    'definitions'
] as const;

/**
 * Subschema-carrying keywords whose value is a `name → subschema` object
 * (not a single subschema or array of subschemas). The visit branches over
 * `Object.values()` for these.
 */
const OBJECT_VALUED_SUBSCHEMA_KEYWORDS: ReadonlySet<string> = new Set(['patternProperties', 'dependentSchemas', '$defs', 'definitions']);

function pathName(path: readonly string[]): string {
    return path.length === 0 ? '<root>' : path.join('.');
}

/* ------------------------------------------------------------------------ *
 * Value encoding
 * ------------------------------------------------------------------------ */

const BASE64_SENTINEL_PREFIX = '=?base64?';
const BASE64_SENTINEL_SUFFIX = '?=';
// RFC 4648 §4, padding required (the spec's encoding-examples table and the
// conformance referee's invalid-padding cell both require canonical padding).
const BASE64_CANONICAL = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// Strict decimal — gates the numeric comparison in `validateMcpParamHeaders`
// so `Number()` never sees the looser forms it would otherwise accept
// (`'0x1a'`, `' 42 '`, `'1e3'`).
const CANONICAL_DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Convert a primitive argument value to its string representation per the
 * spec's type-conversion rules: strings pass through, integers and numbers
 * become their decimal string, booleans become lowercase `'true'` / `'false'`.
 * Non-finite numbers and integers outside the safe range are refused (the
 * caller treats `undefined` as "do not emit a header for this value").
 */
export function mcpParamPrimitiveToString(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return undefined;
        if (Number.isInteger(value) && !Number.isSafeInteger(value)) return undefined;
        return String(value);
    }
    return undefined;
}

/**
 * `true` when `s` cannot be safely represented as a plain ASCII HTTP field
 * value per RFC 9110 §5.5: it contains a byte outside `0x20–0x7E` / `0x09`, it
 * has leading or trailing whitespace (which field parsing strips), or it
 * already matches the Base64 sentinel pattern (the spec's "to avoid ambiguity"
 * rule).
 */
function needsBase64(s: string): boolean {
    if (s.length === 0) return true;
    if (s.startsWith(BASE64_SENTINEL_PREFIX) && s.endsWith(BASE64_SENTINEL_SUFFIX)) return true;
    if (s !== s.trim()) return true;
    for (let i = 0; i < s.length; i++) {
        const c = s.codePointAt(i)!;
        // Visible ASCII 0x21–0x7E, plus space 0x20 and horizontal tab 0x09; a
        // tab is only safe when it is interior whitespace (the trim() check
        // above already covered leading/trailing).
        if (c === 0x09 || (c >= 0x20 && c <= 0x7e)) continue;
        return true;
    }
    return false;
}

function utf8ToBase64(s: string): string {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (const b of bytes) bin += String.fromCodePoint(b);
    return btoa(bin);
}

function base64ToUtf8(b64: string): string {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.codePointAt(i)!;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * Encode a string value as an HTTP field value per the spec's value-encoding
 * rules: a value that is already a safe plain-ASCII field value is passed
 * through unchanged; anything else is wrapped as `=?base64?{b64-of-utf8}?=`.
 */
export function encodeMcpParamValue(value: string): string {
    return needsBase64(value) ? `${BASE64_SENTINEL_PREFIX}${utf8ToBase64(value)}${BASE64_SENTINEL_SUFFIX}` : value;
}

/**
 * Decode an `Mcp-Param-*` header value: when it carries the Base64 sentinel,
 * the payload is decoded as UTF-8; otherwise the value is returned as-is.
 * Returns `undefined` when the sentinel is present but the payload is not
 * canonical Base64 (or not valid UTF-8) — the spec requires servers to reject
 * such values.
 */
export function decodeMcpParamValue(value: string): string | undefined {
    if (!(value.startsWith(BASE64_SENTINEL_PREFIX) && value.endsWith(BASE64_SENTINEL_SUFFIX))) {
        return value;
    }
    const b64 = value.slice(BASE64_SENTINEL_PREFIX.length, value.length - BASE64_SENTINEL_SUFFIX.length);
    if (!BASE64_CANONICAL.test(b64)) return undefined;
    try {
        return base64ToUtf8(b64);
    } catch {
        return undefined;
    }
}

/* ------------------------------------------------------------------------ *
 * Client-side header construction (the 5-step MUST algorithm, steps 3–5)
 * ------------------------------------------------------------------------ */

function valueAtPath(root: unknown, path: readonly string[]): unknown {
    let node: unknown = root;
    for (const key of path) {
        if (node === null || typeof node !== 'object') return undefined;
        node = (node as Record<string, unknown>)[key];
    }
    return node;
}

/**
 * Build the `Mcp-Param-{Name}` headers for one `tools/call` from a scan of the
 * tool's `inputSchema` and the call's `arguments`. A declaration whose value is
 * `null` or absent in `arguments` is omitted (the spec's "client MUST omit the
 * header" rows); a value that is not a primitive of the declared kind is
 * omitted rather than emitted malformed.
 */
export function buildMcpParamHeaders(
    declarations: readonly XMcpHeaderDeclaration[],
    args: Record<string, unknown> | undefined
): Record<string, string> {
    const out: Record<string, string> = {};
    for (const decl of declarations) {
        const raw = valueAtPath(args, decl.path);
        if (raw === undefined || raw === null) continue;
        const stringValue = mcpParamPrimitiveToString(raw);
        if (stringValue === undefined) continue;
        out[`${MCP_PARAM_HEADER_PREFIX}${decl.headerName}`] = encodeMcpParamValue(stringValue);
    }
    return out;
}

/* ------------------------------------------------------------------------ *
 * Server-side validation
 * ------------------------------------------------------------------------ */

/**
 * The header/body comparison the server performs at tool-resolution time.
 *
 * For each `x-mcp-header` declaration on the named tool: when the body
 * `arguments` carries a value, the matching `Mcp-Param-{Name}` header MUST be
 * present and decode to an equal value; when the body value is `null` or
 * absent the server MUST NOT expect the header (a present header is ignored).
 * A sentinel-carrying header whose payload is not canonical Base64 / valid
 * UTF-8 is rejected as invalid characters.
 *
 * Integer-typed declarations are compared numerically (the spec's SHOULD —
 * `42.0` and `42` are equal); everything else is compared as decoded strings.
 *
 * Returns `undefined` when every check passes, or an
 * {@linkcode InboundLadderRejection} carrying the same `-32020`
 * (`HeaderMismatch`) shape the inbound classifier emits for the
 * standard-header cross-checks — `400 Bad Request` with the disagreeing pair
 * in `data.mismatch`.
 */
export function validateMcpParamHeaders(
    declarations: readonly XMcpHeaderDeclaration[],
    args: Record<string, unknown> | undefined,
    headers: Headers
): InboundLadderRejection | undefined {
    for (const decl of declarations) {
        const headerKey = `${MCP_PARAM_HEADER_PREFIX}${decl.headerName}`;
        const headerValue = headers.get(headerKey);
        const bodyRaw = valueAtPath(args, decl.path);

        if (bodyRaw === undefined || bodyRaw === null) {
            // Server MUST NOT expect the header for a null/absent value.
            continue;
        }
        const bodyString = mcpParamPrimitiveToString(bodyRaw);
        if (bodyString === undefined) {
            // Body carries a non-primitive where the schema declares one;
            // params validation owns that fault. Skip the header check.
            continue;
        }
        if (headerValue === null) {
            return paramHeaderMismatchRejection(
                'param-header-missing',
                headerKey,
                `the body carries ${pathName(decl.path)}=${JSON.stringify(bodyRaw)} but the ${headerKey} header is absent`
            );
        }
        const decoded = decodeMcpParamValue(headerValue);
        if (decoded === undefined) {
            return paramHeaderMismatchRejection(
                'param-header-invalid-encoding',
                headerKey,
                `the ${headerKey} header carries an invalid Base64 sentinel value`
            );
        }
        // Integer/number-typed declarations compare numerically (the spec's
        // SHOULD — `42.0` and `42` are equal). The strict-decimal gate is
        // applied to the *header* side only (so `'0x1a'`, `' 42 '`, `'1e3'`
        // etc. never coerce); the body side is gated on being an actual JS
        // number — `String(0.0000001) === '1e-7'` would fail the regex even
        // though the value is perfectly canonical. A non-numeric body
        // primitive (e.g. `'abc'` where the schema declares `integer`) is a
        // body-vs-schema fault that params validation owns; fall back to
        // string comparison and let dispatch emit `-32602` instead so an
        // identical non-numeric pair never reports a mismatch.
        const numericComparable =
            (decl.type === 'integer' || decl.type === 'number') && CANONICAL_DECIMAL.test(decoded) && typeof bodyRaw === 'number';
        const equal = numericComparable ? Number(decoded) === bodyRaw : decoded === bodyString;
        if (!equal) {
            return paramHeaderMismatchRejection(
                'param-header-mismatch',
                headerKey,
                `the ${headerKey} header decodes to ${JSON.stringify(decoded)} but the body carries ${pathName(decl.path)}=${JSON.stringify(bodyRaw)}`
            );
        }
    }
    return undefined;
}

/**
 * Build the `-32020` (`HeaderMismatch`) rejection for an `Mcp-Param-*`
 * disagreement. Same shape as the inbound classifier's standard-header
 * cross-check mismatch (HTTP `400`, `data.mismatch` naming the disagreeing
 * pair, `settled: true`); only the rung differs because this check runs at the
 * pre-dispatch step against a known tool's schema rather than at the edge.
 */
export function paramHeaderMismatchRejection(cell: string, header: string, body: string): InboundLadderRejection {
    return {
        kind: 'reject',
        rung: 'param-header-validation',
        cell,
        httpStatus: 400,
        code: HEADER_MISMATCH_ERROR_CODE,
        message: `Bad Request: the request headers and body disagree: ${body}`,
        data: { mismatch: { header, body } },
        settled: true
    };
}
