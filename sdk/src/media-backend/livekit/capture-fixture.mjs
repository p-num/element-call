/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { vi } from "vitest";

export class Capture extends EventTarget {
  constructor(kind, settings = {}) {
    super();
    this.kind = kind;
    this.id = crypto.randomUUID();
    this.enabled = true;
    this.muted = false;
    this.readyState = "live";
    this.settings = settings;
  }
  getSettings() {
    return this.settings;
  }
  getConstraints() {
    return {};
  }
  async applyConstraints() {}
  clone() {
    return new Capture(this.kind, this.settings);
  }
  stop() {
    this.readyState = "ended";
  }
}

export class Stream {
  constructor(tracks = []) {
    this.tracks = tracks;
  }
  getTracks() {
    return [...this.tracks];
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  addTrack(track) {
    this.tracks.push(track);
  }
  removeTrack(track) {
    this.tracks = this.tracks.filter((t) => t !== track);
  }
}

export function sender(encodings = []) {
  return {
    encodings,
    getParameters() {
      return { encodings: structuredClone(this.encodings) };
    },
    setParameters: vi.fn(async function (params) {
      this.encodings = structuredClone(params.encodings);
    }),
    replaceTrack: vi.fn(async () => {}),
  };
}
