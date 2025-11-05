import { McpError, ErrorCode, ToolAnnotations, type StreamTimeoutConfig } from '../types.js';

export interface StreamState {
    callId: string;
    toolName: string;
    arguments: Map<string, { chunks: unknown[]; complete: boolean }>;
    startTime: number;
    lastActivityTime: number;
    timeout?: NodeJS.Timeout;
    warningTimeout?: NodeJS.Timeout;
    status: 'active' | 'warning' | 'timeout' | 'cancelled' | 'completed';
    config?: StreamTimeoutConfig;
    annotations?: ToolAnnotations;
}

export class StreamValidationError extends Error {
    constructor(
        public argumentName: string,
        public chunkData: unknown,
        public originalError: unknown,
        message?: string
    ) {
        super(message || `Validation failed for argument '${argumentName}': ${originalError}`);
    }
}

export class StreamManager {
    private _streams = new Map<string, StreamState>();
    private _callIdCounter = 0;
    private _defaultConfig: StreamTimeoutConfig = {
        defaultTimeoutMs: 30000,
        maxTimeoutMs: 300000,
        warningThresholdMs: 10000
    };

    createStream(toolName: string, annotations?: ToolAnnotations, timeoutMs?: number): string {
        const callId = `stream_${++this._callIdCounter}`;
        const now = Date.now();

        // Determine timeout configuration
        const config = annotations?.timeoutConfig || this._defaultConfig;
        const actualTimeout = Math.min(Math.max(timeoutMs || config.defaultTimeoutMs, 1000), config.maxTimeoutMs);

        const stream: StreamState = {
            callId,
            toolName,
            arguments: new Map(),
            startTime: now,
            lastActivityTime: now,
            status: 'active',
            config,
            annotations
        };

        // Set warning timeout
        stream.warningTimeout = setTimeout(() => {
            this._handleStreamWarning(callId);
        }, config.warningThresholdMs);

        // Set hard timeout
        stream.timeout = setTimeout(() => {
            this._handleStreamTimeout(callId);
        }, actualTimeout);

        this._streams.set(callId, stream);
        return callId;
    }

    private _handleStreamWarning(callId: string): void {
        const stream = this._streams.get(callId);
        if (stream && stream.status === 'active') {
            stream.status = 'warning';
            this.onStreamWarning?.(callId, {
                elapsed: Date.now() - stream.startTime,
                threshold: stream.config?.warningThresholdMs || this._defaultConfig.warningThresholdMs
            });
        }
    }

    private _handleStreamTimeout(callId: string): void {
        const stream = this._streams.get(callId);
        if (stream && (stream.status === 'active' || stream.status === 'warning')) {
            stream.status = 'timeout';
            this.onStreamTimeout?.(callId, {
                elapsed: Date.now() - stream.startTime,
                lastActivity: Date.now() - stream.lastActivityTime,
                chunksReceived: Array.from(stream.arguments.values()).reduce((sum, arg) => sum + arg.chunks.length, 0)
            });
            this.cleanupStream(callId);
        }
    }

    // Event callbacks for error handling
    onStreamWarning?: (callId: string, info: { elapsed: number; threshold: number }) => void;
    onStreamTimeout?: (callId: string, info: { elapsed: number; lastActivity: number; chunksReceived: number }) => void;
    onStreamError?: (callId: string, error: StreamValidationError) => void;
    onStreamCancelled?: (callId: string, reason: string) => void;

    addChunk(callId: string, argument: string, data: unknown, isFinal?: boolean): void {
        const stream = this._streams.get(callId);
        if (!stream) {
            throw new McpError(ErrorCode.InvalidParams, `Invalid stream ID: ${callId}`);
        }

        // Update activity time
        stream.lastActivityTime = Date.now();

        // Reset timeouts on activity
        if (stream.timeout) {
            clearTimeout(stream.timeout);
            stream.timeout = setTimeout(() => {
                this._handleStreamTimeout(callId);
            }, stream.config?.defaultTimeoutMs || this._defaultConfig.defaultTimeoutMs);
        }

        try {
            // Validate chunk before adding
            this._validateChunkDataType(argument, data, stream.annotations);

            // Add chunk to stream
            if (!stream.arguments.has(argument)) {
                stream.arguments.set(argument, { chunks: [], complete: false });
            }

            const argState = stream.arguments.get(argument)!;
            argState.chunks.push(data);

            if (isFinal) {
                argState.complete = true;
            }
        } catch (error) {
            // Report validation error immediately
            const validationError = new StreamValidationError(argument, data, error);
            this.onStreamError?.(callId, validationError);
            throw validationError;
        }
    }

    private _validateChunkDataType(argument: string, data: unknown, annotations?: ToolAnnotations): void {
        const streamingArg = annotations?.streamingArguments?.find(arg => arg.name === argument);

        if (!streamingArg) {
            return; // No validation rules for this argument
        }

        switch (streamingArg.mergeStrategy) {
            case 'concatenate':
                if (typeof data !== 'string' && typeof data !== 'number' && typeof data !== 'boolean') {
                    throw new Error(`Chunk for argument '${argument}' must be a primitive type for concatenate strategy`);
                }
                break;

            case 'json_merge':
                if (data !== null && typeof data !== 'object') {
                    throw new Error(`Chunk for argument '${argument}' must be an object for json_merge strategy`);
                }
                break;

            case 'last':
                // Any data type acceptable for last strategy
                break;
        }
    }

    completeStream(callId: string): Record<string, unknown> | null {
        const stream = this._streams.get(callId);
        if (!stream) {
            throw new McpError(ErrorCode.InvalidParams, `Invalid stream ID: ${callId}`);
        }

        // Check if all required arguments are complete
        const result: Record<string, unknown> = {};

        for (const [argName, argState] of stream.arguments) {
            if (argState.chunks.length === 0 || !argState.complete) {
                return null; // Incomplete stream
            }

            // Determine merge strategy from tool annotations
            const streamingArg = stream.annotations?.streamingArguments?.find(arg => arg.name === argName);
            const mergeStrategy = streamingArg?.mergeStrategy ?? 'concatenate';

            switch (mergeStrategy) {
                case 'concatenate':
                    if (typeof argState.chunks[0] === 'string') {
                        result[argName] = argState.chunks.join('');
                    } else {
                        // For non-string concatenation, convert to string and join
                        result[argName] = argState.chunks.map(chunk => String(chunk)).join('');
                    }
                    break;

                case 'json_merge':
                    // Merge JSON objects (last chunk wins for conflicting keys)
                    result[argName] = argState.chunks.reduce((merged: unknown, chunk: unknown) => {
                        if (typeof chunk === 'object' && chunk !== null && typeof merged === 'object' && merged !== null) {
                            return { ...(merged as Record<string, unknown>), ...(chunk as Record<string, unknown>) };
                        }
                        return chunk; // Use last non-object chunk
                    });
                    break;

                case 'last':
                    // Use only the last chunk
                    result[argName] = argState.chunks[argState.chunks.length - 1];
                    break;
            }
        }

        // Clean up timeout
        if (stream.timeout) {
            clearTimeout(stream.timeout);
        }

        return result;
    }

    getStream(callId: string): StreamState | undefined {
        return this._streams.get(callId);
    }

    listStreams(): StreamState[] {
        return Array.from(this._streams.values());
    }

    cleanupStream(callId: string): void {
        const stream = this._streams.get(callId);
        if (stream?.timeout) {
            clearTimeout(stream.timeout);
        }
        this._streams.delete(callId);
    }

    // Cleanup expired streams
    cleanupExpiredStreams(maxAgeMs: number = 300000): void {
        // 5 minutes default
        const now = Date.now();
        for (const [callId, stream] of this._streams) {
            if (now - stream.startTime > maxAgeMs) {
                this.cleanupStream(callId);
            }
        }
    }
}
