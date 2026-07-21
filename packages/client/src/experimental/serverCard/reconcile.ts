import type { ServerCard, ServerCardRemote } from '@modelcontextprotocol/core/experimental/server-card';
import type { Implementation } from '@modelcontextprotocol/core-internal';

/**
 * One disagreement between a Server Card claim and the live connection.
 * Runtime always wins; the card was advisory.
 */
export interface ServerCardMismatch {
    /** The disagreeing field. */
    field: 'name' | 'version' | 'title' | 'websiteUrl' | 'protocolVersion';
    /** What the card claimed. */
    cardValue: string | undefined;
    /** What the live connection reported. */
    runtimeValue: string | undefined;
}

/**
 * Post-connect advisory check: compares a card's claims against the live
 * connection's `serverInfo`, per the spec's requirement that clients verify
 * card claims and prefer runtime values on disagreement.
 *
 * Returns a diff and never a merged card, so there is nothing to accidentally
 * treat as authoritative. Never throws; returns `[]` on agreement. Optional
 * card fields are compared only when the card states them. A
 * `'protocolVersion'` mismatch is reported when
 * `options.negotiatedProtocolVersion` is given and the remote declares
 * `supportedProtocolVersions` that do not include it.
 *
 * `name` is compared verbatim: a card's `name` is the namespaced form
 * (`'com.example/weather'`), so a server whose `serverInfo.name` is the bare
 * unqualified name reports an advisory `'name'` mismatch. Per the extension
 * spec the two are expected to match exactly; treat the mismatch as the
 * card and the server disagreeing, not as a false positive.
 *
 * Deliberately not wired into `Client.connect`: cards must not gate
 * anything.
 */
export function reconcileServerCard(
    card: ServerCard,
    serverInfo: Implementation,
    options?: { remote?: ServerCardRemote; negotiatedProtocolVersion?: string }
): ServerCardMismatch[] {
    const mismatches: ServerCardMismatch[] = [];
    if (card.name !== serverInfo.name) {
        mismatches.push({ field: 'name', cardValue: card.name, runtimeValue: serverInfo.name });
    }
    if (card.version !== serverInfo.version) {
        mismatches.push({ field: 'version', cardValue: card.version, runtimeValue: serverInfo.version });
    }
    if (card.title !== undefined && card.title !== serverInfo.title) {
        mismatches.push({ field: 'title', cardValue: card.title, runtimeValue: serverInfo.title });
    }
    if (card.websiteUrl !== undefined && card.websiteUrl !== serverInfo.websiteUrl) {
        mismatches.push({ field: 'websiteUrl', cardValue: card.websiteUrl, runtimeValue: serverInfo.websiteUrl });
    }
    const supported = options?.remote?.supportedProtocolVersions;
    if (
        options?.negotiatedProtocolVersion !== undefined &&
        supported !== undefined &&
        !supported.includes(options.negotiatedProtocolVersion)
    ) {
        mismatches.push({
            field: 'protocolVersion',
            cardValue: supported.join(', '),
            runtimeValue: options.negotiatedProtocolVersion
        });
    }
    return mismatches;
}
