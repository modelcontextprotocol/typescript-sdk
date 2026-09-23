import { describe, expect, it } from 'vitest';

import { AICatalogEntrySchema, AICatalogSchema, SERVER_CARD_MEDIA_TYPE } from '../../src/experimental/serverCard';

const urlEntry = {
    identifier: 'urn:air:example.com:mcp:weather',
    type: SERVER_CARD_MEDIA_TYPE,
    url: 'https://example.com/mcp/server-card'
};

describe('AICatalogEntrySchema', () => {
    it('accepts a url entry and a data entry', () => {
        expect(AICatalogEntrySchema.safeParse(urlEntry).success).toBe(true);
        expect(AICatalogEntrySchema.safeParse({ ...urlEntry, url: undefined, data: { any: 'card' } }).success).toBe(true);
    });

    it('rejects an entry with both url and data', () => {
        expect(AICatalogEntrySchema.safeParse({ ...urlEntry, data: {} }).success).toBe(false);
    });

    it('rejects an entry with neither url nor data', () => {
        expect(AICatalogEntrySchema.safeParse({ identifier: urlEntry.identifier, type: urlEntry.type }).success).toBe(false);
    });

    it('requires identifier and type', () => {
        expect(AICatalogEntrySchema.safeParse({ type: urlEntry.type, url: urlEntry.url }).success).toBe(false);
        expect(AICatalogEntrySchema.safeParse({ identifier: urlEntry.identifier, url: urlEntry.url }).success).toBe(false);
    });
});

describe('AICatalogSchema', () => {
    it('accepts a catalog with empty entries', () => {
        expect(AICatalogSchema.safeParse({ specVersion: '1.0', entries: [] }).success).toBe(true);
    });

    it('requires specVersion and entries', () => {
        expect(AICatalogSchema.safeParse({ entries: [] }).success).toBe(false);
        expect(AICatalogSchema.safeParse({ specVersion: '1.0' }).success).toBe(false);
    });

    it('keeps loose extra fields on catalog, host, and entries', () => {
        const catalog = AICatalogSchema.parse({
            specVersion: '1.0',
            entries: [{ ...urlEntry, trustManifest: { identity: 'https://example.com' }, extra: true }],
            host: { displayName: 'Example', futureField: 'kept' },
            metadata: { 'com.example/region': 'eu' }
        });
        expect(catalog.entries[0]!['extra']).toBe(true);
        expect(catalog.entries[0]!.trustManifest).toEqual({ identity: 'https://example.com' });
        expect(catalog.host!['futureField']).toBe('kept');
    });
});
