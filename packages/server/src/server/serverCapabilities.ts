import type { ClientCapabilities, NotificationMethod, RequestMethod, ServerCapabilities } from '@modelcontextprotocol/core';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/core';

/**
 * Throws if the connected client does not advertise the capability required
 * for the server to send the given outbound request.
 */
export function assertCapabilityForMethod(method: RequestMethod, clientCapabilities: ClientCapabilities | undefined): void {
    switch (method) {
        case 'sampling/createMessage': {
            if (!clientCapabilities?.sampling) {
                throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Client does not support sampling (required for ${method})`);
            }
            break;
        }
        case 'elicitation/create': {
            if (!clientCapabilities?.elicitation) {
                throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Client does not support elicitation (required for ${method})`);
            }
            break;
        }
        case 'roots/list': {
            if (!clientCapabilities?.roots) {
                throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Client does not support listing roots (required for ${method})`);
            }
            break;
        }
    }
}

/**
 * Throws if either side lacks the capability required for the server to emit
 * the given notification.
 */
export function assertNotificationCapability(
    method: NotificationMethod,
    serverCapabilities: ServerCapabilities,
    clientCapabilities: ClientCapabilities | undefined
): void {
    switch (method) {
        case 'notifications/message': {
            if (!serverCapabilities.logging) {
                throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support logging (required for ${method})`);
            }
            break;
        }
        case 'notifications/resources/updated':
        case 'notifications/resources/list_changed': {
            if (!serverCapabilities.resources) {
                throw new SdkError(
                    SdkErrorCode.CapabilityNotSupported,
                    `Server does not support notifying about resources (required for ${method})`
                );
            }
            break;
        }
        case 'notifications/tools/list_changed': {
            if (!serverCapabilities.tools) {
                throw new SdkError(
                    SdkErrorCode.CapabilityNotSupported,
                    `Server does not support notifying of tool list changes (required for ${method})`
                );
            }
            break;
        }
        case 'notifications/prompts/list_changed': {
            if (!serverCapabilities.prompts) {
                throw new SdkError(
                    SdkErrorCode.CapabilityNotSupported,
                    `Server does not support notifying of prompt list changes (required for ${method})`
                );
            }
            break;
        }
        case 'notifications/elicitation/complete': {
            if (!clientCapabilities?.elicitation?.url) {
                throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Client does not support URL elicitation (required for ${method})`);
            }
            break;
        }
    }
}

/**
 * Throws if the server does not advertise the capability required to register
 * a handler for the given inbound request method.
 */
export function assertRequestHandlerCapability(method: string, serverCapabilities: ServerCapabilities): void {
    switch (method) {
        case 'completion/complete': {
            if (!serverCapabilities.completions) {
                throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support completions (required for ${method})`);
            }
            break;
        }
        case 'logging/setLevel': {
            if (!serverCapabilities.logging) {
                throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support logging (required for ${method})`);
            }
            break;
        }
        case 'prompts/get':
        case 'prompts/list': {
            if (!serverCapabilities.prompts) {
                throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support prompts (required for ${method})`);
            }
            break;
        }
        case 'resources/list':
        case 'resources/templates/list':
        case 'resources/read':
        case 'resources/subscribe':
        case 'resources/unsubscribe': {
            if (!serverCapabilities.resources) {
                throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support resources (required for ${method})`);
            }
            break;
        }
        case 'tools/call':
        case 'tools/list': {
            if (!serverCapabilities.tools) {
                throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support tools (required for ${method})`);
            }
            break;
        }
    }
}
