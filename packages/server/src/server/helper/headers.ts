import type { IncomingHttpHeaders } from 'node:http';

/**
 * Converts a Node.js IncomingHttpHeaders object to a Web Headers object.
 * @param h - The Node.js IncomingHttpHeaders object.
 * @returns The Web Headers object.
 */
export function nodeHeadersToWebHeaders(h: IncomingHttpHeaders): Headers {
    const out = new Headers();

    for (const [name, value] of Object.entries(h)) {
        if (value === undefined) continue;

        // Node may surface set-cookie as string[]
        if (name.toLowerCase() === 'set-cookie') {
            if (Array.isArray(value)) {
                for (const v of value) out.append('set-cookie', v);
            } else {
                out.append('set-cookie', value);
            }
            continue;
        }

        if (Array.isArray(value)) {
            // Most headers can be joined; append preserves multiple values too.
            for (const v of value) out.append(name, v);
        } else {
            out.set(name, value);
        }
    }

    return out;
}
