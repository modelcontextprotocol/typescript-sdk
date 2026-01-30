export type HostHeaderValidationResult =
    | { ok: true; hostname: string }
    | {
          ok: false;
          errorCode: 'missing_host' | 'invalid_host_header' | 'invalid_host';
          message: string;
          hostHeader?: string;
          hostname?: string;
      };

/**
 * Parse and validate a Host header against an allowlist of hostnames (port-agnostic).
 *
 * - Input host header may include a port (e.g. `localhost:3000`) or IPv6 brackets (e.g. `[::1]:3000`).
 * - Allowlist items should be hostnames only (no ports). For IPv6, include brackets (e.g. `[::1]`).
 */
export function validateHostHeader(hostHeader: string | null | undefined, allowedHostnames: string[]): HostHeaderValidationResult {
    if (!hostHeader) {
        return { ok: false, errorCode: 'missing_host', message: 'Missing Host header' };
    }

    // Use URL API to parse hostname (handles IPv4, IPv6, and regular hostnames)
    let hostname: string;
    try {
        hostname = new URL(`http://${hostHeader}`).hostname;
    } catch {
        return { ok: false, errorCode: 'invalid_host_header', message: `Invalid Host header: ${hostHeader}`, hostHeader };
    }

    if (!allowedHostnames.includes(hostname)) {
        return { ok: false, errorCode: 'invalid_host', message: `Invalid Host: ${hostname}`, hostHeader, hostname };
    }

    return { ok: true, hostname };
}

/**
 * Convenience allowlist for localhost DNS rebinding protection.
 */
export function localhostAllowedHostnames(): string[] {
    return ['localhost', '127.0.0.1', '[::1]'];
}

/**
 * Web-standard Request helper for DNS rebinding protection.
 * @example
 * const result = validateHostHeader(req.headers.get('host'), ['localhost'])
 */
export function hostHeaderValidationResponse(req: Request, allowedHostnames: string[]): Response | undefined {
    const result = validateHostHeader(req.headers.get('host'), allowedHostnames);
    if (result.ok) return undefined;

    return Response.json(
        {
            jsonrpc: '2.0',
            error: {
                code: -32_000,
                message: result.message
            },
            id: null
        },
        {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
        }
    );
}
