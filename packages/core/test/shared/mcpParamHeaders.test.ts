/**
 * SEP-2243 `Mcp-Param-*` codec — fixture corpus.
 *
 * Encoding rows mirror the spec's "Encoding examples" table (and the
 * sentinel-collision rule); the constraint rows mirror the published
 * conformance referee's `http-invalid-tool-headers` scenario; the
 * server-validation rows cover the spec's server-behavior table including the
 * two checks the conformance manifest leaves globally untested
 * (`sep-2243-server-not-expect-null`, `sep-2243-server-reject-missing-required`).
 */
import { describe, expect, test } from 'vitest';

import { HEADER_MISMATCH_ERROR_CODE } from '../../src/shared/inboundClassification.js';
import {
    buildMcpParamHeaders,
    decodeMcpParamValue,
    encodeMcpParamValue,
    MCP_PARAM_HEADER_PREFIX,
    mcpParamPrimitiveToString,
    paramHeaderMismatchRejection,
    scanXMcpHeaderDeclarations,
    validateMcpParamHeaders,
    X_MCP_HEADER_KEY
} from '../../src/shared/mcpParamHeaders.js';

/* ------------------------------------------------------------------------ *
 * Value encoding (spec table)
 * ------------------------------------------------------------------------ */

describe('encodeMcpParamValue / decodeMcpParamValue — spec encoding-examples table', () => {
    const CASES: ReadonlyArray<[label: string, input: string, expected: string]> = [
        ['plain ASCII passes through', 'us-west1', 'us-west1'],
        ['non-ASCII is Base64-wrapped', 'Hello, 世界', '=?base64?SGVsbG8sIOS4lueVjA==?='],
        ['leading + trailing whitespace is Base64-wrapped', ' padded ', '=?base64?IHBhZGRlZCA=?='],
        ['embedded newline is Base64-wrapped', 'line1\nline2', '=?base64?bGluZTEKbGluZTI=?='],
        ['a value matching the sentinel pattern is itself Base64-wrapped', '=?base64?literal?=', '=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?='],
        ['the empty string is Base64-wrapped (would otherwise vanish on the wire)', '', '=?base64??='],
        ['internal-only spaces stay plain ASCII (RFC 9110 admits SP inside a field value)', 'a b c', 'a b c'],
        ['leading-only space is Base64-wrapped', ' lead', `=?base64?${btoa(' lead')}?=`],
        ['trailing-only space is Base64-wrapped', 'trail ', `=?base64?${btoa('trail ')}?=`],
        ['CR/LF is Base64-wrapped', 'a\r\nb', `=?base64?${btoa('a\r\nb')}?=`],
        ['leading tab is Base64-wrapped', '\tindent', `=?base64?${btoa('\tindent')}?=`]
    ];

    for (const [label, input, expected] of CASES) {
        test(label, () => {
            const encoded = encodeMcpParamValue(input);
            expect(encoded).toBe(expected);
            expect(decodeMcpParamValue(encoded)).toBe(input);
        });
    }

    test('decode passes a non-sentinel value through unchanged', () => {
        expect(decodeMcpParamValue('us-west1')).toBe('us-west1');
    });

    test('CRLF header-injection: encode produces a sentinel value with no CR/LF and round-trips intact', () => {
        // Mcp-Param-* and Mcp-Name share this encoder; an attacker-controlled
        // value with CR/LF MUST encode to a header-safe form (RFC 9110 token
        // alphabet for the sentinel framing, RFC 4648 §4 alphabet for the
        // payload — neither contains CR/LF) so it cannot inject a header.
        const injection = 'foo\r\nX-Injected: bar';
        const encoded = encodeMcpParamValue(injection);
        expect(encoded.startsWith('=?base64?')).toBe(true);
        expect(encoded).not.toMatch(/[\r\n]/);
        expect(decodeMcpParamValue(encoded)).toBe(injection);
        // The Mcp-Name encoding path is the same encodeMcpParamValue call
        // (`_applyBodyDerivedHeaders` in the client transport); pin the
        // header-safety property here so a future encoder change cannot
        // regress it silently.
        expect(() => new Headers().set('mcp-name', encoded)).not.toThrow();
    });

    test('decode rejects invalid Base64 padding inside the sentinel', () => {
        expect(decodeMcpParamValue('=?base64?SGVsbG8?=')).toBeUndefined();
    });

    test('decode rejects non-alphabet characters inside the sentinel', () => {
        expect(decodeMcpParamValue('=?base64?SGV%%G8=?=')).toBeUndefined();
    });
});

describe('mcpParamPrimitiveToString — type-conversion rules', () => {
    test('string passes through', () => expect(mcpParamPrimitiveToString('a')).toBe('a'));
    test('boolean true → "true"', () => expect(mcpParamPrimitiveToString(true)).toBe('true'));
    test('boolean false → "false"', () => expect(mcpParamPrimitiveToString(false)).toBe('false'));
    test('integer → decimal string', () => expect(mcpParamPrimitiveToString(42)).toBe('42'));
    test('negative integer → decimal string', () => expect(mcpParamPrimitiveToString(-7)).toBe('-7'));
    test('non-finite is refused', () => expect(mcpParamPrimitiveToString(Number.POSITIVE_INFINITY)).toBeUndefined());
    test('integer outside ±(2^53-1) is refused', () => expect(mcpParamPrimitiveToString(2 ** 53)).toBeUndefined());
    test('object is refused', () => expect(mcpParamPrimitiveToString({})).toBeUndefined());
});

/* ------------------------------------------------------------------------ *
 * Declaration scan (constraint rows from http-invalid-tool-headers)
 * ------------------------------------------------------------------------ */

describe('scanXMcpHeaderDeclarations — constraint table', () => {
    const valid = (schema: unknown) => {
        const r = scanXMcpHeaderDeclarations(schema);
        expect(r.valid).toBe(true);
        return r.valid ? r.declarations : [];
    };
    const invalid = (schema: unknown) => {
        const r = scanXMcpHeaderDeclarations(schema);
        expect(r.valid).toBe(false);
        return r.valid ? '' : r.reason;
    };

    test('a valid declaration is collected', () => {
        const decls = valid({ type: 'object', properties: { region: { type: 'string', [X_MCP_HEADER_KEY]: 'Region' } } });
        expect(decls).toEqual([{ path: ['region'], headerName: 'Region', type: 'string' }]);
    });

    test('declarations at any nesting depth are collected', () => {
        const decls = valid({
            type: 'object',
            properties: {
                outer: { type: 'object', properties: { inner: { type: 'string', [X_MCP_HEADER_KEY]: 'Inner' } } }
            }
        });
        expect(decls).toEqual([{ path: ['outer', 'inner'], headerName: 'Inner', type: 'string' }]);
    });

    test('a schema with no declarations scans valid with an empty list', () => {
        expect(valid({ type: 'object', properties: { a: { type: 'string' } } })).toEqual([]);
    });

    test('empty x-mcp-header value is rejected', () => {
        expect(invalid({ type: 'object', properties: { a: { type: 'string', [X_MCP_HEADER_KEY]: '' } } })).toMatch(/non-empty/);
    });

    test('non-token x-mcp-header value (space) is rejected', () => {
        expect(invalid({ type: 'object', properties: { a: { type: 'string', [X_MCP_HEADER_KEY]: 'My Region' } } })).toMatch(
            /RFC 9110 token/
        );
    });

    test('object-typed property is rejected', () => {
        expect(invalid({ type: 'object', properties: { a: { type: 'object', [X_MCP_HEADER_KEY]: 'Data' } } })).toMatch(/primitive/);
    });

    test('array-typed property is rejected', () => {
        expect(invalid({ type: 'object', properties: { a: { type: 'array', [X_MCP_HEADER_KEY]: 'Items' } } })).toMatch(/primitive/);
    });

    test('null-typed property is rejected', () => {
        expect(invalid({ type: 'object', properties: { a: { type: 'null', [X_MCP_HEADER_KEY]: 'Nil' } } })).toMatch(/primitive/);
    });

    // Static-reachability MUST: an x-mcp-header anywhere outside the
    // properties-only chain invalidates the tool definition.
    const REACHABILITY_CASES: ReadonlyArray<[label: string, schema: unknown]> = [
        ['root schema', { type: 'object', [X_MCP_HEADER_KEY]: 'Root' }],
        ['under items', { type: 'object', properties: { a: { type: 'array', items: { type: 'string', [X_MCP_HEADER_KEY]: 'Elem' } } } }],
        [
            'under additionalProperties',
            { type: 'object', properties: {}, additionalProperties: { type: 'string', [X_MCP_HEADER_KEY]: 'Extra' } }
        ],
        [
            'under oneOf',
            { type: 'object', oneOf: [{ type: 'object', properties: { a: { type: 'string', [X_MCP_HEADER_KEY]: 'Branch' } } }] }
        ],
        ['under anyOf', { type: 'object', anyOf: [{ type: 'string', [X_MCP_HEADER_KEY]: 'Branch' }] }],
        ['under allOf', { type: 'object', allOf: [{ type: 'string', [X_MCP_HEADER_KEY]: 'Branch' }] }],
        ['under not', { type: 'object', not: { type: 'string', [X_MCP_HEADER_KEY]: 'Neg' } }],
        ['under if/then/else', { type: 'object', if: {}, then: { type: 'string', [X_MCP_HEADER_KEY]: 'Cond' } }],
        [
            'under $defs (a $ref-within-$defs target)',
            { type: 'object', properties: { a: { $ref: '#/$defs/R' } }, $defs: { R: { type: 'string', [X_MCP_HEADER_KEY]: 'Ref' } } }
        ],
        [
            "under draft-07 'definitions' (legacy alias of $defs)",
            {
                type: 'object',
                properties: { a: { $ref: '#/definitions/R' } },
                definitions: { R: { type: 'string', [X_MCP_HEADER_KEY]: 'Ref' } }
            }
        ],
        [
            'under dependentSchemas',
            {
                type: 'object',
                dependentSchemas: { foo: { type: 'object', properties: { bar: { type: 'string', [X_MCP_HEADER_KEY]: 'Dep' } } } }
            }
        ],
        ['under unevaluatedProperties', { type: 'object', unevaluatedProperties: { type: 'string', [X_MCP_HEADER_KEY]: 'Unev' } }],
        [
            'under unevaluatedItems',
            { type: 'object', properties: { a: { type: 'array', unevaluatedItems: { type: 'string', [X_MCP_HEADER_KEY]: 'Unev' } } } }
        ],
        ['under propertyNames', { type: 'object', propertyNames: { type: 'string', [X_MCP_HEADER_KEY]: 'PNames' } }],
        [
            'nested: properties → items → properties (the chain passes through items)',
            {
                type: 'object',
                properties: {
                    a: { type: 'array', items: { type: 'object', properties: { b: { type: 'string', [X_MCP_HEADER_KEY]: 'Deep' } } } }
                }
            }
        ]
    ];
    for (const [label, schema] of REACHABILITY_CASES) {
        test(`x-mcp-header on a non-statically-reachable position is rejected: ${label}`, () => {
            expect(invalid(schema)).toMatch(/statically reachable/);
        });
    }

    test('case-insensitively duplicated header name is rejected', () => {
        expect(
            invalid({
                type: 'object',
                properties: {
                    a: { type: 'string', [X_MCP_HEADER_KEY]: 'MyField' },
                    b: { type: 'string', [X_MCP_HEADER_KEY]: 'myfield' }
                }
            })
        ).toMatch(/unique/);
    });
});

/* ------------------------------------------------------------------------ *
 * buildMcpParamHeaders — null/absent omission, primitive emission
 * ------------------------------------------------------------------------ */

describe('buildMcpParamHeaders', () => {
    const DECLS = [
        { path: ['region'], headerName: 'Region', type: 'string' },
        { path: ['priority'], headerName: 'Priority', type: 'integer' },
        { path: ['verbose'], headerName: 'Verbose', type: 'boolean' }
    ] as const;

    test('present primitive values become headers; null and absent are omitted', () => {
        expect(buildMcpParamHeaders(DECLS, { region: 'us-west1', priority: 5, verbose: null })).toEqual({
            'Mcp-Param-Region': 'us-west1',
            'Mcp-Param-Priority': '5'
        });
    });

    test('a non-primitive value is silently omitted (params validation owns that fault)', () => {
        expect(buildMcpParamHeaders([{ path: ['region'], headerName: 'Region', type: 'string' }], { region: { x: 1 } })).toEqual({});
    });
});

/* ------------------------------------------------------------------------ *
 * Server-side validation — the spec's server-behavior table
 * ------------------------------------------------------------------------ */

describe('validateMcpParamHeaders — server-behavior table', () => {
    const DECLS = [{ path: ['region'], headerName: 'Region', type: 'string' }] as const;

    test('header present and matching → ok', () => {
        const headers = new Headers({ [`${MCP_PARAM_HEADER_PREFIX}Region`]: 'us-west1' });
        expect(validateMcpParamHeaders(DECLS, { region: 'us-west1' }, headers)).toBeUndefined();
    });

    test('header decodes from Base64 and matches → ok', () => {
        const headers = new Headers({ [`${MCP_PARAM_HEADER_PREFIX}Region`]: encodeMcpParamValue('Hello, 世界') });
        expect(validateMcpParamHeaders(DECLS, { region: 'Hello, 世界' }, headers)).toBeUndefined();
    });

    // sep-2243-server-not-expect-null — globally-untested manifest check, covered here.
    test('body value null → server MUST NOT expect the header (a stray header is ignored)', () => {
        const headers = new Headers({ [`${MCP_PARAM_HEADER_PREFIX}Region`]: 'whatever' });
        expect(validateMcpParamHeaders(DECLS, { region: null }, headers)).toBeUndefined();
        expect(validateMcpParamHeaders(DECLS, {}, new Headers())).toBeUndefined();
    });

    // sep-2243-server-reject-missing-required — globally-untested manifest check, covered here.
    test('body has the value but the header is absent → reject 400/-32020', () => {
        const r = validateMcpParamHeaders(DECLS, { region: 'us-west1' }, new Headers());
        expect(r).toMatchObject({ kind: 'reject', httpStatus: 400, code: HEADER_MISMATCH_ERROR_CODE, cell: 'param-header-missing' });
    });

    test('header present but disagreeing → reject 400/-32020 with the mismatch in data', () => {
        const r = validateMcpParamHeaders(DECLS, { region: 'us-west1' }, new Headers({ [`${MCP_PARAM_HEADER_PREFIX}Region`]: 'eu' }));
        expect(r).toMatchObject({
            kind: 'reject',
            httpStatus: 400,
            code: HEADER_MISMATCH_ERROR_CODE,
            cell: 'param-header-mismatch',
            data: { mismatch: { header: 'Mcp-Param-Region' } }
        });
    });

    test('invalid Base64 sentinel → reject 400/-32020', () => {
        const r = validateMcpParamHeaders(
            DECLS,
            { region: 'Hello' },
            new Headers({ [`${MCP_PARAM_HEADER_PREFIX}Region`]: '=?base64?SGVsbG8?=' })
        );
        expect(r).toMatchObject({
            kind: 'reject',
            httpStatus: 400,
            code: HEADER_MISMATCH_ERROR_CODE,
            cell: 'param-header-invalid-encoding'
        });
    });

    test('integer-typed declarations are compared numerically (42.0 == 42)', () => {
        const intDecl = [{ path: ['n'], headerName: 'N', type: 'integer' }] as const;
        expect(validateMcpParamHeaders(intDecl, { n: 42 }, new Headers({ [`${MCP_PARAM_HEADER_PREFIX}N`]: '42.0' }))).toBeUndefined();
    });

    test('a non-numeric primitive in a number-declared param falls back to string comparison (no false NaN mismatch)', () => {
        const intDecl = [{ path: ['n'], headerName: 'N', type: 'integer' }] as const;
        // Identical header/body — must NOT report a header/body disagreement;
        // params validation owns the body-vs-schema fault.
        expect(validateMcpParamHeaders(intDecl, { n: 'abc' }, new Headers({ [`${MCP_PARAM_HEADER_PREFIX}N`]: 'abc' }))).toBeUndefined();
        // Different values still reject as a mismatch.
        const r = validateMcpParamHeaders(intDecl, { n: 'abc' }, new Headers({ [`${MCP_PARAM_HEADER_PREFIX}N`]: 'xyz' }));
        expect(r).toMatchObject({ kind: 'reject', cell: 'param-header-mismatch' });
    });
});

describe('paramHeaderMismatchRejection — consumes the inbound-classifier −32020 shape verbatim', () => {
    test('shape: 400 / -32020 / settled, with data.mismatch and the same message prefix', () => {
        const r = paramHeaderMismatchRejection('param-header-mismatch', 'Mcp-Param-Region', 'body says us-west1');
        expect(r).toEqual({
            kind: 'reject',
            rung: 'param-header-validation',
            cell: 'param-header-mismatch',
            httpStatus: 400,
            code: HEADER_MISMATCH_ERROR_CODE,
            message: 'Bad Request: the request headers and body disagree: body says us-west1',
            data: { mismatch: { header: 'Mcp-Param-Region', body: 'body says us-west1' } },
            settled: true
        });
    });
});
