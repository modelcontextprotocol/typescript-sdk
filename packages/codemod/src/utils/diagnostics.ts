import type { Diagnostic } from '../types.js';
import { DiagnosticLevel } from '../types.js';

export function error(file: string, line: number, message: string): Diagnostic {
    return { level: DiagnosticLevel.Error, file, line, message };
}

export function warning(file: string, line: number, message: string): Diagnostic {
    return { level: DiagnosticLevel.Warning, file, line, message };
}

export function info(file: string, line: number, message: string): Diagnostic {
    return { level: DiagnosticLevel.Info, file, line, message };
}

const LEVEL_PREFIX: Record<DiagnosticLevel, string> = {
    [DiagnosticLevel.Error]: 'ERROR',
    [DiagnosticLevel.Warning]: 'WARNING',
    [DiagnosticLevel.Info]: 'INFO'
};

export function formatDiagnostic(d: Diagnostic): string {
    return `  ${d.file}:${d.line} - [${LEVEL_PREFIX[d.level]}] ${d.message}`;
}
