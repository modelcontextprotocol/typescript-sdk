// @ts-check

import baseConfig from '@modelcontextprotocol/eslint-config';

export default [
    ...baseConfig,
    {
        // Wire-layer isolation, outbound direction: nothing outside src/wire/ may
        // reach into a wire revision module. The wire layer's only public surface
        // is src/wire/codec.ts (the WireCodec interface) and src/wire/bootstrap.ts.
        // Type-only imports are exempted — the sole intended user of that exemption
        // is types/types.ts re-exporting the deprecated Task* vocabulary as types
        // (Q1-SD2); test/wire/layeringInvariants.test.ts pins it to that one site.
        files: ['src/**/*.ts'],
        ignores: ['src/wire/**'],
        rules: {
            '@typescript-eslint/no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            group: ['**/wire/rev*', '**/wire/rev*/**', '@modelcontextprotocol/core/wire/rev*'],
                            allowTypeImports: true,
                            message:
                                'Wire revision modules are codec-private. Route through src/wire/codec.ts (WireCodec) instead. ' +
                                'The only permitted crossing is the type-only Task* re-export in types/types.ts (Q1-SD2).'
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
