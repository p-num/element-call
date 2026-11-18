/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

export type ParticipationIdentity = {
  roomId: string;
  slotId: string;
  sender: string;
  memberId: string;
  generation: "per-join" | `legacy-join:${string}` | `legacy:${bigint}`;
};

export type CorrelationUpdate =
  | {
      correlationKind: "binding";
      participationId: string;
      canonicalRoot: string;
    }
  | {
      correlationKind: "edgeAndAlias";
      participantA: string;
      participantB: string;
      previousRoot: string;
      canonicalRoot: string;
    };

/** The shared v1 preimage is UTF-8 byte lengths, never JS string lengths. */
export async function participationDigest(
  identity: ParticipationIdentity,
): Promise<string> {
  const fields = [
    "letro-call-participation-v1",
    identity.roomId,
    normalizedSlot(identity.slotId),
    identity.sender,
    identity.memberId,
    identity.generation,
  ].map((field) => new TextEncoder().encode(field));
  const bytes = new Uint8Array(
    fields.reduce((size, field) => size + 8 + field.length, 0),
  );
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const field of fields) {
    view.setBigUint64(offset, BigInt(field.length));
    bytes.set(field, offset + 8);
    offset += 8 + field.length;
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function normalizedSlot(slot: string): string {
  return ["", "ROOM", "m.call#", "m.call#ROOM"].includes(slot)
    ? "m.call#room"
    : slot;
}

/** Positive co-membership snapshots only; decreasing roots also encode aliases. */
export class ParticipationGraph {
  private readonly parents = new Map<string, string>();
  private lastBinding: string | undefined;

  public observe(
    local: string,
    coMembers: readonly string[],
  ): CorrelationUpdate[] {
    if (!isDigest(local) || !coMembers.includes(local)) return [];
    const nodes = [...new Set(coMembers.filter(isDigest))].sort();
    const updates: CorrelationUpdate[] = [];
    for (let i = 1; i < nodes.length; i++) {
      const [a, b] = [nodes[0], nodes[i]];
      const [rootA, rootB] = [this.root(a), this.root(b)].sort();
      if (rootA === rootB) continue;
      this.parents.set(rootB, rootA);
      updates.push({
        correlationKind: "edgeAndAlias",
        participantA: a,
        participantB: b,
        previousRoot: rootB,
        canonicalRoot: rootA,
      });
    }
    const canonicalRoot = this.root(local);
    const binding = `${local}:${canonicalRoot}`;
    if (binding !== this.lastBinding) {
      this.lastBinding = binding;
      updates.push({
        correlationKind: "binding",
        participationId: local,
        canonicalRoot,
      });
    }
    return updates;
  }

  private root(node: string): string {
    const parent = this.parents.get(node);
    if (parent === undefined) return node;
    const root = this.root(parent);
    this.parents.set(node, root);
    return root;
  }
}

function isDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}
