import { context, propagation, SpanStatusCode, trace, type Attributes, type Span, type Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { detectResourcesSync, envDetectorSync, Resource } from '@opentelemetry/resources';
import { BatchSpanProcessor, SimpleSpanProcessor, type SpanExporter, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { FetchOtlpSpanExporter } from './fetch-otlp-exporter.js';
import { FileOtlpSpanExporter } from './file-otlp-exporter.js';
import { currentLlmTraceContext, llmTraceAttributes } from './llm-context.js';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export interface TelemetryConfig {
  serviceName: string;
  serviceVersion?: string;
  /** OTLP/HTTP base URL; defaults to `OTEL_EXPORTER_OTLP_ENDPOINT`. */
  otlpEndpoint?: string;
  /**
   * Langfuse OTLP base URL, exported in parallel. Defaults to `LANGFUSE_OTLP_ENDPOINT` /
   * `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`; disabled unless all three are set.
   */
  langfuseEndpoint?: string;
  langfusePublicKey?: string;
  langfuseSecretKey?: string;
  /** Also write spans as OTLP/JSON to this file for the control plane to relay (sandboxes cannot reach the collector). */
  spanFile?: string;
  /** Tests: export synchronously. */
  simple?: boolean;
}

export interface TelemetryHandle {
  enabled: boolean;
  tracer(name: string): Tracer;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export type { Tracer, Span, Attributes } from '@opentelemetry/api';

export { withLlmTraceContext, currentLlmTraceContext, llmTraceAttributes } from './llm-context.js';
export type { LlmTraceContext } from './llm-context.js';
export { LangfuseAdminClient, langfuseAdminFromEnv } from './langfuse-admin.js';
export type { LangfuseAdminConfig, LangfuseMetadataMatch, LangfuseTraceEraser } from './langfuse-admin.js';
export { SpanStatusCode } from '@opentelemetry/api';

export {
  initMetrics,
  metricsText,
  metricsContentType,
  metricsAccess,
  createMetricsServer,
  registerQueueDepthGauge,
  recordJob,
  recordReview,
  recordPluginCall,
  recordWebhook,
  recordReviewCost,
  recordLlmCall,
  recordFinding,
  recordDependencyScan,
  recordWebhookConfigDrift,
} from './metrics.js';

/** Global tracer; its spans nest under the active span. No-op when telemetry is disabled. */
export function getTracer(name: string): Tracer {
  return trace.getTracer(name);
}

/** Runs fn in an active span: OK on success, ERROR + recordException on throw (rethrown). */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Attributes,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span: Span) => {
    // Langfuse reads `langfuse.trace.metadata.*` per span (no inheritance), so every span carries them.
    span.setAttributes(llmTraceAttributes(currentLlmTraceContext()));
    if (attributes) span.setAttributes(attributes);
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error)?.message });
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/** W3C `traceparent`/`tracestate`, stored on the job row to link traces across processes. */
export type TraceCarrier = Record<string, string>;

/** Carrier for the active span; undefined when telemetry is off or no span is active. */
export function currentTraceCarrier(): TraceCarrier | undefined {
  const carrier: TraceCarrier = {};
  propagation.inject(context.active(), carrier);
  return Object.keys(carrier).length > 0 ? carrier : undefined;
}

/** Runs fn with the carrier's remote context as parent; a missing carrier runs it as is. */
export function withRemoteTraceCarrier<T>(carrier: TraceCarrier | null | undefined, fn: () => T): T {
  if (!carrier || Object.keys(carrier).length === 0) return fn();
  return context.with(propagation.extract(context.active(), carrier), fn);
}

/**
 * A second exporter alongside the main one. Takes the key pair rather than a prebuilt header so a
 * hand-made base64 mistake cannot silently disable reporting.
 */
function resolveLangfuseExport(
  config: TelemetryConfig,
  env: NodeJS.ProcessEnv,
): { url: string; headers: Record<string, string> } | undefined {
  const base = config.langfuseEndpoint ?? env.LANGFUSE_OTLP_ENDPOINT;
  const publicKey = config.langfusePublicKey ?? env.LANGFUSE_PUBLIC_KEY;
  const secretKey = config.langfuseSecretKey ?? env.LANGFUSE_SECRET_KEY;
  if (!base || !publicKey || !secretKey) return undefined;
  return {
    url: `${base.replace(/\/$/, '')}/v1/traces`,
    headers: { Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}` },
  };
}

/** Call once per process. When disabled the handle still works as a no-op. */
export function initTelemetry(config: TelemetryConfig): TelemetryHandle {
  const endpoint = config.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const langfuse = resolveLangfuseExport(config, process.env);
  if (!endpoint && !langfuse && !config.spanFile) {
    return {
      enabled: false,
      tracer: (name) => trace.getTracer(name),
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    };
  }

  const wrap = (e: SpanExporter): SpanProcessor =>
    config.simple ? new SimpleSpanProcessor(e) : new BatchSpanProcessor(e);
  const processors: SpanProcessor[] = [];
  if (endpoint) processors.push(wrap(new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` })));
  // fetch-based: the official exporter's own https agent bypasses the sandbox's squid proxy.
  if (langfuse) processors.push(wrap(new FetchOtlpSpanExporter(langfuse.url, langfuse.headers)));
  if (config.spanFile) processors.push(wrap(new FileOtlpSpanExporter(config.spanFile)));
  // After esbuild bundling, the SDK's `instanceof Resource` can fail across copies and drop the
  // explicit resource; reading OTEL_SERVICE_NAME via envDetector keeps the service name.
  const resource = detectResourcesSync({ detectors: [envDetectorSync] }).merge(
    new Resource({
      [ATTR_SERVICE_NAME]: config.serviceName,
      ...(config.serviceVersion ? { [ATTR_SERVICE_VERSION]: config.serviceVersion } : {}),
    }),
  );
  const provider = new NodeTracerProvider({ resource, spanProcessors: processors });
  provider.register();

  return {
    enabled: true,
    tracer: (name) => provider.getTracer(name),
    forceFlush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
}

export { FileOtlpSpanExporter, relayOtlpFile } from './file-otlp-exporter.js';
