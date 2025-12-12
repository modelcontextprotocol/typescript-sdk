import { webcrypto } from 'node:crypto';

// Polyfill globalThis.crypto for environments (e.g. Node 18) where it is not defined.
// This is necessary for the tests to run in Node 18, specifically for the jose library, which relies on the globalThis.crypto object.
if (typeof globalThis.crypto === 'undefined') {
    globalThis.crypto = webcrypto;
}
