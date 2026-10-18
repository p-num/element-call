/*
Copyright 2026 Element Creations Ltd.
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { distinctUntilChanged, type Observable, type Subscription } from "rxjs";
import { logger } from "matrix-js-sdk/lib/logger";
import type { HostBridge } from "../../HostBridge";

/** Reports media connection, independently of the user's join intent. */
export function observeHostConnection(
  connected$: Observable<boolean>,
  notify: HostBridge["notifyConnectionState"],
): Subscription {
  let sequence = 0;
  return connected$.pipe(distinctUntilChanged()).subscribe((connected) => {
    notify?.({ connected, sequence: sequence++ }).catch((error) => {
      logger.warn("Failed to report the call connection to the host", error);
    });
  });
}
