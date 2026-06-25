/**
 * Opt-in resolver for external (`$ref`) JSON Schema references (SEP-2106, R-2106-10).
 *
 * By default the SDK **refuses** to dereference any `$ref`/`$dynamicRef` that is not a same-document
 * reference (see {@link ./schemaBounds.js | assertSchemaSafeToCompile}). That safe default protects
 * against the SSRF / fetch-amplification primitive a naive resolver would expose. SEP-2106 permits an
 * **opt-in** mode that fetches non-local references, but requires it to be:
 *
 * - **disabled by default** — this is a separate function an operator must call explicitly
 *   ("explicit operator action", per the SEP); it is never invoked during normal validation;
 * - **host-restricted** — it SHOULD enforce an allowlist of hosts, and at minimum reject loopback,
 *   link-local, and private network addresses;
 * - **bounded** — it MUST apply timeouts and response size limits;
 * - **observable** — it SHOULD log the URIs it dereferences;
 * - **fail-closed** — a reference that cannot be resolved MUST cause rejection, never a silent pass.
 *
 * Rather than teaching the (synchronous) validators to fetch, this resolver runs **ahead of time**
 * and returns a self-contained schema: each external document is fetched once and **flattened** into
 * the root document's `$defs`, and every reference (external, and the internal references inside a
 * fetched document) is rewritten to a root-relative same-document JSON Pointer. The result therefore
 * contains **only** local pointer references — no nested `$id` scopes — so it passes the default
 * safety guard and compiles with the standard validators (AJV / cfworker) without any network access
 * at validation time.
 *
 * @example
 * ```ts source="./externalRefResolver.examples.ts#resolveExternalSchemaRefs_basic"
 * const resolved = await resolveExternalSchemaRefs(toolOutputSchema, {
 *     allowlist: ['schemas.example.com']
 * });
 * // `resolved` has no external $refs; hand it to registerTool / fromJsonSchema as usual.
 * ```
 *
 * @module
 */

import type { JsonSchemaType } from './types';

/** Default per-request fetch timeout, in milliseconds. */
export const DEFAULT_REF_FETCH_TIMEOUT_MS = 5000;

/** Default maximum size of a fetched schema document, in bytes. */
export const DEFAULT_REF_MAX_BYTES = 1_000_000;

/** Default maximum number of distinct external documents fetched while resolving one schema. */
export const DEFAULT_REF_MAX_DOCUMENTS = 50;

/** Options controlling {@link resolveExternalSchemaRefs}. */
export interface ResolveExternalRefsOptions {
    /**
     * Allowlist of permitted hosts (e.g. `'schemas.example.com'`). When provided, only references
     * whose host exactly matches an entry are fetched; everything else is rejected. **Strongly
     * recommended** — without it, the resolver still rejects loopback/link-local/private targets,
     * but cannot defend against a public URL that an attacker controls.
     */
    allowlist?: readonly string[];
    /**
     * Permitted URL protocols. Defaults to `['https:']`. Add `'http:'` only for trusted internal
     * use; plaintext fetches are easier to tamper with in transit.
     */
    allowedProtocols?: readonly string[];
    /** Per-request timeout in milliseconds (default: 5000). */
    timeoutMs?: number;
    /** Maximum size of a single fetched document in bytes (default: 1,000,000). */
    maxBytes?: number;
    /** Maximum number of distinct documents fetched (default: 50). */
    maxDocuments?: number;
    /**
     * Fetch implementation. Defaults to the global `fetch`. Inject a custom one for tests or to add
     * proxying/auth. Must honour the `AbortSignal` passed in `init.signal`.
     */
    fetch?: typeof globalThis.fetch;
    /**
     * Called with each external URI **before** it is dereferenced, so operators can audit/log
     * network access (the SEP asks implementations to log dereferenced URIs). Defaults to a no-op.
     */
    onDereference?: (uri: string) => void;
}

interface ResolvedOptions {
    allowlist?: readonly string[];
    allowedProtocols: readonly string[];
    timeoutMs: number;
    maxBytes: number;
    maxDocuments: number;
    fetchImpl: typeof globalThis.fetch;
    onDereference: (uri: string) => void;
}

/** Split a reference into its base (document) URI and fragment (without the leading `#`). */
function splitRef(ref: string): { base: string; fragment: string } {
    const hashIndex = ref.indexOf('#');
    if (hashIndex === -1) {
        return { base: ref, fragment: '' };
    }
    return { base: ref.slice(0, hashIndex), fragment: ref.slice(hashIndex + 1) };
}

/** A reference is "external" when it has a non-empty base (i.e. it does not start with `#`). */
function isExternalRef(ref: string): boolean {
    return ref.length > 0 && !ref.startsWith('#');
}

const DATA_VALUE_KEYWORDS = new Set(['const', 'default', 'enum', 'examples']);
const SCHEMA_MAP_KEYWORDS = new Set(['$defs', 'definitions', 'dependentSchemas', 'patternProperties', 'properties']);

function resolveExternalBase(base: string, containingDocumentUri: string | undefined, originalRef: string): string {
    try {
        return new URL(base, containingDocumentUri).href;
    } catch {
        throw new Error(`Refusing to dereference "${originalRef}": not an absolute URI.`);
    }
}

function ipv6LiteralFromHost(host: string): string | undefined {
    return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : undefined;
}

function stripTrailingDnsRootDots(host: string): string {
    let end = host.length;
    while (end > 0 && host.codePointAt(end - 1) === 46) {
        end--;
    }

    return end === host.length ? host : host.slice(0, end);
}

function normalizeHostForPolicy(host: string): string {
    return ipv6LiteralFromHost(host) === undefined ? stripTrailingDnsRootDots(host) : host;
}

function isBlockedIPv6Literal(host: string): boolean {
    if (host === '::' || host === '::1' || host.startsWith('::ffff:')) {
        return true;
    }

    const firstHextet = Number.parseInt(host.split(':', 1)[0] ?? '', 16);
    if (Number.isNaN(firstHextet)) {
        return false;
    }

    return (firstHextet >= 0xfc_00 && firstHextet <= 0xfd_ff) || (firstHextet >= 0xfe_80 && firstHextet <= 0xfe_bf);
}

/**
 * Reject hosts that are obvious SSRF targets: loopback, link-local, and private ranges. This is a
 * best-effort literal-address check (it does not resolve DNS); the allowlist is the real defence.
 */
function assertHostAllowed(url: URL, options: ResolvedOptions): void {
    if (!options.allowedProtocols.includes(url.protocol)) {
        throw new Error(
            `Refusing to dereference "${url.href}": protocol "${url.protocol}" is not allowed (allowed: ${options.allowedProtocols.join(', ')}).`
        );
    }

    const host = normalizeHostForPolicy(url.hostname.toLowerCase());

    if (options.allowlist) {
        const allowlist = new Set(options.allowlist.map(allowedHost => normalizeHostForPolicy(allowedHost.toLowerCase())));
        if (!allowlist.has(host)) {
            throw new Error(`Refusing to dereference "${url.href}": host "${host}" is not in the allowlist.`);
        }
        return;
    }

    // No allowlist: reject the most dangerous literal targets so an unguarded call still cannot
    // trivially hit internal services / cloud metadata endpoints.
    const ipv6Literal = ipv6LiteralFromHost(host);
    const blocked =
        host === 'localhost' ||
        host === '0.0.0.0' ||
        host.endsWith('.localhost') ||
        host.endsWith('.internal') ||
        /^127\./.test(host) ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^169\.254\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        (ipv6Literal !== undefined && isBlockedIPv6Literal(ipv6Literal));
    if (blocked) {
        throw new Error(
            `Refusing to dereference "${url.href}": host "${host}" resolves to a loopback/link-local/private address. ` +
                `Provide an explicit allowlist to dereference internal hosts intentionally.`
        );
    }
}

/** Read a response body, enforcing the byte cap as it streams. */
async function readBounded(response: Response, maxBytes: number, uri: string): Promise<string> {
    const declared = response.headers.get('content-length');
    if (declared && Number(declared) > maxBytes) {
        throw new Error(`Refusing to dereference "${uri}": declared content-length ${declared} exceeds max ${maxBytes} bytes.`);
    }

    const body = response.body;
    if (!body) {
        const text = await response.text();
        if (text.length > maxBytes) {
            throw new Error(`Refusing to dereference "${uri}": response exceeds max ${maxBytes} bytes.`);
        }
        return text;
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let out = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        received += value.byteLength;
        if (received > maxBytes) {
            await reader.cancel();
            throw new Error(`Refusing to dereference "${uri}": response exceeds max ${maxBytes} bytes.`);
        }
        out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return out;
}

/** Fetch and parse one external schema document, applying timeout + size bounds. */
async function fetchDocument(uri: string, options: ResolvedOptions): Promise<Record<string, unknown>> {
    let url: URL;
    try {
        url = new URL(uri);
    } catch {
        throw new Error(`Refusing to dereference "${uri}": not an absolute URI.`);
    }
    assertHostAllowed(url, options);

    options.onDereference(url.href);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    let text: string;
    try {
        const response = await options.fetchImpl(url.href, { signal: controller.signal, redirect: 'error' });
        if (!response.ok) {
            throw new Error(`Refusing to use "${url.href}": fetch returned HTTP ${response.status}.`);
        }
        text = await readBounded(response, options.maxBytes, url.href);
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(`Refusing to dereference "${url.href}": fetch timed out after ${options.timeoutMs}ms.`);
        }
        throw error instanceof Error ? error : new Error(String(error));
    } finally {
        clearTimeout(timer);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`Refusing to use "${url.href}": response is not valid JSON.`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Refusing to use "${url.href}": resolved document is not a JSON Schema object.`);
    }
    return parsed as Record<string, unknown>;
}

/**
 * Resolve and inline all external `$ref`/`$dynamicRef` references in a JSON Schema, returning a
 * self-contained schema with only same-document references.
 *
 * This is the **opt-in** external-reference mode described by SEP-2106 (R-2106-10): it is never
 * invoked during normal validation and must be called explicitly. Each distinct external document is
 * fetched once (subject to the allowlist, protocol, timeout, size, and document-count limits) and
 * bundled under a generated `$defs` slot that preserves the document's canonical `$id`; every
 * external reference to that document is rewritten to a local JSON Pointer into the slot. References
 * the resolver cannot satisfy cause rejection (fail-closed) rather than a silent pass.
 *
 * @param schema - the schema to resolve. Not mutated; a new object is returned.
 * @param options - allowlist and bounds. Supplying an `allowlist` is strongly recommended.
 * @returns a schema whose references are all same-document (safe to compile with the default guard).
 * @throws Error if a reference targets a disallowed host, cannot be fetched within bounds, uses an
 *   external `$anchor` fragment (unsupported), or the document budget is exceeded.
 */
export async function resolveExternalSchemaRefs(schema: JsonSchemaType, options: ResolveExternalRefsOptions = {}): Promise<JsonSchemaType> {
    const resolved: ResolvedOptions = {
        allowlist: options.allowlist,
        allowedProtocols: options.allowedProtocols ?? ['https:'],
        timeoutMs: options.timeoutMs ?? DEFAULT_REF_FETCH_TIMEOUT_MS,
        maxBytes: options.maxBytes ?? DEFAULT_REF_MAX_BYTES,
        maxDocuments: options.maxDocuments ?? DEFAULT_REF_MAX_DOCUMENTS,
        fetchImpl: options.fetch ?? globalThis.fetch,
        onDereference: options.onDereference ?? (() => {})
    };
    if (typeof resolved.fetchImpl !== 'function') {
        throw new TypeError('resolveExternalSchemaRefs: no fetch implementation available; pass options.fetch.');
    }

    // Map of base URI -> generated $defs slot key, and the collected bundle of fetched documents.
    const slotByBase = new Map<string, string>();
    const bundle: Record<string, Record<string, unknown>> = {};

    const ensureDocument = async (base: string): Promise<string> => {
        const existing = slotByBase.get(base);
        if (existing) {
            return existing;
        }
        if (slotByBase.size >= resolved.maxDocuments) {
            throw new Error(`Refusing to resolve more than ${resolved.maxDocuments} external schema documents.`);
        }
        const slot = `__externalRef_${slotByBase.size}`;
        slotByBase.set(base, slot);

        const doc = await fetchDocument(base, resolved);
        // Flatten the document into the root's $defs under `slot`. Its own identity/dialect keywords
        // are dropped (it no longer is a standalone document), and its internal references are
        // rewritten to root-relative pointers that target this slot.
        const { $id: _id, $schema: _schema, ...rest } = doc;
        void _id;
        void _schema;
        const flattened = await rewrite(rest, `/$defs/${slot}`, base);
        bundle[slot] = flattened as Record<string, unknown>;
        return slot;
    };

    /**
     * Rewrite references in `node` to root-relative same-document pointers.
     *
     * @param node - the schema (sub)tree.
     * @param slotPrefix - `''` for the root document; `/$defs/<slot>` when rewriting a fetched
     *   document that is being flattened into that slot (so its internal `#/x` refs become
     *   `#/$defs/<slot>/x`).
     * @param containingDocumentUri - the fetched document URL used to resolve relative refs.
     */
    async function rewrite(node: unknown, slotPrefix: string, containingDocumentUri?: string): Promise<unknown> {
        if (Array.isArray(node)) {
            return Promise.all(node.map(item => rewrite(item, slotPrefix, containingDocumentUri)));
        }
        if (node === null || typeof node !== 'object') {
            return node;
        }
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
            if ((key === '$ref' || key === '$dynamicRef') && typeof value === 'string') {
                if (isExternalRef(value)) {
                    const { base, fragment } = splitRef(value);
                    if (fragment && !fragment.startsWith('/')) {
                        throw new Error(
                            `Cannot resolve external ${key} "${value}": external "$anchor" fragments are not supported. ` +
                                `Use a JSON Pointer fragment (e.g. "#/$defs/Foo") or restructure the schema.`
                        );
                    }
                    const slot = await ensureDocument(resolveExternalBase(base, containingDocumentUri, value));
                    out[key] = `#/$defs/${slot}${fragment}`;
                } else if (slotPrefix === '') {
                    out[key] = value;
                } else {
                    // Internal reference inside a flattened document: re-base it onto the slot.
                    const fragment = value.slice(1);
                    if (fragment !== '' && !fragment.startsWith('/')) {
                        throw new Error(
                            `Cannot flatten ${key} "${value}" from an external document: "$anchor" references inside ` +
                                `fetched schemas are not supported. Use JSON Pointer references (e.g. "#/$defs/Foo").`
                        );
                    }
                    out[key] = `#${slotPrefix}${fragment}`;
                }
            } else if (slotPrefix !== '' && (key === '$id' || key === '$anchor' || key === '$dynamicAnchor')) {
                // Scope-defining keywords inside a flattened document cannot be preserved once the
                // document loses its own identity; reject rather than silently change semantics.
                throw new Error(
                    `Cannot flatten external schema: nested "${key}" is not supported. ` +
                        `Restructure the referenced document to use plain JSON Pointer references.`
                );
            } else if (DATA_VALUE_KEYWORDS.has(key)) {
                out[key] = value;
            } else if (SCHEMA_MAP_KEYWORDS.has(key) && value !== null && typeof value === 'object' && !Array.isArray(value)) {
                out[key] = Object.fromEntries(
                    await Promise.all(
                        Object.entries(value as Record<string, unknown>).map(async ([childKey, childValue]) => [
                            childKey,
                            await rewrite(childValue, slotPrefix, containingDocumentUri)
                        ])
                    )
                );
            } else {
                out[key] = await rewrite(value, slotPrefix, containingDocumentUri);
            }
        }
        return out;
    }

    const rewrittenRoot = (await rewrite(schema, '')) as Record<string, unknown>;

    if (slotByBase.size === 0) {
        // No external references; return the (structurally identical) schema unchanged.
        return rewrittenRoot as JsonSchemaType;
    }

    const existingDefs = (rewrittenRoot.$defs as Record<string, unknown> | undefined) ?? {};
    return { ...rewrittenRoot, $defs: { ...existingDefs, ...bundle } } as JsonSchemaType;
}
