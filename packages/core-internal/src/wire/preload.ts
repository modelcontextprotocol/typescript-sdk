/**
 * Explicit warm-up entry for the lazy wire-schema layers.
 *
 * The per-revision wire schemas are built lazily: each era's schema set sits
 * behind a memoized factory (`buildSchemas2025`/`buildSchemas2026`), and the
 * registry/codec lookup maps above those factories are memoized the same way.
 * That laziness is the right default on process-per-invocation runtimes (CLI
 * tools, dev servers), where module evaluation IS startup latency and most
 * short-lived processes never validate a message on both eras.
 *
 * On platforms that bill request CPU but not module evaluation — isolate-based
 * edge/serverless runtimes such as Cloudflare Workers — the trade inverts:
 * module-scope work runs during isolate warm-up outside any request, while
 * lazy construction lands inside the first request's billed (and latency
 * budgeted) CPU. `preloadSchemas()` lets deployments on such platforms move
 * the one-time construction cost back to module scope by calling it at module
 * scope themselves. The packages' own workerd shims already do this, so
 * Workers deployments get eager construction automatically.
 */
import { buildSchemas2025 } from './rev2025-11-25/buildSchemas';
import { warmRegistryMaps2025 } from './rev2025-11-25/registry';
import { buildSchemas2026 } from './rev2026-07-28/buildSchemas';
import { warmWireResultSchemas2026 } from './rev2026-07-28/codec';
import { warmInputSchemaMaps2026 } from './rev2026-07-28/inputRequired';

/**
 * Eagerly builds every lazily-constructed wire-schema layer, so that no later
 * validation pays schema-construction cost.
 *
 * Synchronous and idempotent: every layer is a memo, so the first call does
 * all the work and subsequent calls return immediately. Reference identity is
 * unaffected — this forces the same memos every lazy consumer pulls through.
 *
 * Call it at module scope on platforms that bill per-request CPU but not
 * module evaluation (isolate-based edge/serverless runtimes), where deferring
 * construction would move it into the first request of every fresh isolate:
 *
 * ```ts
 * // from '@modelcontextprotocol/server' or '@modelcontextprotocol/client' —
 * // each package bundles its own schema copy, so warm the one(s) you import.
 * preloadSchemas(); // module scope — runs during isolate warm-up
 * ```
 *
 * On Node CLIs and other process-per-invocation runtimes, prefer the lazy
 * default — there, module-scope construction is pure added boot latency.
 */
export function preloadSchemas(): void {
    // The era schema factories — the bulk of the construction cost.
    buildSchemas2025();
    buildSchemas2026();
    // The memoized lookup layers above the factories. (The 2026 registry has
    // no map memo of its own — it reads the dispatch maps straight off the
    // built schema set.)
    warmRegistryMaps2025();
    warmInputSchemaMaps2026();
    warmWireResultSchemas2026();
}
