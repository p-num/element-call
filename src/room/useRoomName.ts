/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  KnownMembership,
  type Room,
  RoomEvent,
  RoomStateEvent,
} from "matrix-js-sdk";
import { useCallback, useSyncExternalStore } from "react";

/**
 * The room's display title, kept up to date. Null when there is no room yet, for a
 * caller that only sometimes has one.
 */
export function useRoomName(room: Room): string;
export function useRoomName(room: Room | null): string | null;
export function useRoomName(room: Room | null): string | null {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (room === null) return (): void => {};
      room.on(RoomEvent.Name, onChange);
      room.on(RoomEvent.Summary, onChange);
      room.on(RoomEvent.CurrentStateUpdated, onChange);
      room.on(RoomStateEvent.Update, onChange);
      return (): void => {
        room.off(RoomEvent.Name, onChange);
        room.off(RoomEvent.Summary, onChange);
        room.off(RoomEvent.CurrentStateUpdated, onChange);
        room.off(RoomStateEvent.Update, onChange);
      };
    },
    [room],
  );
  return useSyncExternalStore(
    subscribe,
    useCallback(() => getRoomTitle(room), [room]),
  );
}

function getRoomTitle(room: Room | null): string | null {
  if (room === null) return null;
  if (
    room.isSpaceRoom() ||
    room.getJoinedMemberCount() + room.getInvitedMemberCount() !== 2
  ) {
    return room.name;
  }

  const counterparts = room
    .getMembers()
    .filter(
      (member) =>
        member.userId !== room.myUserId &&
        (member.membership === KnownMembership.Join ||
          member.membership === KnownMembership.Invite),
    );
  return counterparts.length === 1
    ? counterparts[0].name || counterparts[0].userId
    : room.roomId;
}
