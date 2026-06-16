/**
 * Per-message era predicate for long-lived dual-era channels
 * (`classifyInboundMessage`) — the body-primary rule (Q2) in its stdio form,
 * with the T11 sharpening: classification keys on the SPECIFIC reserved
 * envelope key (`io.modelcontextprotocol/protocolVersion`), never on bare
 * `_meta` presence.
 */
import { describe, expect, it } from 'vitest';

import { classifyInboundMessage } from '../../src/shared/inboundClassification.js';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    LOG_LEVEL_META_KEY,
    PROTOCOL_VERSION_META_KEY
} from '../../src/types/index.js';

const MODERN = '2026-07-28';

const fullEnvelope = (version: string) => ({
    [PROTOCOL_VERSION_META_KEY]: version,
    [CLIENT_INFO_META_KEY]: { name: 'fixture-client', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
});

describe('classifyInboundMessage (per-message body-primary predicate)', () => {
    it('classifies `initialize` as legacy and carries the requested version as the revision', () => {
        const classification = classifyInboundMessage({
            method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } }
        });
        expect(classification).toEqual({ era: 'legacy', revision: '2025-06-18' });
    });

    it('classifies `initialize` without a parsable protocolVersion as legacy with no revision', () => {
        expect(classifyInboundMessage({ method: 'initialize', params: {} })).toEqual({ era: 'legacy' });
        expect(classifyInboundMessage({ method: 'initialize' })).toEqual({ era: 'legacy' });
    });

    it('classifies `initialize` REQUESTING a modern revision as a bare legacy classification (initialize never negotiates a modern era)', () => {
        const classification = classifyInboundMessage({
            method: 'initialize',
            params: { protocolVersion: MODERN, capabilities: {}, clientInfo: { name: 'c', version: '1' } }
        });
        expect(classification).toEqual({ era: 'legacy' });
    });

    it('classifies a message carrying the reserved protocol-version envelope key as modern with the claimed revision', () => {
        const classification = classifyInboundMessage({
            method: 'tools/list',
            params: { _meta: fullEnvelope(MODERN) }
        });
        expect(classification).toEqual({ era: 'modern', revision: MODERN });
    });

    it('classifies an envelope claim naming a 2025-era revision as legacy with that revision', () => {
        const classification = classifyInboundMessage({
            method: 'tools/list',
            params: { _meta: { [PROTOCOL_VERSION_META_KEY]: '2025-06-18' } }
        });
        expect(classification).toEqual({ era: 'legacy', revision: '2025-06-18' });
    });

    it('classifies a claim with a non-string protocol-version value as a modern claim (validated at dispatch, never silently legacy)', () => {
        const classification = classifyInboundMessage({
            method: 'tools/list',
            params: { _meta: { [PROTOCOL_VERSION_META_KEY]: 42 } }
        });
        expect(classification).toEqual({ era: 'modern' });
    });

    it('T11: a legacy client carrying only `progressToken` in `_meta` classifies legacy — never bare `_meta` presence', () => {
        const classification = classifyInboundMessage({
            method: 'tools/call',
            params: { name: 'echo', arguments: {}, _meta: { progressToken: 7 } }
        });
        expect(classification).toEqual({ era: 'legacy' });
    });

    it('T11: other reserved envelope keys without the protocol-version key do NOT constitute a claim', () => {
        const classification = classifyInboundMessage({
            method: 'tools/call',
            params: {
                name: 'echo',
                arguments: {},
                _meta: {
                    [CLIENT_INFO_META_KEY]: { name: 'c', version: '1' },
                    [CLIENT_CAPABILITIES_META_KEY]: {},
                    [LOG_LEVEL_META_KEY]: 'info'
                }
            }
        });
        expect(classification).toEqual({ era: 'legacy' });
    });

    it('classifies a claim-less request as legacy', () => {
        expect(classifyInboundMessage({ method: 'tools/list', params: {} })).toEqual({ era: 'legacy' });
        expect(classifyInboundMessage({ method: 'ping' })).toEqual({ era: 'legacy' });
    });

    it('classifies notifications by the same body-primary rule', () => {
        expect(classifyInboundMessage({ method: 'notifications/cancelled', params: { requestId: 1 } })).toEqual({ era: 'legacy' });
        expect(
            classifyInboundMessage({ method: 'notifications/cancelled', params: { requestId: 1, _meta: fullEnvelope(MODERN) } })
        ).toEqual({ era: 'modern', revision: MODERN });
    });
});
