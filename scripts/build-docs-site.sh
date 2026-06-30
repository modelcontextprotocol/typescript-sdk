#!/usr/bin/env bash
#
# Build the combined V1 + V2 documentation site (VitePress).
#
# V2 (from the current checkout, sources in docs/) is placed under /v2/.
# V1 (content from the v1.x branch, VitePress shell in docs-v1/) is placed at the root.
#
# Usage:
#   scripts/build-docs-site.sh [output-dir]
#
# Default output directory: tmp/docs-combined
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="$(cd "$REPO_ROOT" && realpath -m "${1:-tmp/docs-combined}")"
V1_WORKTREE="$REPO_ROOT/.worktrees/v1-docs"
V1_CONTENT="$REPO_ROOT/docs-v1/content"
V1_GITHUB="https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x"

cleanup() {
    echo "Cleaning up worktree..."
    cd "$REPO_ROOT"
    git worktree remove --force "$V1_WORKTREE" 2>/dev/null || true
}
trap cleanup EXIT

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# ---------------------------------------------------------------------------
# Step 1: Build V2 site from the current checkout
# ---------------------------------------------------------------------------
echo "=== Building V2 site ==="

cd "$REPO_ROOT"
pnpm install
pnpm -r --filter='./packages/**' build
pnpm docs:build

mkdir -p "$OUTPUT_DIR/v2"
cp -r "$REPO_ROOT/docs/.vitepress/dist/." "$OUTPUT_DIR/v2/"

# ---------------------------------------------------------------------------
# Step 2: Build V1 site from the v1.x branch
# ---------------------------------------------------------------------------
echo "=== Building V1 site ==="

git fetch origin v1.x

git worktree remove --force "$V1_WORKTREE" 2>/dev/null || true
rm -rf "$V1_WORKTREE"
# FETCH_HEAD (set by the fetch above) rather than origin/v1.x: the remote-tracking ref
# does not exist in single-branch or refspec-restricted clones.
git worktree add "$V1_WORKTREE" FETCH_HEAD --detach

cd "$V1_WORKTREE"
npm install
npm install --no-save typedoc@^0.28.14 typedoc-plugin-markdown@^4.9.0 typedoc-vitepress-theme@^1.1.0

rm -rf "$V1_CONTENT"
mkdir -p "$V1_CONTENT"

# Same entry points as the previous typedoc HTML setup for v1, but rendered to
# markdown (one page per module) for the VitePress shell in docs-v1/.
cat > typedoc.v1-site.json << TYPEDOC_EOF
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
  "plugin": ["typedoc-plugin-markdown", "typedoc-vitepress-theme"],
  "outputFileStrategy": "modules",
  "readme": "none",
  "docsRoot": "$V1_CONTENT",
  "out": "$V1_CONTENT/api",
  "exclude": [
    "**/*.test.ts",
    "**/__fixtures__/**",
    "**/__mocks__/**",
    "src/examples/**"
  ],
  "skipErrorChecking": true
}
TYPEDOC_EOF

npx typedoc --options typedoc.v1-site.json

# Copy the v1 markdown content (build copy only — the v1.x branch stays untouched).
cp docs/*.md "$V1_CONTENT/"
cp README.md "$V1_CONTENT/index.md"

# Rewrite links that don't resolve on the site:
# - source files -> GitHub
# - README links into docs/ -> site-local pages (docs/*.md sit next to index.md in content/)
sed -i "s|(src/examples/|(${V1_GITHUB}/src/examples/|g" "$V1_CONTENT/index.md"
sed -i "s|(LICENSE)|(${V1_GITHUB}/LICENSE)|g" "$V1_CONTENT/index.md"
sed -i "s|(docs/|(./|g" "$V1_CONTENT/index.md"
sed -i "s|(\.\./src/examples/|(${V1_GITHUB}/src/examples/|g" "$V1_CONTENT"/*.md

# Mechanical {@linkcode} -> backticks transform, mirroring the v2 docs transform.
# (The v1 docs currently contain none; this keeps the build robust if tags appear.)
node -e '
const fs = require("fs");
for (const f of process.argv.slice(1)) {
    const src = fs.readFileSync(f, "utf8");
    const out = src.replace(/\{@linkcode\s+([^}|]+?)(?:\s*\|\s*([^}]+?))?\s*\}/gs, (_m, path, label) =>
        "`" + (label !== undefined ? label.replace(/\s+/g, " ").trim() : path.replace(/\s+/g, " ").trim().split(/[.#!/]/).pop()) + "`"
    );
    if (out !== src) fs.writeFileSync(f, out);
}
' "$V1_CONTENT"/*.md

# The v1.x guide pages start at "##" — the old typedoc shell supplied the page title,
# VitePress does not. Prepend a title heading (build copy only) so pages don't open
# with an orphaned section gap. index.md (the README) already has one.
for f in "$V1_CONTENT"/*.md; do
    name="$(basename "$f" .md)"
    [ "$name" = "index" ] && continue
    head -n 1 "$f" | grep -q '^# ' && continue
    case "$name" in
        faq) title="FAQ" ;;
        *) title="$(printf '%s' "${name:0:1}" | tr '[:lower:]' '[:upper:]')${name:1}" ;;
    esac
    if head -n 1 "$f" | grep -qi "^## *${title} *$"; then
        # The page's first section heading already is the title — promote it.
        sed -i '1s/^## */# /' "$f"
    else
        { printf '# %s\n\n' "$title"; cat "$f"; } > "$f.tmp" && mv "$f.tmp" "$f"
    fi
done

cd "$REPO_ROOT"
pnpm exec vitepress build docs-v1

cp -r "$REPO_ROOT/docs-v1/.vitepress/dist/." "$OUTPUT_DIR/"

echo "=== Combined docs generated at $OUTPUT_DIR ==="
