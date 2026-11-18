function serialize(json: unknown): string {
    if (Array.isArray(json)) return `[${json.map(item => serialize(item)).join(',')}]`;
    if (typeof json !== 'object' || json === null) return JSON.stringify(json);
    const members = Object.keys(json)
        .toSorted()
        .map(name => `${JSON.stringify(name)}:${serialize((json as Record<string, unknown>)[name])}`);
    return `{${members.join(',')}}`;
}

/** `JSON.stringify(value)` with object keys sorted by UTF-16 code unit at every depth; `TypeError` when there is no JSON text. */
export function canonicalJson(value: unknown): string {
    const text = JSON.stringify(value) as string | undefined;
    if (text === undefined) throw new TypeError('canonicalJson: the value has no JSON text');
    // Parsing the standard text first applies every JSON.stringify rule (toJSON, dropped members, NaN to null).
    return serialize(JSON.parse(text));
}
