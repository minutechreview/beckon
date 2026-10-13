# Design

How Beckon's web app and site look and behave, and how to extend them without breaking either. The code is
the source of truth: `web/src/app/globals.css` (tokens and components), `web/src/components/` (React), and
`web/e2e/` (the behaviour the tests pin down).

## Principles

1. **The core moment comes first.** A phone buzzes; the user understands what is being asked and answers
   safely, in under five seconds. Everything on the path from notification to answer is optimised for that:
   the question in full and in terminal type, answer buttons of 50 px within thumb reach, and nothing else
   competing for attention. Onboarding comes second, the public site third.
2. **Security UX only gets clearer.** Say what Beckon does and no more. Every request shows whether the program
   reported it or the helper **detected** it on screen, that it was decrypted on this device, and, after an
   answer, which device answered and what happened (applied, already handled, rejected, expired). Never imply
   protection that [SECURITY.md](../SECURITY.md) doesn't promise: for example, response statuses come from the
   server, and the UI says so where it matters.
3. **Feel native on phones.** It is an installed PWA first: a bottom tab bar, safe-area insets, the platform
   font, sheets and switches people already know, the app badge, and no layout shift.
4. **Every state is designed.** Loading (placeholders that hold their space), empty, offline and reconnecting,
   errors, plan limits, unpaired and revoked devices. If a state can happen, it has words and a next step.
5. **Plain CSS, small JavaScript.** No UI library and no CSS framework. One stylesheet of tokens and
   components; libsodium loads on first use, not in the initial bundle.

## Tokens

All tokens are custom properties on `:root` in `globals.css`, redefined for dark mode under
`@media (prefers-color-scheme: dark)`. Never write a colour literal in a component; use a token.

| Group | Tokens | Use |
|---|---|---|
| Surfaces | `--bg`, `--surface`, `--surface-2`, `--fill`, `--fill-strong`, `--separator`, `--chrome` | page ground, cards, insets (code), secondary buttons, hairlines, translucent bars |
| Text | `--text`, `--text-2`, `--muted` | body, secondary body, captions. `--muted` is at least 4.5:1 on every surface |
| Action | `--accent`, `--accent-hover`, `--on-accent`, `--accent-soft`, `--link` | primary buttons, selection, links. Links use `--link`, which passes AA as text |
| States | `--blocked*`, `--error*`, `--done*`, `--working*`, `--idle*`, `--danger*` | each state has a strong colour (dots, bars), a `-text` colour and a `-bg` tint |
| Type | `--font`, `--font-mono`, `--fs-xs` … `--fs-3xl`, `--lh`, `--lh-tight` | the platform UI font; JetBrains Mono for terminal text |
| Space | `--s1` (4 px) … `--s12` (48 px) | margins, padding, gaps |
| Shape | `--r-sm` … `--r-xl`, `--r-pill`, `--shadow-card`, `--shadow-float`, `--ring-card` | radii and elevation |
| Sizes | `--tap` (44 px), `--tap-lg` (50 px), `--content`, `--sidebar`, `--appbar-h`, `--tabbar-h` | touch targets and the shell |
| Motion | `--ease`, `--dur-fast`, `--dur`, `--focus` | transitions and the focus ring. All motion stops under `prefers-reduced-motion` |

**Colour rules.** State is never shown by colour alone: a badge has a dot *and* a word, and a card has a
heading. Every text/background pair meets WCAG 2.2 AA in both themes; check new pairs before adding them.

**Fonts.** UI text uses the platform font, so most pages download no font. Terminal text (commands, the
message block, safety words) uses JetBrains Mono, self-hosted from `web/public/fonts/` (SIL OFL 1.1; the
licence sits next to the file). The CSP is `font-src 'self'`: never link a font CDN.

## Components

React components live in `web/src/components/`; their CSS is in `globals.css`, grouped by area.

| Component | What it is | Notes |
|---|---|---|
| `Icon` | Inline 24 px stroke icons by name | Decorative unless given `label`. Add new icons to `PATHS` |
| `Logo`, `LogoMark` | The mark (a prompt chevron and a waiting dot) and wordmark | `scripts/gen-icons.ts` draws the same shapes for the PWA icons |
| `Nav`, `ConnStatus` | The main navigation and the connection status | One `<nav>`: a bottom tab bar under 900 px, a sidebar above. Status is a word, announced only when lost or regained |
| `.btn` | Buttons: default, `.primary`, `.danger`, `.ghost`; sizes `.small`, `.large`; `.block` | Every size keeps a 44 px target |
| `.card`, `.group`, `.list-row` | A card, a grouped list, and its rows | `.group` children get hairlines between them |
| `StateChip`, `DetectedChip` | State badge (dot and word) and the "Detected" badge | Keep `data-state` and `data-testid="detected-chip"` |
| `.notice` | Banners: `.info`, `.warn`, `.error`, `.success` | An icon and one or two sentences that say what to do |
| `RecordText` | A record's decrypted title and message | The message is read as Markdown (`lib/client/markdown.ts`, rendered by `Markdown`) and built from text nodes only: no HTML, links keep their text but are not clickable. `clamp` shows it as plain text. Locked/unverified show a warning, never content. `variant="request"` sets the message in full, in mono |
| `ResponseButtons`, `ResponseStatus`, `ResponseList` | Answer buttons, the latest outcome, and the audit list | Buttons only for a verified body with options. Status says who sent it |
| `RequestView` | The focused request (session page, and the split view's panel with `level={2}`) | The answer bar is sticky within thumb reach |
| `SplitInbox` (in `Inbox.tsx`) | At 1100 px and wider: compact rows (`inbox-row`, links with `aria-current`) beside a panel (`inbox-panel`) showing the selected record | The answer buttons render only in the panel, never in the list: one copy of each control that types into a terminal. The selection is in the URL (`/app?s=<session>&p=<path>`). ↑/↓/Home/End move it while the list has focus and never answer; Enter moves focus to the panel heading. A new request never takes the panel; once the shown request is answered or leaves, the next one is selected, announced, and its buttons stay disabled for 800 ms so a second tap can't answer it. Below 1100 px the component isn't rendered at all (`useMediaQuery`, false on the server) |
| `AnswerHint` (in `Inbox.tsx`) | A one-time hint on the first phone request card with answer buttons (`answer-hint`) | "Got it" hides it for good, stored per device in localStorage (`lib/client/flag.ts`), never on the server. Not in the split view or the request page, where there is no card to tap or swipe. Its wording must match SECURITY.md, "Signed responses" |
| `HostsView`, `RecordTree` | Hosts: a compact row per session (`data-testid="session"`, `data-group` blocked, working or finished), finished ones under "Finished (N)" (`finished`); a row opens to its `RecordTree` | Disclosures are `<button aria-expanded aria-controls>` with a turning chevron (`.disclosure`), remembered per device by `useDisclosure` (`lib/client/disclosure.ts`). Two or more children of the root fold to the current one (`stage-toggle`). `Clamp` cuts long text to three lines with "Show more"; never for a blocked record |
| `PairPanel` | Pairing: steps, the six words in a numbered grid, confirm or reject | `data-testid="safety-code"` text is the words separated by spaces |
| `CopyCommand` | A shell command with a Copy button | Falls back to selecting the text |
| `Toasts` | In-app notifications | Drop themselves when their record moves on; announced but not shown on the inbox |
| `AuthShell` | The frame for `/signin` and `/device` | |
| `.empty`, `.skeleton` | Empty and loading states | Give placeholders the height of what replaces them |

**Stable hooks.** The e2e tests and the demo script (`scripts/demo/`) rely on `data-testid`s (`inbox-item`, which
exists only below 1100 px: wider, the inbox has `inbox-row` and `inbox-panel` instead;
`response-buttons`, `response-status`, `safety-code`, `codes-match`, `approve`, `approved`, `conn`, …) and on
a few roles and names: the main nav's **Inbox** link must stay unique on every page, and answer buttons are
found by their option label. Keep them when you change markup; prefer role- and label-based selectors in new
tests.

## Adding a page

1. **Route.** App pages go under `web/src/app/app/` (they get the shell, the live store and device keys);
   public pages under `web/src/app/(site)/` (site header and footer); full-screen flows like sign-in use
   `AuthShell`.
2. **Heading.** Exactly one `h1`, in every state: loading, empty and error included.
3. **Layout.** Build from existing classes first: `.section-title` for section labels, `.group` and
   `.list-row` for settings-like lists, `.card` for objects, `.notice` for banners, `.empty` for nothing-here.
   New CSS goes in `globals.css` under its area, using tokens only.
4. **States.** Design loading (a placeholder of the right height), empty, error and offline before the happy
   path. Use `useBeckon().state.loaded` and `useDevice().status`. App pages are rendered on the server with the
   first snapshot, so `loaded` is already true on a full page load; whatever depends on this device (its keys and
   pins) is not known until the browser reads IndexedDB. Use `useDevice().paired` for placeholders: it holds the
   server's hint until the pins are read, so the first paint and the hydrated page agree.
5. **Text.** Short, direct sentences from the user's side ("Pair this device", not "Create pinning"). Errors
   say what happened and what to do. Security claims must match SECURITY.md.
6. **Accessibility.** Real buttons and links, labels on every input, visible focus (the global
   `:focus-visible` ring), 44 px targets, no colour-only meaning, `role="status"` only for changes the user
   needs to hear.
7. **Check.** `npm run typecheck`, `npm test`, `npm run test:e2e`. The e2e suite includes
   `e2e/a11y.spec.ts`, which runs axe (WCAG 2.2 A and AA) on the main site and app pages in light and dark and
   fails on any violation; add a new page to its list. `npm run ui:capture -- --out after` (and `--out before` on
   `main`) takes before/after screenshots of every page and state at 390×844 and 1440×900, light and dark, in
   `web/ui-captures/`. Then a keyboard pass, and Lighthouse mobile on a production build. Expect perf of 90 or
   more, accessibility 100, and CLS under 0.1.

## Notifications and the PWA

- The push title is the server's generic line, worded like the app's own headlines
  (`web/src/lib/client/labels.ts`): "claude-code needs permission on studio-mac", "… has a question", "… needs
  you to sign in", "… hit an error", "… finished", with "(detected)" added for inferred records. The in-app
  toast uses the same line. The service worker adds the decrypted message as the body when the record
  verifies on this device, and answer actions where the platform has them (not iOS). Blocked notifications set `requireInteraction`.
- Tapping a notification opens the session page, which leads with the request.
- `web/src/app/manifest.ts` and `public/icons/` (generated by `npm run icons`) define the installed app.
  `npm run icons` also draws the iOS launch screens in `public/icons/splash/`: the icon centred on `--bg`, light
  and dark, one per screen size listed in `web/src/lib/splash.ts`, which the root layout links. When Apple ships a
  new screen size, add it there and rerun; a test checks every linked file exists at the right size. Portrait
  only: an iPad opened in landscape still opens on a blank screen.
- `public/offline.html` is self-contained because the service worker serves it with no network.

## Not done yet

- **iPad landscape launch screens.** Only portrait sizes are generated.
- **A screen-reader pass on real devices** (VoiceOver on iPhone, TalkBack on Android) over the inbox, the request
  view, pairing and the setup guide. Only the accessibility tree and axe have been checked so far.
- **Phone cards that move under a tap.** When a new request arrives, the inbox cards can reorder while a thumb is
  on its way to a button. The split view holds a newly shown request's buttons for a moment; the card list does
  not yet.
