import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/core-internal';
import { compareUris, decodeBase64, decodeUtf8Lossless, encodeBase64, encodeUtf8 } from '@modelcontextprotocol/core-internal/ext/skills';

const CURSOR_PREFIX = 'after:';

// An opaque, URL-safe cursor meaning "after this URI".
export function encodeCursor(uri: string): string {
    return encodeBase64(encodeUtf8(CURSOR_PREFIX + uri))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '');
}

// The URI a cursor points after, or `undefined` when it is not one of ours.
export function decodeCursor(cursor: string): string | undefined {
    try {
        const base64 = cursor.replaceAll('-', '+').replaceAll('_', '/');
        const decoded = decodeUtf8Lossless(decodeBase64(base64 + '='.repeat((4 - (base64.length % 4)) % 4)));
        return decoded?.startsWith(CURSOR_PREFIX) ? decoded.slice(CURSOR_PREFIX.length) : undefined;
    } catch {
        return undefined;
    }
}

// One page of URI-sorted `items` after `cursor`; entries added or removed elsewhere never shift the boundary.
export function paginate<T>(
    items: readonly T[],
    cursor: string | undefined,
    pageSize: number,
    key: (item: T) => string
): { items: T[]; nextCursor?: string } {
    let start = 0;
    if (cursor !== undefined) {
        const after = decodeCursor(cursor);
        if (after === undefined) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid cursor');
        start = items.findIndex(item => compareUris(key(item), after) > 0);
        if (start === -1) start = items.length;
    }
    const end = Math.min(items.length, start + pageSize);
    const page = items.slice(start, end);
    const last = page.at(-1);
    return end < items.length && last !== undefined ? { items: page, nextCursor: encodeCursor(key(last)) } : { items: page };
}

export function resolvePageSize(pageSize: number | undefined): number {
    if (pageSize === undefined) return 100;
    if (pageSize === Number.POSITIVE_INFINITY || (Number.isSafeInteger(pageSize) && pageSize > 0)) return pageSize;
    throw new RangeError(`pageSize must be a positive integer or Infinity (got ${pageSize})`);
}
