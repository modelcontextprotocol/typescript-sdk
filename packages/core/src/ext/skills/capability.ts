import { SKILLS_EXTENSION_ID } from './constants';
import { SkillsCapabilitySchema } from './schemas';
import type { SkillsCapability } from './types';

/**
 * The shape this module reads capabilities out of. Declared structurally so
 * the helper stays in the runtime-neutral core package: the nominal
 * `ServerCapabilities` type lives downstream, and every value of it satisfies
 * this.
 */
export interface CapabilitiesWithExtensions {
    extensions?: Record<string, unknown>;
}

/**
 * Reads the Skills extension capability out of a peer's advertised
 * capabilities, returning `undefined` when the peer does not advertise the
 * extension or advertises a malformed value.
 *
 * Shared by both roles: servers use it to check what they published, clients
 * to gate `skills/list` / `skills/get` on negotiation.
 */
export function skillsCapabilityOf(capabilities: CapabilitiesWithExtensions | undefined): SkillsCapability | undefined {
    const declared = capabilities?.extensions?.[SKILLS_EXTENSION_ID];
    if (declared === undefined) {
        return undefined;
    }
    const parsed = SkillsCapabilitySchema.safeParse(declared);
    return parsed.success ? parsed.data : undefined;
}
