/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { MatrixRTCSession } from "matrix-js-sdk/lib/matrixrtc";
import { logger } from "matrix-js-sdk/lib/logger";

import type { HangupReply, HangupRequest, HostRequest } from "../../HostBridge";

type Session = Pick<MatrixRTCSession, "leaveRoomSession">;
interface Departure {
  result: Promise<boolean>;
  response: Promise<void>;
}

const departures = new WeakMap<Session, Departure>();

/** Opt-in acknowledgement of membership leave, rather than acknowledgement of the request. */
export function handleHostHangup(
  request: HostRequest<HangupRequest, HangupReply | void>,
  session: Session,
): void {
  if (request.data.wait_for_leave !== true) {
    request.reply();
    return;
  }

  let departure = departures.get(session);
  if (!departure) {
    departure = {
      result: session.leaveRoomSession(10_000).catch(() => false),
      response: Promise.resolve(),
    };
    departures.set(session, departure);
  }
  departure.response = departure.result
    .then((left) => request.reply({ left }))
    .catch((error) => logger.error("Failed to acknowledge call leave", error));
}

/** Keep the host connection alive until the requested leave result has been returned. */
export async function waitForHostHangup(session: Session): Promise<void> {
  const departure = departures.get(session);
  await departure?.response;
  if (departures.get(session) === departure) departures.delete(session);
}
