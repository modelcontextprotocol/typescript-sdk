// Plain .mjs (with a sibling .d.mts) so tsdown's native config loader can import it from the
// per-package tsdown.config.ts files on every supported Node version.

const RE_DTS_CHUNK = /\.d\.[cm]?ts$/;
const RE_DTS_SOURCE_MAPPING_URL = /\n?\/\/# sourceMappingURL=\S+\s*$/;

/**
 * tsdown `inputOptions` hook that removes the trailing `//# sourceMappingURL=` comment from the
 * emitted `.d.ts` / `.d.mts` / `.d.cts` chunks.
 *
 * The published packages ship only `dist/` (`"files": ["dist"]`), and tsc cannot embed
 * `sourcesContent` into declaration maps, so shipped `.d.*ts.map` files would always point at
 * `src/` paths that do not exist on a consumer's machine (#2233). Setting `dts.sourcemap: false`
 * stops the maps from being emitted, but the JS-level `sourcemap: true` still makes rolldown
 * append a sourceMappingURL comment to the declaration chunks; this hook strips that comment so
 * the shipped declaration files do not reference maps that are not there.
 *
 * Registered via `inputOptions` rather than `plugins` because tsdown does not forward user
 * plugins to the extra CJS dts pass that emits the `.d.cts` files.
 *
 * @param {import('tsdown').Rolldown.InputOptions} options
 * @returns {void}
 */
export function stripDtsSourceMappingUrl(options) {
    options.plugins = [
        options.plugins,
        {
            name: 'strip-dts-source-mapping-url',
            generateBundle(_outputOptions, bundle) {
                for (const output of Object.values(bundle)) {
                    if (output.type === 'chunk' && RE_DTS_CHUNK.test(output.fileName)) {
                        output.code = output.code.replace(RE_DTS_SOURCE_MAPPING_URL, '\n');
                    }
                }
            }
        }
    ];
}
