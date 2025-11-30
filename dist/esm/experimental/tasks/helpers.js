/**
 * Experimental task capability assertion helpers.
 * WARNING: These APIs are experimental and may change without notice.
 *
 * @experimental
 */
/**
 * Asserts that task creation is supported for tools/call.
 * Used by Client.assertTaskCapability and Server.assertTaskHandlerCapability.
 *
 * @param requests - The task requests capability object
 * @param method - The method being checked
 * @param entityName - 'Server' or 'Client' for error messages
 * @throws Error if the capability is not supported
 *
 * @experimental
 */
export function assertToolsCallTaskCapability(requests, method, entityName) {
    var _a;
    if (!requests) {
        throw new Error(`${entityName} does not support task creation (required for ${method})`);
    }
    switch (method) {
        case 'tools/call':
            if (!((_a = requests.tools) === null || _a === void 0 ? void 0 : _a.call)) {
                throw new Error(`${entityName} does not support task creation for tools/call (required for ${method})`);
            }
            break;
        default:
            // Method doesn't support tasks, which is fine - no error
            break;
    }
}
/**
 * Asserts that task creation is supported for sampling/createMessage or elicitation/create.
 * Used by Server.assertTaskCapability and Client.assertTaskHandlerCapability.
 *
 * @param requests - The task requests capability object
 * @param method - The method being checked
 * @param entityName - 'Server' or 'Client' for error messages
 * @throws Error if the capability is not supported
 *
 * @experimental
 */
export function assertClientRequestTaskCapability(requests, method, entityName) {
    var _a, _b;
    if (!requests) {
        throw new Error(`${entityName} does not support task creation (required for ${method})`);
    }
    switch (method) {
        case 'sampling/createMessage':
            if (!((_a = requests.sampling) === null || _a === void 0 ? void 0 : _a.createMessage)) {
                throw new Error(`${entityName} does not support task creation for sampling/createMessage (required for ${method})`);
            }
            break;
        case 'elicitation/create':
            if (!((_b = requests.elicitation) === null || _b === void 0 ? void 0 : _b.create)) {
                throw new Error(`${entityName} does not support task creation for elicitation/create (required for ${method})`);
            }
            break;
        default:
            // Method doesn't support tasks, which is fine - no error
            break;
    }
}
//# sourceMappingURL=helpers.js.map