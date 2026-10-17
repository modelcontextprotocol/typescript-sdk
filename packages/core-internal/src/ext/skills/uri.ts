/** Percent-encodes one path segment; the result is stable under `new URL()`. */
export function encodeSegment(segment: string): string {
    return encodeURIComponent(segment);
}

/** `base` + `/`-joined encoded segments. `base` is `scheme://` or a URI without a trailing slash. */
export function joinUri(base: string, segments: readonly string[]): string {
    const prefix = base.endsWith('://') ? base : `${base.replace(/\/+$/, '')}/`;
    return prefix + segments.map(segment => encodeSegment(segment)).join('/');
}

/** WHATWG-serialised form of `uri`, or `undefined` if it does not parse. */
export function canonicalUri(uri: string): string | undefined {
    try {
        return new URL(uri).href;
    } catch {
        return undefined;
    }
}

/** True when `uri` is already in canonical form. */
export function isRoundTripUri(uri: string): boolean {
    return canonicalUri(uri) === uri;
}

const MANIFEST_SUFFIX = '/SKILL.md';

/**
 * The skill's root directory URI (no trailing slash), or `undefined` if `skillMdUri` is not a `…/SKILL.md` URI
 * directly inside a named directory.
 */
export function skillRootUri(skillMdUri: string): string | undefined {
    const canonical = canonicalUri(skillMdUri);
    if (canonical === undefined || !canonical.endsWith(MANIFEST_SUFFIX)) return undefined;
    const root = canonical.slice(0, -MANIFEST_SUFFIX.length);
    // `scheme:/` or `scheme://` (no directory) and `…//SKILL.md` (an empty last segment) name no directory.
    return root.endsWith('/') ? undefined : root;
}

function safeDecode(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

/** The decoded last segment of a directory URI (the authority when the path is empty). */
export function lastSegmentOf(rootUri: string): string {
    const url = new URL(rootUri);
    const path = url.pathname;
    return safeDecode(path === '' || path === '/' ? url.host : path.slice(path.lastIndexOf('/') + 1));
}

/**
 * True when `uri`, once normalised, is strictly inside `rootUri` and every segment below it decodes to a plain
 * name: not empty, `.` or `..`, and free of `/` and NUL. An encoded `%2F` would otherwise carry traversal inside
 * one segment. A backslash is allowed: it is legal in POSIX names and {@linkcode joinUri} encodes it as `%5C`.
 */
export function isWithin(rootUri: string, uri: string): boolean {
    const canonical = canonicalUri(uri);
    if (canonical === undefined || !canonical.startsWith(`${rootUri}/`)) return false;
    return canonical
        .slice(rootUri.length + 1)
        .split('/')
        .every(segment => {
            const decoded = safeDecode(segment);
            return decoded !== '' && decoded !== '.' && decoded !== '..' && !decoded.includes('/') && !decoded.includes('\0');
        });
}

/** Resolves `ref` (default `SKILL.md`) against the skill's root, as a browser resolves a link. */
export function resolveSkillRef(skillMdUri: string, ref?: string): string {
    const root = skillRootUri(skillMdUri);
    if (root === undefined) throw new TypeError(`${skillMdUri} is not a SKILL.md URI`);
    return new URL(ref ?? 'SKILL.md', `${root}/`).href;
}

/** Code-unit order of two URIs: the one order for entries, directory children and cursors. */
export function compareUris(a: string, b: string): number {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}
