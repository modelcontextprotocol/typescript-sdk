import type { Response } from 'express';
import { vi } from 'vitest';

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
            return res as Response;
        }),
        json: vi.fn<Response['json']>().mockImplementation((_body: unknown) => {
            return res as Response;
        }),
        send: vi.fn<Response['send']>().mockImplementation((_body?: unknown) => {
            return res as Response;
        }),
        set: vi.fn<Response['set']>().mockImplementation((_field: string, _value?: string | string[]) => {
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
