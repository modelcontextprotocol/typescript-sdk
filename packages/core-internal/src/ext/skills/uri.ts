/**
 * Every character a segment cannot carry as it is: WHATWG URL's path percent-encode set (controls, space,
 * `"#<>?^\`{}`, DEL and non-ASCII) plus `%`, `/` and `\`, which would start an escape or split the segment. `^` is
 * encoded on every runtime although older URL parsers (Node 20 and 22) leave it raw, so the published form does not
 * depend on the runtime; {@linkcode skillFileKey} keys both spellings alike.
 */
const ENCODED_IN_SEGMENT = /[^\w!$&'()*+,.:;=@[\]|~-]/gu;

/** `text` with every character in {@linkcode ENCODED_IN_SEGMENT} percent-encoded as UTF-8. */
function encodePathText(text: string): string {
    return text.replaceAll(ENCODED_IN_SEGMENT, char => encodeURIComponent(char));
}

/**
 * Percent-encodes one path segment the way WHATWG URL serialises it, so `new URL(name, root)` on a host yields the
 * published URI: sub-delimiters such as `&`, `+`, `@` and `[` stay as they are, and `%`, `/`, `?`, `#` and `\` are
 * always encoded. The dots of a `.` or `..` segment are encoded too; WHATWG URL still reads `%2E` as a dot segment,
 * so such a URI does not survive {@linkcode isRoundTripUri} (the catalog then skips the file) rather than naming
 * the directory or its parent. Throws `URIError` on a lone surrogate.
 */
export function encodeSegment(segment: string): string {
    if (segment === '.' || segment === '..') return segment.replaceAll('.', '%2E');
    return encodePathText(segment);
}

/**
 * `base` + `/`-joined encoded segments. `base` is `scheme://` or a URI without a trailing slash. After `scheme://`
 * the first segment is the authority, where `@`, `:`, `[`, `]` and `|` would read as userinfo, a port or an IP
 * literal, so it is encoded strictly with `encodeURIComponent`; path segments follow {@linkcode encodeSegment}.
 */
export function joinUri(base: string, segments: readonly string[]): string {
    if (!base.endsWith('://')) return `${base.replace(/\/+$/, '')}/${segments.map(segment => encodeSegment(segment)).join('/')}`;
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

function decodeOrUndefined(escapes: string): string | undefined {
    try {
        return decodeURIComponent(escapes);
    } catch {
        return undefined;
    }
}

/** The length of the UTF-8 sequence a lead byte announces: 1 for ASCII, and for bytes that cannot lead one. */
function utf8Width(lead: number): number {
    if (lead >= 0xf0) return 4;
    if (lead >= 0xe0) return 3;
    if (lead >= 0xc0) return 2;
    return 1;
}

/**
 * A run of `%XX` escapes keyed: each valid UTF-8 sequence decoded and re-encoded. A `%XX` that starts none is a
 * literal `%` before two characters, keyed `%25XX` with their case kept, exactly as {@linkcode encodeSegment}
 * publishes such a name (`10%Dec.md` is `10%25Dec.md`).
 */
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

/** Runs of `%XX` escapes; splitting on this puts them at odd indexes. */
const ESCAPE_RUN = /((?:%[\dA-Fa-f]{2})+)/;

/** One segment keyed: escape runs normalised, every other character (a stray `%` too) encoded as {@linkcode encodeSegment} does. */
function keyOfSegment(segment: string): string {
    return segment
        .split(ESCAPE_RUN)
        .map((part, index) => (index % 2 === 0 ? encodePathText(part) : keyOfEscapes(part)))
        .join('');
}

/**
 * The one spelling every way of writing a file's URI below `rootUri` shares: canonical, without its fragment, and
 * each segment below the root decoded and re-encoded as {@linkcode encodeSegment} does. Each UTF-8 sequence of
 * escapes is decoded on its own, and a `%` that starts none is literal (keyed `%25`), so a stray `%` in a plain name
 * (`100% off.md`, `10%Dec.md`) keys as published. `Q&A.md`, `Q%26A.md` and `%51&A.md` key alike, as do `%c3%a9`
 * and `%C3%A9`, and `^` and `%5E`; `%ff` and `%FF` do not, being literal text. A URI outside the root, or with a
 * query, keys as its canonical form without the fragment; `undefined` if it does not parse.
 */
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
