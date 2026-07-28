import type { CallToolResult, ContentBlock, ReadResourceResult } from '@modelcontextprotocol/client';

import type { ContentPart } from '../providers/provider';
import { partsToText } from '../providers/provider';

/**
 * How much server-provided text the model gets to see is a host policy, not an SDK or
 * protocol concern. cli-client applies one cap to everything it injects (tool results and
 * attached resources alike).
 */
export const MAX_INJECTED_CHARS = 50_000;

/**
 * Strip terminal escape sequences and stray control characters from server-provided text
 * before rendering it: CSI sequences (colors, cursor movement), OSC sequences (window titles,
 * hyperlinks), other ESC-introduced sequences, and any remaining C0 controls except tab,
 * newline, and carriage return. Servers are not trusted to write to the user's terminal.
 */
const TERMINAL_ESCAPES =
    // eslint-disable-next-line no-control-regex
    /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|\u001B[@-Z\\^_]|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function stripAnsi(text: string): string {
    return text.replaceAll(TERMINAL_ESCAPES, '');
}

export function truncate(text: string, limit: number = MAX_INJECTED_CHARS): string {
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n[truncated ${text.length - limit} characters — cli-client caps injected content at ${limit} characters]`;
}

/**
 * Convert one MCP content block into provider content parts.
 *
 * Text and images pass through; audio, resource links, and binary embedded resources are
 * reduced to placeholders the model can reason about. This is the narrowing every host
 * writes — note there are five block types, not just text.
 */
export function contentBlockToParts(block: ContentBlock): ContentPart[] {
    switch (block.type) {
        case 'text': {
            return [{ type: 'text', text: truncate(block.text) }];
        }
        case 'image': {
            return [{ type: 'image', mimeType: block.mimeType, data: block.data }];
        }
        case 'audio': {
            return [{ type: 'text', text: `[audio content: ${block.mimeType}]` }];
        }
        case 'resource_link': {
            return [{ type: 'text', text: `[linked resource: ${block.uri}${block.description ? ` — ${block.description}` : ''}]` }];
        }
        case 'resource': {
            if ('text' in block.resource) {
                return [{ type: 'text', text: truncate(`[embedded resource ${block.resource.uri}]\n${block.resource.text}`) }];
            }
            return [{ type: 'text', text: `[binary resource ${block.resource.uri}: ${block.resource.mimeType ?? 'unknown type'}]` }];
        }
        default: {
            return [{ type: 'text', text: '[unsupported content block]' }];
        }
    }
}

/** Convert MCP tool-result content into provider content parts (empty results get a placeholder). */
export function toolResultToParts(result: CallToolResult): ContentPart[] {
    const parts = result.content.flatMap(block => contentBlockToParts(block));
    if (parts.length === 0) {
        parts.push({ type: 'text', text: '(tool returned no content)' });
    }
    return parts;
}

/**
 * Render a read resource as a context block for the conversation, with explicit provenance
 * (which server, which URI) and an instruction not to re-fetch — so the model can cite where
 * the content came from and does not burn a tool round re-reading it.
 */
export function resourceToContextText(serverName: string, uri: string, result: ReadResourceResult): string {
    const rendered = result.contents
        .map(item =>
            'text' in item
                ? item.text
                : `[binary content ${item.mimeType ?? 'unknown type'}, ${Math.ceil((item.blob.length * 3) / 4)} bytes]`
        )
        .join('\n');
    return [
        `<attached-resource server="${serverName}" uri="${uri}">`,
        truncate(rendered),
        '</attached-resource>',
        'The user attached this MCP resource as context. Use it to answer; do not re-read it unless told it changed.'
    ].join('\n');
}

/** One-line rendering of content parts for the terminal (status output, not the model). */
export function partsToDisplayText(parts: ContentPart[]): string {
    return stripAnsi(partsToText(parts).replaceAll('\n', ' ')).trim();
}
