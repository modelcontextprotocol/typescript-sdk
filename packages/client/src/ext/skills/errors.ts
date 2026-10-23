import { SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal/public';

/** Why a skill file failed verification. */
export type SkillVerificationReason = 'unlisted' | 'size' | 'digest' | 'frontmatter';

/**
 * A skill file failed verification against its skill entry: not listed,
 * wrong size, wrong digest, or (for `SKILL.md`) frontmatter that differs from
 * the entry. Hosts must not load the file; for `SKILL.md`, not the skill.
 */
export class SkillVerificationError extends SdkError {
    static {
        Object.defineProperty(this, 'mcpBrand', { value: 'mcp.SkillVerificationError' });
    }

    readonly reason: SkillVerificationReason;
    readonly uri: string;
    /** For `frontmatter`: one line per differing field. */
    readonly differences: readonly string[];

    constructor(
        reason: SkillVerificationReason,
        uri: string,
        message: string,
        differences: readonly string[] = [],
        options?: ErrorOptions
    ) {
        super(SdkErrorCode.InvalidResult, message, { reason, uri, differences }, options);
        this.name = 'SkillVerificationError';
        this.reason = reason;
        this.uri = uri;
        this.differences = differences;
    }
}
