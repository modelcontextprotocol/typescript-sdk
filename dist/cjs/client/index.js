"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Client = void 0;
exports.getSupportedElicitationModes = getSupportedElicitationModes;
const protocol_js_1 = require("../shared/protocol.js");
const types_js_1 = require("../types.js");
const ajv_provider_js_1 = require("../validation/ajv-provider.js");
const zod_compat_js_1 = require("../server/zod-compat.js");
const client_js_1 = require("../experimental/tasks/client.js");
const helpers_js_1 = require("../experimental/tasks/helpers.js");
/**
 * Elicitation default application helper. Applies defaults to the data based on the schema.
 *
 * @param schema - The schema to apply defaults to.
 * @param data - The data to apply defaults to.
 */
function applyElicitationDefaults(schema, data) {
    if (!schema || data === null || typeof data !== 'object')
        return;
    // Handle object properties
    if (schema.type === 'object' && schema.properties && typeof schema.properties === 'object') {
        const obj = data;
        const props = schema.properties;
        for (const key of Object.keys(props)) {
            const propSchema = props[key];
            // If missing or explicitly undefined, apply default if present
            if (obj[key] === undefined && Object.prototype.hasOwnProperty.call(propSchema, 'default')) {
                obj[key] = propSchema.default;
            }
            // Recurse into existing nested objects/arrays
            if (obj[key] !== undefined) {
                applyElicitationDefaults(propSchema, obj[key]);
            }
        }
    }
    if (Array.isArray(schema.anyOf)) {
        for (const sub of schema.anyOf) {
            applyElicitationDefaults(sub, data);
        }
    }
    // Combine schemas
    if (Array.isArray(schema.oneOf)) {
        for (const sub of schema.oneOf) {
            applyElicitationDefaults(sub, data);
        }
    }
}
/**
 * Determines which elicitation modes are supported based on declared client capabilities.
 *
 * According to the spec:
 * - An empty elicitation capability object defaults to form mode support (backwards compatibility)
 * - URL mode is only supported if explicitly declared
 *
 * @param capabilities - The client's elicitation capabilities
 * @returns An object indicating which modes are supported
 */
function getSupportedElicitationModes(capabilities) {
    if (!capabilities) {
        return { supportsFormMode: false, supportsUrlMode: false };
    }
    const hasFormCapability = capabilities.form !== undefined;
    const hasUrlCapability = capabilities.url !== undefined;
    // If neither form nor url are explicitly declared, form mode is supported (backwards compatibility)
    const supportsFormMode = hasFormCapability || (!hasFormCapability && !hasUrlCapability);
    const supportsUrlMode = hasUrlCapability;
    return { supportsFormMode, supportsUrlMode };
}
/**
 * An MCP client on top of a pluggable transport.
 *
 * The client will automatically begin the initialization flow with the server when connect() is called.
 *
 * To use with custom types, extend the base Request/Notification/Result types and pass them as type parameters:
 *
 * ```typescript
 * // Custom schemas
 * const CustomRequestSchema = RequestSchema.extend({...})
 * const CustomNotificationSchema = NotificationSchema.extend({...})
 * const CustomResultSchema = ResultSchema.extend({...})
 *
 * // Type aliases
 * type CustomRequest = z.infer<typeof CustomRequestSchema>
 * type CustomNotification = z.infer<typeof CustomNotificationSchema>
 * type CustomResult = z.infer<typeof CustomResultSchema>
 *
 * // Create typed client
 * const client = new Client<CustomRequest, CustomNotification, CustomResult>({
 *   name: "CustomClient",
 *   version: "1.0.0"
 * })
 * ```
 */
class Client extends protocol_js_1.Protocol {
    /**
     * Initializes this client with the given name and version information.
     */
    constructor(_clientInfo, options) {
        var _a, _b;
        super(options);
        this._clientInfo = _clientInfo;
        this._cachedToolOutputValidators = new Map();
        this._cachedKnownTaskTools = new Set();
        this._cachedRequiredTaskTools = new Set();
        this._capabilities = (_a = options === null || options === void 0 ? void 0 : options.capabilities) !== null && _a !== void 0 ? _a : {};
        this._jsonSchemaValidator = (_b = options === null || options === void 0 ? void 0 : options.jsonSchemaValidator) !== null && _b !== void 0 ? _b : new ajv_provider_js_1.AjvJsonSchemaValidator();
    }
    /**
     * Access experimental features.
     *
     * WARNING: These APIs are experimental and may change without notice.
     *
     * @experimental
     */
    get experimental() {
        if (!this._experimental) {
            this._experimental = {
                tasks: new client_js_1.ExperimentalClientTasks(this)
            };
        }
        return this._experimental;
    }
    /**
     * Registers new capabilities. This can only be called before connecting to a transport.
     *
     * The new capabilities will be merged with any existing capabilities previously given (e.g., at initialization).
     */
    registerCapabilities(capabilities) {
        if (this.transport) {
            throw new Error('Cannot register capabilities after connecting to transport');
        }
        this._capabilities = (0, protocol_js_1.mergeCapabilities)(this._capabilities, capabilities);
    }
    /**
     * Override request handler registration to enforce client-side validation for elicitation.
     */
    setRequestHandler(requestSchema, handler) {
        var _a, _b, _c;
        const shape = (0, zod_compat_js_1.getObjectShape)(requestSchema);
        const methodSchema = shape === null || shape === void 0 ? void 0 : shape.method;
        if (!methodSchema) {
            throw new Error('Schema is missing a method literal');
        }
        // Extract literal value using type-safe property access
        let methodValue;
        if ((0, zod_compat_js_1.isZ4Schema)(methodSchema)) {
            const v4Schema = methodSchema;
            const v4Def = (_a = v4Schema._zod) === null || _a === void 0 ? void 0 : _a.def;
            methodValue = (_b = v4Def === null || v4Def === void 0 ? void 0 : v4Def.value) !== null && _b !== void 0 ? _b : v4Schema.value;
        }
        else {
            const v3Schema = methodSchema;
            const legacyDef = v3Schema._def;
            methodValue = (_c = legacyDef === null || legacyDef === void 0 ? void 0 : legacyDef.value) !== null && _c !== void 0 ? _c : v3Schema.value;
        }
        if (typeof methodValue !== 'string') {
            throw new Error('Schema method literal must be a string');
        }
        const method = methodValue;
        if (method === 'elicitation/create') {
            const wrappedHandler = async (request, extra) => {
                var _a, _b, _c;
                const validatedRequest = (0, zod_compat_js_1.safeParse)(types_js_1.ElicitRequestSchema, request);
                if (!validatedRequest.success) {
                    // Type guard: if success is false, error is guaranteed to exist
                    const errorMessage = validatedRequest.error instanceof Error ? validatedRequest.error.message : String(validatedRequest.error);
                    throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, `Invalid elicitation request: ${errorMessage}`);
                }
                const { params } = validatedRequest.data;
                const mode = (_a = params.mode) !== null && _a !== void 0 ? _a : 'form';
                const { supportsFormMode, supportsUrlMode } = getSupportedElicitationModes(this._capabilities.elicitation);
                if (mode === 'form' && !supportsFormMode) {
                    throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, 'Client does not support form-mode elicitation requests');
                }
                if (mode === 'url' && !supportsUrlMode) {
                    throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, 'Client does not support URL-mode elicitation requests');
                }
                const result = await Promise.resolve(handler(request, extra));
                // When task creation is requested, validate and return CreateTaskResult
                if (params.task) {
                    const taskValidationResult = (0, zod_compat_js_1.safeParse)(types_js_1.CreateTaskResultSchema, result);
                    if (!taskValidationResult.success) {
                        const errorMessage = taskValidationResult.error instanceof Error
                            ? taskValidationResult.error.message
                            : String(taskValidationResult.error);
                        throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, `Invalid task creation result: ${errorMessage}`);
                    }
                    return taskValidationResult.data;
                }
                // For non-task requests, validate against ElicitResultSchema
                const validationResult = (0, zod_compat_js_1.safeParse)(types_js_1.ElicitResultSchema, result);
                if (!validationResult.success) {
                    // Type guard: if success is false, error is guaranteed to exist
                    const errorMessage = validationResult.error instanceof Error ? validationResult.error.message : String(validationResult.error);
                    throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, `Invalid elicitation result: ${errorMessage}`);
                }
                const validatedResult = validationResult.data;
                const requestedSchema = mode === 'form' ? params.requestedSchema : undefined;
                if (mode === 'form' && validatedResult.action === 'accept' && validatedResult.content && requestedSchema) {
                    if ((_c = (_b = this._capabilities.elicitation) === null || _b === void 0 ? void 0 : _b.form) === null || _c === void 0 ? void 0 : _c.applyDefaults) {
                        try {
                            applyElicitationDefaults(requestedSchema, validatedResult.content);
                        }
                        catch (_d) {
                            // gracefully ignore errors in default application
                        }
                    }
                }
                return validatedResult;
            };
            // Install the wrapped handler
            return super.setRequestHandler(requestSchema, wrappedHandler);
        }
        if (method === 'sampling/createMessage') {
            const wrappedHandler = async (request, extra) => {
                const validatedRequest = (0, zod_compat_js_1.safeParse)(types_js_1.CreateMessageRequestSchema, request);
                if (!validatedRequest.success) {
                    const errorMessage = validatedRequest.error instanceof Error ? validatedRequest.error.message : String(validatedRequest.error);
                    throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, `Invalid sampling request: ${errorMessage}`);
                }
                const { params } = validatedRequest.data;
                const result = await Promise.resolve(handler(request, extra));
                // When task creation is requested, validate and return CreateTaskResult
                if (params.task) {
                    const taskValidationResult = (0, zod_compat_js_1.safeParse)(types_js_1.CreateTaskResultSchema, result);
                    if (!taskValidationResult.success) {
                        const errorMessage = taskValidationResult.error instanceof Error
                            ? taskValidationResult.error.message
                            : String(taskValidationResult.error);
                        throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, `Invalid task creation result: ${errorMessage}`);
                    }
                    return taskValidationResult.data;
                }
                // For non-task requests, validate against CreateMessageResultSchema
                const validationResult = (0, zod_compat_js_1.safeParse)(types_js_1.CreateMessageResultSchema, result);
                if (!validationResult.success) {
                    const errorMessage = validationResult.error instanceof Error ? validationResult.error.message : String(validationResult.error);
                    throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, `Invalid sampling result: ${errorMessage}`);
                }
                return validationResult.data;
            };
            // Install the wrapped handler
            return super.setRequestHandler(requestSchema, wrappedHandler);
        }
        // Other handlers use default behavior
        return super.setRequestHandler(requestSchema, handler);
    }
    assertCapability(capability, method) {
        var _a;
        if (!((_a = this._serverCapabilities) === null || _a === void 0 ? void 0 : _a[capability])) {
            throw new Error(`Server does not support ${capability} (required for ${method})`);
        }
    }
    async connect(transport, options) {
        await super.connect(transport);
        // When transport sessionId is already set this means we are trying to reconnect.
        // In this case we don't need to initialize again.
        if (transport.sessionId !== undefined) {
            return;
        }
        try {
            const result = await this.request({
                method: 'initialize',
                params: {
                    protocolVersion: types_js_1.LATEST_PROTOCOL_VERSION,
                    capabilities: this._capabilities,
                    clientInfo: this._clientInfo
                }
            }, types_js_1.InitializeResultSchema, options);
            if (result === undefined) {
                throw new Error(`Server sent invalid initialize result: ${result}`);
            }
            if (!types_js_1.SUPPORTED_PROTOCOL_VERSIONS.includes(result.protocolVersion)) {
                throw new Error(`Server's protocol version is not supported: ${result.protocolVersion}`);
            }
            this._serverCapabilities = result.capabilities;
            this._serverVersion = result.serverInfo;
            // HTTP transports must set the protocol version in each header after initialization.
            if (transport.setProtocolVersion) {
                transport.setProtocolVersion(result.protocolVersion);
            }
            this._instructions = result.instructions;
            await this.notification({
                method: 'notifications/initialized'
            });
        }
        catch (error) {
            // Disconnect if initialization fails.
            void this.close();
            throw error;
        }
    }
    /**
     * After initialization has completed, this will be populated with the server's reported capabilities.
     */
    getServerCapabilities() {
        return this._serverCapabilities;
    }
    /**
     * After initialization has completed, this will be populated with information about the server's name and version.
     */
    getServerVersion() {
        return this._serverVersion;
    }
    /**
     * After initialization has completed, this may be populated with information about the server's instructions.
     */
    getInstructions() {
        return this._instructions;
    }
    assertCapabilityForMethod(method) {
        var _a, _b, _c, _d, _e;
        switch (method) {
            case 'logging/setLevel':
                if (!((_a = this._serverCapabilities) === null || _a === void 0 ? void 0 : _a.logging)) {
                    throw new Error(`Server does not support logging (required for ${method})`);
                }
                break;
            case 'prompts/get':
            case 'prompts/list':
                if (!((_b = this._serverCapabilities) === null || _b === void 0 ? void 0 : _b.prompts)) {
                    throw new Error(`Server does not support prompts (required for ${method})`);
                }
                break;
            case 'resources/list':
            case 'resources/templates/list':
            case 'resources/read':
            case 'resources/subscribe':
            case 'resources/unsubscribe':
                if (!((_c = this._serverCapabilities) === null || _c === void 0 ? void 0 : _c.resources)) {
                    throw new Error(`Server does not support resources (required for ${method})`);
                }
                if (method === 'resources/subscribe' && !this._serverCapabilities.resources.subscribe) {
                    throw new Error(`Server does not support resource subscriptions (required for ${method})`);
                }
                break;
            case 'tools/call':
            case 'tools/list':
                if (!((_d = this._serverCapabilities) === null || _d === void 0 ? void 0 : _d.tools)) {
                    throw new Error(`Server does not support tools (required for ${method})`);
                }
                break;
            case 'completion/complete':
                if (!((_e = this._serverCapabilities) === null || _e === void 0 ? void 0 : _e.completions)) {
                    throw new Error(`Server does not support completions (required for ${method})`);
                }
                break;
            case 'initialize':
                // No specific capability required for initialize
                break;
            case 'ping':
                // No specific capability required for ping
                break;
        }
    }
    assertNotificationCapability(method) {
        var _a;
        switch (method) {
            case 'notifications/roots/list_changed':
                if (!((_a = this._capabilities.roots) === null || _a === void 0 ? void 0 : _a.listChanged)) {
                    throw new Error(`Client does not support roots list changed notifications (required for ${method})`);
                }
                break;
            case 'notifications/initialized':
                // No specific capability required for initialized
                break;
            case 'notifications/cancelled':
                // Cancellation notifications are always allowed
                break;
            case 'notifications/progress':
                // Progress notifications are always allowed
                break;
        }
    }
    assertRequestHandlerCapability(method) {
        // Task handlers are registered in Protocol constructor before _capabilities is initialized
        // Skip capability check for task methods during initialization
        if (!this._capabilities) {
            return;
        }
        switch (method) {
            case 'sampling/createMessage':
                if (!this._capabilities.sampling) {
                    throw new Error(`Client does not support sampling capability (required for ${method})`);
                }
                break;
            case 'elicitation/create':
                if (!this._capabilities.elicitation) {
                    throw new Error(`Client does not support elicitation capability (required for ${method})`);
                }
                break;
            case 'roots/list':
                if (!this._capabilities.roots) {
                    throw new Error(`Client does not support roots capability (required for ${method})`);
                }
                break;
            case 'tasks/get':
            case 'tasks/list':
            case 'tasks/result':
            case 'tasks/cancel':
                if (!this._capabilities.tasks) {
                    throw new Error(`Client does not support tasks capability (required for ${method})`);
                }
                break;
            case 'ping':
                // No specific capability required for ping
                break;
        }
    }
    assertTaskCapability(method) {
        var _a, _b;
        (0, helpers_js_1.assertToolsCallTaskCapability)((_b = (_a = this._serverCapabilities) === null || _a === void 0 ? void 0 : _a.tasks) === null || _b === void 0 ? void 0 : _b.requests, method, 'Server');
    }
    assertTaskHandlerCapability(method) {
        var _a;
        // Task handlers are registered in Protocol constructor before _capabilities is initialized
        // Skip capability check for task methods during initialization
        if (!this._capabilities) {
            return;
        }
        (0, helpers_js_1.assertClientRequestTaskCapability)((_a = this._capabilities.tasks) === null || _a === void 0 ? void 0 : _a.requests, method, 'Client');
    }
    async ping(options) {
        return this.request({ method: 'ping' }, types_js_1.EmptyResultSchema, options);
    }
    async complete(params, options) {
        return this.request({ method: 'completion/complete', params }, types_js_1.CompleteResultSchema, options);
    }
    async setLoggingLevel(level, options) {
        return this.request({ method: 'logging/setLevel', params: { level } }, types_js_1.EmptyResultSchema, options);
    }
    async getPrompt(params, options) {
        return this.request({ method: 'prompts/get', params }, types_js_1.GetPromptResultSchema, options);
    }
    async listPrompts(params, options) {
        return this.request({ method: 'prompts/list', params }, types_js_1.ListPromptsResultSchema, options);
    }
    async listResources(params, options) {
        return this.request({ method: 'resources/list', params }, types_js_1.ListResourcesResultSchema, options);
    }
    async listResourceTemplates(params, options) {
        return this.request({ method: 'resources/templates/list', params }, types_js_1.ListResourceTemplatesResultSchema, options);
    }
    async readResource(params, options) {
        return this.request({ method: 'resources/read', params }, types_js_1.ReadResourceResultSchema, options);
    }
    async subscribeResource(params, options) {
        return this.request({ method: 'resources/subscribe', params }, types_js_1.EmptyResultSchema, options);
    }
    async unsubscribeResource(params, options) {
        return this.request({ method: 'resources/unsubscribe', params }, types_js_1.EmptyResultSchema, options);
    }
    /**
     * Calls a tool and waits for the result. Automatically validates structured output if the tool has an outputSchema.
     *
     * For task-based execution with streaming behavior, use client.experimental.tasks.callToolStream() instead.
     */
    async callTool(params, resultSchema = types_js_1.CallToolResultSchema, options) {
        // Guard: required-task tools need experimental API
        if (this.isToolTaskRequired(params.name)) {
            throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidRequest, `Tool "${params.name}" requires task-based execution. Use client.experimental.tasks.callToolStream() instead.`);
        }
        const result = await this.request({ method: 'tools/call', params }, resultSchema, options);
        // Check if the tool has an outputSchema
        const validator = this.getToolOutputValidator(params.name);
        if (validator) {
            // If tool has outputSchema, it MUST return structuredContent (unless it's an error)
            if (!result.structuredContent && !result.isError) {
                throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidRequest, `Tool ${params.name} has an output schema but did not return structured content`);
            }
            // Only validate structured content if present (not when there's an error)
            if (result.structuredContent) {
                try {
                    // Validate the structured content against the schema
                    const validationResult = validator(result.structuredContent);
                    if (!validationResult.valid) {
                        throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, `Structured content does not match the tool's output schema: ${validationResult.errorMessage}`);
                    }
                }
                catch (error) {
                    if (error instanceof types_js_1.McpError) {
                        throw error;
                    }
                    throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, `Failed to validate structured content: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }
        return result;
    }
    isToolTask(toolName) {
        var _a, _b, _c, _d;
        if (!((_d = (_c = (_b = (_a = this._serverCapabilities) === null || _a === void 0 ? void 0 : _a.tasks) === null || _b === void 0 ? void 0 : _b.requests) === null || _c === void 0 ? void 0 : _c.tools) === null || _d === void 0 ? void 0 : _d.call)) {
            return false;
        }
        return this._cachedKnownTaskTools.has(toolName);
    }
    /**
     * Check if a tool requires task-based execution.
     * Unlike isToolTask which includes 'optional' tools, this only checks for 'required'.
     */
    isToolTaskRequired(toolName) {
        return this._cachedRequiredTaskTools.has(toolName);
    }
    /**
     * Cache validators for tool output schemas.
     * Called after listTools() to pre-compile validators for better performance.
     */
    cacheToolMetadata(tools) {
        var _a;
        this._cachedToolOutputValidators.clear();
        this._cachedKnownTaskTools.clear();
        this._cachedRequiredTaskTools.clear();
        for (const tool of tools) {
            // If the tool has an outputSchema, create and cache the validator
            if (tool.outputSchema) {
                const toolValidator = this._jsonSchemaValidator.getValidator(tool.outputSchema);
                this._cachedToolOutputValidators.set(tool.name, toolValidator);
            }
            // If the tool supports task-based execution, cache that information
            const taskSupport = (_a = tool.execution) === null || _a === void 0 ? void 0 : _a.taskSupport;
            if (taskSupport === 'required' || taskSupport === 'optional') {
                this._cachedKnownTaskTools.add(tool.name);
            }
            if (taskSupport === 'required') {
                this._cachedRequiredTaskTools.add(tool.name);
            }
        }
    }
    /**
     * Get cached validator for a tool
     */
    getToolOutputValidator(toolName) {
        return this._cachedToolOutputValidators.get(toolName);
    }
    async listTools(params, options) {
        const result = await this.request({ method: 'tools/list', params }, types_js_1.ListToolsResultSchema, options);
        // Cache the tools and their output schemas for future validation
        this.cacheToolMetadata(result.tools);
        return result;
    }
    async sendRootsListChanged() {
        return this.notification({ method: 'notifications/roots/list_changed' });
    }
}
exports.Client = Client;
//# sourceMappingURL=index.js.map