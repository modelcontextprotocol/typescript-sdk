#!/usr/bin/env bash
#
# Generate combined V1 + V2 TypeDoc documentation.
#
# V1 docs (from the v1.x branch) are placed at the root.
# V2 docs (from main) are placed under /v2/.
#
# This script can be run from any branch — it fetches both v1.x and main
# via git worktrees.
#
# Usage:
#   scripts/generate-multidoc.sh [output-dir]
#
# Default output directory: tmp/docs-combined
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="${1:-$REPO_ROOT/tmp/docs-combined}"
V1_WORKTREE="$REPO_ROOT/.worktrees/v1-docs"
V2_WORKTREE="$REPO_ROOT/.worktrees/v2-docs"

cleanup() {
    echo "Cleaning up worktrees..."
    cd "$REPO_ROOT"
    git worktree remove --force "$V1_WORKTREE" 2>/dev/null || true
    git worktree remove --force "$V2_WORKTREE" 2>/dev/null || true
}
trap cleanup EXIT

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# ---------------------------------------------------------------------------
# Step 1: Generate V1 docs from v1.x branch
# ---------------------------------------------------------------------------
echo "=== Generating V1 docs ==="

git fetch origin v1.x

git worktree remove --force "$V1_WORKTREE" 2>/dev/null || true
rm -rf "$V1_WORKTREE"
git worktree add "$V1_WORKTREE" "origin/v1.x" --detach

cd "$V1_WORKTREE"
npm install
npm install --save-dev typedoc@^0.28.14

cat > typedoc.json << 'TYPEDOC_EOF'
{
  "name": "MCP TypeScript SDK",
  "entryPoints": [
    "src/client/index.ts",
    "src/server/index.ts",
    "src/shared/protocol.ts",
    "src/shared/transport.ts",
    "src/types.ts",
    "src/inMemory.ts",
    "src/validation/index.ts",
    "src/experimental/index.ts"
  ],
  "tsconfig": "tsconfig.json",
  "out": "tmp/docs",
  "exclude": [
    "**/*.test.ts",
    "**/__fixtures__/**",
    "**/__mocks__/**",
    "src/examples/**"
  ],
  "projectDocuments": [
    "docs/server.md",
    "docs/client.md",
    "docs/capabilities.md",
    "docs/protocol.md",
    "docs/faq.md"
  ],
  "navigationLinks": {
    "V2 Docs": "/v2/"
  },
  "headings": {
    "readme": false
  },
  "skipErrorChecking": true
}
TYPEDOC_EOF

# Rewrite relative .ts links to point to GitHub source instead of media downloads
V1_GITHUB="https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x"
sed -i "s|(src/examples/|(${V1_GITHUB}/src/examples/|g" README.md
sed -i "s|(../src/examples/|(${V1_GITHUB}/src/examples/|g" docs/*.md

npx typedoc

cp -r "$V1_WORKTREE/tmp/docs/"* "$OUTPUT_DIR/"

# ---------------------------------------------------------------------------
# Step 2: Generate V2 docs from main branch
# ---------------------------------------------------------------------------
echo "=== Generating V2 docs ==="

git fetch origin main

git worktree remove --force "$V2_WORKTREE" 2>/dev/null || true
rm -rf "$V2_WORKTREE"
git worktree add "$V2_WORKTREE" "origin/main" --detach

cd "$V2_WORKTREE"
pnpm install
pnpm -r --filter='./packages/**' build

# Write the V2 pre-release banner script
cat > docs/v2-banner.js << 'BANNER_EOF'
document.addEventListener("DOMContentLoaded", function () {
    var banner = document.createElement("div");
    banner.innerHTML =
        "This documents a <strong>pre-release</strong> version of the SDK. Expect breaking changes. For the stable SDK, see the <a href='/'>V1 docs</a>.";
    banner.style.cssText =
        "background:#fff3cd;color:#856404;border-bottom:1px solid #ffc107;padding:8px 16px;text-align:center;font-size:14px;";
    banner.querySelector("a").style.cssText = "color:#856404;text-decoration:underline;";
    document.body.insertBefore(banner, document.body.firstChild);


});
BANNER_EOF

# Patch the V2 typedoc config to add navigation links, base URL, and banner
node -e "
import fs from 'fs';
const cfg = fs.readFileSync('typedoc.config.mjs', 'utf8');
const patched = cfg.replace(
  /export default \{/,
  \"export default {\\n    hostedBaseUrl: 'https://modelcontextprotocol.github.io/typescript-sdk/v2/',\\n    customJs: 'docs/v2-banner.js',\"
).replace(
  /navigation:/,
  \"navigationLinks: {\\n        'V1 Docs': '/',\\n    },\\n    navigation:\"
);
fs.writeFileSync('typedoc.config.mjs', patched);
"

npx typedoc  # outputs to tmp/docs/ per typedoc.config.mjs

mkdir -p "$OUTPUT_DIR/v2"
cp -r "$V2_WORKTREE/tmp/docs/"* "$OUTPUT_DIR/v2/"

cd "$REPO_ROOT"
echo "=== Combined docs generated at $OUTPUT_DIR ==="
