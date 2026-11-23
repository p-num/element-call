/*
Copyright 2023-2025 New Vector Ltd.
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/lib/logger";
import {
  BehaviorSubject,
  combineLatest,
  distinctUntilChanged,
  map,
  type Observable,
  withLatestFrom,
} from "rxjs";

import { type MediaDevices, type MediaDevice } from "../state/MediaDevices";
import { type DeviceMuteState, type HostBridge } from "../HostBridge";
import { type ObservableScope } from "./ObservableScope";
import { type Behavior, constant } from "./Behavior";

export type Handler = (desired: boolean) => Promise<boolean>;
const defaultHandler: Handler = async (desired) => desired;

/** The user's capture choice and the device state allowed by this call. */
export class MuteState<Label, Selected> {
  private handler: Handler = defaultHandler;
  private desired: boolean;
  private controls?: object;
  private ended = false;
  private pending?: object;
  private needsRepair = false;

  private readonly enabled = new BehaviorSubject(false);
  private readonly syncing = new BehaviorSubject(false);
  public readonly enabled$: Behavior<boolean>;
  public readonly syncing$: Behavior<boolean>;
  public readonly setEnabled$: Behavior<((enabled: boolean) => void) | null>;
  public readonly toggle$: Behavior<(() => void) | null>;

  public constructor(
    scope: ObservableScope,
    device: MediaDevice<Label, Selected>,
    enabledByDefault: boolean,
    forceMute$: Observable<boolean>,
  ) {
    this.desired = enabledByDefault;
    this.enabled$ = scope.behavior(this.enabled);
    this.syncing$ = scope.behavior(this.syncing);
    const controls$ = scope.behavior(
      combineLatest([device.available$, forceMute$]).pipe(
        map(([available, forced]) => !forced && available.size > 0),
        distinctUntilChanged(),
        map((eligible) => {
          logger.info(
            `MuteState: canControlDevices: ${eligible}, enabled by default: ${enabledByDefault}`,
          );
          const controls = eligible ? {} : undefined;
          this.controls = controls;
          if (!eligible) {
            this.enabled.next(false);
            this.apply(false);
          } else if (this.handler === defaultHandler) {
            this.enabled.next(this.desired);
          } else {
            this.reconcile();
          }
          return controls;
        }),
      ),
    );
    this.setEnabled$ = scope.behavior(
      controls$.pipe(
        map((controls) =>
          controls
            ? (enabled: boolean) => {
                if (this.controls !== controls) return;
                this.desired = enabled;
                this.reconcile();
              }
            : null,
        ),
      ),
    );
    this.toggle$ = scope.behavior(
      this.setEnabled$.pipe(
        map((set) =>
          set
            ? () => {
                if (!this.syncing.value) set(!this.enabled.value);
              }
            : null,
        ),
      ),
    );
    scope.onEnd(() => {
      this.ended = true;
      this.controls = undefined;
    });
  }

  public setHandler(handler: Handler): void {
    if (this.handler !== defaultHandler)
      throw new Error("Multiple mute state handlers are not supported");
    this.replaceHandler(handler);
  }

  public unsetHandler(): void {
    this.replaceHandler(defaultHandler);
  }

  private replaceHandler(handler: Handler): void {
    this.handler = handler;
    this.pending = undefined;
    this.needsRepair = false;
    this.syncing.next(false);
  }

  private get target(): boolean {
    return !!this.controls && this.desired;
  }

  private reconcile(): void {
    if (
      !this.pending &&
      (this.needsRepair || this.enabled.value !== this.target)
    ) {
      this.apply(this.target);
    }
  }

  private apply(target: boolean): void {
    const request = {};
    const handler = this.handler;
    this.pending = request;
    this.needsRepair = false;
    this.syncing.next(!!this.controls);
    const finish = (result: boolean | undefined): void => {
      if (this.ended || this.handler !== handler) return;
      if (this.pending !== request) {
        // A superseded publication can still change the real device.
        if (result !== undefined && result !== this.target) {
          this.needsRepair = true;
          this.reconcile();
        }
        return;
      }
      this.pending = undefined;
      if (this.controls && result !== undefined) this.enabled.next(result);
      if (this.needsRepair || target !== this.target) this.reconcile();
      if (!this.pending) this.syncing.next(false);
    };
    void handler(target).then(finish, (err: unknown) => {
      logger.error("MuteState: handler error", err);
      finish(undefined);
    });
  }
}

export class MuteStates {
  /**
   *  True if the selected audio output device is an earpiece.
   *  Used to force-disable video when on earpiece.
   */
  private readonly isEarpiece$ = combineLatest([
    this.mediaDevices.audioOutput.available$,
    this.mediaDevices.audioOutput.selected$,
  ]).pipe(
    map(([available, selected]) => {
      if (!selected?.id) return false;
      const device = available.get(selected.id);
      logger.info(`MuteStates: selected audio output device:`, device);
      return device?.type === "earpiece";
    }),
  );

  public readonly audio = new MuteState(
    this.scope,
    this.mediaDevices.audioInput,
    this.initialMuteState.audioEnabled,
    constant(false),
  );
  public readonly video = new MuteState(
    this.scope,
    this.mediaDevices.videoInput,
    this.initialMuteState.videoEnabled,
    this.isEarpiece$,
  );

  public constructor(
    private readonly scope: ObservableScope,
    private readonly mediaDevices: MediaDevices,
    private readonly initialMuteState: {
      audioEnabled: boolean;
      videoEnabled: boolean;
    },
    hostBridge: HostBridge,
  ) {
    // Keep the host informed of our mute state
    const muteState$ = combineLatest(
      [this.audio.enabled$, this.video.enabled$],
      (audio, video): DeviceMuteState => ({
        audio_enabled: audio,
        video_enabled: video,
      }),
    );
    muteState$.pipe(this.scope.bind()).subscribe((state) => {
      hostBridge
        .notifyDeviceMute(state)
        .catch((e) => logger.warn("Could not send mute state to the host", e));
    });

    // And apply the changes the host asks for
    hostBridge.deviceMute$
      .pipe(
        withLatestFrom(
          muteState$,
          this.audio.setEnabled$,
          this.video.setEnabled$,
        ),
        this.scope.bind(),
      )
      .subscribe(([request, state, setAudioEnabled, setVideoEnabled]) => {
        // First copy the current state into our new state
        const newState = { ...state };
        // Then apply whichever changes the host asked for
        if (
          typeof request.data.audio_enabled === "boolean" &&
          setAudioEnabled !== null
        ) {
          newState.audio_enabled = request.data.audio_enabled;
          setAudioEnabled(newState.audio_enabled);
        }
        if (
          typeof request.data.video_enabled === "boolean" &&
          setVideoEnabled !== null
        ) {
          newState.video_enabled = request.data.video_enabled;
          setVideoEnabled(newState.video_enabled);
        }
        request.reply(newState);
      });
  }
}
