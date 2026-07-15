/**
 * Pins that the `Protocol` base class and `mergeCapabilities` are exported from
 * the package ROOT — not just from the core-internal public barrel. The root's
 * `export * from '@modelcontextprotocol/core-internal/public'` is what carries
 * them; replacing it with named exports (or adding a colliding explicit export)
 * would silently drop them while the barrel-level pin stays green.
 */
import { describe, expect, test } from 'vitest';

import { mergeCapabilities, Protocol } from '../../src/index';

describe('package root exports', () => {
    test('Protocol and mergeCapabilities are exported from the client root', () => {
        expect(typeof Protocol).toBe('function');
        expect(typeof mergeCapabilities).toBe('function');
    });
});
