/**
 * Content Formatting Helpers
 *
 * Utilities for working with tool call results and content types.
 * Reduces boilerplate when processing mixed content types in results.
 */

import type {
    AudioContent,
    BlobResourceContents,
    ContentBlock,
    EmbeddedResource,
    ImageContent,
    ResourceLink,
    TextContent,
    TextResourceContents
} from '../types/types.js';

/**
 * Type guard to check if content is TextContent
 */
export function isTextContent(item: ContentBlock): item is TextContent {
    return item.type === 'text';
}

/**
 * Type guard to check if content is ImageContent
 */
export function isImageContent(item: ContentBlock): item is ImageContent {
    return item.type === 'image';
}

/**
 * Type guard to check if content is AudioContent
 */
export function isAudioContent(item: ContentBlock): item is AudioContent {
    return item.type === 'audio';
}

/**
 * Type guard to check if content is EmbeddedResource
 */
export function isEmbeddedResource(item: ContentBlock): item is EmbeddedResource {
    return item.type === 'resource';
}

/**
 * Type guard to check if content is ResourceLink
 */
export function isResourceLink(item: ContentBlock): item is ResourceLink {
    return item.type === 'resource_link';
}

/**
 * Extracts all text content from a tool result content array.
 *
 * @example
 * ```typescript
 * const result = await client.callTool('search', { query: 'hello' });
 * const texts = extractTextContent(result.content);
 * console.log(texts.join('\n'));
 * ```
 */
export function extractTextContent(content: ContentBlock[]): string[] {
    return content.filter(item => isTextContent(item)).map(item => item.text);
}

/**
 * Formats all text content from a tool result as a single string.
 *
 * @param content - The content array from a tool result
 * @param separator - Separator between text items (default: newline)
 * @returns Concatenated text content
 *
 * @example
 * ```typescript
 * const result = await client.callTool('search', { query: 'hello' });
 * const text = formatTextContent(result.content);
 * ```
 */
export function formatTextContent(content: ContentBlock[], separator: string = '\n'): string {
    return extractTextContent(content).join(separator);
}

/**
 * Extracts all image content from a tool result content array.
 */
export function extractImageContent(content: ContentBlock[]): ImageContent[] {
    return content.filter(item => isImageContent(item));
}

/**
 * Extracts all audio content from a tool result content array.
 */
export function extractAudioContent(content: ContentBlock[]): AudioContent[] {
    return content.filter(item => isAudioContent(item));
}

/**
 * Extracts all embedded resources from a tool result content array.
 */
export function extractEmbeddedResources(content: ContentBlock[]): EmbeddedResource[] {
    return content.filter(item => isEmbeddedResource(item));
}

/**
 * Extracts all resource links from a tool result content array.
 */
export function extractResourceLinks(content: ContentBlock[]): ResourceLink[] {
    return content.filter(item => isResourceLink(item));
}

/**
 * Creates a text content item.
 *
 * @example
 * ```typescript
 * return { content: [text('Hello, world!')] };
 * ```
 */
export function text(content: string, annotations?: TextContent['annotations']): TextContent {
    return {
        type: 'text',
        text: content,
        annotations
    };
}

/**
 * Creates an image content item from base64 data.
 *
 * @example
 * ```typescript
 * return { content: [image(base64Data, 'image/png')] };
 * ```
 */
export function image(data: string, mimeType: string, annotations?: ImageContent['annotations']): ImageContent {
    return {
        type: 'image',
        data,
        mimeType,
        annotations
    };
}

/**
 * Creates an audio content item from base64 data.
 *
 * @example
 * ```typescript
 * return { content: [audio(base64Data, 'audio/wav')] };
 * ```
 */
export function audio(data: string, mimeType: string, annotations?: AudioContent['annotations']): AudioContent {
    return {
        type: 'audio',
        data,
        mimeType,
        annotations
    };
}

/**
 * Creates an embedded resource content item.
 *
 * @example
 * ```typescript
 * return {
 *   content: [
 *     embeddedResource({
 *       uri: 'file:///path/to/file.txt',
 *       mimeType: 'text/plain',
 *       text: 'File contents'
 *     })
 *   ]
 * };
 * ```
 */
export function embeddedResource(
    resource: TextResourceContents | BlobResourceContents,
    annotations?: EmbeddedResource['annotations']
): EmbeddedResource {
    return {
        type: 'resource',
        resource,
        annotations
    };
}

/**
 * Creates a resource link content item.
 *
 * @example
 * ```typescript
 * return {
 *   content: [
 *     resourceLink({
 *       uri: 'file:///path/to/file.txt',
 *       mimeType: 'text/plain',
 *       name: 'file.txt'
 *     })
 *   ]
 * };
 * ```
 */
export function resourceLink(link: Omit<ResourceLink, 'type'>): ResourceLink {
    return {
        type: 'resource_link',
        ...link
    };
}
