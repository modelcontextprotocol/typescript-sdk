/**
 * Behavior-surface pins: error codes, error classes, and version constants.
 *
 * Consumers match SDK errors by literal numeric code, `error.name`, and message
 * text — not only by enum member or `instanceof` (brand-matched `instanceof`
 * needs both bundled copies at a brand-aware release; the literal values are
 * the version-agnostic contract). These tests pin the literal values so that a renumber,
 * rename, or membership change turns CI red instead of landing silently. A
 * failing pin here means the change is deliberate: update the pin in the same
 * change, together with a changeset and a migration-doc entry.
 *
 * See docs/behavior-surface-pins.md for the maintenance protocol.
 */
import { describe, expect, test } from 'vitest';

import { SdkError, SdkErrorCode, SdkHttpError } from '../../src/errors/sdkErrors';
import {
    DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
    INTERNAL_ERROR,
    INVALID_PARAMS,
    INVALID_REQUEST,
    JSONRPC_VERSION,
    LATEST_PROTOCOL_VERSION,
    METHOD_NOT_FOUND,
    PARSE_ERROR,
    ProtocolError,
    ProtocolErrorCode,
    SUPPORTED_PROTOCOL_VERSIONS,
    ResourceNotFoundError,
    UnsupportedProtocolVersionError,
    UrlElicitationRequiredError
} from '../../src/types/index';
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from '../../src/shared/stdio';

describe('ProtocolErrorCode', () => {
    test('numeric values are frozen wire ABI', () => {
        // Consumers map wire error codes by numeric value (value-to-label tables,
        // duck-typed {code} checks across package boundaries), so the literal values
        // are public ABI. Exact-equality on the whole table also locks membership in
        // both directions: adding or removing a member is a deliberate act.
        const members = Object.fromEntries(Object.entries(ProtocolErrorCode).filter(([key]) => Number.isNaN(Number(key))));
        expect(members).toEqual({
            ParseError: -32700,
            InvalidRequest: -32600,
            MethodNotFound: -32601,
            InvalidParams: -32602,
            InternalError: -32603,
            ResourceNotFound: -32002,
            MissingRequiredClientCapability: -32021,
            UnsupportedProtocolVersion: -32022,
            UrlElicitationRequired: -32042
        });
    });

    test('bare JSON-RPC constant values are frozen', () => {
        expect(PARSE_ERROR).toBe(-32700);
        expect(INVALID_REQUEST).toBe(-32600);
        expect(METHOD_NOT_FOUND).toBe(-32601);
        expect(INVALID_PARAMS).toBe(-32602);
        expect(INTERNAL_ERROR).toBe(-32603);
        expect(JSONRPC_VERSION).toBe('2.0');
    });
});

describe('SdkErrorCode', () => {
    test('string values are frozen ABI', () => {
        // SDK errors are local (never serialized to the wire) but consumers still
        // branch on the literal string codes, so the values and the membership of
        // the enum are pinned in both directions.
        expect({ ...SdkErrorCode }).toEqual({
            NotConnected: 'NOT_CONNECTED',
            AlreadyConnected: 'ALREADY_CONNECTED',
            NotInitialized: 'NOT_INITIALIZED',
            CapabilityNotSupported: 'CAPABILITY_NOT_SUPPORTED',
            RequestTimeout: 'REQUEST_TIMEOUT',
            ConnectionClosed: 'CONNECTION_CLOSED',
            SendFailed: 'SEND_FAILED',
            InvalidResult: 'INVALID_RESULT',
            UnsupportedResultType: 'UNSUPPORTED_RESULT_TYPE',
            InputRequiredRoundsExceeded: 'INPUT_REQUIRED_ROUNDS_EXCEEDED',
            ListPaginationExceeded: 'LIST_PAGINATION_EXCEEDED',
            MethodNotSupportedByProtocolVersion: 'METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION',
            EraNegotiationFailed: 'ERA_NEGOTIATION_FAILED',
            ClientHttpNotImplemented: 'CLIENT_HTTP_NOT_IMPLEMENTED',
            ClientHttpAuthentication: 'CLIENT_HTTP_AUTHENTICATION',
            ClientHttpForbidden: 'CLIENT_HTTP_FORBIDDEN',
            ClientHttpUnexpectedContent: 'CLIENT_HTTP_UNEXPECTED_CONTENT',
            ClientHttpFailedToOpenStream: 'CLIENT_HTTP_FAILED_TO_OPEN_STREAM',
            ClientHttpFailedToTerminateSession: 'CLIENT_HTTP_FAILED_TO_TERMINATE_SESSION'
        });
    });
});

describe('ProtocolError', () => {
    test('sets error.name, carries code/data, and leaves the message verbatim', () => {
        // Consumers classify errors via err.name (`instanceof` brand-matches
        // across bundles only when both copies are brand-aware), and read
        // .code/.data as a duck shape. The constructor must not decorate the message.
        const error = new ProtocolError(ProtocolErrorCode.InvalidParams, 'oops', { extra: 1 });
        expect(error.name).toBe('ProtocolError');
        expect(error.code).toBe(-32602);
        expect(error.data).toEqual({ extra: 1 });
        expect(error.message).toBe('oops');
        expect(error).toBeInstanceOf(Error);
    });

    test('fromError materializes typed errors from code + parsed data, not instanceof', () => {
        // Cross-bundle recognition contract: typed error classes are reconstructed
        // from the wire shape (numeric code + structurally valid data). The inputs
        // here are plain values, exactly what arrives across a package boundary.
        const urlError = ProtocolError.fromError(-32042, 'elicitation required', {
            elicitations: [{ mode: 'url', message: 'visit', url: 'https://example.com', elicitationId: 'e1' }]
        });
        expect(urlError).toBeInstanceOf(UrlElicitationRequiredError);
        expect((urlError as UrlElicitationRequiredError).elicitations).toHaveLength(1);

        const versionError = ProtocolError.fromError(-32022, 'unsupported', { supported: ['2025-11-25'], requested: '1999-01-01' });
        expect(versionError).toBeInstanceOf(UnsupportedProtocolVersionError);
        expect((versionError as UnsupportedProtocolVersionError).supported).toEqual(['2025-11-25']);
        expect((versionError as UnsupportedProtocolVersionError).requested).toBe('1999-01-01');

        // Malformed/missing data falls back to the generic class instead of throwing.
        const generic = ProtocolError.fromError(-32022, 'unsupported', { wrong: 'shape' });
        expect(generic).toBeInstanceOf(ProtocolError);
        expect(generic).not.toBeInstanceOf(UnsupportedProtocolVersionError);
    });

    test('fromError accepts BOTH -32602 and -32002 as resource-not-found by data.uri shape', () => {
        // Cross-bundle data-parse contract: the typed ResourceNotFoundError is
        // recognised by `data.uri` being a string on either the spec-mandated
        // -32602 or the legacy -32002 (the spec's "clients SHOULD also accept
        // -32002" backwards-compatibility clause). The recognition input is the
        // bare wire shape — no instanceof on the inbound value.
        const onSpecCode = ProtocolError.fromError(-32602, 'Resource not found: file:///x', { uri: 'file:///x' });
        expect(onSpecCode).toBeInstanceOf(ResourceNotFoundError);
        expect((onSpecCode as ResourceNotFoundError).uri).toBe('file:///x');
        expect(onSpecCode.code).toBe(-32602);

        const onLegacyCode = ProtocolError.fromError(-32002, 'Resource not found', { uri: 'mem://y' });
        expect(onLegacyCode).toBeInstanceOf(ResourceNotFoundError);
        expect((onLegacyCode as ResourceNotFoundError).uri).toBe('mem://y');

        // -32602 without `data.uri` is an ordinary Invalid Params, not resource-not-found.
        const plainInvalid = ProtocolError.fromError(-32602, 'Invalid params', { something: 'else' });
        expect(plainInvalid).not.toBeInstanceOf(ResourceNotFoundError);
        expect(plainInvalid.code).toBe(-32602);
    });

    test('fromError does NOT reclassify -32602 as ResourceNotFoundError when data carries uri alongside other keys', () => {
        // A server's own Invalid Params with `data.uri` (e.g. a "uri must be
        // https" validation error) is NOT a resource-not-found. The discriminator
        // on -32602 is "exactly { uri } and nothing else".
        const validationError = ProtocolError.fromError(-32602, 'uri must be https', {
            uri: 'http://example/x',
            reason: 'uri must be https'
        });
        expect(validationError).not.toBeInstanceOf(ResourceNotFoundError);
        expect(validationError).toBeInstanceOf(ProtocolError);
        expect(validationError.code).toBe(-32602);
        // -32002 is still recognised on `data.uri` regardless of extra keys —
        // the legacy code is itself the discriminator.
        const legacyWithExtra = ProtocolError.fromError(-32002, 'Resource not found', { uri: 'mem://y', extra: 1 });
        expect(legacyWithExtra).toBeInstanceOf(ResourceNotFoundError);
    });
});

describe('SdkError', () => {
    test('sets error.name and carries the string code', () => {
        const error = new SdkError(SdkErrorCode.RequestTimeout, 'Request timed out', { timeout: 60000 });
        expect(error.name).toBe('SdkError');
        expect(error.code).toBe('REQUEST_TIMEOUT');
        expect(error.data).toEqual({ timeout: 60000 });
        expect(error.message).toBe('Request timed out');
    });

    test('SdkHttpError carries the HTTP status in data', () => {
        const error = new SdkHttpError(SdkErrorCode.ClientHttpFailedToOpenStream, 'Failed to open SSE stream: Not Found', {
            status: 404,
            statusText: 'Not Found'
        });
        expect(error.name).toBe('SdkHttpError');
        expect(error.code).toBe('CLIENT_HTTP_FAILED_TO_OPEN_STREAM');
        expect(error.data).toMatchObject({ status: 404 });
    });
});

describe('protocol version constants', () => {
    test('values and membership are frozen', () => {
        // The supported list is pinned by exact value (not just membership) so a
        // naive LATEST bump that silently drops a previous version goes red here.
        expect(LATEST_PROTOCOL_VERSION).toBe('2025-11-25');
        expect(DEFAULT_NEGOTIATED_PROTOCOL_VERSION).toBe('2025-03-26');
        expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']);
        expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(LATEST_PROTOCOL_VERSION);
        expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(DEFAULT_NEGOTIATED_PROTOCOL_VERSION);
    });
});

describe('stdio framing constants', () => {
    test('the default read-buffer cap is 10 MiB', () => {
        // Public export consumed by custom transport authors; raising or lowering
        // the cap changes which deployed payloads parse, so the value is pinned.
        expect(STDIO_DEFAULT_MAX_BUFFER_SIZE).toBe(10 * 1024 * 1024);
    });
});
