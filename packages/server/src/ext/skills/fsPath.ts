import { splitRelativePath } from './files';

// The parts of `node:path` the containment rule needs: `path`, `path.win32` and `path.posix` all fit.
export interface PathRules {
    readonly sep: string;
    join(...paths: string[]): string;
    relative(from: string, to: string): string;
    isAbsolute(path: string): boolean;
}

const escapes = (relative: string): TypeError =>
    new TypeError(`path must be a relative path that stays inside the skills folder (got ${JSON.stringify(relative)})`);

// Where adapter path `relative` is under `base`; a TypeError for any path that could leave it, by the platform's `rules`.
export function fsPathWithin(rules: PathRules, base: string, relative: string): string {
    if (relative === '') return base;
    const segments = splitRelativePath(relative, 'path');
    if (segments.some(segment => segment.split(rules.sep).includes('..'))) throw escapes(relative);
    const full = rules.join(base, ...segments);
    const inside = rules.relative(base, full);
    if (inside === '..' || inside.startsWith(`..${rules.sep}`) || rules.isAbsolute(inside)) throw escapes(relative);
    return full;
}
