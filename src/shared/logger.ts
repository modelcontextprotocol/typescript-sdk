

type LogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';

/**
 * Logger - SysLog RFC5424 compliant logger type
 * 
 * @see RFC5424: https://tools.ietf.org/html/rfc5424
 */
export type Logger = {
    [Level in LogLevel]: (message: string, extra?: Record<string, unknown>) => void;
};

/**
 * Console logger implementation of the Logger interface, to be used by default if no custom logger is provided.
 *
 * @remarks
 * The console logger will log to the console.
 *
 * The console logger will log at the following levels:
 * - log (alias for console.debug)
 * - info
 * - error
 */
export const consoleLogger: Logger = {
    debug: (message, extra) => {
        console.log(message, extra);
    },
    info: (message, extra) => {
        console.info(message, extra);
    },
    notice: (message, extra) => {
        console.info(message, extra);
    },
    warning: (message, extra) => {
        console.warn(message, extra);
    },
    error: (message, extra) => {
        console.error(message, extra);
    },
    critical: (message, extra) => {
        console.error(message, extra);
    },
    alert: (message, extra) => {
        console.error(message, extra);
    },
    emergency: (message, extra) => {
        console.error(message, extra);
    },
};