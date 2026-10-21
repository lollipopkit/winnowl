import { currentTraceCarrier, initTelemetry } from '@reviewbot/telemetry';
import { setJobTraceCarrierProvider } from '@reviewbot/queue';
import { type Tracer } from '@opentelemetry/api';
import { pino, type Logger, type LoggerOptions } from 'pino';

/**
 * Logs never include provider tokens, secrets, full source or full prompts.
 * Tracing is a no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
 */
export const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
};

/** For non-request contexts such as startup. */
export const logger: Logger = pino(loggerOptions);

export const telemetry = initTelemetry({ serviceName: 'winnowl-control-api' });
// Jobs enqueued from console requests join the request's trace.
setJobTraceCarrierProvider(() => currentTraceCarrier());

export const tracer: Tracer = telemetry.tracer('reviewbot-control-api');
