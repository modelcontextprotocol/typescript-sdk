#!/bin/bash
set -e

# Generates versioned API documentation and commits to gh-pages branch
#
# PURPOSE:
#   This script generates API documentation in the gh-pages branch for a
#   specific version tag while preserving existing versioned documentation.
#   This script is invoked by the publish-gh-pages job in the GitHub Actions
#   workflow (.github/workflows/main.yml) when a release is published.
#
# HOW IT WORKS:
#   - Creates isolated git worktrees for the specified tag and gh-pages branch
#   - Generates documentation into gh-pages in a directory based on the tag name (e.g., v1.2.3/)
#   - Generates _data/latest_version.yml for Jekyll template
#   - Copies static Jekyll template files from .github/pages/
#   - Commits changes to gh-pages (does not push automatically)
#
# WORKFLOW:
#   1. Run this script with a tag name: `generate-gh-pages.sh v1.2.3`
#   2. Script generates docs and commits to local gh-pages branch
#   3. Push gh-pages branch to deploy: `git push origin gh-pages`

TAG_NAME="${1}"

# Parse semantic version from tag name (ignoring arbitrary prefixes)
if [[ "${TAG_NAME}" =~ ([0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?)$ ]]; then
  VERSION="v${BASH_REMATCH[1]}"
else
  echo "Error: Must specify a tag name that contains a valid semantic version"
  echo "Usage: ${0} <tag-name>"
  echo "Examples:"
  echo "  ${0} 1.2.3"
  echo "  ${0} v2.0.0-rc.1"
  exit 1
fi

echo "Generating documentation for tag: ${TAG_NAME}"

# Generates documentation for the given source directory.
#
# Can modify this function to customize documentation structure.
# For example, to add guides from ./docs/ and nest API docs under /api:
#   1. Copy docs/ contents: `cp -r docs/* "${output_dir}/"`
#   2. Change typedoc output: `npx typedoc --out "${output_dir}/api"`
generate_docs() {
    local source_dir="${1}"
    local output_dir="${2}"

    # Resolve to absolute path (because typedoc runs from source_dir)
    [[ "${output_dir}" != /* ]] && output_dir="$(pwd)/${output_dir}"

    echo "Installing dependencies..."
    (cd "${source_dir}" && pnpm install --frozen-lockfile --ignore-scripts)

    echo "Generating TypeDoc documentation..."
    (cd "${source_dir}" && pnpm exec typedoc --out "${output_dir}")

    # Verify docs were generated
    if [ -z "$(ls -A "${output_dir}")" ]; then
        echo "Error: Documentation was not generated at ${output_dir}"
        exit 1
    fi
}

# Create temporary directories for both worktrees
TAG_WORKTREE_DIR=$(mktemp -d)
GHPAGES_WORKTREE_DIR=$(mktemp -d)

# Set up trap to clean up both worktrees on exit
trap 'git worktree remove --force "${TAG_WORKTREE_DIR}" 2>/dev/null || true; \
      git worktree remove --force "${GHPAGES_WORKTREE_DIR}" 2>/dev/null || true' EXIT

echo "Creating worktree for ${TAG_NAME}..."
git worktree add --quiet "${TAG_WORKTREE_DIR}" "${TAG_NAME}"

# Fetch gh-pages from remote if available (creates local branch if missing)
git fetch --quiet origin gh-pages:refs/heads/gh-pages 2>/dev/null || true

if git show-ref --verify --quiet refs/heads/gh-pages; then
  echo "Creating worktree for gh-pages branch..."
  git worktree add --quiet "${GHPAGES_WORKTREE_DIR}" gh-pages
else
  echo "Creating worktree for new orphan gh-pages branch..."
  git worktree add --quiet --detach "${GHPAGES_WORKTREE_DIR}"
  git -C "${GHPAGES_WORKTREE_DIR}" switch --orphan gh-pages
fi

# Change to gh-pages worktree for all subsequent operations
cd "${GHPAGES_WORKTREE_DIR}"

# Generate TypeDoc documentation into gh-pages worktree
mkdir -p "${VERSION}"
generate_docs "${TAG_WORKTREE_DIR}" "${VERSION}"

# Generate version data for Jekyll
echo "Generating _data/latest_version.yml..."
mkdir -p _data
LATEST_VERSION="v$(printf '%s\n' */ | grep '^v[0-9]' | sed -e 's/^v//' -e 's:/$::' | sort -Vr | head -1)"
echo "${LATEST_VERSION}" > _data/latest_version.yml

if [ "${VERSION}" = "${LATEST_VERSION}" ]; then
  echo "${VERSION} is the latest version, updating static files..."

  # Clean up old tracked files from gh-pages root (but preserve directories)
  git ls-files -z | grep -zv '/' | xargs -0 rm -f

  # Copy static files from .github/pages/
  find "${TAG_WORKTREE_DIR}/.github/pages" -maxdepth 1 -type f -exec cp -t . {} +
else
  echo "${VERSION} is not the latest version (latest is ${LATEST_VERSION})"
fi

# Commit if there are changes
git add .

if git diff --staged --quiet; then
  echo "No changes to commit for tag ${TAG_NAME}"
else
  git commit -m "Add ${VERSION} docs"
  echo "Documentation for tag ${TAG_NAME} committed to gh-pages branch!"
  echo "Push to remote to deploy to GitHub Pages"
fi
