/**
 * Generate docs/index.md (the V2 site's landing page) from the repository README.
 *
 * The docs site lands on the README — the same model as the V1 site — so the README
 * stays the single source of truth and the landing page can never drift from it.
 * Links that only resolve on GitHub are rewritten for the site:
 *   - `docs/<page>.md`   -> `./<page>.md`        (index.md sits next to the guide pages)
 *   - other repo paths   -> the GitHub blob URL
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const GITHUB = 'https://github.com/modelcontextprotocol/typescript-sdk/blob/main';

let markdown = readFileSync(join(repoRoot, 'README.md'), 'utf8');

markdown = markdown
    .replaceAll('](docs/', '](./')
    .replaceAll('](packages/', `](${GITHUB}/packages/`)
    .replaceAll('](examples/', `](${GITHUB}/examples/`)
    .replaceAll('](LICENSE)', `](${GITHUB}/LICENSE)`)
    .replaceAll('](CONTRIBUTING.md)', `](${GITHUB}/CONTRIBUTING.md)`)
    .replaceAll('](SECURITY.md)', `](${GITHUB}/SECURITY.md)`)
    .replaceAll('](CODE_OF_CONDUCT.md)', `](${GITHUB}/CODE_OF_CONDUCT.md)`);

writeFileSync(join(repoRoot, 'docs', 'index.md'), markdown);
console.log('docs/index.md generated from README.md');
