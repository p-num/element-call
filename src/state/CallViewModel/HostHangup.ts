/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type RTCParticipation } from "@element-hq/matrixrtc-sdk";

import {
  type HangupReply,
  type HangupRequest,
  type HostRequest,
} from "../../HostBridge";

/** Keep the host transport open until this request has its departure result. */
export async function handleHostHangup(
  request: HostRequest<HangupRequest, HangupReply | void>,
  participation: Pick<RTCParticipation, "leave">,
): Promise<void> {
  if (request.data?.wait_for_leave !== true) {
    request.reply();
    return;
  }
  request.reply({ left: await participation.leave() });
}
