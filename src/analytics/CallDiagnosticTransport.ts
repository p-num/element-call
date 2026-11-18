/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type makeFetchTransport, type Event } from "@sentry/react";

import { callFailureDiagnostic } from "./CallFailureDiagnostic";
import { type TelemetryEvent } from "./CallTelemetry";

type Transport = ReturnType<typeof makeFetchTransport>;
type Envelope = Parameters<Transport["send"]>[0];
type PendingDiagnostic = {
  event: Event;
  capturedAt: number;
  isCurrent(): boolean;
};

/** The SDK may bypass beforeSend on recovery. Only locally authorized events may leave. */
export class CallDiagnosticTransport {
  private readonly pending = new Map<string, PendingDiagnostic>();
  private readonly attempts = new Map<string, Set<string>>();

  public constructor(
    private readonly options: {
      release: string;
      environment?: string;
      consent(): boolean;
      consentGeneration(): number;
    },
  ) {}

  public authorize(
    source: TelemetryEvent,
    isCurrent: () => boolean,
  ): Event | undefined {
    if (!this.options.consent() || !isCurrent()) return undefined;
    const consentGeneration = this.options.consentGeneration();
    const diagnostic = callFailureDiagnostic(source);
    if (diagnostic === null) return undefined;
    const attemptId = String(source.attemptId);
    let failures = this.attempts.get(attemptId);
    const key = `${source.cause}:${source.phase}`;
    if (failures?.has(key)) return undefined;
    if (failures === undefined) {
      while (this.attempts.size >= 32)
        this.attempts.delete(this.attempts.keys().next().value!);
      failures = new Set<string>();
      this.attempts.set(attemptId, failures);
    }
    failures.add(key);
    this.prune();
    while (this.pending.size >= 32)
      this.pending.delete(this.pending.keys().next().value!);
    const event: Event = {
      ...diagnostic,
      event_id: crypto.randomUUID().replaceAll("-", ""),
      timestamp: Date.now() / 1000,
      platform: "javascript",
      release: this.options.release,
      environment: this.options.environment,
    };
    this.pending.set(event.event_id!, {
      event: structuredClone(event),
      capturedAt: Date.now(),
      isCurrent: () =>
        consentGeneration === this.options.consentGeneration() && isCurrent(),
    });
    return event;
  }

  public wrap(delegate: Transport): Transport {
    return {
      send: async (envelope) => {
        const safe = this.consume(envelope);
        if (safe === undefined) return { statusCode: 200 };
        return await delegate.send(safe);
      },
      flush: async (timeout) => await delegate.flush(timeout),
    };
  }

  private consume(envelope: Envelope): Envelope | undefined {
    this.prune();
    const events = envelope[1].filter(([header]) => header.type === "event");
    if (events.length !== 1) return undefined;
    const payload = events[0][1] as Event;
    const eventId = envelope[0].event_id;
    if (
      typeof eventId !== "string" ||
      payload === null ||
      typeof payload !== "object" ||
      payload.event_id !== eventId
    )
      return undefined;
    const pending = this.pending.get(eventId);
    if (pending === undefined) return undefined;
    this.pending.delete(eventId);
    if (
      !this.options.consent() ||
      !pending.isCurrent() ||
      payload.type !== undefined ||
      payload.message !== "Unsuccessful call" ||
      payload.exception?.values?.length !== 1 ||
      payload.exception.values[0].type !== "CallFailure"
    )
      return undefined;
    // Rebuild headers and payload; do not reuse SDK scopes, attachments, DSC, sessions or reports.
    return [
      { event_id: eventId, sent_at: new Date().toISOString() },
      [[{ type: "event" }, structuredClone(pending.event)]],
    ];
  }

  private prune(): void {
    const oldestAllowed = Date.now() - 120_000;
    for (const [id, pending] of this.pending)
      if (pending.capturedAt < oldestAllowed || !pending.isCurrent())
        this.pending.delete(id);
  }
}
