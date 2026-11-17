/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";
import { type MatrixClient, SyncState } from "matrix-js-sdk";
import { logger } from "matrix-js-sdk/lib/logger";
import { type MatrixRTCSession } from "matrix-js-sdk/lib/matrixrtc";
import {
  type LocalParticipant,
  type Room as LivekitRoom,
  ConnectionState,
} from "livekit-client";
import { BehaviorSubject, EMPTY, NEVER } from "rxjs";
import {
  constant,
  E2eeType,
  Epoch,
  MatrixRTCMode,
  type RTCSlot,
} from "@element-hq/matrixrtc-sdk";

import { createRTCParticipation } from "../../sdk/src/RTCParticipation";
import { createLivekitLocalMedia } from "../../sdk/src/media-backend/livekit/LocalMedia";
import { ConnectionMap } from "../../sdk/src/media-backend/livekit/ConnectionMap";
import { type Connection } from "../../sdk/src/media-backend/livekit/Connection";
import { CallTelemetry, type TelemetryEvent } from "../analytics/CallTelemetry";
import { callFailureDiagnostic } from "../analytics/CallFailureDiagnostic";
import {
  mockEmitter,
  mockMatrixRoom,
  MockRTCSession,
  testScope,
  flushPromises,
} from "../utils/test";
import { observeCallTelemetry } from "./CallTelemetry";

describe("real microphone publication telemetry", () => {
  it.each([
    [
      new DOMException("private permission detail", "NotAllowedError"),
      "permissionRefused",
    ],
    [new Error("private publication detail"), "failed"],
  ])(
    "does not record connected when the actual initial publication rejects: %s",
    async (error, outcome) => {
      const scope = testScope();
      const room = mockMatrixRoom({});
      const session = new MockRTCSession(room);
      const rejected = Promise.withResolvers<never>();
      const microphone = vi.fn(async () => rejected.promise);
      const transport = {
        type: "livekit" as const,
        livekit_service_url: "https://media.example.org",
      };
      const localParticipant = {
        ...mockEmitter(),
        identity: "local-member",
        isLocal: true,
        trackPublications: new Map(),
        setMicrophoneEnabled: microphone,
        getTrackPublication: () => undefined,
      } as unknown as LocalParticipant;
      const connection = {
        transport,
        serverName: "example.org",
        state$: constant({
          state: "authenticated",
          livekitState: ConnectionState.Connected,
        } as const),
        livekitRoom: {
          ...mockEmitter(),
          options: {},
          setE2EEEnabled: vi.fn(),
          localParticipant,
        } as unknown as LivekitRoom,
      } as Connection;
      const connections = new ConnectionMap();
      connections.add(connection, []);
      const client = {
        ...mockEmitter(),
        getUserId: () => "@alice:example.org",
        getDeviceId: () => "AAAA",
        getSyncState: () => SyncState.Syncing,
      } as unknown as MatrixClient;
      const { participation } = createRTCParticipation(
        scope,
        {
          client,
          room,
          slot: {} as RTCSlot,
          jsSdkSession: session as unknown as MatrixRTCSession,
          members$: constant([]),
          transports: { get: vi.fn(), connected$: constant([]) },
          slotOptions: {
            matrixRTCMode: MatrixRTCMode.Compatibility,
            encryptionSystem: { kind: E2eeType.NONE },
          },
          logger,
        },
        {
          transport,
          publish: [{ source: "microphone" }],
          backend: (backendScope, context) => ({
            transportType: "livekit",
            prepareLocalTransport: async () =>
              Promise.resolve({
                canDelegateDelayedLeave: false,
              }),
            delegateDelayedLeave: vi.fn(),
            local: createLivekitLocalMedia({
              scope: backendScope,
              connectionMap$: constant(new Epoch(connections)),
              localTransport$: constant({
                transport,
                serverName: "example.org",
              }),
              publish: context.publish,
              audioOutputDeviceId$: new BehaviorSubject<string | undefined>(
                undefined,
              ),
              encryptionSystem: context.encryptionSystem,
              logger,
            }),
            mediaFor: () => ({
              tracks$: constant(null),
              encryptionError$: EMPTY,
            }),
            connections$: constant([]),
            setAudioOutputDeviceId: vi.fn(),
            sendData: vi.fn(),
            data$: NEVER,
          }),
        },
      );
      const events: TelemetryEvent[] = [];
      const reportFailure = vi.fn();
      const telemetry = new CallTelemetry({
        callKind: "dm",
        componentVersion: "test",
        hostAppVersion: "test",
        hostAppBuild: "test",
        track: (event) => events.push(event),
        reportFailure,
      });
      observeCallTelemetry(
        scope,
        telemetry,
        participation,
        session as unknown as MatrixRTCSession,
        room,
      );
      await flushPromises();
      expect(participation.state$.value.kind).toBe("connected");
      expect(microphone).toHaveBeenCalledOnce();
      expect(
        events.filter((event) => event.eventName === "CallJoinOutcome"),
      ).toEqual([]);
      rejected.reject(error);
      await flushPromises();
      expect(
        events
          .filter((event) => event.eventName === "CallJoinOutcome")
          .map((event) => event.outcome),
      ).toEqual([outcome]);
      expect(events.some((event) => event.phase === "connected")).toBe(false);
      if (outcome === "failed") {
        const failure = events.find(
          (event) => event.eventName === "CallFailure",
        )!;
        expect(reportFailure).toHaveBeenCalledWith(failure);
        expect(callFailureDiagnostic(failure)).toMatchObject({
          fingerprint: ["call-failure", "microphoneFailed", "joining"],
        });
      } else expect(reportFailure).not.toHaveBeenCalled();
      scope.end();
      expect(
        events.filter((event) => event.eventName === "CallJoinOutcome"),
      ).toHaveLength(1);
    },
  );
});
