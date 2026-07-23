/**
 * The shared client-capability requirement helpers behind the `-32021`
 * MissingRequiredClientCapability rule (protocol revision 2026-07-28).
 *
 * `missingClientCapabilities` is the single helper shared by the pre-dispatch
 * feature gate at the HTTP entry, the outbound input-request leg of multi
 * round-trip requests, and the legacy-session pre-check; the per-method
 * requirement table feeds the entry gate only.
 */
import { describe, expect, test } from 'vitest';

import {
    missingClientCapabilities,
    REQUIRED_CLIENT_CAPABILITIES_BY_METHOD,
    requiredClientCapabilitiesForInputRequest,
    requiredClientCapabilitiesForRequest
} from '../../src/shared/clientCapabilityRequirements';
import { rev2026RequestMethods } from '../../src/wire/rev2026-07-28/registry';

describe('missingClientCapabilities', () => {
    test('an undeclared capability view (no envelope, empty session state) misses everything required — the structural clean refusal', () => {
        expect(missingClientCapabilities({ sampling: {} }, undefined)).toEqual({ sampling: {} });
        expect(missingClientCapabilities({ sampling: {}, elicitation: {} }, {})).toEqual({ sampling: {}, elicitation: {} });
    });

    test('declared top-level capabilities satisfy top-level requirements', () => {
        expect(missingClientCapabilities({ sampling: {} }, { sampling: {} })).toBeUndefined();
    });

    test('only the missing subset is reported', () => {
        expect(missingClientCapabilities({ sampling: {}, elicitation: {} }, { sampling: {} })).toEqual({ elicitation: {} });
    });

    test('a requirement naming nested members needs each named member declared', () => {
        expect(missingClientCapabilities({ elicitation: { url: {} } }, { elicitation: {} })).toEqual({ elicitation: { url: {} } });
        expect(missingClientCapabilities({ elicitation: { url: {} } }, { elicitation: { url: {} } })).toBeUndefined();
        expect(missingClientCapabilities({ elicitation: { url: {} } }, { elicitation: { form: {}, url: {} } })).toBeUndefined();
    });

    test('an empty requirement object is always satisfied', () => {
        expect(missingClientCapabilities({}, undefined)).toBeUndefined();
    });

    test('a bare elicitation declaration implies form support (the pre-mode meaning), but not other modes', () => {
        // Bare `elicitation: {}` satisfies the form requirement…
        expect(missingClientCapabilities({ elicitation: { form: {} } }, { elicitation: {} })).toBeUndefined();
        // …but an explicit mode declaration removes the implication…
        expect(missingClientCapabilities({ elicitation: { form: {} } }, { elicitation: { url: {} } })).toEqual({
            elicitation: { form: {} }
        });
        // …and the bare declaration never implies URL support.
        expect(missingClientCapabilities({ elicitation: { url: {} } }, { elicitation: {} })).toEqual({ elicitation: { url: {} } });
    });
});

describe('requiredClientCapabilitiesForInputRequest', () => {
    test('elicitation requirements are mode-aware sub-capabilities', () => {
        expect(requiredClientCapabilitiesForInputRequest({ method: 'elicitation/create', params: { mode: 'url' } })).toEqual({
            elicitation: { url: {} }
        });
        expect(requiredClientCapabilitiesForInputRequest({ method: 'elicitation/create', params: { mode: 'form' } })).toEqual({
            elicitation: { form: {} }
        });
        // Mode omitted defaults to form.
        expect(requiredClientCapabilitiesForInputRequest({ method: 'elicitation/create', params: { message: 'Name?' } })).toEqual({
            elicitation: { form: {} }
        });
    });

    test('sampling requires sampling.tools only when tools/toolChoice are present; roots requires roots; other methods are not input requests', () => {
        expect(requiredClientCapabilitiesForInputRequest({ method: 'sampling/createMessage', params: { maxTokens: 5 } })).toEqual({
            sampling: {}
        });
        expect(
            requiredClientCapabilitiesForInputRequest({ method: 'sampling/createMessage', params: { maxTokens: 5, tools: [] } })
        ).toEqual({ sampling: { tools: {} } });
        expect(requiredClientCapabilitiesForInputRequest({ method: 'roots/list' })).toEqual({ roots: {} });
        expect(requiredClientCapabilitiesForInputRequest({ method: 'tools/call' })).toBeUndefined();
    });
});

describe('requiredClientCapabilitiesForRequest', () => {
    test('no method served on the 2026-07-28 registry has a static capability requirement today (the table is empty)', () => {
        // This pin burns when a request method with a structural client-capability
        // requirement is added (for example by the input-request engine or opt-in
        // subscription delivery): add the entry, then update this expectation and
        // cover the new cell.
        expect(Object.keys(REQUIRED_CLIENT_CAPABILITIES_BY_METHOD)).toEqual([]);
        for (const method of rev2026RequestMethods) {
            expect(requiredClientCapabilitiesForRequest(method)).toBeUndefined();
        }
    });

    test('prototype-chain names never resolve to a requirement', () => {
        expect(requiredClientCapabilitiesForRequest('constructor')).toBeUndefined();
        expect(requiredClientCapabilitiesForRequest('hasOwnProperty')).toBeUndefined();
    });
});
