import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, test } from 'vitest';

import { ensureBuilt } from '../helpers/ensureBuilt';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
const distDir = join(pkgDir, 'dist');
const requireDist = createRequire(join(pkgDir, 'package.json'));
const NODE_ONLY = /\b(child_process|cross-spawn|node:stream|node:child_process)\b/;
// Anchored at start-of-line so JSDoc-example `from 'ajv'` strings in vendored chunks don't match.
const VALIDATOR_BACKEND_IMPORT = /^import[^\n]*?from\s+["'](?:ajv|ajv-formats|@cfworker\/json-schema)["']/m;
const ROOT_VALIDATOR_EXPORTS = ['AjvJsonSchemaValidator', 'CfWorkerJsonSchemaValidator', 'CfWorkerSchemaDraft'];
// Static (`from "node:x"`), side-effect (`import "node:x"`, what rolldown keeps for an external whose bindings were
// tree-shaken) and dynamic `node:` imports. Only `.mjs` files are scanned, so `require(` is not matched.
const NODE_BUILTIN_IMPORT = /\b(?:from|import)\s*["']node:|\bimport\s*\(\s*["']node:/;
// The skills extension's shared schemas: a static, side-effect or dynamic import of the external subpath.
const CORE_SKILLS_IMPORT = /\b(?:from|import)\s*\(?\s*["']@modelcontextprotocol\/core\/ext\/skills["']/;
// The skills extension's own code (core-internal's `ext/skills`): the frontmatter parser and the entry builder.
const SKILLS_CODE = /\b(?:FrontmatterError|parseFrontmatterYaml|buildSkillEntry|skillEntryProblems)\b/;

/**
 * An ESM entry and every chunk it imports, following relative `from` and side-effect `import` specifiers, both
 * `./` and `../` (nested entries import `../../chunk.mjs`, and side-effect-only `import "../../chunk.mjs"`).
 */
function moduleGraphOf(entryPath: string): string[] {
    const visited = new Set<string>();
    const queue = [entryPath];
    while (queue.length > 0) {
        const file = queue.shift()!;
        if (visited.has(file)) continue;
        visited.add(file);
        for (const m of readFileSync(file, 'utf8').matchAll(/\b(?:from|import)\s*["'](\.{1,2}\/[^"']+?\.mjs)["']/g)) {
            queue.push(join(dirname(file), m[1]!));
        }
    }
    return [...visited];
}

/** A declaration entry and every declaration chunk it imports (a `.d.mts` file names its siblings as `.mjs`). */
function declarationGraphOf(entryPath: string): string[] {
    const visited = new Set<string>();
    const queue = [entryPath];
    while (queue.length > 0) {
        const file = queue.shift()!;
        if (visited.has(file)) continue;
        visited.add(file);
        for (const m of readFileSync(file, 'utf8').matchAll(/\b(?:from|import)\s*["'](\.{1,2}\/[^"']+?)\.mjs["']/g)) {
            queue.push(join(dirname(file), `${m[1]!}.d.mts`));
        }
    }
    return [...visited];
}

function rootExportBlockOf(content: string): string {
    const blocks = content.match(/(?:^|\n)export \{[\s\S]*?\};/g);
    expect(blocks).toBeTruthy();
    return blocks!.at(-1)!;
}

describe('@modelcontextprotocol/server root entry is browser-safe', () => {
    beforeAll(async () => {
        // Single-flight across parallel vitest workers: this file and
        // workerdSchemaPreload.test.ts both read the built dist, and two
        // unlocked `pnpm build`s would race tsdown's clean step.
        await ensureBuilt(pkgDir);
    }, 180_000);

    test('dist/index.mjs does not export StdioServerTransport and has no process-stdio runtime imports', () => {
        const entry = readFileSync(join(distDir, 'index.mjs'), 'utf8');
        // Server stdio has only type-level node:stream imports (erased at compile time), so the
        // meaningful regression check is that the symbol itself is absent from the root barrel.
        expect(entry).not.toMatch(/\bexport\s*\{[^}]*\bStdioServerTransport\b/);
        expect(entry).not.toMatch(NODE_ONLY);
    });

    test('chunks transitively imported by dist/index.mjs contain no process-stdio runtime imports', () => {
        for (const file of moduleGraphOf(join(distDir, 'index.mjs'))) {
            expect({ file, content: readFileSync(file, 'utf8') }).not.toEqual(
                expect.objectContaining({ content: expect.stringMatching(NODE_ONLY) })
            );
        }
    });

    test('dist/stdio.mjs exists and exports StdioServerTransport', () => {
        const stdio = readFileSync(join(distDir, 'stdio.mjs'), 'utf8');
        expect(stdio).toMatch(/\bStdioServerTransport\b/);
    });

    test('runtime shims vendor default validator backends instead of requiring consumers to install them', () => {
        for (const shim of ['shimsNode.mjs', 'shimsWorkerd.mjs', 'shimsBrowser.mjs']) {
            // The graph includes the shim entry itself.
            for (const file of moduleGraphOf(join(distDir, shim))) {
                expect({ file, content: readFileSync(file, 'utf8') }).not.toEqual(
                    expect.objectContaining({ content: expect.stringMatching(VALIDATOR_BACKEND_IMPORT) })
                );
            }
        }
    });

    test('CJS AJV validator subpath exposes Ajv at runtime', () => {
        const { Ajv, AjvJsonSchemaValidator, addFormats } = requireDist(
            './dist/validators/ajv.cjs'
        ) as typeof import('../../src/validators/ajv');

        const ajv = new Ajv({ strict: false, allErrors: true });
        addFormats(ajv);

        expect(new AjvJsonSchemaValidator(ajv)).toBeInstanceOf(AjvJsonSchemaValidator);
    });

    test('root declarations do not advertise validator provider classes', () => {
        for (const declaration of ['index.d.mts', 'index.d.cts']) {
            const rootExportBlock = rootExportBlockOf(readFileSync(join(distDir, declaration), 'utf8'));
            for (const symbol of ROOT_VALIDATOR_EXPORTS) {
                expect(rootExportBlock).not.toMatch(new RegExp(`\\b(?:type\\s+)?${symbol}\\b`));
            }
        }
    });
});

describe('@modelcontextprotocol/server root and ext/skills are runtime-neutral', () => {
    beforeAll(async () => {
        await ensureBuilt(pkgDir);
    }, 180_000);

    test.each(['index.mjs', 'ext/skills/index.mjs'])('%s and every chunk it imports have no node: imports', entry => {
        for (const file of moduleGraphOf(join(distDir, entry))) {
            expect({ file, content: readFileSync(file, 'utf8') }).not.toEqual(
                expect.objectContaining({ content: expect.stringMatching(NODE_BUILTIN_IMPORT) })
            );
        }
    });

    test('ext/skills/node exports the folder adapter and is where the node: imports live', () => {
        const node = join(distDir, 'ext/skills/node.mjs');
        expect(rootExportBlockOf(readFileSync(node, 'utf8'))).toMatch(
            /\bloadSkills\b[\s\S]*\bnodeSkillFiles\b|\bnodeSkillFiles\b[\s\S]*\bloadSkills\b/
        );
        expect(moduleGraphOf(node).some(file => NODE_BUILTIN_IMPORT.test(readFileSync(file, 'utf8')))).toBe(true);
    });

    test('the root entry does not export the skills extension', () => {
        expect(rootExportBlockOf(readFileSync(join(distDir, 'index.mjs'), 'utf8'))).not.toMatch(
            /\b(?:SkillsExtension|SkillCatalog|loadSkills|nodeSkillFiles)\b/
        );
    });

    test('dist/index.mjs and every chunk it imports carry no skills code and no @modelcontextprotocol/core/ext/skills import', () => {
        // Users who never import ext/skills must not load (or bundle) the frontmatter parser or the skills schemas.
        for (const file of moduleGraphOf(join(distDir, 'index.mjs'))) {
            const content = readFileSync(file, 'utf8');
            expect({ file, content }).not.toEqual(expect.objectContaining({ content: expect.stringMatching(CORE_SKILLS_IMPORT) }));
            expect({ file, content }).not.toEqual(expect.objectContaining({ content: expect.stringMatching(SKILLS_CODE) }));
        }
    });

    test('the ext/skills entry graph is where the skills code and the core/ext/skills import live (guards the patterns)', () => {
        const graph = moduleGraphOf(join(distDir, 'ext/skills/index.mjs')).map(file => readFileSync(file, 'utf8'));
        expect(graph.some(content => CORE_SKILLS_IMPORT.test(content))).toBe(true);
        expect(graph.some(content => SKILLS_CODE.test(content))).toBe(true);
    });

    test('the ext/skills declarations give subclasses no attach hook to override', () => {
        // SEP-3371 registration (`extensions: [skills]`) will not go through attach(), so no hook may be public API.
        const graph = declarationGraphOf(join(distDir, 'ext/skills/index.d.mts'));
        expect(graph.some(file => /\bdeclare class SkillCatalog\b/.test(readFileSync(file, 'utf8')))).toBe(true);
        for (const file of graph) {
            expect({ file, content: readFileSync(file, 'utf8') }).not.toEqual(
                expect.objectContaining({ content: expect.stringMatching(/\bafterAttach\b/) })
            );
        }
    });
});
