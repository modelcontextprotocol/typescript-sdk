import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SERVER_CARD_SCHEMA_URL, ServerCardRemoteSchema, ServerCardSchema } from '../../src/experimental/serverCard';

const fixturesDir = fileURLToPath(new URL('./fixtures/server-card', import.meta.url));

function readFixtures(kind: 'valid' | 'invalid'): Array<{ name: string; document: unknown }> {
    const dir = join(fixturesDir, kind);
    return readdirSync(dir)
        .filter(file => file.endsWith('.json'))
        .map(file => ({ name: file, document: JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown }));
}

const baseCard = {
    $schema: SERVER_CARD_SCHEMA_URL,
    name: 'com.example/weather',
    version: '1.0.0',
    description: 'Hourly and 7-day forecasts for any coordinates'
};

describe('ServerCardSchema conformance fixtures', () => {
    it.each(readFixtures('valid'))('accepts and round-trips valid fixture $name', ({ document }) => {
        expect(ServerCardSchema.parse(document)).toEqual(document);
    });

    it('rejects a name without a slash for the name pattern', () => {
        const fixture = readFixtures('invalid').find(f => f.name === 'bad-name-pattern.json')!;
        const result = ServerCardSchema.safeParse(fixture.document);
        expect(result.success).toBe(false);
        expect(result.error!.issues.map(issue => issue.path.join('.'))).toContain('name');
    });

    it('rejects a date-versioned $schema URL', () => {
        const fixture = readFixtures('invalid').find(f => f.name === 'date-versioned-schema.json')!;
        const result = ServerCardSchema.safeParse(fixture.document);
        expect(result.success).toBe(false);
        expect(result.error!.issues.map(issue => issue.path.join('.'))).toContain('$schema');
    });

    it('rejects a missing name', () => {
        const fixture = readFixtures('invalid').find(f => f.name === 'missing-name.json')!;
        const result = ServerCardSchema.safeParse(fixture.document);
        expect(result.success).toBe(false);
        expect(result.error!.issues.map(issue => issue.path.join('.'))).toContain('name');
    });

    it('rejects a missing $schema (strict schema; leniency lives in the client fetchers)', () => {
        const fixture = readFixtures('invalid').find(f => f.name === 'missing-schema.json')!;
        const result = ServerCardSchema.safeParse(fixture.document);
        expect(result.success).toBe(false);
        expect(result.error!.issues.map(issue => issue.path.join('.'))).toContain('$schema');
    });

    it('rejects the removed registry server.schema.json URL', () => {
        const fixture = readFixtures('invalid').find(f => f.name === 'wrong-schema-name.json')!;
        const result = ServerCardSchema.safeParse(fixture.document);
        expect(result.success).toBe(false);
        expect(result.error!.issues.map(issue => issue.path.join('.'))).toContain('$schema');
    });
});

describe('ServerCardSchema constraints', () => {
    it.each(['^1.2.3', '~1.2.3', '>=1.2.3', '<=1', '>1', '<1', '1.x', '1.*'])('rejects version range %s', version => {
        const result = ServerCardSchema.safeParse({ ...baseCard, version });
        expect(result.success).toBe(false);
        expect(result.error!.issues[0]!.message).toContain('range');
    });

    it.each(['1.0.2', '2.1.0-alpha', 'build-2024', '2024-01-15'])('accepts exact or non-semver version %s', version => {
        expect(ServerCardSchema.safeParse({ ...baseCard, version }).success).toBe(true);
    });

    it('rejects a description longer than 100 characters and an empty description', () => {
        expect(ServerCardSchema.safeParse({ ...baseCard, description: 'x'.repeat(101) }).success).toBe(false);
        expect(ServerCardSchema.safeParse({ ...baseCard, description: '' }).success).toBe(false);
    });

    it('rejects a name with more than one slash or shorter than 3 characters', () => {
        expect(ServerCardSchema.safeParse({ ...baseCard, name: 'a/b/c' }).success).toBe(false);
        expect(ServerCardSchema.safeParse({ ...baseCard, name: 'a/' }).success).toBe(false);
    });

    it('keeps unknown fields (open objects) and _meta content', () => {
        const card = ServerCardSchema.parse({ ...baseCard, 'x-vendor': 1, _meta: { 'com.example/hint': 'v' } });
        expect(card['x-vendor']).toBe(1);
        expect(card._meta).toEqual({ 'com.example/hint': 'v' });
    });
});

describe('ServerCardRemoteSchema url template pattern', () => {
    it.each(['https://example.com/mcp', 'http://example.com/mcp', '{base}/mcp', '{base_url}'])('accepts %s', url => {
        expect(ServerCardRemoteSchema.safeParse({ type: 'streamable-http', url }).success).toBe(true);
    });

    it.each(['ftp://example.com/mcp', 'example.com/mcp', '{1bad}/mcp', 'https://exa mple.com'])('rejects %s', url => {
        expect(ServerCardRemoteSchema.safeParse({ type: 'streamable-http', url }).success).toBe(false);
    });

    it('rejects unknown transport types', () => {
        expect(ServerCardRemoteSchema.safeParse({ type: 'websocket', url: 'https://example.com/mcp' }).success).toBe(false);
    });
});
