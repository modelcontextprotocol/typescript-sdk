const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const show = (value: unknown): string => (value === undefined ? 'nothing' : JSON.stringify(value));

const fieldOf = (path: string, key: string): string => (path === '' ? key : `${path}.${key}`);

/** `object[key]` when `key` is its own: a missing `constructor` or `__proto__` must read as nothing, not Object.prototype's. */
const ownValue = (object: Record<string, unknown>, key: string): unknown => (Object.hasOwn(object, key) ? object[key] : undefined);

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
        const keys = [...new Set([...Object.keys(entry), ...Object.keys(parsed)])].toSorted();
        return keys.flatMap(key => frontmatterDifferences(ownValue(entry, key), ownValue(parsed, key), fieldOf(path, key)));
    }
    return entry === parsed ? [] : [`${label}: the entry has ${show(entry)}, SKILL.md has ${show(parsed)}`];
}
