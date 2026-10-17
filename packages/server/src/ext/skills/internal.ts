import type { SkillSource } from './types';

/** Sources whose entries the SDK built itself and so does not re-validate per request. Package-internal. */
export const trustedSources = new WeakSet<SkillSource>();
