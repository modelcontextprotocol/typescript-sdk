import type { FetchLike } from '@modelcontextprotocol/core-internal';

export interface RecordedRequest {
    url: string;
    init?: RequestInit;
}

/**
 * A FetchLike backed by a URL-to-response map, recording every call so tests
 * can assert on headers, credentials, and hop order.
 */
export function mockFetch(routes: Record<string, (request: RecordedRequest) => Response>): FetchLike & { calls: RecordedRequest[] } {
    const calls: RecordedRequest[] = [];
    const fetchLike = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
        const call = { url: url.toString(), init };
        calls.push(call);
        const route = routes[call.url];
        if (route === undefined) {
            return new Response('not found', { status: 404 });
        }
        return route(call);
    }) as FetchLike & { calls: RecordedRequest[] };
    fetchLike.calls = calls;
    return fetchLike;
}

export function jsonResponse(body: unknown, init?: { status?: number; contentType?: string; headers?: Record<string, string> }): Response {
    return new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'Content-Type': init?.contentType ?? 'application/json', ...init?.headers }
    });
}
