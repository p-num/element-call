# Remote audio playback

`MatrixAudioRenderer` filters room tracks against Matrix membership and owns the
handset audio context. Its `useTracks` subscription must include track subscribed
and unsubscribed events: a publication can replace its track without changing its
subscription status.

`RemoteAudioVolume` holds the requested volume per participant and source. Media
view models write this state; they must not also mutate LiveKit volume. Each
`RemoteAudioPlayback` applies the current value to its selected output, including
when playback mounts or a track is replaced.

`RemoteAudioPlayback` owns attachment, volume subscriptions, and mute policy:

- Speaker and headset playback use LiveKit's public HTML track attachment API to
  retain output routing and background playback. Track selection comes from the
  room subscription, rather than a second React SDK subscription.
- Handset playback uses only a per-track WebAudio gain/pan graph. Never attach an
  HTML audio element alongside it: LiveKit can unmute it during `startAudio()`,
  bypassing handset attenuation on iOS.
- Global mute or a requested volume of zero disables the publication and removes
  the playback path. HTML volume alone cannot mute iOS playback. Unmuting restores
  playback only when both mute controls permit it.

`HandsetAudio.test.tsx` exercises these contracts with real LiveKit room, track,
publication, and attachment behavior. Browser audio hardware is mocked, so these
tests do not establish physical receiver acoustics or OS background behavior.
