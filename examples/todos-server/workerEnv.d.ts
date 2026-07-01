/** Wrangler bundles .html imports as text modules (see the [[rules]] block in wrangler.toml). */
declare module '*.html' {
    const text: string;
    export default text;
}
