// Tells the Release workflow whether every public package version is already on npm, so Publish only runs when it has work.
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const registry = 'https://registry.npmjs.org';
const repo = path.resolve(import.meta.dirname, '..');

// Every package.json outside node_modules, not only the workspace globs, so a publishable package is not left out.
function packageJsonFiles(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        if (entry.isDirectory()) {
            return entry.name === 'node_modules' || entry.name === '.git' ? [] : packageJsonFiles(path.join(dir, entry.name));
        }
        return entry.name === 'package.json' ? [path.join(dir, entry.name)] : [];
    });
}

// Published means the registry returned the document for exactly this name and version; anything else is not proof.
async function isPublished({ name, version }) {
    const response = await fetch(`${registry}/${name}/${version}`, { signal: AbortSignal.timeout(30_000) });
    const body = await response.text();
    const doc = response.status === 200 ? JSON.parse(body) : {};
    const published = doc.name === name && doc.version === version;
    console.log(`${name}@${version}: ${published ? 'on npm' : `not confirmed on npm (HTTP ${response.status})`}`);
    return published;
}

// Any doubt (no packages found, a network error, an odd reply) counts as unpublished, so Publish is still reached.
let allPublished = false;
try {
    const packages = packageJsonFiles(repo)
        .map(file => JSON.parse(readFileSync(file, 'utf8')))
        .filter(pkg => !pkg.private && pkg.name && pkg.version);
    let published = 0;
    for (const pkg of packages) {
        if (await isPublished(pkg)) published++;
    }
    allPublished = packages.length > 0 && published === packages.length;
    console.log(`${published} of ${packages.length} public package versions are on npm`);
} catch (error) {
    console.log(`Check failed: ${error.cause ?? error}`);
}

console.log(`allPublished=${allPublished}`);
if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `allPublished=${allPublished}\n`);
}
