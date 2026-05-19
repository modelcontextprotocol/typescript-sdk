import { describe, expect, it } from 'vitest';

import {
    parseServerCard,
    parseServerJson,
    safeParseServerCard,
    safeParseServerJson,
    SERVER_CARD_SCHEMA_URL,
    SERVER_CARD_WELL_KNOWN_PATH,
    SERVER_JSON_SCHEMA_URL,
    ServerCardSchema,
    ServerJsonSchema
} from '../../src/experimental/serverCard.js';

const MINIMAL = {
    $schema: SERVER_CARD_SCHEMA_URL,
    name: 'example-org/minimal',
    version: '1.0.0',
    description: 'Smallest valid Server Card.'
};

const FULL = {
    $schema: SERVER_CARD_SCHEMA_URL,
    name: 'example-org/weather',
    version: '2.1.0-alpha',
    description: 'Weather forecasts and alerts.',
    title: 'Weather',
    websiteUrl: 'https://example.com/weather',
    repository: { url: 'https://github.com/example-org/weather', source: 'github', subfolder: 'packages/server', id: '12345' },
    icons: [{ src: 'https://example.com/icon.png', mimeType: 'image/png', sizes: ['48x48'], theme: 'light' }],
    remotes: [
        {
            type: 'streamable-http',
            url: 'https://mcp.example.com/mcp',
            headers: [{ name: 'X-Api-Key', isSecret: true, isRequired: true }],
            variables: { region: { default: 'us', choices: ['us', 'eu'] } },
            supportedProtocolVersions: ['2025-11-25']
        },
        { type: 'sse', url: '{base}/sse' }
    ],
    _meta: { 'com.example/internal': { tier: 'gold' } }
};

describe('SERVER_CARD constants', () => {
    it('expose the well-known path and schema URLs', () => {
        expect(SERVER_CARD_WELL_KNOWN_PATH).toBe('/.well-known/mcp-server-card');
        expect(SERVER_CARD_SCHEMA_URL).toMatch(/server-card\.schema\.json$/);
        expect(SERVER_JSON_SCHEMA_URL).toMatch(/server\.schema\.json$/);
    });
});

describe('ServerCardSchema', () => {
    it('accepts a minimal valid card', () => {
        expect(() => ServerCardSchema.parse(MINIMAL)).not.toThrow();
    });

    it('accepts a fully-populated card', () => {
        const parsed = ServerCardSchema.parse(FULL);
        expect(parsed.remotes).toHaveLength(2);
        expect(parsed.icons?.[0]?.src).toBe('https://example.com/icon.png');
    });

    it('strips unknown top-level keys but keeps _meta', () => {
        const parsed = ServerCardSchema.parse({ ...MINIMAL, somethingElse: true, _meta: { 'a.b/c': 1 } });
        expect(parsed).not.toHaveProperty('somethingElse');
        expect(parsed._meta).toEqual({ 'a.b/c': 1 });
    });

    it('rejects a missing $schema', () => {
        const { $schema, ...rest } = MINIMAL;
        void $schema;
        expect(ServerCardSchema.safeParse(rest).success).toBe(false);
    });

    it('rejects a $schema that is not a versioned modelcontextprotocol.io URL', () => {
        expect(ServerCardSchema.safeParse({ ...MINIMAL, $schema: 'https://example.com/x.json' }).success).toBe(false);
    });

    it('rejects a name without a namespace slash', () => {
        expect(ServerCardSchema.safeParse({ ...MINIMAL, name: 'noslash' }).success).toBe(false);
    });

    it('rejects a name shorter than 3 characters', () => {
        expect(ServerCardSchema.safeParse({ ...MINIMAL, name: 'a/' }).success).toBe(false);
    });

    it.each(['^1.2.3', '~1.2.3', '>=1.2.3', '1.x', '1.*'])('rejects version range %s', range => {
        expect(ServerCardSchema.safeParse({ ...MINIMAL, version: range }).success).toBe(false);
    });

    it('accepts concrete semver-ish versions', () => {
        for (const version of ['1.0.0', '2.1.0-alpha', '0.0.1', '10.20.30']) {
            expect(ServerCardSchema.safeParse({ ...MINIMAL, version }).success).toBe(true);
        }
    });

    it('rejects a description longer than 100 characters', () => {
        expect(ServerCardSchema.safeParse({ ...MINIMAL, description: 'x'.repeat(101) }).success).toBe(false);
    });

    it('rejects a remote url that is neither http(s) nor a template variable', () => {
        expect(ServerCardSchema.safeParse({ ...MINIMAL, remotes: [{ type: 'sse', url: 'ftp://nope' }] }).success).toBe(false);
    });

    it('rejects an unknown remote transport type', () => {
        expect(ServerCardSchema.safeParse({ ...MINIMAL, remotes: [{ type: 'carrier-pigeon', url: 'https://x.example' }] }).success).toBe(
            false
        );
    });

    it('rejects a non-https websiteUrl shape', () => {
        expect(ServerCardSchema.safeParse({ ...MINIMAL, websiteUrl: 'not a url' }).success).toBe(false);
    });
});

describe('parseServerCard / safeParseServerCard', () => {
    it('parseServerCard returns the validated card', () => {
        expect(parseServerCard(MINIMAL).name).toBe('example-org/minimal');
    });

    it('parseServerCard throws on an invalid card', () => {
        expect(() => parseServerCard({ name: 'x' })).toThrow();
    });

    it('safeParseServerCard reports success and failure without throwing', () => {
        expect(safeParseServerCard(MINIMAL).success).toBe(true);
        const bad = safeParseServerCard({});
        expect(bad.success).toBe(false);
        if (!bad.success) {
            expect(bad.error.issues.length).toBeGreaterThan(0);
        }
    });
});

describe('ServerJsonSchema', () => {
    it('accepts a card augmented with packages', () => {
        const parsed = parseServerJson({
            ...MINIMAL,
            $schema: SERVER_JSON_SCHEMA_URL,
            packages: [
                {
                    registryType: 'npm',
                    identifier: '@example-org/weather',
                    version: '1.0.0',
                    transport: { type: 'stdio' },
                    runtimeHint: 'npx',
                    packageArguments: [{ type: 'named', name: '--port', value: '8080' }],
                    environmentVariables: [{ name: 'API_KEY', isSecret: true }]
                }
            ]
        });
        expect(parsed.packages?.[0]?.registryType).toBe('npm');
    });

    it('rejects an invalid package transport', () => {
        const result = safeParseServerJson({
            ...MINIMAL,
            packages: [{ registryType: 'npm', identifier: 'x', transport: { type: 'telepathy' } }]
        });
        expect(result.success).toBe(false);
    });

    it('rejects a fileSha256 that is not a hex digest', () => {
        const result = ServerJsonSchema.safeParse({
            ...MINIMAL,
            packages: [{ registryType: 'oci', identifier: 'x', transport: { type: 'stdio' }, fileSha256: 'ZZZ' }]
        });
        expect(result.success).toBe(false);
    });

    it('a plain ServerCard is also a valid ServerJson', () => {
        expect(safeParseServerJson(MINIMAL).success).toBe(true);
    });
});
