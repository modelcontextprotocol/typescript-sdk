import { describe, expect, it } from 'vitest';

import { ClientResponseCache, InMemoryResponseCacheStore } from '../../src/client/responseCache';

describe('SEP-2792 response cache variants', () => {
    it('keys cache entries by the exact request preference, not the selected language', async () => {
        const store = new InMemoryResponseCacheStore();
        const cache = new ClientResponseCache(
            store,
            false,
            () => {},
            '',
            () => 1_000
        );
        cache.setServerIdentity('server@1');

        const canadian = 'fr-CA, fr;q=0.9';
        const french = 'fr;q=1.0';
        const canadianGeneration = cache.captureGeneration('tools/list', undefined, canadian);
        const frenchGeneration = cache.captureGeneration('tools/list', undefined, french);

        await cache.write('tools/list', { tools: [{ name: 'quiz', title: 'Québec' }] }, canadianGeneration, {
            expiresAt: 2_000,
            scope: 'public',
            variant: canadian
        });
        await cache.write('tools/list', { tools: [{ name: 'quiz', title: 'France' }] }, frenchGeneration, {
            expiresAt: 2_000,
            scope: 'public',
            variant: french
        });

        await expect(cache.read('tools/list', undefined, canadian)).resolves.toEqual({
            value: { tools: [{ name: 'quiz', title: 'Québec' }] }
        });
        await expect(cache.read('tools/list', undefined, french)).resolves.toEqual({
            value: { tools: [{ name: 'quiz', title: 'France' }] }
        });
        await expect(cache.read('tools/list')).resolves.toBeUndefined();
    });

    it('invalidates every persisted language variant for a logical key', async () => {
        const store = new InMemoryResponseCacheStore();
        const cache = new ClientResponseCache(
            store,
            false,
            () => {},
            '',
            () => 1_000
        );
        cache.setServerIdentity('server@1');

        for (const variant of ['en', 'fr', 'de']) {
            const generation = cache.captureGeneration('resources/read', 'file:///quiz', variant);
            await cache.write('resources/read', { contents: [{ uri: 'file:///quiz', text: variant }] }, generation, {
                expiresAt: 2_000,
                scope: 'private',
                params: 'file:///quiz',
                variant
            });
        }

        await cache.evictKey('resources/read', 'file:///quiz');
        await expect(cache.read('resources/read', 'file:///quiz', 'en')).resolves.toBeUndefined();
        await expect(cache.read('resources/read', 'file:///quiz', 'fr')).resolves.toBeUndefined();
        await expect(cache.read('resources/read', 'file:///quiz', 'de')).resolves.toBeUndefined();
    });
});
