/**
 * Code Snippet Sync Script
 *
 * This script syncs code snippets into JSDoc comments and markdown files
 * containing labeled code fences.
 *
 * ## Supported Source Files
 *
 * - **Full-file inclusion**: Any file type (e.g., `.json`, `.yaml`, `.sh`, `.ts`)
 * - **Region extraction**: Only `.ts` files (using `//#region` markers)
 *
 * ## Code Fence Format
 *
 * Full-file inclusion (any file type):
 *
 * ``````typescript
 * ```json source="./config.json"
 * // entire file content is synced here
 * ```
 * ``````
 *
 * Region extraction (.ts only):
 *
 * ``````typescript
 * ```ts source="./path.examples.ts#regionName"
 * // region content is synced here
 * ```
 * ``````
 *
 * Optionally, a display filename can be shown before the source reference:
 *
 * ``````typescript
 * ```ts my-app.ts source="./path.examples.ts#regionName"
 * // code is synced here
 * ```
 * ``````
 *
 * ## Region Format (in .examples.ts files)
 *
 * ``````typescript
 * //#region regionName
 * // code here
 * //#endregion regionName
 * ``````
 *
 * Run: pnpm sync:snippets
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');
const PACKAGES_DIR = join(PROJECT_ROOT, 'packages');
const DOCS_DIR = join(PROJECT_ROOT, 'docs');

/** Processing mode based on file type */
type FileMode = 'jsdoc' | 'markdown';

/**
 * Represents a labeled code fence found in a source file.
 */
interface LabeledCodeFence {
  /** Optional display filename (e.g., "my-app.ts") */
  displayName?: string;
  /** Relative path to the example file (e.g., "./app.examples.ts") */
  examplePath: string;
  /** Region name (e.g., "App_basicUsage"), or undefined for whole file */
  regionName?: string;
  /** Language from the code fence (e.g., "ts", "json", "yaml") */
  language: string;
  /** Character index of the opening fence line start */
  openingFenceStart: number;
  /** Character index after the opening fence line (after newline) */
  openingFenceEnd: number;
  /** Character index of the closing fence line start */
  closingFenceStart: number;
  /** The JSDoc line prefix extracted from context (e.g., " * ") */
  linePrefix: string;
}

/**
 * Cache for example file regions to avoid re-reading files.
 * Key: `${absoluteExamplePath}#${regionName}` (empty regionName for whole file)
 * Value: extracted code string
 */
type RegionCache = Map<string, string>;

/**
 * Processing result for a source file.
 */
interface FileProcessingResult {
  filePath: string;
  modified: boolean;
  snippetsProcessed: number;
  errors: string[];
}

// JSDoc patterns - for code fences inside JSDoc comments with " * " prefix
// Matches: <prefix>```<lang> [displayName] source="<path>" or source="<path>#<region>"
// Example: " * ```ts my-app.ts source="./app.examples.ts#App_basicUsage""
// Example: " * ```ts source="./app.examples.ts#App_basicUsage""
// Example: " * ```ts source="./complete-example.ts"" (whole file)
const JSDOC_LABELED_FENCE_PATTERN =
  /^(\s*\*\s*)```(\w+)(?:\s+(\S+))?\s+source="([^"#]+)(?:#([^"]+))?"/;
const JSDOC_CLOSING_FENCE_PATTERN = /^(\s*\*\s*)```\s*$/;

// Markdown patterns - for plain code fences in markdown files (no prefix)
// Matches: ```<lang> [displayName] source="<path>" or source="<path>#<region>"
// Example: ```ts source="./patterns.ts#chunkedDataServer"
// Example: ```ts source="./complete-example.ts" (whole file)
const MARKDOWN_LABELED_FENCE_PATTERN =
  /^```(\w+)(?:\s+(\S+))?\s+source="([^"#]+)(?:#([^"]+))?"/;
const MARKDOWN_CLOSING_FENCE_PATTERN = /^```\s*$/;

/**
 * Find all labeled code fences in a source file.
 * @param content The file content
 * @param filePath The file path (for error messages)
 * @param mode The processing mode (jsdoc or markdown)
 * @returns Array of labeled code fence references
 */
function findLabeledCodeFences(
  content: string,
  filePath: string,
  mode: FileMode,
): LabeledCodeFence[] {
  const results: LabeledCodeFence[] = [];
  const lines = content.split('\n');
  let charIndex = 0;

  // Select patterns based on mode
  const openPattern =
    mode === 'jsdoc'
      ? JSDOC_LABELED_FENCE_PATTERN
      : MARKDOWN_LABELED_FENCE_PATTERN;
  const closePattern =
    mode === 'jsdoc'
      ? JSDOC_CLOSING_FENCE_PATTERN
      : MARKDOWN_CLOSING_FENCE_PATTERN;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const openMatch = line.match(openPattern);

    if (openMatch) {
      let linePrefix: string;
      let language: string;
      let displayName: string | undefined;
      let examplePath: string;
      let regionName: string;

      if (mode === 'jsdoc') {
        // JSDoc: group 1=prefix, 2=lang, 3=displayName, 4=path, 5=region
        [, linePrefix, language, displayName, examplePath, regionName] =
          openMatch;
      } else {
        // Markdown: group 1=lang, 2=displayName, 3=path, 4=region (no prefix)
        [, language, displayName, examplePath, regionName] = openMatch;
        linePrefix = '';
      }

      const openingFenceStart = charIndex;
      const openingFenceEnd = charIndex + line.length + 1; // +1 for newline

      // Find closing fence
      let closingFenceStart = -1;
      let searchIndex = openingFenceEnd;

      for (let j = i + 1; j < lines.length; j++) {
        const closeLine = lines[j];
        if (closePattern.test(closeLine)) {
          closingFenceStart = searchIndex;
          break;
        }
        searchIndex += closeLine.length + 1;
      }

      if (closingFenceStart === -1) {
        throw new Error(
          `${filePath}: No closing fence for ${examplePath}#${regionName}`,
        );
      }

      results.push({
        displayName,
        examplePath,
        regionName,
        language,
        openingFenceStart,
        openingFenceEnd,
        closingFenceStart,
        linePrefix,
      });
    }

    charIndex += line.length + 1;
  }

  return results;
}

/**
 * Dedent content by removing a base indentation prefix from each line.
 * @param content The content to dedent
 * @param baseIndent The indentation to remove
 * @returns The dedented content
 */
function dedent(content: string, baseIndent: string): string {
  const lines = content.split('\n');
  const dedentedLines = lines.map((line) => {
    // Preserve empty lines as-is
    if (line.trim() === '') return '';
    // Remove the base indentation if present
    if (line.startsWith(baseIndent)) {
      return line.slice(baseIndent.length);
    }
    // Line has less indentation than base - keep as-is
    return line;
  });

  // Trim trailing empty lines
  while (
    dedentedLines.length > 0 &&
    dedentedLines[dedentedLines.length - 1] === ''
  ) {
    dedentedLines.pop();
  }

  return dedentedLines.join('\n');
}

/**
 * Extract a region from an example file.
 * @param exampleContent The content of the example file
 * @param regionName The region name to extract
 * @param examplePath The example file path (for error messages)
 * @returns The dedented region content
 */
function extractRegion(
  exampleContent: string,
  regionName: string,
  examplePath: string,
): string {
  // Region extraction only supported for .ts files (uses //#region syntax)
  if (!examplePath.endsWith('.ts')) {
    throw new Error(
      `Region extraction (#${regionName}) is only supported for .ts files. ` +
        `Use full-file inclusion (without #regionName) for: ${examplePath}`,
    );
  }

  const lineEnding = exampleContent.includes('\r\n') ? '\r\n' : '\n';
  const regionStart = `//#region ${regionName}${lineEnding}`;
  const regionEnd = `//#endregion ${regionName}${lineEnding}`;

  const startIndex = exampleContent.indexOf(regionStart);
  if (startIndex === -1) {
    throw new Error(`Region "${regionName}" not found in ${examplePath}`);
  }

  const endIndex = exampleContent.indexOf(regionEnd, startIndex);
  if (endIndex === -1) {
    throw new Error(
      `Region end marker for "${regionName}" not found in ${examplePath}`,
    );
  }

  // Get content after the region start line
  const afterStart = exampleContent.indexOf('\n', startIndex);
  if (afterStart === -1 || afterStart >= endIndex) {
    return ''; // Empty region
  }

  // Extract the raw content
  const rawContent = exampleContent.slice(afterStart + 1, endIndex);

  // Determine base indentation from the //#region line
  let lineStart = exampleContent.lastIndexOf('\n', startIndex);
  lineStart = lineStart === -1 ? 0 : lineStart + 1;
  const regionLine = exampleContent.slice(lineStart, startIndex);

  // The base indent is the whitespace before //#region
  const baseIndent = regionLine;

  return dedent(rawContent, baseIndent);
}

/**
 * Get or load a region from the cache.
 * @param sourceFilePath The source file requesting the region
 * @param examplePath The relative path to the example file
 * @param regionName The region name to extract, or undefined for whole file
 * @param cache The region cache
 * @returns The extracted code string
 */
function getOrLoadRegion(
  sourceFilePath: string,
  examplePath: string,
  regionName: string | undefined,
  cache: RegionCache,
): string {
  // Resolve the example path relative to the source file
  const sourceDir = dirname(sourceFilePath);
  const absoluteExamplePath = resolve(sourceDir, examplePath);

  // File content is always cached with key ending in "#" (empty region)
  const fileKey = `${absoluteExamplePath}#`;
  let fileContent = cache.get(fileKey);

  if (fileContent === undefined) {
    try {
      fileContent = readFileSync(absoluteExamplePath, 'utf-8');
    } catch {
      throw new Error(`Example file not found: ${absoluteExamplePath}`);
    }
    cache.set(fileKey, fileContent);
  }

  // If no region name, return whole file
  if (!regionName) {
    return fileContent.trim();
  }

  // Extract region from cached file content, cache the result
  const regionKey = `${absoluteExamplePath}#${regionName}`;
  let regionContent = cache.get(regionKey);

  if (regionContent === undefined) {
    regionContent = extractRegion(fileContent, regionName, examplePath);
    cache.set(regionKey, regionContent);
  }

  return regionContent;
}

/**
 * Format code lines for insertion into a JSDoc comment.
 * @param code The code to format
 * @param linePrefix The JSDoc line prefix (e.g., " * ")
 * @returns The formatted code with JSDoc prefixes
 */
function formatCodeLines(code: string, linePrefix: string): string {
  const lines = code.split('\n');
  return lines
    .map((line) =>
      line === '' ? linePrefix.trimEnd() : `${linePrefix}${line}`,
    )
    .join('\n');
}

interface ProcessFileOptions {
  check?: boolean;
}

/**
 * Process a single source file to sync snippets.
 * @param filePath The source file path
 * @param cache The region cache
 * @param mode The processing mode (jsdoc or markdown)
 * @returns The processing result
 */
function processFile(
  filePath: string,
  cache: RegionCache,
  mode: FileMode,
  options?: ProcessFileOptions,
): FileProcessingResult {
  const result: FileProcessingResult = {
    filePath,
    modified: false,
    snippetsProcessed: 0,
    errors: [],
  };

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    result.errors.push(`Failed to read file: ${err}`);
    return result;
  }

  let fences: LabeledCodeFence[];
  try {
    fences = findLabeledCodeFences(content, filePath, mode);
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
    return result;
  }

  if (fences.length === 0) {
    return result;
  }

  const originalContent = content;

  // Process fences in reverse order to preserve positions
  for (let i = fences.length - 1; i >= 0; i--) {
    const fence = fences[i];

    try {
      const code = getOrLoadRegion(
        filePath,
        fence.examplePath,
        fence.regionName,
        cache,
      );

      const formattedCode = formatCodeLines(code, fence.linePrefix);

      // Replace content between opening fence end and closing fence start
      content =
        content.slice(0, fence.openingFenceEnd) +
        formattedCode +
        '\n' +
        content.slice(fence.closingFenceStart);

      result.snippetsProcessed++;
    } catch (err) {
      result.errors.push(
        `${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (
    result.snippetsProcessed > 0 &&
    result.errors.length === 0 &&
    content !== originalContent
  ) {
    if (!options?.check) {
      writeFileSync(filePath, content);
    }
    result.modified = true;
  }

  return result;
}

/**
 * Find all TypeScript source files in a directory, excluding examples, tests, and generated files.
 * @param dir The directory to search
 * @returns Array of absolute file paths
 */
function findSourceFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true, recursive: true });

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const name = entry.name;

    // Only process .ts files
    if (!name.endsWith('.ts')) continue;

    // Exclude example files, test files
    if (name.endsWith('.examples.ts')) continue;
    if (name.endsWith('.test.ts')) continue;

    // Get the relative path from the parent directory
    const parentPath = entry.parentPath;

    // Exclude generated directory
    if (parentPath.includes('/generated') || parentPath.includes('\\generated'))
      continue;

    const fullPath = join(parentPath, name);
    files.push(fullPath);
  }

  return files;
}

/**
 * Find all markdown files in a directory.
 * @param dir The directory to search
 * @returns Array of absolute file paths
 */
function findMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true, recursive: true });

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    // Only process .md files
    if (!entry.name.endsWith('.md')) continue;

    const fullPath = join(entry.parentPath, entry.name);
    files.push(fullPath);
  }

  return files;
}

/**
 * Find all package src directories under the packages directory.
 * @param packagesDir The packages directory
 * @returns Array of absolute paths to src directories
 */
function findPackageSrcDirs(packagesDir: string): string[] {
  const srcDirs: string[] = [];
  const entries = readdirSync(packagesDir, {
    withFileTypes: true,
    recursive: true,
  });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name !== 'src') continue;

    const fullPath = join(entry.parentPath, entry.name);

    // Only include src dirs that are direct children of a package
    // (e.g., packages/core/src, packages/middleware/express/src)
    // Skip nested src dirs like node_modules/*/src
    if (fullPath.includes('node_modules')) continue;

    srcDirs.push(fullPath);
  }

  return srcDirs;
}

async function main() {
  const checkMode = process.argv.includes('--check');
  console.log(
    checkMode
      ? 'Checking code snippets are in sync...\n'
      : 'Syncing code snippets from example files...\n',
  );

  const cache: RegionCache = new Map();
  const results: FileProcessingResult[] = [];

  // Process TypeScript source files (JSDoc mode) across all packages
  const packageSrcDirs = findPackageSrcDirs(PACKAGES_DIR);
  for (const srcDir of packageSrcDirs) {
    const sourceFiles = findSourceFiles(srcDir);
    for (const filePath of sourceFiles) {
      const result = processFile(filePath, cache, 'jsdoc', { check: checkMode });
      results.push(result);
    }
  }

  // Process markdown documentation files
  const markdownFiles = findMarkdownFiles(DOCS_DIR);
  for (const filePath of markdownFiles) {
    const result = processFile(filePath, cache, 'markdown', { check: checkMode });
    results.push(result);
  }

  // Report results
  const modified = results.filter((r) => r.modified);
  const errors = results.flatMap((r) => r.errors);

  if (modified.length > 0) {
    if (checkMode) {
      console.error(`${modified.length} file(s) out of sync:`);
    } else {
      console.log(`Modified ${modified.length} file(s):`);
    }
    for (const r of modified) {
      console.log(`   ${r.filePath} (${r.snippetsProcessed} snippet(s))`);
    }
  } else {
    console.log('All snippets are up to date');
  }

  if (errors.length > 0) {
    console.error('\nErrors:');
    for (const error of errors) {
      console.error(`   ${error}`);
    }
    process.exit(1);
  }

  if (checkMode && modified.length > 0) {
    console.error('\nRun "pnpm sync:snippets" to fix.');
    process.exit(1);
  }

  console.log('\nSnippet sync complete!');
}

main().catch((error) => {
  console.error('Snippet sync failed:', error);
  process.exit(1);
});
