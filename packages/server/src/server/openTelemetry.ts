import type { ProtocolInstrumentation } from '@modelcontextprotocol/core-internal';
import { openTelemetryInstrumentation } from '@modelcontextprotocol/core-internal';

let shared: ProtocolInstrumentation | undefined;

/** OpenTelemetry instrumentation every `Server` attaches; created on first use and shared. */
export function defaultInstrumentation(): ProtocolInstrumentation {
    return (shared ??= openTelemetryInstrumentation('@modelcontextprotocol/server'));
}
