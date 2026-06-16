/**
 * The error→HTTP status matrix for the modern (2026-07-28) HTTP serving path,
 * pinned at the table level (`LADDER_ERROR_HTTP_STATUS` /
 * `httpStatusForErrorCode`). The mapping is keyed on ORIGIN, not on the bare
 * code:
 *
 *  - errors produced by the validation ladder or a pre-handler protocol gate
 *    map through the table (`-32601` → 404; the small mandated 400 set);
 *  - everything a request handler produces — whatever its code, including
 *    `-32603`, `-32602` and domain-specific codes — stays in-band on HTTP 200,
 *    never a blanket 500;
 *  - `-32602` deliberately has no table entry: the classifier's envelope rung
 *    carries its own HTTP 400 and is the only invalid-params rejection that
 *    maps to 400.
 *
 * Cells whose error CODE is still disputed upstream (the header/body mismatch
 * family) stay parameterized: the emitted code is asserted as candidate-set
 * membership, never a pinned literal.
 *
 * Transport- and dispatch-level behavior for these cells is covered by the
 * ladder cell sheet and the per-request transport suites; this file pins the
 * table itself.
 */
import { describe, expect, test } from 'vitest';

import {
    httpStatusForErrorCode,
    LADDER_ERROR_HTTP_STATUS,
    PROVISIONAL_CROSS_CHECK_MISMATCH_CODE
} from '../../src/shared/inboundClassification.js';
import { ProtocolErrorCode } from '../../src/types/enums.js';

describe('the status matrix — pinned cells', () => {
    const PINNED_LADDER_CELLS: ReadonlyArray<{ code: number; status: number; cell: string }> = [
        {
            code: ProtocolErrorCode.MethodNotFound,
            status: 404,
            cell: 'unknown or era-removed method (including a post-dispatch registry miss)'
        },
        { code: ProtocolErrorCode.UnsupportedProtocolVersion, status: 400, cell: 'unsupported protocol version' },
        { code: ProtocolErrorCode.MissingRequiredClientCapability, status: 400, cell: 'missing required client capability' },
        { code: -32_001, status: 400, cell: 'header mismatch family (when emitted by the ladder)' },
        { code: ProtocolErrorCode.ParseError, status: 400, cell: 'unparseable request body' },
        { code: ProtocolErrorCode.InvalidRequest, status: 400, cell: 'malformed JSON-RPC body / rejected batch' }
    ];

    test.each(PINNED_LADDER_CELLS.map(row => [row.cell, row]))('%s', (_cell, row) => {
        expect(LADDER_ERROR_HTTP_STATUS[row.code]).toBe(row.status);
        expect(httpStatusForErrorCode(row.code, 'ladder')).toBe(row.status);
    });

    test('every code stays in-band on HTTP 200 when handler-originated — including internal errors and domain codes', () => {
        const handlerCodes = [
            ProtocolErrorCode.InternalError,
            ProtocolErrorCode.InvalidParams,
            ProtocolErrorCode.MethodNotFound,
            ProtocolErrorCode.ResourceNotFound,
            ProtocolErrorCode.UrlElicitationRequired,
            -32_000,
            -1,
            12_345
        ];
        for (const code of handlerCodes) {
            expect(httpStatusForErrorCode(code, 'in-band')).toBe(200);
        }
    });

    test('-32603 never becomes a blanket 500: handler-originated internal errors are in-band', () => {
        expect(LADDER_ERROR_HTTP_STATUS[ProtocolErrorCode.InternalError]).toBeUndefined();
        expect(httpStatusForErrorCode(ProtocolErrorCode.InternalError, 'in-band')).toBe(200);
    });

    test('-32602 has no table entry: the envelope rung short-circuit is the only invalid-params source of HTTP 400', () => {
        expect(LADDER_ERROR_HTTP_STATUS[ProtocolErrorCode.InvalidParams]).toBeUndefined();
        expect(httpStatusForErrorCode(ProtocolErrorCode.InvalidParams, 'in-band')).toBe(200);
    });

    test('the table is exactly the mandated set (no silent growth)', () => {
        expect(
            Object.keys(LADDER_ERROR_HTTP_STATUS)
                .map(Number)
                .sort((a, b) => a - b)
        ).toEqual([-32_700, -32_601, -32_600, -32_004, -32_003, -32_001].sort((a, b) => a - b));
    });
});

describe('the status matrix — parameterized (disputed) cells', () => {
    test('the header/body mismatch family code is a candidate, not a pin, and maps to 400 whichever candidate it is', () => {
        const candidates = [-32_001, ProtocolErrorCode.InvalidParams, ProtocolErrorCode.UnsupportedProtocolVersion];
        expect(candidates).toContain(PROVISIONAL_CROSS_CHECK_MISMATCH_CODE);
        // Whatever the upstream resolution turns out to be, a ladder-originated
        // rejection in this family answers HTTP 400: every candidate either has
        // a 400 row or is carried by the classifier's own httpStatus.
        if (PROVISIONAL_CROSS_CHECK_MISMATCH_CODE !== ProtocolErrorCode.InvalidParams) {
            expect(httpStatusForErrorCode(PROVISIONAL_CROSS_CHECK_MISMATCH_CODE, 'ladder')).toBe(400);
        }
    });
});
