import type { Implementation } from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';

import type { ServerCard, ServerCardRemote } from '../../src/experimental/serverCard/index';
import { reconcileServerCard, SERVER_CARD_SCHEMA_URL } from '../../src/experimental/serverCard/index';

const card: ServerCard = {
    $schema: SERVER_CARD_SCHEMA_URL,
    name: 'com.example/weather',
    version: '1.0.0',
    description: 'Forecasts',
    title: 'Weather',
    websiteUrl: 'https://example.com'
};

const agreeingServerInfo: Implementation = {
    name: 'com.example/weather',
    version: '1.0.0',
    title: 'Weather',
    websiteUrl: 'https://example.com'
};

const remote: ServerCardRemote = {
    type: 'streamable-http',
    url: 'https://example.com/mcp',
    supportedProtocolVersions: ['2025-11-25']
};

describe('reconcileServerCard', () => {
    it('returns [] on full agreement', () => {
        expect(reconcileServerCard(card, agreeingServerInfo)).toEqual([]);
    });

    it('reports each disagreeing field with card and runtime values', () => {
        const mismatches = reconcileServerCard(card, { name: 'other/name', version: '2.0.0', title: 'Other' });
        expect(mismatches).toEqual([
            { field: 'name', cardValue: 'com.example/weather', runtimeValue: 'other/name' },
            { field: 'version', cardValue: '1.0.0', runtimeValue: '2.0.0' },
            { field: 'title', cardValue: 'Weather', runtimeValue: 'Other' },
            { field: 'websiteUrl', cardValue: 'https://example.com', runtimeValue: undefined }
        ]);
    });

    it('compares optional fields only when the card states them', () => {
        const minimal: ServerCard = { $schema: SERVER_CARD_SCHEMA_URL, name: 'com.example/weather', version: '1.0.0', description: 'x' };
        expect(reconcileServerCard(minimal, agreeingServerInfo)).toEqual([]);
    });

    it('reports a protocolVersion mismatch only with a negotiated version and declared support', () => {
        expect(reconcileServerCard(card, agreeingServerInfo, { remote, negotiatedProtocolVersion: '2025-11-25' })).toEqual([]);
        expect(reconcileServerCard(card, agreeingServerInfo, { remote, negotiatedProtocolVersion: '2024-11-05' })).toEqual([
            { field: 'protocolVersion', cardValue: '2025-11-25', runtimeValue: '2024-11-05' }
        ]);
        expect(reconcileServerCard(card, agreeingServerInfo, { negotiatedProtocolVersion: '2024-11-05' })).toEqual([]);
        expect(
            reconcileServerCard(card, agreeingServerInfo, {
                remote: { type: 'streamable-http', url: 'https://example.com/mcp' },
                negotiatedProtocolVersion: '2024-11-05'
            })
        ).toEqual([]);
    });

    it('never throws', () => {
        expect(() => reconcileServerCard(card, { name: '', version: '' })).not.toThrow();
    });
});
