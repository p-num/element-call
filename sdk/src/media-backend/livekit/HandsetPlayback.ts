/* Copyright 2026 p-num. SPDX-License-Identifier: AGPL-3.0-only */
import { logger } from "matrix-js-sdk/lib/logger";

export interface HandsetPlayback {
  setVolume(volume: number): void;
  stop(): void;
}

/** Direct playback keeps LiveKit audio restarts from reviving an HTML path. */
export function createHandsetPlayback(
  context: AudioContext,
  track: MediaStreamTrack,
  plugins: AudioNode[],
  volume: number,
): HandsetPlayback {
  const source = context.createMediaStreamSource(new MediaStream([track]));
  const gain = context.createGain();
  gain.gain.value = volume;
  const nodes: AudioNode[] = [source, gain, ...plugins, context.destination];
  for (let index = 0; index < nodes.length - 1; index++)
    nodes[index].connect(nodes[index + 1]);
  void context
    .resume()
    .catch((error) =>
      logger
        .getChild("[HandsetPlayback]")
        .warn("Unable to start handset audio", error),
    );
  return {
    setVolume: (value) => {
      gain.gain.value = value;
    },
    stop: () => {
      for (let index = 0; index < nodes.length - 1; index++)
        nodes[index].disconnect(nodes[index + 1]);
    },
  };
}
