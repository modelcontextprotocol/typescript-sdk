/**
 * Behavior-surface pins: the stdio environment-inheritance safelist.
 *
 * getDefaultEnvironment() decides which parent environment variables every
 * spawned stdio server inherits. Widening the safelist leaks more of the
 * parent environment into child processes, so both the list itself and the
 * filtering behavior are pinned. A failing pin here means the change is
 * deliberate: update the pin in the same change, together with a changeset
 * and a migration-doc entry.
 *
 * See docs/behavior-surface-pins.md for the maintenance protocol.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

import { DEFAULT_INHERITED_ENV_VARS, getDefaultEnvironment } from '../../src/client/stdio';

// Frozen copy of the documented safelist. The expectation side is a literal,
// not derived from src, so any edit to DEFAULT_INHERITED_ENV_VARS goes red
// here regardless of which variables happen to be set in the runner's
// environment. (The behavioral test below cannot catch a widened safelist on
// its own: getDefaultEnvironment skips unset keys, and sensitive variables
// are exactly the ones typically unset in CI.)
const SAFELIST =
    process.platform === 'win32'
        ? [
              'APPDATA',
              'HOMEDRIVE',
              'HOMEPATH',
              'LOCALAPPDATA',
              'PATH',
              'PROCESSOR_ARCHITECTURE',
              'SYSTEMDRIVE',
              'SYSTEMROOT',
              'TEMP',
              'USERNAME',
              'USERPROFILE',
              'PROGRAMFILES'
          ]
        : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];

describe('stdio environment safelist', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    test('DEFAULT_INHERITED_ENV_VARS matches the frozen safelist exactly', () => {
        expect([...DEFAULT_INHERITED_ENV_VARS].sort()).toEqual([...SAFELIST].sort());
    });

    test('getDefaultEnvironment inherits exactly the safelist keys that are set', () => {
        for (const key of SAFELIST) {
            vi.stubEnv(key, `safe-${key}`);
        }
        vi.stubEnv('STDIO_PIN_SECRET', 'must-not-be-inherited');

        const env = getDefaultEnvironment();

        expect(Object.keys(env).sort()).toEqual([...SAFELIST].sort());
        for (const key of SAFELIST) {
            expect(env[key]).toBe(`safe-${key}`);
        }
    });

    test('skips values that look like exported shell functions', () => {
        vi.stubEnv('PATH', '() { echo pwned; }');
        const env = getDefaultEnvironment();
        expect(env.PATH).toBeUndefined();
    });
});
