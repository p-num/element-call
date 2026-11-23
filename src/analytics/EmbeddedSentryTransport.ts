/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  type Event,
  type EventHint,
  type getClient,
  type makeFetchTransport,
  type StackFrame,
} from "@sentry/react";

import {
  embeddedSentryEnvironment,
  rewriteEmbeddedCallFrame,
  sentryErrorsEnabled,
  sentryErrorsGeneration,
  sentryPerformanceEnabled,
  sentryPerformanceGeneration,
} from "./SentryReporting";

type Transport = ReturnType<typeof makeFetchTransport>;
type Envelope = Parameters<Transport["send"]>[0];
type EventEnvelope = Extract<Envelope, [{ event_id: string }, unknown[]]>;
type Client = NonNullable<ReturnType<typeof getClient>>;
type EventType = "event" | "transaction";
type CapturedEvent = {
  type: EventType;
  generation: number;
  diagnostics?: DiagnosticAttachment;
};
type DiagnosticAttachment = {
  eventId: string;
  contents: string;
  length: number;
};
type RequestDiagnostics = (
  eventId: string,
  timestamp: number,
) => Promise<unknown> | null;

declare global {
  interface Window {
    __letroCallAudioDiagnostics?: {
      sentryAttachment?: RequestDiagnostics;
    };
  }
}

export function iosSentryDiagnosticRequest(): RequestDiagnostics | undefined {
  if (import.meta.env.VITE_IOS_SENTRY_ATTACHMENTS !== "true") return undefined;
  const property = Object.getOwnPropertyDescriptor(
    window,
    "__letroCallAudioDiagnostics",
  );
  if (property?.configurable !== false || property.writable !== false)
    return undefined;
  const bridge = window.__letroCallAudioDiagnostics;
  return Object.isFrozen(bridge) &&
    typeof bridge?.sentryAttachment === "function"
    ? bridge.sentryAttachment
    : undefined;
}

export function createEmbeddedSentryReporting(
  delegateTransport: typeof makeFetchTransport,
  metadata: Pick<Event, "environment" | "release">,
  diagnostics?: {
    request: RequestDiagnostics;
    fetch?: typeof globalThis.fetch;
  },
) {
  const sendRequest = diagnostics
    ? (diagnostics.fetch ?? window.fetch?.bind(window))
    : undefined;
  const captured = new WeakMap<EventHint, CapturedEvent>();
  const dispatchable = new WeakMap<object, CapturedEvent>();
  const integration = {
    name: "ElementCallEmbeddedConsent",
    setup(client: Client): void {
      // Sentry emits preprocessEvent before running event processors, which can await.
      client.on("preprocessEvent", (event, hint) => {
        if (!hint || hint.data?.__sentry__ === true) return;
        const type = event.type ?? "event";
        if (type !== "event" && type !== "transaction") return;
        const generation = currentConsentGeneration(type);
        if (generation !== undefined) captured.set(hint, { type, generation });
      });
      client.addEventProcessor((event, hint): Event | PromiseLike<Event> => {
        const capture = captured.get(hint);
        const { event_id: eventId, timestamp } = event;
        if (
          capture?.type !== "event" ||
          capture.generation !== currentConsentGeneration("event") ||
          !diagnostics ||
          !sendRequest ||
          !isError(event) ||
          !validEventId(eventId) ||
          typeof timestamp !== "number" ||
          !Number.isFinite(timestamp)
        )
          return event;
        // Keep the bridge deadline inside Sentry's event processing so flush waits for it.
        return readDiagnostics(eventId, async () =>
          diagnostics.request(eventId, timestamp),
        ).then((diagnostics) => {
          capture.diagnostics = diagnostics;
          return event;
        });
      });
      client.on("beforeSendEvent", (event, hint) => {
        if (!hint) return;
        const consent = captured.get(hint);
        captured.delete(hint);
        // The SDK keeps this payload object by reference in the event envelope.
        if (consent) dispatchable.set(event, consent);
      });
    },
  };
  const transport: typeof makeFetchTransport = (options) => {
    const delegate = delegateTransport(
      {
        ...options,
        fetchOptions: {
          ...options.fetchOptions,
          referrerPolicy: "no-referrer",
        },
      },
      sendRequest &&
        (async (input, init) => {
          // Sentry can rate-limit the error independently from its attachment.
          if (!startsWithEvent(init?.body)) return new Response(null);
          return sendRequest(input, init);
        }),
    );
    return {
      send: async (envelope) => {
        const safe = safeEnvelope(envelope, metadata, dispatchable);
        return safe
          ? delegate.send(safe)
          : Promise.resolve({ statusCode: 200 });
      },
      flush: (timeout) => delegate.flush(timeout),
    };
  };
  return { integration, transport };
}

function currentConsentGeneration(type: string): number | undefined {
  if (type === "event" && sentryErrorsEnabled())
    return sentryErrorsGeneration();
  if (type === "transaction" && sentryPerformanceEnabled())
    return sentryPerformanceGeneration();
  return undefined;
}

function safeEnvelope(
  [header, items]: Envelope,
  metadata: Pick<Event, "environment" | "release">,
  dispatchable: WeakMap<object, CapturedEvent>,
): EventEnvelope | undefined {
  if (!validEventId(header.event_id)) return undefined;
  const events: EventEnvelope[1] = [];
  let diagnostics: DiagnosticAttachment | undefined;
  for (const [item, payload] of items) {
    if (payload === null || typeof payload !== "object") continue;
    const consent = dispatchable.get(payload);
    dispatchable.delete(payload);
    if (
      consent?.type === item.type &&
      consent.generation === currentConsentGeneration(item.type) &&
      (payload as Event).event_id === header.event_id
    ) {
      events.push([
        { type: item.type },
        safeEvent(payload as Event, {
          ...metadata,
          environment: embeddedSentryEnvironment(metadata.environment),
          event_id: header.event_id,
          type: item.type === "transaction" ? "transaction" : undefined,
        }),
      ]);
      if (
        item.type === "event" &&
        consent.diagnostics?.eventId === header.event_id
      )
        diagnostics ??= consent.diagnostics;
    }
  }
  if (events.length === 0) return undefined;
  if (diagnostics && events.length === 1)
    events.push([
      {
        type: "attachment",
        filename: "letro-diagnostics.json",
        content_type: "application/json",
        attachment_type: "event.attachment",
        length: diagnostics.length,
      },
      diagnostics.contents,
    ]);
  return [
    { event_id: header.event_id, sent_at: new Date().toISOString() },
    events,
  ];
}

function validEventId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-f]{32}$/i.test(id);
}

function startsWithEvent(body: RequestInit["body"]): boolean {
  if (typeof body !== "string") return false;
  const start = body.indexOf("\n") + 1;
  const end = body.indexOf("\n", start);
  if (start === 0 || end < start) return false;
  try {
    const first: unknown = JSON.parse(body.slice(start, end));
    return (
      typeof first === "object" &&
      first !== null &&
      "type" in first &&
      (first.type === "event" || first.type === "transaction")
    );
  } catch {
    return false;
  }
}

function isError({ level, exception }: Event): boolean {
  return (
    level === "error" || level === "fatal" || Boolean(exception?.values?.length)
  );
}

async function readDiagnostics(
  eventId: string,
  request: () => unknown,
): Promise<DiagnosticAttachment | undefined> {
  const limit = 32 * 1024;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      request(),
      new Promise<null>((resolve) => {
        deadline = setTimeout(() => resolve(null), 250);
      }),
    ]);
    if (typeof result !== "string" || !result.length || result.length > limit)
      return undefined;
    const value: unknown = JSON.parse(result);
    if (
      typeof value !== "object" ||
      value === null ||
      !("schema" in value && value.schema === 1 && "entries" in value) ||
      !Array.isArray(value.entries) ||
      value.entries.length === 0 ||
      value.entries.length > 64
    )
      return undefined;
    const length = new TextEncoder().encode(result).byteLength;
    return length <= limit ? { eventId, contents: result, length } : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(deadline);
  }
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
    /^((?:app:\/\/\/element-call|https:\/\/appassets\.androidplatform\.net\/element-call)\/assets\/[\w.-]+\.js)(?:[?#].*)?$/,
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
