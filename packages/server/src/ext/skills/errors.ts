import type { SkillWarning } from './types';

/** Thrown when a skill catalog cannot be built: storage failures always, skill problems under `strict`. */
export class SkillCatalogError extends Error {
    readonly problems: readonly SkillWarning[];

    constructor(problems: readonly SkillWarning[]) {
        const lines = problems.map(problem => `  ${problem.path}: ${problem.message}`).join('\n');
        super(`${problems.length} skill problem${problems.length === 1 ? '' : 's'}:\n${lines}`);
        this.name = 'SkillCatalogError';
        this.problems = problems;
    }
}

/** Default warning sink: stderr, so it never corrupts a stdio transport. */
export function defaultWarn(warning: SkillWarning): void {
    // eslint-disable-next-line no-console -- the documented default sink for skills warnings
    console.warn(`[mcp-sdk] skills: ${warning.path}: ${warning.message}`);
}
