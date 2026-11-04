/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { act, renderHook } from "@testing-library/react";
import {
  createClient,
  EventType,
  KnownMembership,
  MatrixEvent,
  Room,
} from "matrix-js-sdk";
import { expect, test, vi } from "vitest";

import { useRoomName } from "./useRoomName";

const ownUserId = "@alice:example.org";
const peerUserId = "@bob:example.org";
const sharedName = "A shared room name";

test("two-person calls show the counterpart even when the room has a name", () => {
  const room = makeRoom();
  const { result } = renderHook(() => useRoomName(room));
  expect(result.current).toBe("Bob");
});

test("renaming a two-person room does not rename the person in the call", () => {
  const room = makeRoom();
  const { result } = renderHook(() => useRoomName(room));
  act(() => setRoomName(room, "Alice"));
  expect(room.name).toBe("Alice");
  expect(result.current).toBe("Bob");
});

test("the counterpart profile updates while the shared room name stays unchanged", () => {
  const room = makeRoom();
  const { result } = renderHook(() => useRoomName(room));
  act(() => setMember(room, peerUserId, KnownMembership.Join, "Robert"));
  expect(room.name).toBe(sharedName);
  expect(result.current).toBe("Robert");
});

test("an invited counterpart counts as the other person", () => {
  const room = makeRoom(KnownMembership.Invite);
  const { result } = renderHook(() => useRoomName(room));
  expect(result.current).toBe("Bob");
});

test("adding and removing a third active member switches the call title", () => {
  const room = makeRoom();
  const { result } = renderHook(() => useRoomName(room));
  act(() =>
    setMember(room, "@charlie:example.org", KnownMembership.Invite, "Charlie"),
  );
  expect(result.current).toBe(sharedName);
  act(() =>
    setMember(room, "@charlie:example.org", KnownMembership.Leave, "Charlie"),
  );
  expect(result.current).toBe("Bob");
});

test("larger groups retain their shared name", () => {
  const room = makeRoom();
  setMember(room, "@charlie:example.org", KnownMembership.Join, "Charlie");
  const { result } = renderHook(() => useRoomName(room));
  expect(result.current).toBe(sharedName);
  act(() => setRoomName(room, "New group name"));
  expect(result.current).toBe("New group name");
});

test("spaces retain their shared name even with two active members", () => {
  const room = makeRoom(KnownMembership.Join, true);
  const { result } = renderHook(() => useRoomName(room));
  expect(result.current).toBe(sharedName);
});

test("a counterpart without a display name uses their Matrix ID", () => {
  const room = makeRoom();
  setMember(room, peerUserId, KnownMembership.Join);
  const { result } = renderHook(() => useRoomName(room));
  expect(result.current).toBe(peerUserId);
});

test("incomplete two-person membership does not expose the shared name", () => {
  const room = makeRoom();
  setMember(room, peerUserId, KnownMembership.Leave);
  vi.spyOn(room, "getJoinedMemberCount").mockReturnValue(2);
  const { result } = renderHook(() => useRoomName(room));
  expect(result.current).toBe(room.roomId);
});

test("a missing room has no title and can later be supplied", () => {
  const { result, rerender } = renderHook(
    ({ room }: { room: Room | null }) => useRoomName(room),
    {
      initialProps: { room: null as Room | null },
    },
  );
  expect(result.current).toBeNull();
  rerender({ room: makeRoom() });
  expect(result.current).toBe("Bob");
  rerender({ room: null });
  expect(result.current).toBeNull();
});

function makeRoom(
  peerMembership = KnownMembership.Join,
  isSpace = false,
): Room {
  const client = createClient({
    baseUrl: "https://example.org",
    userId: ownUserId,
  });
  const room = new Room("!call:example.org", client, ownUserId);
  room.currentState.setStateEvents([
    new MatrixEvent({
      type: EventType.RoomCreate,
      room_id: room.roomId,
      state_key: "",
      content: {
        creator: ownUserId,
        room_version: "10",
        ...(isSpace ? { type: "m.space" } : {}),
      },
    }),
  ]);
  setMember(room, ownUserId, KnownMembership.Join, "Alice");
  setMember(room, peerUserId, peerMembership, "Bob");
  setRoomName(room, sharedName);
  return room;
}

function setMember(
  room: Room,
  userId: string,
  membership: KnownMembership,
  displayName?: string,
): void {
  room.currentState.setStateEvents([
    new MatrixEvent({
      type: EventType.RoomMember,
      room_id: room.roomId,
      state_key: userId,
      content: { membership, displayname: displayName },
    }),
  ]);
  room.recalculate();
}

function setRoomName(room: Room, name: string): void {
  room.currentState.setStateEvents([
    new MatrixEvent({
      type: EventType.RoomName,
      room_id: room.roomId,
      state_key: "",
      content: { name },
    }),
  ]);
  room.recalculate();
}
