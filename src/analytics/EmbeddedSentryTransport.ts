/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  type Event,
  type makeFetchTransport,
  type StackFrame,
} from "@sentry/react";

import {
  embeddedSentryEnvironment,
  rewriteEmbeddedCallFrame,
  sentryErrorsEnabled,
  sentryPerformanceEnabled,
} from "./SentryReporting";

type Transport = ReturnType<typeof makeFetchTransport>;
type Envelope = Parameters<Transport["send"]>[0];

/** Internal SDK errors bypass beforeSend, and trace names can live in the envelope header. */
export function embeddedSentryTransport(
  transport: typeof makeFetchTransport,
  metadata: Pick<Event, "environment" | "release">,
): typeof makeFetchTransport {
  return (options) => {
    const delegate = transport({
      ...options,
      fetchOptions: { ...options.fetchOptions, referrerPolicy: "no-referrer" },
    });
    return {
      send: (envelope) => {
        const safe = safeEnvelope(envelope, metadata);
        return safe
          ? delegate.send(safe)
          : Promise.resolve({ statusCode: 200 });
      },
      flush: (timeout) => delegate.flush(timeout),
    };
  };
}

function safeEnvelope(
  [header, items]: Envelope,
  metadata: Pick<Event, "environment" | "release">,
): Envelope | undefined {
  if (
    typeof header.event_id !== "string" ||
    !/^[0-9a-f]{32}$/i.test(header.event_id)
  )
    return undefined;
  const events: [{ type: "event" | "transaction" }, Event][] = [];
  for (const [item, payload] of items) {
    if (
      ((item.type === "event" && sentryErrorsEnabled()) ||
        (item.type === "transaction" && sentryPerformanceEnabled())) &&
      payload !== null &&
      typeof payload === "object"
    )
      events.push([
        { type: item.type },
        safeEvent(payload as Event, {
          ...metadata,
          environment: embeddedSentryEnvironment(metadata.environment),
          event_id: header.event_id,
          type: item.type === "transaction" ? "transaction" : undefined,
        }),
      ]);
  }
  if (events.length === 0) return undefined;
  return [
    { event_id: header.event_id, sent_at: new Date().toISOString() },
    events,
  ];
}

function safeEvent(
  event: Event,
  metadata: Pick<Event, "environment" | "release" | "event_id" | "type">,
): Event {
  const { exception, debug_meta: debugMeta, contexts, spans } = event;
  const trace = contexts?.trace;
  return {
    ...metadata,
    platform: "javascript",
    level: event.level,
    timestamp: event.timestamp,
    start_timestamp: event.start_timestamp,
    measurements:
      metadata.type === "transaction"
        ? safeMeasurements(event.measurements)
        : undefined,
    transaction: metadata.type === "transaction" ? "Element Call" : undefined,
    message:
      metadata.type === undefined && !exception
        ? "Element Call error"
        : undefined,
    exception: exception && {
      values: exception.values?.map(({ type, mechanism, stacktrace }) => ({
        type: safeErrorType(type),
        value: "Element Call error",
        mechanism: mechanism && { type: "generic", handled: mechanism.handled },
        stacktrace: stacktrace && {
          frames: stacktrace.frames?.flatMap(safeFrame),
        },
      })),
    },
    debug_meta: debugMeta && {
      images: debugMeta.images?.flatMap((image) => {
        const filename = assetFilename(image.code_file);
        if (
          image.type !== "sourcemap" ||
          !filename ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(image.debug_id)
        )
          return [];
        return [
          {
            type: "sourcemap" as const,
            code_file: filename,
            debug_id: image.debug_id,
          },
        ];
      }),
    },
    contexts:
      trace && validTraceIds(trace)
        ? {
            trace: {
              trace_id: trace.trace_id,
              span_id: trace.span_id,
              parent_span_id: safeParentSpanId(trace.parent_span_id),
              op: safeSpanOperation(trace.op),
              status: safeSpanStatus(trace.status),
            },
          }
        : undefined,
    spans: spans?.filter(validTraceIds).map((span) => ({
      trace_id: span.trace_id,
      span_id: span.span_id,
      parent_span_id: safeParentSpanId(span.parent_span_id),
      start_timestamp: span.start_timestamp,
      timestamp: span.timestamp,
      op: safeSpanOperation(span.op),
      status: safeSpanStatus(span.status),
      measurements: safeMeasurements(span.measurements),
    })),
  };
}

function safeFrame(frame: StackFrame): StackFrame[] {
  const filename = assetFilename(frame.filename ?? frame.abs_path);
  if (!filename) return [];
  return [
    {
      filename,
      lineno: frame.lineno,
      colno: frame.colno,
      in_app: frame.in_app,
    },
  ];
}

function assetFilename(filename: string | undefined): string | undefined {
  const mapped = rewriteEmbeddedCallFrame({ filename }).filename;
  return mapped?.match(
    /^(app:\/\/\/element-call\/assets\/[\w.-]+\.js|https?:\/\/[\w.:-]+\/(?:[\w.-]+\/)*assets\/[\w.-]+\.js)(?:[?#].*)?$/,
  )?.[1];
}

function validTraceIds(trace: { trace_id: string; span_id: string }): boolean {
  return (
    /^[0-9a-f]{32}$/i.test(trace.trace_id) &&
    /^[0-9a-f]{16}$/i.test(trace.span_id)
  );
}

function safeParentSpanId(id?: string): string | undefined {
  return id && /^[0-9a-f]{16}$/i.test(id) ? id : undefined;
}

function safeErrorType(type?: string): string {
  return type &&
    [
      "AbortError",
      "ConnectionError",
      "EvalError",
      "MatrixError",
      "MatrixRTCError",
      "NotAllowedError",
      "RangeError",
      "ReferenceError",
      "SyntaxError",
      "TypeError",
      "URIError",
    ].includes(type)
    ? type
    : "Error";
}

function safeSpanOperation(op?: string): string {
  return op &&
    [
      "browser",
      "http.client",
      "navigation",
      "pageload",
      "resource.css",
      "resource.img",
      "resource.link",
      "resource.script",
      "ui.long-task",
    ].includes(op)
    ? op
    : "other";
}

function safeSpanStatus(status?: string): string | undefined {
  return status &&
    [
      "ok",
      "cancelled",
      "unknown_error",
      "invalid_argument",
      "deadline_exceeded",
      "not_found",
      "already_exists",
      "permission_denied",
      "resource_exhausted",
      "failed_precondition",
      "aborted",
      "out_of_range",
      "unimplemented",
      "internal_error",
      "unavailable",
      "data_loss",
      "unauthenticated",
    ].includes(status)
    ? status
    : undefined;
}

function safeMeasurements(
  measurements: Event["measurements"],
): Event["measurements"] {
  if (!measurements) return undefined;
  const safe: NonNullable<Event["measurements"]> = {};
  for (const name of [
    "cls",
    "fid",
    "fp",
    "fcp",
    "inp",
    "lcp",
    "ttfb",
    "ttfb.requestTime",
  ]) {
    const measurement = measurements[name];
    const unit = name === "cls" ? "" : "millisecond";
    if (measurement?.unit === unit && Number.isFinite(measurement.value))
      safe[name] = { value: measurement.value, unit };
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}
