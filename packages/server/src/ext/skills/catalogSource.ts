import { ProtocolError, ProtocolErrorCode, ResourceNotFoundError } from '@modelcontextprotocol/core-internal';
import { canonicalUri, decodeUtf8Lossless, sha256Digest } from '@modelcontextprotocol/core-internal/ext/skills';

import type { CatalogSnapshot } from './catalogBuild';
import { trustedSources } from './internal';
import { paginate } from './paging';
import type { SkillFiles, SkillReadResult, SkillSource, SkillWarning } from './types';

// `reload()` swaps `current` in one assignment.
export interface CatalogState {
    current: CatalogSnapshot;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// A trusted source: the SDK built and checked the snapshot's entries.
export function catalogSource(
    state: CatalogState,
    files: SkillFiles,
    pageSize: number,
    warn: (warning: SkillWarning) => void
): SkillSource {
    const source: SkillSource = {
        async list({ cursor }) {
            const page = paginate(state.current.ordered, cursor, pageSize, skill => skill.uri);
            return page.nextCursor === undefined ? { skills: page.items } : { skills: page.items, nextCursor: page.nextCursor };
        },
        async get(uri) {
            const canonical = canonicalUri(uri);
            return canonical === undefined ? undefined : state.current.skills.get(canonical);
        },
        read: uri => readChecked(state.current, files, uri, warn),
        async readDirectory(uri, { cursor }) {
            const canonical = canonicalUri(uri);
            const children = canonical === undefined ? undefined : state.current.dirs.get(canonical);
            if (children === undefined) return;
            const page = paginate(children, cursor, pageSize, child => child.uri);
            return page.nextCursor === undefined ? { resources: page.items } : { resources: page.items, nextCursor: page.nextCursor };
        },
        async listResources() {
            return [...state.current.listed];
        }
    };
    trustedSources.add(source);
    return source;
}

// Reads a published file through the adapter and serves it only if it still matches its entry.
async function readChecked(
    snapshot: CatalogSnapshot,
    files: SkillFiles,
    uri: string,
    warn: (warning: SkillWarning) => void
): Promise<SkillReadResult | undefined> {
    const canonical = canonicalUri(uri);
    const file = canonical === undefined ? undefined : snapshot.files.get(canonical);
    if (file === undefined) {
        if (canonical !== undefined && snapshot.dirs.has(canonical)) {
            throw new ResourceNotFoundError(uri, `${uri} is a directory; use resources/directory/read`);
        }
        return undefined;
    }
    let bytes: Uint8Array;
    try {
        bytes = await files.read(file.path);
    } catch (error) {
        warn({ path: file.path, message: `could not be read: ${errorText(error)}` });
        throw new ProtocolError(ProtocolErrorCode.InternalError, `${uri} could not be read`);
    }
    if (bytes.byteLength !== file.size || (await sha256Digest(bytes)) !== file.digest) {
        warn({ path: file.path, message: 'changed since the catalog was loaded; call reload()' });
        throw new ProtocolError(ProtocolErrorCode.InternalError, `${uri} changed since the skills catalog was loaded`);
    }
    // Spec §5: `text` whenever the bytes decode losslessly as UTF-8, whatever the MIME type; otherwise a base64 `blob`.
    const text = decodeUtf8Lossless(bytes);
    return text === undefined ? { bytes, mimeType: file.mimeType } : { text, mimeType: file.mimeType };
}
