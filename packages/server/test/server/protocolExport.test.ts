/**
 * Pins that `Protocol` and `mergeCapabilities` are exported from the package
 * root (carried by the `export *` of the core-internal public barrel).
 */
import { describe, expect, test } from 'vitest';

import { mergeCapabilities, Protocol } from '../../src/index';

describe('package root exports', () => {
    test('Protocol and mergeCapabilities are exported from the server root', () => {
        expect(typeof Protocol).toBe('function');
        expect(typeof mergeCapabilities).toBe('function');
    });
});
