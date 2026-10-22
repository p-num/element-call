/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type Logger } from "matrix-js-sdk/lib/logger";
import {
  type MatrixRTCSession as JsSdkRTCSession,
  type Transport,
} from "matrix-js-sdk/lib/matrixrtc";
import { deepCompare } from "matrix-js-sdk/lib/utils";
import {
  BehaviorSubject,
  catchError,
  combineLatest,
  distinctUntilChanged,
  NEVER,
  type Observable,
  scan,
} from "rxjs";

import { type Behavior } from "../reactive/Behavior";
import { type ObservableScope } from "../reactive/ObservableScope";
import { type DelayedLeaveTimings, type SessionTimings } from "../config";
import { type MatrixDisconnectReason } from "../api";
import {
  type MatrixRTCError,
  MembershipManagerError,
  toMatrixRTCError,
} from "../errors";
import {
  type MediaBackend,
  type TransportCapabilities,
} from "../media-backend/api";
import { type HomeserverConnected } from "./HomeserverConnected";

export type MembershipState =
  /** Asking the homeserver for a transport, or preparing it. */
  | { kind: "waitingForTransport" }
  /** Transport known; sending the membership for the first time. */
  | { kind: "joining" }
  /** Syncing, membership confirmed by the server, delayed leave still being refreshed. */
  | { kind: "joined" }
  /** Was joined and one homeserver link is down; the membership manager is retrying. */
  | { kind: "reconnecting"; reason: MatrixDisconnectReason }
  /** A transport, join or membership manager error ended the membership. Terminal unless `left`. */
  | { kind: "failed"; error: MatrixRTCError }
  /** `leave()` was called. Terminal. */
  | { kind: "left" };

/** The local transport, found and prepared, with what the join needs to know about it. */
export interface PreparedTransport extends TransportCapabilities {
  transport: Transport;
}

interface Props {
  scope: ObservableScope;
  delegateDelayedLeave: MediaBackend["delegateDelayedLeave"];
  preparedTransport$: Observable<PreparedTransport>;
  homeserverConnected: HomeserverConnected;
  joinMatrixRTC: (
    transport: Transport,
    delayedLeave: DelayedLeaveTimings,
  ) => void;
  /** The membership manager giving up on keeping the membership alive. */
  membershipManagerError$: Observable<unknown>;
  matrixRTCSession: Pick<JsSdkRTCSession, "leave">;
  /** The id of the delayed leave event, for the backend to take over. */
  delayId$: Behavior<string | null>;
  timings: SessionTimings;
  logger: Logger;
}

export interface LocalMembership {
  /** Sends the leave. Final: there is no joining again. */
  leave: () => Promise<boolean>;
  state$: Behavior<MembershipState>;
}

/**
 * The Matrix side of the local member: waits for the transport, enters the
 * MatrixRTC session, keeps the delayed leave delegated, and leaves on
 * `leave()`. Knows nothing about the media.
 */
export function createLocalMembership$({
  scope,
  delegateDelayedLeave,
  preparedTransport$: preparedTransportWithErrors$,
  homeserverConnected,
  joinMatrixRTC,
  membershipManagerError$,
  matrixRTCSession,
  delayId$,
  timings,
  logger: parentLogger,
}: Props): LocalMembership {
  const logger = parentLogger.getChild("[LocalMembership]");

  const transportError$ = new BehaviorSubject<MatrixRTCError | null>(null);
  const transport$ = scope.behavior<PreparedTransport | null>(
    preparedTransportWithErrors$.pipe(
      catchError((e: unknown) => {
        transportError$.next(toMatrixRTCError(e));
        return NEVER;
      }),
    ),
    null,
  );

  const joined$ = new BehaviorSubject(true);
  const matrixError$ = new BehaviorSubject<MatrixRTCError | null>(null);
  let entered = false;
  let leaveResult: Promise<boolean> | undefined;
  const leaveSession = async (): Promise<boolean> => {
    leaveResult ??= entered
      ? confirmedLeave(
          matrixRTCSession,
          membershipManagerError$,
          matrixError$.value !== null,
        )
      : Promise.resolve(true);
    return leaveResult;
  };
  scope.onEnd(() => {
    void leaveSession();
  });

  scope.reconcile(
    scope.behavior(combineLatest([transport$, joined$])),
    async ([prepared, joined]) => {
      if (prepared === null || !joined) return;
      try {
        entered = true;
        joinMatrixRTC(
          prepared.transport,
          prepared.canDelegateDelayedLeave
            ? timings.delegatedDelayedLeave
            : timings.delayedLeave,
        );
      } catch (e) {
        logger.error("Failed to enter the session", e);
        if (matrixError$.value === null) matrixError$.next(toMatrixRTCError(e));
      }
      return Promise.resolve(async (): Promise<void> => {
        await leaveSession();
      });
    },
  );

  scope.reconcile(
    scope.behavior(combineLatest([transport$, delayId$])),
    async ([prepared, delayId]) => {
      if (!prepared?.canDelegateDelayedLeave || delayId === null) return;
      try {
        await delegateDelayedLeave(delayId);
      } catch (e) {
        logger.error("Failed to delegate the leave", e);
      }
    },
  );

  membershipManagerError$.pipe(scope.bind()).subscribe((e) => {
    logger.error("The membership manager stopped", e);
    if (matrixError$.value === null)
      matrixError$.next(
        new MembershipManagerError(
          e instanceof Error ? e : new Error(String(e)),
        ),
      );
  });

  const state$ = scope.behavior<MembershipState>(
    combineLatest([
      joined$,
      transportError$,
      matrixError$,
      transport$,
      homeserverConnected.disconnectReason$,
    ]).pipe(
      scan(
        (previous, [joined, transportError, matrixError, transport, reason]) =>
          membershipState(previous, {
            joined,
            error: transportError ?? matrixError,
            hasTransport: transport !== null,
            reason,
          }),
        { kind: "waitingForTransport" } as MembershipState,
      ),
      distinctUntilChanged(deepCompare),
    ),
  );

  return {
    leave: async () => {
      joined$.next(false);
      return leaveSession();
    },
    state$,
  };
}

interface MembershipInputs {
  joined: boolean;
  error: MatrixRTCError | null;
  hasTransport: boolean;
  reason: MatrixDisconnectReason | null;
}

/** The next state, in priority order; `left` and `failed` are absorbing. */
function membershipState(
  previous: MembershipState,
  { joined, error, hasTransport, reason }: MembershipInputs,
): MembershipState {
  if (!joined) return { kind: "left" };
  if (previous.kind === "failed") return previous;
  if (error !== null) return { kind: "failed", error };
  if (!hasTransport) return { kind: "waitingForTransport" };
  if (reason === null) return { kind: "joined" };
  const wasJoined =
    previous.kind === "joined" || previous.kind === "reconnecting";
  return wasJoined ? { kind: "reconnecting", reason } : { kind: "joining" };
}

/** The legacy SDK can resolve true after its worker has failed. */
async function confirmedLeave(
  session: Pick<JsSdkRTCSession, "leave">,
  membershipManagerError$: Observable<unknown>,
  failed: boolean,
): Promise<boolean> {
  const errors = membershipManagerError$.subscribe(() => {
    failed = true;
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const left = await Promise.race([
      // Teardown stops local media before the network leave starts.
      Promise.resolve().then(async () => session.leave(10_000)),
      new Promise<false>((resolve) => {
        deadline = setTimeout(() => resolve(false), 10_000);
      }),
    ]);
    return left && !failed;
  } catch {
    return false;
  } finally {
    clearTimeout(deadline);
    errors.unsubscribe();
  }
}
