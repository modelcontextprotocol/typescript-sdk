import type http from 'node:http';
import { type Server } from 'node:http';
import type { Response } from 'express';
import { AddressInfo } from 'node:net';
import { vi } from 'vitest';

/**
 * Attach a listener to an existing server on a random localhost port and return its base URL.
 */
export async function listenOnRandomPort(server: Server, host: string = '127.0.0.1'): Promise<URL> {
    return new Promise<URL>(resolve => {
        server.listen(0, host, () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://${host}:${addr.port}`));
        });
    });
}

// =========================
// HTTP/Express mock helpers
// =========================

/**
 * Create a minimal Express-like Response mock for tests.
 *
 * The mock supports:
 * - redirect()
 * - status().json().send() chaining
 * - set()/header()
 * - optional getRedirectUrl() helper used in some tests
 */
export function createExpressResponseMock(options: { trackRedirectUrl?: boolean } = {}): Response & {
    getRedirectUrl?: () => string;
} {
    let capturedRedirectUrl: string | undefined;

    const res: Partial<Response> & { getRedirectUrl?: () => string } = {
        redirect: vi.fn((urlOrStatus: string | number, maybeUrl?: string | number) => {
            if (options.trackRedirectUrl) {
                if (typeof urlOrStatus === 'string') {
                    capturedRedirectUrl = urlOrStatus;
                } else if (typeof maybeUrl === 'string') {
                    capturedRedirectUrl = maybeUrl;
                }
            }
            return res as Response;
        }) as unknown as Response['redirect'],
        status: vi.fn<Response['status']>().mockImplementation((_code: number) => {
            // status code is ignored for now; tests assert it via jest/vitest spies
            return res as Response;
        }),
        json: vi.fn<Response['json']>().mockImplementation((_body: unknown) => {
            // body is ignored; tests usually assert via spy
            return res as Response;
        }),
        send: vi.fn<Response['send']>().mockImplementation((_body?: unknown) => {
            // body is ignored; tests usually assert via spy
            return res as Response;
        }),
        set: vi.fn<Response['set']>().mockImplementation((_field: string, _value?: string | string[]) => {
            // header value is ignored in the generic mock; tests spy on set()
            return res as Response;
        }),
        header: vi.fn<Response['header']>().mockImplementation((_field: string, _value?: string | string[]) => {
            return res as Response;
        })
    };

    if (options.trackRedirectUrl) {
        res.getRedirectUrl = () => {
            if (capturedRedirectUrl === undefined) {
                throw new Error('No redirect URL was captured. Ensure redirect() was called first.');
            }
            return capturedRedirectUrl;
        };
    }

    return res as Response & { getRedirectUrl?: () => string };
}

/**
 * Create a Node http.ServerResponse mock used for low-level transport tests.
 *
 * All core methods are jest/vitest fns returning `this` so that
 * tests can assert on writeHead/write/on/end calls.
 */
export function createNodeServerResponseMock(): http.ServerResponse {
    const res = {
        writeHead: vi.fn<http.ServerResponse['writeHead']>().mockReturnThis(),
        write: vi.fn<http.ServerResponse['write']>().mockReturnThis(),
        on: vi.fn<http.ServerResponse['on']>().mockReturnThis(),
        end: vi.fn<http.ServerResponse['end']>().mockReturnThis()
    };

    return res as unknown as http.ServerResponse;
}
