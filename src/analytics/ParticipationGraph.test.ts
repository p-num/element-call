/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { webcrypto } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import {
  ParticipationGraph,
  participationDigest,
  normalizedSlot,
  type ParticipationIdentity,
} from "./ParticipationGraph";

describe("participation identity v1", () => {
  beforeEach(() => vi.stubGlobal("crypto", webcrypto));
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    [
      "legacy:1234567890",
      "1b883baaa40e151769e19ec07db0fb506a3d67fc2967bb6ce726abd95b896add",
    ],
    [
      "per-join",
      "2b50f7aa4c98f4354169b972b8eb99b1ac40e97c003c258ab297e82f873ddce0",
    ],
  ] as const)(
    "matches the shared native %s hash fixture",
    async (generation, expected) => {
      expect(await participationDigest(identity(generation))).toBe(expected);
    },
  );

  it("keeps legacy slot aliases identical and successive room calls distinct", async () => {
    const first = await participationDigest(identity("legacy:1234567890"));
    for (const slotId of ["", "ROOM", "m.call#", "m.call#ROOM", "m.call#room"])
      expect(
        await participationDigest({ ...identity("legacy:1234567890"), slotId }),
      ).toBe(first);
    expect(await participationDigest(identity("legacy:1234567891"))).not.toBe(
      first,
    );
    expect(
      await participationDigest({
        ...identity("per-join"),
        memberId: "next-join",
      }),
    ).not.toBe(await participationDigest(identity("per-join")));
    expect(normalizedSlot("m.call#another")).toBe("m.call#another");
  });

  it.each([
    [
      "legacy:1234567890",
      "80c431cf2ce574fbbaf2e75330be7ba177af3c409692ef60662b358f449c890b",
    ],
    [
      "per-join",
      "56c28d9cd9eb30866df9774de45609794047cb5876425af412ff26554e2650b7",
    ],
  ] as const)(
    "preserves the literal room slot in the shared %s negative fixture",
    async (generation, expected) => {
      expect(normalizedSlot("room")).toBe("room");
      expect(
        await participationDigest({ ...identity(generation), slotId: "room" }),
      ).toBe(expected);
    },
  );

  it("length-prefixes UTF-8 fields without Unicode normalization or boundary ambiguity", async () => {
    expect(
      await participationDigest({
        ...identity("per-join"),
        sender: "é",
        memberId: "x",
      }),
    ).not.toBe(
      await participationDigest({
        ...identity("per-join"),
        sender: "e\u0301",
        memberId: "x",
      }),
    );
    expect(
      await participationDigest({
        ...identity("per-join"),
        sender: "ab",
        memberId: "c",
      }),
    ).not.toBe(
      await participationDigest({
        ...identity("per-join"),
        sender: "a",
        memberId: "bc",
      }),
    );
  });
});

describe("positive participation graph", () => {
  const [a, b, c, d] = ["1", "2", "3", "4"].map((value) => value.repeat(64));

  it("emits sorted positive edges and only decreasing aliases, ignoring duplicates", () => {
    const graph = new ParticipationGraph();
    const updates = graph.observe(c, [c, a, b, c]);
    expect(updates).toEqual([
      {
        correlationKind: "edgeAndAlias",
        participantA: a,
        participantB: b,
        previousRoot: b,
        canonicalRoot: a,
      },
      {
        correlationKind: "edgeAndAlias",
        participantA: a,
        participantB: c,
        previousRoot: c,
        canonicalRoot: a,
      },
      { correlationKind: "binding", participationId: c, canonicalRoot: a },
    ]);
    expect(graph.observe(c, [b, c, a])).toEqual([]);
    expect(graph.observe(c, [])).toEqual([]);
    expect(graph.observe(c, [d])).toEqual([]);
  });

  it("retains continuous overlap when the original participant leaves", () => {
    const graph = new ParticipationGraph();
    graph.observe(b, [a, b]);
    const updates = graph.observe(b, [b, c]);
    expect(updates).toContainEqual({
      correlationKind: "edgeAndAlias",
      participantA: b,
      participantB: c,
      previousRoot: c,
      canonicalRoot: a,
    });
    expect(graph.observe(c, [c, d])).toContainEqual({
      correlationKind: "binding",
      participationId: c,
      canonicalRoot: a,
    });
  });

  it("converges under reordered independent evidence and binds no empty snapshot", () => {
    const one = new ParticipationGraph();
    const two = new ParticipationGraph();
    one.observe(b, [b, c]);
    one.observe(b, [a, b]);
    two.observe(b, [a, b]);
    two.observe(b, [c, b]);
    expect(one.observe(c, [c])).toEqual([
      { correlationKind: "binding", participationId: c, canonicalRoot: a },
    ]);
    expect(two.observe(c, [c])).toEqual([
      { correlationKind: "binding", participationId: c, canonicalRoot: a },
    ]);
    expect(new ParticipationGraph().observe(a, [])).toEqual([]);
    expect(
      new ParticipationGraph().observe("raw-user-id", ["raw-user-id"]),
    ).toEqual([]);
  });
});

function identity(
  generation: ParticipationIdentity["generation"],
): ParticipationIdentity {
  return {
    roomId: "!fixture:example.org",
    slotId: "m.call#room",
    sender: "@alice:example.org",
    memberId: "fixture-participation",
    generation,
  };
}
