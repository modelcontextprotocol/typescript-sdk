export interface ContextMapping {
    from: string;
    to: string;
}

export const CONTEXT_PROPERTY_MAP: ContextMapping[] = [
    { from: '.signal', to: '.mcpReq.signal' },
    { from: '.requestId', to: '.mcpReq.id' },
    { from: '._meta', to: '.mcpReq._meta' },
    { from: '.sendRequest', to: '.mcpReq.send' },
    { from: '.sendNotification', to: '.mcpReq.notify' },
    { from: '.authInfo', to: '.http?.authInfo' },
    { from: '.sessionId', to: '.sessionId' },
    { from: '.requestInfo', to: '.http?.req' },
    { from: '.closeSSEStream', to: '.http?.closeSSE' },
    { from: '.closeStandaloneSSEStream', to: '.http?.closeStandaloneSSE' },
    { from: '.taskStore', to: '.task?.store' },
    { from: '.taskId', to: '.task?.id' },
    { from: '.taskRequestedTtl', to: '.task?.requestedTtl' }
];

export const EXTRA_PARAM_NAME = 'extra';
export const CTX_PARAM_NAME = 'ctx';
