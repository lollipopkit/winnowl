import { context, SpanKind, SpanStatusCode, trace, type Span, type Tracer } from '@opentelemetry/api';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const spans = new WeakMap<FastifyRequest, Span>();

/** Reads are left out: the console polls them, and their latency is already in Prometheus. */
const TRACED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * One server span per write request so jobs enqueued by the handler join its trace.
 * Callback-style hook so `done`, later hooks and the handler all run inside the span's context.
 */
export function registerRequestTracing(app: FastifyInstance, tracer: Tracer): void {
  app.addHook('onRequest', (request, _reply, done) => {
    if (!TRACED_METHODS.has(request.method)) return done();
    // The route pattern, never the raw path: ids in span names would make every name unique.
    const route = request.routeOptions.url ?? 'unmatched';
    const span = tracer.startSpan(`${request.method} ${route}`, {
      kind: SpanKind.SERVER,
      attributes: { 'http.request.method': request.method, 'http.route': route },
    });
    spans.set(request, span);
    context.with(trace.setSpan(context.active(), span), done);
  });

  app.addHook('onError', (request, _reply, error, done) => {
    const span = spans.get(request);
    if (span) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    }
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    const span = spans.get(request);
    if (span) {
      span.setAttribute('http.response.status_code', reply.statusCode);
      if (reply.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      spans.delete(request);
    }
    done();
  });
}
