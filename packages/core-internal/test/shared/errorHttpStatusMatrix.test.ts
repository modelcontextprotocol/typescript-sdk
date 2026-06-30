/**
 * The error→HTTP status matrix for the modern (2026-07-28) HTTP serving path,
 * pinned at the table level (`LADDER_ERROR_HTTP_STATUS` /
 * `httpStatusForErrorCode`). The mapping is keyed on ORIGIN, not on the bare
 * code:
 *
 *  - errors produced by the validation ladder or a pre-handler protocol gate
 *    map through the table (`-32601` → 404; the small mandated 400 set);
 *  - everything a request handler produces — including `-32603`, `-32602` and
 *    domain-specific codes — stays in-band on HTTP 200, never a blanket 500;
 *  - EXCEPT `-32021` (MissingRequiredClientCapability): the spec mandates its
 *    400 per-error with no origin condition, and the `input_required`
 *    capability gate genuinely emits it after dispatch — so it alone is
 *    status-mapped wherever it arises. A handler relaying a downstream peer's
 *    `-32020`/`-32022` is not that peer's spec error and stays in-band;
 *  - `-32602` deliberately has no table entry: the classifier's envelope rung
 *    carries its own HTTP 400 and is the only invalid-params rejection that
 *    maps to 400.
 *
 * The header/body mismatch family is pinned to `-32020` (HeaderMismatch) and
 * the missing-envelope cells to `-32602`, the assignments asserted by the
 * published conformance suite.
 *
 * Transport- and dispatch-level behavior for these cells is covered by the
 * ladder cell sheet and the per-request transport suites; this file pins the
 * table itself.
 */
import { describe, expect, test } from 'vitest';

import { HEADER_MISMATCH_ERROR_CODE, httpStatusForErrorCode, LADDER_ERROR_HTTP_STATUS } from '../../src/shared/inboundClassification';
import { ProtocolErrorCode } from '../../src/types/enums';

describe('the status matrix — pinned cells', () => {
    const PINNED_LADDER_CELLS: ReadonlyArray<{ code: number; status: number; cell: string }> = [
        {
            code: ProtocolErrorCode.MethodNotFound,
            status: 404,
            cell: 'unknown or era-removed method (including a post-dispatch registry miss)'
        },
        { code: ProtocolErrorCode.UnsupportedProtocolVersion, status: 400, cell: 'unsupported protocol version' },
        { code: ProtocolErrorCode.MissingRequiredClientCapability, status: 400, cell: 'missing required client capability' },
        { code: -32_020, status: 400, cell: 'header mismatch family (when emitted by the ladder)' },
        { code: ProtocolErrorCode.ParseError, status: 400, cell: 'unparseable request body' },
        { code: ProtocolErrorCode.InvalidRequest, status: 400, cell: 'malformed JSON-RPC body / rejected batch' }
    ];

    test.each(PINNED_LADDER_CELLS.map(row => [row.cell, row]))('%s', (_cell, row) => {
        expect(LADDER_ERROR_HTTP_STATUS[row.code]).toBe(row.status);
        expect(httpStatusForErrorCode(row.code, 'ladder')).toBe(row.status);
    });

    test('every code except -32021 stays in-band on HTTP 200 when handler-originated — including internal errors and domain codes', () => {
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

    test('-32021 is the single code-keyed exception: its spec-mandated 400 applies wherever it arises', () => {
        expect(httpStatusForErrorCode(ProtocolErrorCode.MissingRequiredClientCapability, 'in-band')).toBe(400);
        expect(httpStatusForErrorCode(ProtocolErrorCode.MissingRequiredClientCapability, 'ladder')).toBe(400);
        // The relay contract for the OTHER two spec-defined HTTP errors is
        // origin-keyed: a handler-relayed -32020/-32022 is not this server's
        // spec error and stays in-band.
        expect(httpStatusForErrorCode(HEADER_MISMATCH_ERROR_CODE, 'in-band')).toBe(200);
        expect(httpStatusForErrorCode(ProtocolErrorCode.UnsupportedProtocolVersion, 'in-band')).toBe(200);
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
        ).toEqual([-32_700, -32_601, -32_600, -32_022, -32_021, -32_020].sort((a, b) => a - b));
    });
});

describe('the status matrix — header/body mismatch family', () => {
    test('the header/body mismatch family is pinned to -32020 (HeaderMismatch) and maps to HTTP 400', () => {
        expect(HEADER_MISMATCH_ERROR_CODE).toBe(-32_020);
        expect(LADDER_ERROR_HTTP_STATUS[HEADER_MISMATCH_ERROR_CODE]).toBe(400);
        expect(httpStatusForErrorCode(HEADER_MISMATCH_ERROR_CODE, 'ladder')).toBe(400);
    });
});
