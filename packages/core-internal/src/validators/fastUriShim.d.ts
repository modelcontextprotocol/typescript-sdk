/**
 * dts-bundling shim for `fast-uri`.
 *
 * ajv@8.18.0's published .d.ts does `import { URIComponent } from "fast-uri"`,
 * but fast-uri ships its types as `export = namespace`, which rolldown's dts
 * bundler can't destructure into a named import — it drops the import and
 * leaves a dangling `URIComponent` reference in the bundled .d.mts (TS2304 for
 * downstream consumers with `skipLibCheck: false`).
 *
 * The server/client tsdown configs map `fast-uri` to this file via
 * `dts.compilerOptions.paths` so the type is inlined as a plain named export.
 * Runtime code is unaffected (this is a `.d.ts`; the path mapping is dts-only).
 */
export interface URIComponent {
    scheme?: string;
    userinfo?: string;
    host?: string;
    port?: number | string;
    path?: string;
    query?: string;
    fragment?: string;
    reference?: string;
    error?: string;
}
