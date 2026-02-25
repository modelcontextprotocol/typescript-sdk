#!/usr/bin/env bash
#
# Generate combined V1 + V2 TypeDoc documentation locally.
#
# V2 docs are generated from the current branch and placed at the root.
# V1 docs are generated from the v1.x branch (via a git worktree) and
# placed under /v1/.
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
V1_BRANCH="origin/v1.x"

cleanup() {
    echo "Cleaning up V1 worktree..."
    cd "$REPO_ROOT"
    git worktree remove --force "$V1_WORKTREE" 2>/dev/null || true
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Step 1: Generate V2 docs from the current branch
# ---------------------------------------------------------------------------
echo "=== Generating V2 docs ==="
cd "$REPO_ROOT"
pnpm install
pnpm build:all
pnpm docs  # outputs to tmp/docs/ per typedoc.config.mjs

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"
cp -r "$REPO_ROOT/tmp/docs/"* "$OUTPUT_DIR/"

# ---------------------------------------------------------------------------
# Step 2: Generate V1 docs from v1.x via a git worktree
# ---------------------------------------------------------------------------
echo "=== Generating V1 docs ==="

# Ensure we have the latest v1.x ref
git fetch origin v1.x

# Clean up any stale worktree
git worktree remove --force "$V1_WORKTREE" 2>/dev/null || true
rm -rf "$V1_WORKTREE"

git worktree add "$V1_WORKTREE" "$V1_BRANCH" --detach

cd "$V1_WORKTREE"
npm install
npm install --save-dev typedoc@^0.28.14

# Write a temporary TypeDoc config for V1
cat > typedoc.json << 'TYPEDOC_EOF'
{
  "name": "MCP TypeScript SDK (V1)",
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
  "navigationLinks": {
    "V2 Docs (Latest)": "/"
  },
  "skipErrorChecking": true
}
TYPEDOC_EOF

npx typedoc

# ---------------------------------------------------------------------------
# Step 3: Merge V1 docs into the combined output
# ---------------------------------------------------------------------------
mkdir -p "$OUTPUT_DIR/v1"
cp -r "$V1_WORKTREE/tmp/docs/"* "$OUTPUT_DIR/v1/"

cd "$REPO_ROOT"
echo "=== Combined docs generated at $OUTPUT_DIR ==="
