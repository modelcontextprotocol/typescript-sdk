import type { CallToolResult } from '../types/types.js';

/**
 * SEP-2106 §4.3 TextContent auto-append, era-agnostic, called from BOTH
 * codecs' {@link WireCodec.projectCallToolResult}: when `structuredContent`
 * is a non-object value (array/primitive/`null`) and the handler authored no
 * `type:'text'` block, append `{type:'text', text: JSON.stringify(value)}`.
 * Object-shaped (or absent) `structuredContent` returns the same reference.
 *
 * Leaf module: imported by both era codec modules, so it must NOT import from
 * `./codec.js` (which value-imports the rev codecs at top level — that would
 * make a runtime cycle and a TDZ hazard for entries that evaluate a rev codec
 * module first).
 */
export function appendTextFallbackForNonObject(result: CallToolResult): CallToolResult {
    const sc = result.structuredContent;
    if (sc === undefined) return result;
    const isNonObjectValue = typeof sc !== 'object' || sc === null || Array.isArray(sc);
    if (!isNonObjectValue) return result;
    const hasTextContent = result.content?.some(c => c.type === 'text') ?? false;
    if (hasTextContent) return result;
    return { ...result, content: [...(result.content ?? []), { type: 'text' as const, text: JSON.stringify(sc) }] };
}
