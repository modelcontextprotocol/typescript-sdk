import type { ServerCardInput, ServerCardRemote } from '@modelcontextprotocol/core/experimental/server-card';

import { ServerCardError } from './errors';

// The spec's template grammar: `{var}` where var is [a-zA-Z_][a-zA-Z0-9_]*.
// This is deliberately not RFC 6570; the SDK's UriTemplate is a different
// grammar and is not reused here.
const TEMPLATE_VAR = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

/**
 * One input a consent or configuration UI may prompt for, walked from a card
 * remote. Pure data: `isSecret`, `choices`, `default`, and `placeholder` are
 * surfaced on `input`; presentation is host policy.
 */
export interface RemoteInputRequirement {
    /** The name to use as the key in {@link resolveRemote}'s `inputs` map. */
    key: string;
    /**
     * Provenance of the input within the remote, e.g. `'variables.tenant'`
     * or `'headers.Authorization.variables.token'`.
     */
    path: string;
    /** The input declaration from the card. */
    input: ServerCardInput;
    /** Whether the input is declared `isRequired`. */
    required: boolean;
}

/**
 * Walks everything a UI may prompt for on a card remote: the remote's
 * `variables`, header inputs lacking a fixed `value`, and each header's
 * nested `variables`. Keys share one flat namespace (variable names plus
 * header names), matching what {@link resolveRemote} reads from `inputs`.
 */
export function requiredRemoteInputs(remote: ServerCardRemote): RemoteInputRequirement[] {
    const requirements: RemoteInputRequirement[] = [];
    for (const [name, input] of Object.entries(remote.variables ?? {})) {
        requirements.push({ key: name, path: `variables.${name}`, input, required: input.isRequired === true });
    }
    for (const header of remote.headers ?? []) {
        if (header.value === undefined) {
            requirements.push({ key: header.name, path: `headers.${header.name}`, input: header, required: header.isRequired === true });
        }
        for (const [name, input] of Object.entries(header.variables ?? {})) {
            requirements.push({
                key: name,
                path: `headers.${header.name}.variables.${name}`,
                input,
                required: input.isRequired === true
            });
        }
    }
    return requirements;
}

/**
 * A card remote resolved to a connectable endpoint. Feed it to
 * `new StreamableHTTPClientTransport(url, { requestInit: { headers } })` or
 * `SSEClientTransport`; pass a supported protocol version to the transport's
 * `protocolVersion` option if you negotiate one up front.
 */
export interface ResolvedRemote {
    /** Transport type declared by the card. */
    type: 'streamable-http' | 'sse';
    /** Fully substituted endpoint URL. */
    url: URL;
    /** Fully substituted header values, ready for `requestInit.headers`. */
    headers: Record<string, string>;
    /** Protocol versions the card claims the endpoint supports. */
    supportedProtocolVersions?: string[];
}

/**
 * Resolves a card remote's `{var}` templates against supplied inputs.
 *
 * Each `{var}` in the URL resolves from `inputs[key]`, then the variable's
 * `value`, then its `default`. A header with a fixed `value` resolves its
 * nested variables the same way; a header without one takes
 * `inputs[headerName]`, then the header's `default`. A header that resolves
 * to no value and is not required is omitted.
 *
 * Every unmet required input is aggregated into one `'missing-input'` error
 * (one prompt round trip, not N). A supplied value outside an input's
 * `choices`, an unresolved `{var}` left in the final URL, or a resolved URL
 * that is not http(s) throws `'invalid-input'`.
 *
 * No transport is constructed: choosing a remote and supplying inputs is
 * host policy, and card data stays advisory.
 */
export function resolveRemote(remote: ServerCardRemote, inputs: Record<string, string> = {}): ResolvedRemote {
    const missing = new Map<string, ServerCardInput>();

    const checkChoices = (key: string, declaration: ServerCardInput | undefined): void => {
        const supplied = inputs[key];
        if (supplied !== undefined && declaration?.choices !== undefined && !declaration.choices.includes(supplied)) {
            throw new ServerCardError('invalid-input', `Input ${key} must be one of: ${declaration.choices.join(', ')}`);
        }
    };

    const substitute = (
        template: string,
        variables: Record<string, ServerCardInput> | undefined
    ): { value: string; unresolved: string[] } => {
        const unresolved: string[] = [];
        const value = template.replaceAll(TEMPLATE_VAR, (whole, key: string) => {
            const declaration = variables?.[key];
            checkChoices(key, declaration);
            const resolved = inputs[key] ?? declaration?.value ?? declaration?.default;
            if (resolved === undefined) {
                unresolved.push(key);
                if (declaration?.isRequired === true) {
                    missing.set(key, declaration);
                }
                return whole;
            }
            return resolved;
        });
        return { value, unresolved };
    };

    const substitutedUrl = substitute(remote.url, remote.variables);

    const headers: Record<string, string> = {};
    for (const header of remote.headers ?? []) {
        if (header.value !== undefined) {
            const { value, unresolved } = substitute(header.value, header.variables);
            if (unresolved.length === 0) {
                headers[header.name] = value;
            } else if (header.isRequired === true) {
                for (const key of unresolved) {
                    if (!missing.has(key)) {
                        missing.set(key, header.variables?.[key] ?? {});
                    }
                }
            }
            // Otherwise the header resolves to no value and is omitted;
            // any required nested variable was already recorded.
            continue;
        }
        checkChoices(header.name, header);
        const value = inputs[header.name] ?? header.default;
        if (value !== undefined) {
            headers[header.name] = value;
        } else if (header.isRequired === true) {
            missing.set(header.name, header);
        }
    }

    if (missing.size > 0) {
        const entries = [...missing.entries()].map(([key, input]) => ({ key, input }));
        throw new ServerCardError(
            'missing-input',
            `Missing required input${entries.length === 1 ? '' : 's'}: ${entries.map(entry => entry.key).join(', ')}`,
            { missing: entries }
        );
    }

    if (substitutedUrl.unresolved.length > 0) {
        throw new ServerCardError('invalid-input', `Unresolved template variables in remote URL: ${substitutedUrl.unresolved.join(', ')}`);
    }
    let url: URL;
    try {
        url = new URL(substitutedUrl.value);
    } catch (error) {
        throw new ServerCardError('invalid-input', `Resolved remote URL is not a valid URL: ${substitutedUrl.value}`, { cause: error });
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new ServerCardError('invalid-input', `Resolved remote URL must be http(s), got ${url.protocol}`, { url: url.href });
    }

    return {
        type: remote.type,
        url,
        headers,
        ...(remote.supportedProtocolVersions === undefined ? {} : { supportedProtocolVersions: remote.supportedProtocolVersions })
    };
}
