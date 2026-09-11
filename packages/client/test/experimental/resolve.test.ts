import { describe, expect, it } from 'vitest';

import type { ServerCardRemote } from '../../src/experimental/serverCard/index';
import { requiredRemoteInputs, resolveRemote, ServerCardError } from '../../src/experimental/serverCard/index';

// The spec repo's templated-remote example shape: templated url, Authorization
// header with a nested secret token variable, tenant variable with a default.
const templatedRemote: ServerCardRemote = {
    type: 'streamable-http',
    url: 'https://{tenant}.example.com/mcp',
    headers: [
        {
            name: 'Authorization',
            isRequired: true,
            isSecret: true,
            value: 'Bearer {token}',
            variables: { token: { description: 'API token', isRequired: true, isSecret: true } }
        }
    ],
    variables: { tenant: { description: 'Tenant subdomain', isRequired: true, default: 'default' } },
    supportedProtocolVersions: ['2025-06-18', '2025-11-25']
};

function thrown(fn: () => void): ServerCardError {
    try {
        fn();
    } catch (error) {
        expect(error).toBeInstanceOf(ServerCardError);
        return error as ServerCardError;
    }
    throw new Error('expected resolveRemote to throw');
}

describe('requiredRemoteInputs', () => {
    it('walks remote variables, valueless header inputs, and nested header variables', () => {
        const remote: ServerCardRemote = {
            ...templatedRemote,
            headers: [...templatedRemote.headers!, { name: 'X-Region', isRequired: false, choices: ['eu', 'us'] }]
        };
        const requirements = requiredRemoteInputs(remote);
        expect(requirements).toEqual([
            { key: 'tenant', path: 'variables.tenant', input: remote.variables!['tenant'], required: true },
            { key: 'token', path: 'headers.Authorization.variables.token', input: remote.headers![0]!.variables!['token'], required: true },
            { key: 'X-Region', path: 'headers.X-Region', input: remote.headers![1], required: false }
        ]);
    });

    it('does not list headers with a fixed value as their own input', () => {
        const keys = requiredRemoteInputs(templatedRemote).map(requirement => requirement.key);
        expect(keys).not.toContain('Authorization');
    });

    it('skips nested variables of a valueless header, which resolveRemote never reads', () => {
        const remote: ServerCardRemote = {
            type: 'streamable-http',
            url: 'https://example.com/mcp',
            headers: [{ name: 'X-Key', variables: { token: { isRequired: true, isSecret: true } } }]
        };
        expect(requiredRemoteInputs(remote)).toEqual([{ key: 'X-Key', path: 'headers.X-Key', input: remote.headers![0], required: false }]);
        // The walk mirrors consumption: only inputs['X-Key'] is read.
        expect(resolveRemote(remote, { 'X-Key': 'k1' }).headers).toEqual({ 'X-Key': 'k1' });
    });

    it('returns [] for a remote with no inputs', () => {
        expect(requiredRemoteInputs({ type: 'sse', url: 'https://example.com/sse' })).toEqual([]);
    });
});

describe('resolveRemote', () => {
    it('substitutes url and header templates from inputs', () => {
        const resolved = resolveRemote(templatedRemote, { tenant: 'acme', token: 'secret123' });
        expect(resolved.type).toBe('streamable-http');
        expect(resolved.url.href).toBe('https://acme.example.com/mcp');
        expect(resolved.headers).toEqual({ Authorization: 'Bearer secret123' });
        expect(resolved.supportedProtocolVersions).toEqual(['2025-06-18', '2025-11-25']);
    });

    it('falls back to variable defaults, with inputs taking precedence over value and default', () => {
        const resolved = resolveRemote(templatedRemote, { token: 'secret123' });
        expect(resolved.url.href).toBe('https://default.example.com/mcp');

        const withValue: ServerCardRemote = {
            type: 'streamable-http',
            url: 'https://{env}.example.com/mcp',
            variables: { env: { value: 'prod', default: 'staging' } }
        };
        expect(resolveRemote(withValue).url.href).toBe('https://prod.example.com/mcp');
        expect(resolveRemote(withValue, { env: 'dev' }).url.href).toBe('https://dev.example.com/mcp');
    });

    it('aggregates every unmet required input into one missing-input error', () => {
        const error = thrown(() => resolveRemote({ ...templatedRemote, variables: { tenant: { isRequired: true } } }));
        expect(error.code).toBe('missing-input');
        expect(error.missing!.map(entry => entry.key).sort()).toEqual(['tenant', 'token']);
    });

    it('resolves a valueless header from inputs by header name and from its default', () => {
        const remote: ServerCardRemote = {
            type: 'streamable-http',
            url: 'https://example.com/mcp',
            headers: [
                { name: 'X-Api-Key', isRequired: true },
                { name: 'X-Region', default: 'eu' }
            ]
        };
        const resolved = resolveRemote(remote, { 'X-Api-Key': 'k1' });
        expect(resolved.headers).toEqual({ 'X-Api-Key': 'k1', 'X-Region': 'eu' });
    });

    it('omits an optional header that resolves to no value', () => {
        const remote: ServerCardRemote = {
            type: 'streamable-http',
            url: 'https://example.com/mcp',
            headers: [{ name: 'X-Optional' }, { name: 'X-Templated', value: 'v-{missing}' }]
        };
        expect(resolveRemote(remote).headers).toEqual({});
    });

    it('reports a missing required valueless header as missing-input', () => {
        const remote: ServerCardRemote = {
            type: 'streamable-http',
            url: 'https://example.com/mcp',
            headers: [{ name: 'X-Api-Key', isRequired: true }]
        };
        const error = thrown(() => resolveRemote(remote));
        expect(error.code).toBe('missing-input');
        expect(error.missing![0]!.key).toBe('X-Api-Key');
    });

    it('throws invalid-input for a supplied value outside choices', () => {
        const remote: ServerCardRemote = {
            type: 'streamable-http',
            url: 'https://{region}.example.com/mcp',
            variables: { region: { choices: ['eu', 'us'] } }
        };
        expect(resolveRemote(remote, { region: 'eu' }).url.href).toBe('https://eu.example.com/mcp');
        expect(thrown(() => resolveRemote(remote, { region: 'mars' })).code).toBe('invalid-input');
    });

    it('throws invalid-input for an unresolved variable left in the url', () => {
        const remote: ServerCardRemote = { type: 'streamable-http', url: 'https://{tenant}.example.com/mcp' };
        expect(thrown(() => resolveRemote(remote)).code).toBe('invalid-input');
    });

    it('throws invalid-input when the resolved url is not http(s)', () => {
        const remote: ServerCardRemote = {
            type: 'streamable-http',
            url: '{base}/mcp',
            variables: { base: { value: 'ftp://example.com' } }
        };
        expect(thrown(() => resolveRemote(remote)).code).toBe('invalid-input');
    });
});
