/* Copyright 2026 p-num. SPDX-License-Identifier: AGPL-3.0-only */
import { logger } from "matrix-js-sdk/lib/logger";

export interface HandsetPlayback {
  setVolume(volume: number): void;
  stop(): void;
}

/** Direct playback keeps LiveKit audio restarts from reviving an HTML path. */
export function createHandsetPlayback(
  context: AudioContext,
  ownerDocument: Document,
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
  const recovery = retainContext(context, ownerDocument);
  let stopped = false;
  return {
    setVolume: (value) => {
      gain.gain.value = value;
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      recovery.release();
      for (let index = 0; index < nodes.length - 1; index++)
        nodes[index].disconnect(nodes[index + 1]);
    },
  };
}

interface ContextRecovery {
  graphs: number;
  unsettled: number;
  stop?: () => void;
}

const contexts = new WeakMap<AudioContext, ContextRecovery>();
const retryDelays = [1000, 2000, 4000];

function retainContext(
  context: AudioContext,
  ownerDocument: Document,
): { release(): void } {
  const recovery = contexts.get(context) ?? { graphs: 0, unsettled: 0 };
  contexts.set(context, recovery);
  if (++recovery.graphs === 1) {
    recovery.stop = observeInterruptions(context, ownerDocument, recovery);
  }
  return {
    release: () => {
      if (--recovery.graphs === 0) {
        recovery.stop?.();
        recovery.stop = undefined;
      }
    },
  };
}

function observeInterruptions(
  context: AudioContext,
  ownerDocument: Document,
  recovery: ContextRecovery,
): () => void {
  const log = logger.getChild("[HandsetPlayback]");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let episode: { deadline: number; step: number; attempts: number } | undefined;
  const eligible = (): boolean =>
    recovery.graphs > 0 &&
    !ownerDocument.hidden &&
    context.state !== "running" &&
    context.state !== "closed";
  const cancel = (): void => {
    clearTimeout(timer);
    episode = undefined;
  };
  const update = (): void => {
    if (!eligible()) cancel();
    else if (!episode) {
      episode = { deadline: performance.now() + 8000, step: 0, attempts: 0 };
      attempt();
    }
  };
  function attempt(): void {
    const current = episode;
    if (!current || !eligible()) {
      cancel();
      return;
    }
    const remaining = current.deadline - performance.now();
    if (remaining <= 0 || current.step > retryDelays.length) {
      log.warn("Handset audio resume budget exhausted", {
        state: context.state,
        attempts: current.attempts,
      });
      return;
    }
    const delay = retryDelays[current.step++] ?? remaining;
    timer = setTimeout(attempt, Math.min(delay, remaining));
    // WebKit may leave the first resume unresolved throughout the interruption.
    if (recovery.unsettled >= 2) return;
    recovery.unsettled++;
    current.attempts++;
    void context.resume().then(
      () => {
        recovery.unsettled--;
      },
      (error: unknown) => {
        recovery.unsettled--;
        if (current === episode)
          log.warn("Unable to resume handset audio", error);
      },
    );
  }

  ownerDocument.addEventListener("visibilitychange", update);
  context.addEventListener("statechange", update);
  update();
  return () => {
    cancel();
    ownerDocument.removeEventListener("visibilitychange", update);
    context.removeEventListener("statechange", update);
  };
}
