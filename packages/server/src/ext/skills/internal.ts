import type { SkillSource } from './types';

// Sources whose entries the SDK built itself, so they are not re-validated per request.
export const trustedSources = new WeakSet<SkillSource>();
