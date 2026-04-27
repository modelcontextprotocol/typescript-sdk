import type { ListResourcesResult, ServerContext } from '@modelcontextprotocol/core';
import { UriTemplate } from '@modelcontextprotocol/core';

/**
 * A callback to list all resources matching a template.
 */
export type ListResourcesCallback = (ctx: ServerContext) => ListResourcesResult | Promise<ListResourcesResult>;

/**
 * A callback to complete one variable within a resource template's URI template.
 */
export type CompleteResourceTemplateCallback = (
    value: string,
    context?: { arguments?: Record<string, string> }
) => string[] | Promise<string[]>;

/**
 * A resource template combines a URI pattern with optional functionality to enumerate
 * all resources matching that pattern.
 */
export class ResourceTemplate {
    private _uriTemplate: UriTemplate;

    constructor(
        uriTemplate: string | UriTemplate,
        private _callbacks: {
            list: ListResourcesCallback | undefined;
            complete?: { [variable: string]: CompleteResourceTemplateCallback };
        }
    ) {
        this._uriTemplate = typeof uriTemplate === 'string' ? new UriTemplate(uriTemplate) : uriTemplate;
    }

    get uriTemplate(): UriTemplate {
        return this._uriTemplate;
    }

    get listCallback(): ListResourcesCallback | undefined {
        return this._callbacks.list;
    }

    completeCallback(variable: string): CompleteResourceTemplateCallback | undefined {
        return this._callbacks.complete?.[variable];
    }
}
