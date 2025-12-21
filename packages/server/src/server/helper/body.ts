export async function getParsedBody(req: Request): Promise<unknown> {
    const ct = req.headers.get('content-type') ?? '';

    if (ct.includes('application/json')) {
        return await req.json();
    }

    if (ct.includes('application/x-www-form-urlencoded')) {
        const text = await req.text();
        return objectFromUrlEncoded(text);
    }

    // Empty bodies are treated as empty objects.
    const text = await req.text();
    if (!text) return {};

    // If content-type is missing/unknown, fall back to treating it as urlencoded-like.
    return objectFromUrlEncoded(text);
}

export function objectFromUrlEncoded(body: string): Record<string, string> {
    const params = new URLSearchParams(body);
    const out: Record<string, string> = {};
    for (const [k, v] of params.entries()) out[k] = v;
    return out;
}
