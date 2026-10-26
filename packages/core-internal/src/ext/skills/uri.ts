// WHATWG URL's path percent-encode set, `^` included on every runtime (Node 20 and 22 leave it raw), plus `%`, `/` and `\`.
const ENCODED_IN_SEGMENT = /[^\w!$&'()*+,.:;=@[\]|~-]/gu;

function encodePathText(text: string): string {
    return text.replaceAll(ENCODED_IN_SEGMENT, char => encodeURIComponent(char));
}

/** Percent-encodes one path segment as WHATWG URL does, plus `%`, `/`, `\` and the dots of `.` and `..`; throws `URIError` on a lone surrogate. */
export function encodeSegment(segment: string): string {
    if (segment === '.' || segment === '..') return segment.replaceAll('.', '%2E');
    return encodePathText(segment);
}

/** `text` without its trailing `/`s; a loop, since `/\/+$/` backtracks polynomially on a long run of `/`. */
export function trimTrailingSlashes(text: string): string {
    let end = text.length;
    while (end > 0 && text.codePointAt(end - 1) === 0x2f) end--;
    return text.slice(0, end);
}

/** `base` (`scheme://`, or a URI without a trailing slash) + `/`-joined encoded segments; an authority is encoded strictly. */
export function joinUri(base: string, segments: readonly string[]): string {
    if (!base.endsWith('://')) return `${trimTrailingSlashes(base)}/${segments.map(segment => encodeSegment(segment)).join('/')}`;
    const [authority, ...path] = segments;
    if (authority === undefined) return base;
    return [base + encodeURIComponent(authority), ...path.map(segment => encodeSegment(segment))].join('/');
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

/** The skill's root directory URI (no trailing slash), or `undefined` if `skillMdUri` is not a `…/SKILL.md` URI in a named directory. */
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

/** True when `uri` is strictly inside `rootUri` and no segment below it decodes to empty, `.`, `..`, or a name holding `/` or NUL. */
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

function decodeOrUndefined(escapes: string): string | undefined {
    try {
        return decodeURIComponent(escapes);
    } catch {
        return undefined;
    }
}

function utf8Width(lead: number): number {
    if (lead >= 0xf0) return 4;
    if (lead >= 0xe0) return 3;
    if (lead >= 0xc0) return 2;
    return 1;
}

// Each valid UTF-8 sequence is decoded and re-encoded; a `%XX` starting none is a literal `%`, as published (`10%25Dec.md`).
function keyOfEscapes(run: string): string {
    let key = '';
    for (let at = 0; at < run.length; ) {
        const width = 3 * utf8Width(Number.parseInt(run.slice(at + 1, at + 3), 16));
        const decoded = decodeOrUndefined(run.slice(at, at + width));
        if (decoded === undefined) {
            key += `%25${run.slice(at + 1, at + 3)}`;
            at += 3;
        } else {
            key += encodePathText(decoded);
            at += width;
        }
    }
    return key;
}

// Runs of `%XX` escapes; splitting on this puts them at odd indexes.
const ESCAPE_RUN = /((?:%[\dA-Fa-f]{2})+)/;

function keyOfSegment(segment: string): string {
    return segment
        .split(ESCAPE_RUN)
        .map((part, index) => (index % 2 === 0 ? encodePathText(part) : keyOfEscapes(part)))
        .join('');
}

/** The one spelling all ways of writing a file's URI below `rootUri` share (`Q&A.md`, `Q%26A.md#x`); `undefined` if it does not parse. */
export function skillFileKey(rootUri: string, uri: string): string | undefined {
    let url: URL;
    try {
        url = new URL(uri);
    } catch {
        return undefined;
    }
    url.hash = '';
    const canonical = url.href;
    // A canonical path never holds a raw `?`, so one here starts a query, even an empty one.
    if (canonical.includes('?') || !canonical.startsWith(`${rootUri}/`)) return canonical;
    const below = canonical
        .slice(rootUri.length + 1)
        .split('/')
        .map(segment => keyOfSegment(segment));
    return `${rootUri}/${below.join('/')}`;
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
