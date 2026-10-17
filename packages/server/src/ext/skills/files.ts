/** Splits a relative `/`-separated path, rejecting `..` and empty paths. */
export function splitRelativePath(path: string, label: string): string[] {
    const segments = path.split('/').filter(segment => segment !== '' && segment !== '.');
    if (segments.length === 0 || segments.includes('..')) {
        throw new TypeError(`${label} must be a relative path without ".." (got ${JSON.stringify(path)})`);
    }
    return segments;
}
