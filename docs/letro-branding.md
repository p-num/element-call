# Letro Call theme contract (v1)

The maintained source is p-num/element-call. This change starts at upstream
v0.25.0 (latest release on 2026-09-09); upstream development uses `main`.
The same embedded build must be packaged for SwiftPM, Android and Web.

## Selection

Hosts append `brand=letro` to the existing widget fragment, for example
`index.html#?brand=letro&theme=dark&intent=start_call`.
The normal `theme` parameter and Matrix widget ThemeChange action continue to
select light, dark, light-high-contrast and dark-high-contrast independently.
Standalone deployments set `"brand": "letro"` in config.json. A URL selection
overrides that configuration. Absent, misspelled or non-string identifiers use
Element. There are no external stylesheets, CSS payloads, or post-load host CSS.
Brand selection lasts for the app instance, including router navigation.
Standalone config.json preserves it across navigation followed by reload.

`src/branding/theme.ts` is the canonical palette and public semantic mapping.
Vite generates the stylesheet at build/start time; generated.css is ignored.
`call-branding.json` accompanies every build and declares version 1 and both
supported brands. Packaging and host tests must verify it before using a bundle.
A developer-supplied custom call URL must serve this contract too.

## Palette evidence and decisions

Sources inspected at these client commits:

| Client  | Commit     | Source                                                                                 | Primary/accent                               |
| ------- | ---------- | -------------------------------------------------------------------------------------- | -------------------------------------------- |
| iOS     | 20371065d  | ElementX/Sources/Letro/Extensions/SwiftUIExtensions.swift and CompoundExtensions.swift | #F32D1B; gradient #CB2000 → #F7B000          |
| Android | 0f30925145 | libraries/designsystem/.../theme/ElementThemeApp.kt                                    | #BC4500; hover/text #9B2200                  |
| Web     | 3652e89d86 | apps/web/res/themes/letro-light/css/_light.pcss                                        | #E73825; text #C62617; stronger text #7E1107 |

The platforms do **not** have one matching palette. The current iOS primary
#F32D1B defines the decorative primary role. Its existing #CB2000 gradient stop
provides the light interactive background with white text (the brighter primary
is unsuitable for small white text). Web's #7E1107 supplies pressed and high
contrast light roles; Web's #FCCECA/#FDE5E1 supply dark interactive fills.
Android's #9B2200 and iOS's #F7B000 supply light/dark success indicators.
All values come from those clients; no new brand swatches are introduced.

Neutral canvas, surfaces, text, disabled, warning and destructive scales retain
Compound's mode-aware gray, yellow and red tokens. Warning/destructive semantics
remain distinct from brand accents and retain the existing labels/icons.
Participant avatars use neutral foreground/background pairs, avoiding leftover
Element decorative cyan/lime colors. Speaking uses a solid, high contrast brand
ring, so both ends of a gradient cannot hide against a tile. The page's existing
blue/green bitmap backgrounds are replaced only when Letro is selected.

Android currently forces native app light mode and previously forced the call
page dark. The integration selects the active Compound appearance for the call.
It does not change the app-wide appearance policy. Web currently has only a
Letro light host theme; the shared Call bundle provides both appearances.

## Surfaces to validate

| Surface                                             | Shared theme dependencies                                |
| --------------------------------------------------- | -------------------------------------------------------- |
| Prejoin, permissions, connecting, incoming/outgoing | canvas, page gradient, accent actions, connecting status |
| Active call, participant tiles and speaking         | tile, text, speaking ring, avatar palette                |
| Controls and focus                                  | action backgrounds, icon/on-accent pairs, focus border   |
| Menus, dialogs, errors and device selection         | surface, elevated, text, status and destructive tokens   |
| Screen sharing and earpiece overlay                 | existing control/overlay tokens and call lifecycle       |
| Login, register, header and footer                  | brand-selected wordmark and accessible product name      |

Do not infer call or device correctness from a color/token test. Capture the
above states on iOS, Android and Web, in both appearances and high contrast.
Include keyboard focus, disabled controls, camera/microphone denial, reconnect,
Bluetooth/speaker/earpiece, screen sharing, background/foreground, reload and
widget ThemeChange. Check permissions and CallKit independently of branding.

## Maintaining the fork

Keep upstream history intact. `upstream` points to element-hq/element-call and
`origin` to p-num/element-call. Maintain a release-based Letro branch and merge
reviewed upstream release tags with ordinary merge commits; do not rewrite tags
or rebase published history. No cherry-picks outside v0.25.0 are required by
this implementation. Each client's upgrade also incorporates its intervening
upstream Call releases (iOS 0.20.0, Android 0.24.0, Web 0.19.2 → 0.25.0).

On an upstream merge, inspect UrlParams, Config, useTheme, index.css, the Compound
semantic token set, all literal CSS/SVG colors, gradients, logo imports, and new
call states. Run token and contrast tests, TypeScript checks, existing widget and
call-state tests, and the manual matrix. If upstream adds a new semantic token
using green/blue, add an explicit mapping rather than overriding base colors.
Preserve the default Element path. Additive v1 fields are compatible; changes to
identifier meaning or required host behavior require a new contract version.

Publish one source revision with full and embedded outputs. Package that exact
embedded output for p-num/element-call-swift, Android assets and Web npm tarball.
Pin immutable versions/checksums in hosts; never point a release at a moving
branch or merely add brand=letro to an upstream bundle. Keep platform PRs separate.
PR p-num/element-x-ios#207 is already closed and must not be cherry-picked.
