import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packagesDir = path.resolve(__dirname, '../..');

const PACKAGE_DIRS: Record<string, string> = {
    '@modelcontextprotocol/client': 'client',
    '@modelcontextprotocol/server': 'server',
    '@modelcontextprotocol/node': 'middleware/node',
    '@modelcontextprotocol/express': 'middleware/express',
};

const versions: Record<string, string> = {};

for (const [pkg, dir] of Object.entries(PACKAGE_DIRS)) {
    const pkgJsonPath = path.join(packagesDir, dir, 'package.json');
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    versions[pkg] = `^${pkgJson.version}`;
}

const lines = Object.entries(versions)
    .map(([pkg, ver]) => `    '${pkg}': '${ver}',`)
    .join('\n');

const output = `// AUTO-GENERATED — do not edit. Run \`pnpm run generate:versions\` to regenerate.
export const V2_PACKAGE_VERSIONS: Record<string, string> = {
${lines}
};
`;

const outPath = path.resolve(__dirname, '../src/generated/versions.ts');
writeFileSync(outPath, output);
console.log(`Wrote ${outPath}`);
