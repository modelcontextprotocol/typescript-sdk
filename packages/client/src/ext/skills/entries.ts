import type { Skill } from '@modelcontextprotocol/core/ext/skills';
import { SkillSchema } from '@modelcontextprotocol/core/ext/skills';
import { canonicalUri, validateSkillEntry } from '@modelcontextprotocol/core-internal/ext/skills';

/** A `skills/list` entry the client refused, and why. `index` counts across every page walked. */
export interface InvalidSkillEntry {
    index: number;
    uri?: string;
    reason: string;
}

export interface CheckedEntry {
    skill?: Skill;
    uri?: string;
    problems: string[];
}

/** Schema and rule checks for one entry received from a server. */
export function checkEntry(value: unknown): CheckedEntry {
    const raw = (value as { uri?: unknown } | null | undefined)?.uri;
    const uri = typeof raw === 'string' ? raw : undefined;
    const parsed = SkillSchema.safeParse(value);
    if (!parsed.success) {
        return { uri, problems: parsed.error.issues.map(issue => `${issue.path.join('.') || '(entry)'}: ${issue.message}`) };
    }
    return { skill: parsed.data, uri, problems: validateSkillEntry(parsed.data) };
}

function keyOf(entry: CheckedEntry): string | undefined {
    return entry.uri === undefined ? undefined : (canonicalUri(entry.uri) ?? entry.uri);
}

/** Splits listing entries into valid skills and refused entries. Every copy of a repeated URI is refused. */
export function partitionEntries(values: readonly unknown[]): { skills: Skill[]; invalid: InvalidSkillEntry[] } {
    const checked = values.map(value => checkEntry(value));
    const counts = new Map<string, number>();
    for (const entry of checked) {
        const key = keyOf(entry);
        if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const skills: Skill[] = [];
    const invalid: InvalidSkillEntry[] = [];
    for (const [index, entry] of checked.entries()) {
        const key = keyOf(entry);
        const repeated = key !== undefined && (counts.get(key) ?? 0) > 1;
        const problems = repeated ? [...entry.problems, 'the same uri is listed more than once'] : entry.problems;
        if (entry.skill !== undefined && problems.length === 0) skills.push(entry.skill);
        else invalid.push({ index, ...(entry.uri !== undefined && { uri: entry.uri }), reason: problems.join('; ') });
    }
    return { skills, invalid };
}
