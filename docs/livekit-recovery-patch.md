# LiveKit capture recovery patch

The root workspace pins a patch for `livekit-client@2.23.0`. It repairs managed
capture recovery and sender encoding state in the ESM used by the bundled
standalone, widget, embedded and component builds. The patch includes the matching
TypeScript source. The separate SDK library externalizes LiveKit; its host supplies
that dependency. The CommonJS/UMD export keeps its upstream implementation.

## Recovery ownership

An ended managed microphone or camera can retry after a failed acquisition on its
next eligible foreground or permission event. Recovery preserves the caller's mute
choice. Its capture and publication identity bound pending acquisition, processor
work and sender binding. Stopping, muting, unpublishing or replacing the source
cancels that work and releases unused media. Foreground interest survives without
an attached microphone or camera preview.

On Apple mobile devices, a final `NotReadableError` from browser acquisition can
leave an ended, published microphone or camera waiting for a foreground event
that never arrives. A visible recovery gets one additional attempt after one
second. Both the initial and fallback acquisition must start within 2.5 seconds
of the failure. The SDK rechecks visibility, permission and publication before
adopting the candidate. A later foreground event can still recover the same
publication when the delayed attempt was ineligible.

Caller/admission holds and browser capture holds are independent. A WebView can
omit the Safari version in its user agent. The legacy pause restriction applies
only to a known Safari version below 12 and leaves pause ownership unchanged. Replacing capture
preserves an existing caller hold for primary and backup senders. Initial primary
publication continues to use the existing admission architecture.

## Encoding ownership

Each sender's nominal encoding baseline follows its acknowledged parameter write.
Queued layer changes read that baseline inside the same lock. Refresh plans retain
the separate dimensions of raw capture and processed output. Incompatible,
rejected, replaced or partly updated senders remain eligible for a later refresh.
Removing a resizing processor refreshes the raw output again.

## Upgrade checks

Use the package manager version declared in `package.json`. Review the patch when
upgrading LiveKit, update its exact workspace key and lockfile through pnpm, and
verify a fresh frozen installation reproduces the runtime. Keep source and ESM
changes aligned and remove any source-map reference that describes upstream bytes.

Run the public-runtime regression suites:

```sh
pnpm exec vitest run --project unit --maxWorkers 2 \
  EndedCapture UpstreamPause LocalVideoEncodings Publisher.test
```

Replay the SDK suites with `livekit-client` aliased to its `src/index.ts` as a
separate source-mirror check. Include pending acquisition and sender writes,
permission changes, publication cancellation, overlapping holds, processor swaps,
encoding-count mismatches and primary/backup failures.

Run the full lint, formatting, localization and unit/Storybook gates locally before
packaging. Verify the production bundle's source map contains the tested ESM hash,
then package that one embedded build and preserve the host runtime configuration.

These controlled checks verify SDK state transitions. Labeled iPhone interruption
tests with both peers observing speech and video confirm the physical experience.
