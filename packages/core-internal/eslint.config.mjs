// @ts-check

import baseConfig from '@modelcontextprotocol/eslint-config';

export default [
    ...baseConfig,
    {
        // Wire-layer isolation, outbound direction: nothing outside src/wire/ may
        // reach into a wire revision module. The wire layer's only public surface
        // is src/wire/codec.ts (the WireCodec interface), src/wire/bootstrap.ts,
        // and the leaf result-family module src/wire/resultFamilies.ts (the shared
        // tools/call-result ruling, re-exported on the barrel).
        // test/wire/layeringInvariants.test.ts re-derives the same invariant with
        // zero exceptions. Type-only imports are exempted at the lint layer (a
        // type-only crossing is erased at runtime), but the test allows none.
        files: ['src/**/*.ts'],
        ignores: ['src/wire/**'],
        rules: {
            '@typescript-eslint/no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            group: ['**/wire/rev*', '**/wire/rev*/**', '@modelcontextprotocol/core-internal/wire/rev*'],
                            allowTypeImports: true,
                            message: 'Wire revision modules are codec-private. Route through src/wire/codec.ts (WireCodec) instead.'
                        }
                    ]
                }
            ]
        }
    },
    {
        // Wire-layer isolation, inbound direction: wire revision modules are frozen,
        // self-contained schema sets — they must not import the public-layer schema
        // module at runtime. A change to types/schemas.ts must never alter what a
        // codec emits or accepts on the wire. Type-only imports stay permitted.
        files: ['src/wire/rev*/**/*.ts'],
        rules: {
            '@typescript-eslint/no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            group: ['**/types/schemas', '**/types/schemas.js'],
                            allowTypeImports: true,
                            message:
                                'Wire revision modules must be self-contained. Freeze a copy of the schema into the ' +
                                'rev*/ directory instead of importing the mutable public-layer types/schemas.ts.'
                        }
                    ]
                }
            ]
        }
    }
];
