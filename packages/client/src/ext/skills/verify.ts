const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const show = (value: unknown): string => (value === undefined ? 'nothing' : JSON.stringify(value));

const fieldOf = (path: string, key: string): string => (path === '' ? key : `${path}.${key}`);

/** Every field a reader of `object` sees, inherited ones included; Object.prototype's (`constructor`, `__proto__`) are not enumerable. */
function fieldsOf(object: Record<string, unknown>): Map<string, unknown> {
    const fields = new Map<string, unknown>();
    for (const key in object) fields.set(key, object[key]);
    return fields;
}

/**
 * Field-level differences between a skill entry's frontmatter and the
 * frontmatter parsed from its `SKILL.md`: every key both ways, objects in any
 * key order, arrays in order, numbers by value, no type coercion.
 */
export function frontmatterDifferences(entry: unknown, parsed: unknown, path = ''): string[] {
    const label = path === '' ? '(frontmatter)' : path;
    if (Array.isArray(entry) && Array.isArray(parsed)) {
        if (entry.length !== parsed.length) return [`${label}: the entry has ${entry.length} items, SKILL.md has ${parsed.length}`];
        return entry.flatMap((item, index) => frontmatterDifferences(item, parsed[index], `${path}[${index}]`));
    }
    if (isPlainObject(entry) && isPlainObject(parsed)) {
        const [fromEntry, fromParsed] = [fieldsOf(entry), fieldsOf(parsed)];
        const keys = [...new Set([...fromEntry.keys(), ...fromParsed.keys()])].toSorted();
        return keys.flatMap(key => frontmatterDifferences(fromEntry.get(key), fromParsed.get(key), fieldOf(path, key)));
    }
    return entry === parsed ? [] : [`${label}: the entry has ${show(entry)}, SKILL.md has ${show(parsed)}`];
}
