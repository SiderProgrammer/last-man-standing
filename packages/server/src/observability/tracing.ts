import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';
import { errorMessage } from '@lms/protocol';

/**
 * OpenTelemetry tracing.
 *
 * Code everywhere creates spans through `@opentelemetry/api`, which is a no-op
 * until an SDK is registered, so tests and a server without a collector pay
 * nothing. `startTracing` registers the SDK when `OTEL_EXPORTER_OTLP_ENDPOINT`
 * is set; the SDK packages are imported only then.
 *
 * Spans cover the operations worth a waterfall: handling a client frame, a
 * login verification, a relayed call, a settlement, a bridge poll, the keeper
 * transactions. A whole match would make a poor single trace — it lasts
 * minutes and most of it is waiting — so spans carry `lms.match_id` instead
 * and a trace backend groups them by that attribute.
 */
export const tracer = trace.getTracer('lms-server');

/**
 * Runs `work` inside a span, recording a thrown error on it. The span is the
 * active one for everything `work` awaits, so nested spans and log lines join
 * the same trace.
 */
export function withSpan<T>(name: string, attributes: Attributes, work: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await work();
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Registers the tracing SDK and an OTLP/HTTP exporter, if a collector is
 * configured. Returns a shutdown function that flushes pending spans.
 */
export async function startTracing(env: NodeJS.ProcessEnv = process.env): Promise<() => Promise<void>> {
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) return async () => undefined;

  const [{ NodeTracerProvider }, { BatchSpanProcessor }, { OTLPTraceExporter }, { resourceFromAttributes }] =
    await Promise.all([
      import('@opentelemetry/sdk-trace-node'),
      import('@opentelemetry/sdk-trace-base'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/resources'),
    ]);

  // The exporter reads OTEL_EXPORTER_OTLP_ENDPOINT and _HEADERS itself.
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': env.OTEL_SERVICE_NAME ?? 'lms-server' }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  provider.register();
  return () => provider.shutdown();
}
