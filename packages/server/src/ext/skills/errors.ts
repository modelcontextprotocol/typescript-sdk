import { brandedHasInstance, stampErrorBrands } from '@modelcontextprotocol/core-internal';

import type { SkillWarning } from './types';

/**
 * Thrown when a skill catalog cannot be built: storage failures always, skill problems under `strict`.
 * Branded, so `instanceof` also matches an instance from another bundled copy of the SDK.
 */
export class SkillCatalogError extends Error {
    static {
        Object.defineProperty(this, 'mcpBrand', { value: 'mcp.SkillCatalogError' });
    }

    static override [Symbol.hasInstance](value: unknown): boolean {
        return brandedHasInstance(this, value);
    }

    /**
     * Brand-based type guard: equivalent to `value instanceof this`, as an
     * explicit static predicate (the axios/AWS-SDK `isInstance` style). Must be
     * invoked on the class — in callback position write
     * `v => SkillCatalogError.isInstance(v)`, not `.filter(SkillCatalogError.isInstance)`.
     */
    static isInstance<T extends abstract new (...args: never[]) => unknown>(this: T, value: unknown): value is InstanceType<T> {
        if (typeof this !== 'function') {
            throw new TypeError(
                'isInstance must be called on the class (e.g. `SkillCatalogError.isInstance(value)`); for callbacks use `v => SkillCatalogError.isInstance(v)`'
            );
        }
        return brandedHasInstance(this, value);
    }

    readonly problems: readonly SkillWarning[];

    constructor(problems: readonly SkillWarning[]) {
        const lines = problems.map(problem => `  ${problem.path}: ${problem.message}`).join('\n');
        super(`${problems.length} skill problem${problems.length === 1 ? '' : 's'}:\n${lines}`);
        this.name = 'SkillCatalogError';
        this.problems = problems;
        stampErrorBrands(this, new.target);
    }
}

// Stderr, so a warning never corrupts a stdio transport.
export function defaultWarn(warning: SkillWarning): void {
    // eslint-disable-next-line no-console -- the documented default sink for skills warnings
    console.warn(`[mcp-sdk] skills: ${warning.path}: ${warning.message}`);
}
