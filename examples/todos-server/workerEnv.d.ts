/** Wrangler bundles .html imports as text modules (see the [[rules]] block in wrangler.toml). */
declare module '*.html' {
    const text: string;
    export default text;
}

/** The board page's client script, bundled as text and inlined at render time. */
declare module '*.client.js' {
    const text: string;
    export default text;
}
