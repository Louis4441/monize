# Frontend: UI conventions

The shared components and helpers that exist exactly once, and the rules for reusing them. Read this before writing a card, a dialog, a list, a picker, a switcher or any other control a user interacts with.

Paths beginning with `src/` or `scripts/`, and layer configuration filenames, are relative to `frontend/`; other source paths (including `test/...`) are relative to `frontend/src/`. Explicit repository prefixes are preserved. `frontend/CLAUDE.md` is the short index; this document is where the reasoning lives.

## Component Patterns

- All interactive components use `'use client'`. Server components are the default for pages/layouts.
- Use dynamic imports for heavy components: `dynamic(() => import('./Chart'), { ssr: false })`.
- `ProtectedRoute` (`components/auth/ProtectedRoute.tsx`) wraps authenticated pages.
- **No `setState` in `useEffect`** — ESLint rule `react-hooks/set-state-in-effect` is enforced. To reset child state when a prop changes, use the "info from previous render" pattern (track the prop in `useState` and update during render).
- **Dialogs use `Modal`** (`components/ui/Modal.tsx`) — handles Escape, focus trap, body scroll lock, focus restore, and stacked-modal popstate. Opt into `pushHistory` so the browser back button also closes. `ConfirmDialog` forwards `pushHistory` for stacked confirm flows.

## Reusing existing UI patterns

Each of these exists once. Use it; do not hand-roll a second one. Every rule here was added after an agent wrote the generic version and a human had to point it out.

## A panel card is `Card` / `CARD_CLASS`, never an inline class trio

`components/ui/Card.tsx` is the one card surface -- background, radius, shadow, and the border that keeps a card legible on themes where the weakest shadow disappears. Use the `Card` component where a plain wrapper works (`padding="md"` matches the widget shell) and `CARD_CLASS` where the element already exists. The old inline `bg-white dark:bg-gray-800 rounded-lg shadow` trio survives in a recorded, shrink-only baseline in `ui-conventions.test.ts`; converting a file means deleting its baseline line. Everything stays on the gray ramp so the colour themes re-skin it -- never add a literal hex or an off-ramp hue to a card.

**Do not drop the border to make surfaces match.** Card-versus-page luminance is ~1.0 in `default` light, `midnight` and `highcontrast` (page and card both pure white there), so the border is the only thing that defines a card at all in those themes -- removing it makes panels disappear, and the change looks safe from every theme except the three it breaks.

## A category's colour and icon are inherited, and drawn by `CategoryGlyph`

Both are resolved server-side in one walk up the ancestry: read `category.effectiveIcon ?? category.icon`, never the raw column (null for most leaves). `components/categories/CategoryGlyph.tsx` draws the result: icon when there is one, colour dot otherwise, dimmed when inherited. Never interpolate `category.icon` into text -- it is a name like `shopping-cart`, so `{category.icon} {name}` renders the icon's *name*. A surface holding a *joined* category row (a transaction, a payee's default category) has no inherited value, so it reads `buildCategoryIconMap` / `buildCategoryColorMap` (`lib/categoryUtils.ts`) built from the full category list, as the register does.

## A brand favicon is `BrandLogo`, addressed by its entity's wrapper

`components/ui/BrandLogo.tsx` renders a cached favicon with the neutral badge fallback, and owns the one rule that matters: the bytes always come from our own backend, never a third party, so drawing a logo cannot leak which institutions or payees a user has. `InstitutionLogo` and `PayeeLogo` are thin wrappers naming the `/:id/logo` route, gated on `hasLogo` so icon-less rows issue no requests. A 404 lands on `onError` and shows the same badge. A third entity gets a wrapper, not a second component.

**Hiding a logo responsively is spelled `max-sm:hidden`, never a bare `hidden`.** Tailwind emits `.hidden` *first* among the display utilities, so on the fallback badge -- whose own classes include `inline-flex` -- a caller's `hidden sm:inline-flex` never hides anything: the letter circles stayed visible on mobile while the favicons vanished. A `max-*` variant sorts after every base utility and wins below its breakpoint. The brand-logo guard in `ui-conventions.test.ts` fails on a bare `hidden` token in any logo call site's `className`.

## A status pill is `Badge`; table chrome is `Table.tsx`

`components/ui/Badge.tsx` is the small status pill (previously hand-rolled ~50 times). Pass `variant` and `size`; pass `as="button"` where the pill is also a control, rather than nesting a button in a span. It deliberately does not absorb pills whose colour *means* something -- `CategoryPill`, `AccountTypePill` and `SCHEDULED_KIND_CHIP_CLASSES` are each already one source of truth, exempted by name.

`components/ui/Table.tsx` is constants (`TABLE_CLASS`, `TH_CLASS`, `TD_CLASS`) plus thin `Th`/`Td` cells, not a `<Table>` wrapper -- these tables are hand-laid with colspans and sticky cells. `SortableHeader` deliberately stays off `TH_CLASS` (about twenty-five report tables draw a lighter header, and folding it in would restyle every report).

## The card shadow is `--shadow-card`; the bare `shadow` reads no token

Tailwind v4 trap: the bare `shadow` utility is a legacy alias with the stock value compiled in, so redefining `--shadow-sm` in `@theme` touches `shadow-sm` (worn by form fields) and leaves cards flat. `ui-conventions.test.ts` fails on a `--shadow-sm` redefinition. Card elevation goes through `--shadow-card`, worn by `CARD_CLASS`.

## A focus ring is `focus-visible:`, and a hover animates

`focus:ring-*` paints on a mouse click as well as a Tab; use `focus-visible:` on anything clickable. Text inputs are the one exception (`inputBaseClasses` and the element selectors in `globals.css`). Row hover comes from `HOVER_ROW_ON_CARD` / `HOVER_ROW_ON_PAGE` in `Card.tsx`, not a hand-picked grey, and includes the transition (a hover that snaps reads as a redraw). Pair any new transition with `motion-reduce:transition-none`. Both rules carry shrink-only baselines in `ui-conventions.test.ts`.

## A dialog is titled through `Modal`, never by a hand-rolled heading

`Modal` takes `title` (and optional `description`, `footer`, `padding`), draws the standard header and wires `aria-labelledby` -- before it, none of the 74 hand-rolled headings reached the dialog, so every dialog announced itself as an unnamed region. `padding` defaults to `none` and leaves children unwrapped, because several call sites make the panel their own scroll or flex parent. A genuinely bespoke header (ConfirmDialog's icon) stays on the baseline deliberately.

## An empty list renders `EmptyState`

`components/ui/EmptyState.tsx` (glyph, title, optional description and action). `ui-conventions.test.ts` bans the `text-center py-12` container fingerprint outside the component, with no grandfathered baseline.

## An auth screen renders inside `AuthShell`

`components/auth/AuthShell.tsx` is the single shell for login, register, forgot/reset/change-password, verify-email and setup-2fa: transparent brand mark, title/subtitle, notices slot, shared `Card` around the body (`plain` for a bare status line). Language picker and version line are opt-in props. Use `/icons/monize-logo-transparent.svg` everywhere in the UI -- the boxed `monize-logo.svg` bakes in a white background and renders as a white square in dark mode. Guarded in `ui-conventions.test.ts`.

## Navigation links and their icons live in `lib/nav-links.ts`

The header's link arrays and the per-route Heroicon map are declared side by side so `nav-links.test.ts` can hold "every nav route has an icon". The mobile drawer and header dropdowns render `NAV_ICONS[href]`; the desktop top-bar pills stay text-only on purpose (six leading icons overflow 1280-1440px laptops). A new route means one entry in the array and one in the map, in the same file.

## Account-type colour and icon come from `lib/account-type-meta.tsx`

`ACCOUNT_TYPE_META` maps each account type to its pill classes and Heroicon; render `AccountTypePill` / `AccountTypeIcon` rather than re-deriving either. `ui-conventions.test.ts` fails on a second type-to-pill-class mapping. An account with no institution shows its type icon in the brand-badge slot (`InstitutionLogo`'s `fallbackIcon`), not a generic glyph.

## Which account types have a detail page is `lib/account-detail-views.ts`

`ACCOUNT_DETAIL_VIEWS` maps an account type to the view `/accounts/<id>` renders for it, and everything else about "does this account have a Details page" derives from that one registry: `resolveAccountDetailView` (the route), `hasAccountDetailView` (the row action, the tour requirement), `DETAIL_ACCOUNT_TYPES` (the key set). Three surfaces ask the question, so three copies of the list is how they come to disagree -- the account row and the route registry already held one each. `loan-rate-changes.contract.test.ts` checks the `loan` arm against `RATE_CHANGE_ACCOUNT_TYPES` and against the branch the account page actually fetches rate history in.

## A tour step pinned to a dynamic route is reachable only by the user

`routeMatch: '/accounts/'` names an id the tour never knew, so the engine cannot navigate there: pushing the step's `route` can never satisfy the prefix, and the step sits in its `navigating` phase behind an overlay that renders nothing -- the tour disappearing mid-run. `isStepReachable` (`lib/tours/navigation.ts`) is the one test, and both doors use it: Back walks past such a step once the user has left that route, and `TourHost` skips it rather than hanging when the user arrives any other way (they skipped the step that asks them to open the page). The step's own `route` satisfying the prefix is the ordinary case and stays navigable ('/reports?category=insights' for '/reports').

A step gated by `requires` is the omit effect's to remove: the engine neither navigates to it nor skips it as unreachable while its requirement is unmet or still resolving, or the two race and a deliberate omission is reported as a degraded tour.

## A step inside a dropdown asks the engine to hold it open

A menu or panel in the header closes on a click outside itself, and the tour card is outside it -- so a `click` advance on the trigger opens the dropdown and the reader's very next press closes it under the step describing its contents. The step declares the intent instead (`openToolsMenu` for the header's Tools menu, `openNotificationBell` for the notification panel) and the component ORs that flag over its own state, so the flag also wins over the click-outside close. Two consequences: the step pointing at the closed trigger must NOT carry the flag (the open panel covers the button it names), and every step anchored inside the panel must, or the panel vanishes mid-tour. `NotificationBell.test.tsx` holds all three cases -- opens without a click, survives a click on `document.body`, closes again once the tour steps past.

## A coach mark parks in the corner the step is not about

An `unobtrusive` anchorless step parks its card in the bottom-**right** corner, which is exactly where every list puts its row actions (`RowActions` is `justify-end`, in a sticky-right cell). A step that asks the user to click one therefore had its own card intercepting that click -- CI caught the account-detail step's card over the **Details** button at a 720px-tall viewport, and the shipped 1.13 foreign-currency tour had the same collision. Such a step sets `placement: 'left'` (the only meaning `placement` has for a corner-parked card). The card is also draggable, but a tour whose first move is "get my card out of the way" is not one to ship: park it clear. `tours.spec.ts` clicks the real row action, so the collision fails the E2E rather than the user.

## A register's category chip is `CategoryPill`

`components/transactions/CategoryPill.tsx` owns the colour-mix pill and the category's optional icon (via `getIconComponent`, as tag chips do). Categories carry `icon` end-to-end -- `CategoryForm` collects it through the shared `IconPicker` (whose `onClear`/`clearLabel` props make "no icon" a real state) -- so a surface showing a category name with its colour shows its icon too, and an unset icon renders nothing, never a default glyph.

## A dashboard widget header carries its icon from `widget-meta.tsx`

`WIDGET_ICONS` gives every registered widget a distinct Heroicon (`widget-meta.test.tsx` enforces coverage), rendered as the tinted `WidgetIconPuck` -- blue ramp only, so themes re-tint it. Widgets on `WidgetCard` get it from their `widgetId`; a widget drawing its own header uses `WidgetHeading`, which also owns the title-button markup.

## The device can override a stored preference, and the predicate is never the viewport

Two settings mean "unless this device knows better". `DateInput` is a text box on
desktop *regardless of the format preference*, because the pointer decides the
mode (touch keeps the native picker). `mapsUrl` (`lib/contact-links.ts`) ignores
the stored `defaultMapProvider` on iOS and Android, because a device with its own
map app should open it -- the preference describes what a desktop browser does.

Both checks live in the one function that produces the result, never at a call
site: a second caller that skipped it would be a rule nobody enforces. And both
ask about the *platform* (`detectMapPlatform`, `pointer: coarse`), never
`useIsMobile` -- that is a 639px viewport query, so a narrow desktop window would
flip the behaviour mid-session.

## A gate belongs to the thing it admits, not to the thing that produced it

The scan control checked the picked photo against `MAX_ATTACHMENT_BYTES` before
opening the scanner, copied from the plain upload where it is right -- there the
file *is* the attachment. Here it is the scanner's INPUT: what gets attached is
a JPEG capped at `OUTPUT_MAX_EDGE`, so the check refused exactly the captures
the feature exists for (a 12MP phone photo is routinely over 10 MB and scans to
well under it), and it made the dialog's own "the original is too large to keep"
path unreachable outside its unit test -- two suites asserting opposite
behaviours, both green. Before copying an admission check, ask which artefact
the limit describes.

The other half of that fix is the same rule pointing the other way: once such a
photo can reach the dialog, "Keep original only" would upload a file the server
answers **413** to, so it is disabled there. A control offering an action the
server will refuse is worse than an absent one.

## An attachment is opened in `AttachmentPreviewDialog`, never downloaded from a row

Clicking an attachment previews it; Download is a footer action of the preview.
Four rules the viewer holds, each with a test:

- **Bytes come through `attachmentsApi.fetchBytes`**, never a bare `<img src>`
  or `fetch`: the axios client's 401-refresh interceptor is the only thing that
  can renew an expired token, and an `<img>` whose request 401s simply fails to
  load. The row's thumbnail still uses `attachmentDownloadUrl` directly, and
  that is why the preview's request is answered from the HTTP cache it primed.
  `useAttachmentBytes` keys the payload to its source, so switching Enhanced to
  Original and back cannot paint the slower answer over the newer one, and a
  failed read is `error`, never an empty result.
- **pdf.js is reached from one module behind a dynamic import.**
  `lib/attachment-preview/pdf-engine.ts` is the only file naming `pdfjs-dist`
  or `/vendor/pdfjs/`, and `PdfPages` is the only place it is `import()`ed, so
  no page pays for a PDF renderer until somebody previews a PDF (the module
  also touches `DOMMatrix` at load, which a server render must never reach).
  `lib/attachment-preview/attachment-preview.guard.test.ts` scans for both.
- **The worker is vendored and version-pinned.** pdf.js constructs its own
  Web Worker from `GlobalWorkerOptions.workerSrc`; the script must match the
  bundled API exactly, so `frontend/scripts/copy-vendor.mjs` copies it out of the
  installed package on `predev`/`prebuild`/`pretest` (beside the OpenCV build,
  same script) and the engine appends `?v=<pdfjs.version>` so a stale copy in
  the HTTP cache cannot answer for a newer API. `public/sw.js` deliberately
  does not cache `.mjs`.
- **A PDF page is drawn when the reader can see it.** A canvas costs its
  pixels whether or not anyone is looking, and at the dialog's width a full
  page clamps to `MAX_PAGE_PIXELS`, which is 16 MB: drawing all of a 20-page
  statement up front asks for hundreds of megabytes and loses the tab on a
  phone. `PdfPages` observes each page and releases the backing store of one
  scrolled away, keeping the box it measured so nothing jumps. What bounds the
  cost is what is on screen, never the length of the document.
- **What the reader chose belongs to the attachment, not to the prop object.**
  The dialog keys its Enhanced/Original and Fit/Actual state on the subject
  being previewed (`previewSourceKey`), because a caller that composes `target`
  in its JSX rebuilds it on every one of its own renders -- and keyed on
  identity that threw the reader back to the enhanced image mid-read, and
  re-fetched it. The saved list also holds the whole target in state, as the
  staged list already did. Which controls the toolbar offers likewise comes
  from the metadata, not from the bytes in flight, or they appear late and
  shift the picture underneath.
- **A phone gets the whole viewport through `Modal`'s `fullScreenOnPhone`**,
  spelled with `max-sm:` variants so the base classes every other dialog
  relies on are untouched. The layout is a CSS question, so it is not
  `useIsMobile` (see the next section). A scan pair's Enhanced / Original
  switch is the same two-button pattern `DocumentScanDialog` draws, and the
  original's Download carries no filename because the list does not know it --
  the server names it through Content-Disposition.

## A platform capability is not decided by the window's width -- `isTouchDevice`

`useIsMobile` is a 639px media query; `isTouchDevice` (`lib/touch-device.ts`) is
`(pointer: coarse)`, and they answer different questions. The viewport hook is
right for choosing a *layout* (the register's card rows show the same figures
either way) and wrong for anything that changes what a control can do:
`capture="environment"` on the scan input replaces the OS file picker with the
camera on a browser that honours it, so keyed off the width it took "choose an
existing photo" away from anyone with a narrow desktop window and handed it back
when they widened it. The media query lives in that one helper -- `DateInput`
held the only other copy -- and `ui-conventions.test.ts` fails a `capture` in a
file that imports `useIsMobile`, and a second hand-rolled `pointer: coarse`.

## A random value is `crypto.randomUUID()`, never `Math.random()`

Every client-side use so far has been an id -- a list key, a removal handle, a temporary split row -- and those want uniqueness, which `crypto.randomUUID()` gives (`lib/ai-attachments.ts` is the pattern). `Math.random()` is not a security primitive, and Bearer flags it as CWE-330; `SplitEditor` carried that as a dated exception rather than a fix until issue #1323. `ui-conventions.test.ts` fails on `Math.random` in any production source.

## The demo login is `lib/demo-credentials.ts`, and it matches the server's

The login page pre-fills `DEMO_USER_EMAIL` / `DEMO_USER_PASSWORD` from that module; the seed that creates the account reads its own copy in `backend/src/database/demo-credentials.ts`, and `demo-credentials.contract.test.ts` fails when the two drift or a second spelling appears under `src/`. Public by design, so not a secret -- but a form that pre-fills a password the seed no longer sets is a demo nobody can enter.

## A clickable table row -- `useLongPress({ onClick })`

`useLongPress` takes `onClick` alongside `onLongPress`: a plain click runs the row's primary action, a 750ms press (or right-click) opens the mobile action sheet, and a click following a long-press is suppressed. Spread `getRowHandlers(item)` on the `<tr>` and add `cursor-pointer` (accounts, payees, tags, categories, securities lists all do). Do not put the click on a button around the name instead -- the rest of the row becomes dead area. Controls *inside* the row (a favourite star, `RowActions`) must `stopPropagation`.

## A detail page returns to its list above the title, and switches with the caret beside it

Every detail page carries the same two controls: a chevron and "Back to <List>" on the line *above* the title, and `EntitySwitcher`'s caret immediately after the title. The way back is not an action on the thing being viewed, so it does not belong among the buttons on the right. For reports the pair is `BackToReportsLink` and `ReportDetailHeader` (`components/reports/`); `ReportSwitcher` builds the route itself so no call site spells it out. `ui-conventions.test.ts` scans for a hand-rolled back-chevron-to-`/reports`.

**Two switchers on one line means at least one says its name.** `EntitySwitcher` takes `triggerText` (the GEM report's scenario picker reads "Scenario ⌄"); the bare caret stays the default when it is the only one.

**A detail page's actions sit on the title row, not in a row above the body.** `AccountDetailShell` takes `headerActions` for type-specific actions beside the standard set; a signal they need to send the body travels down as a prop (`refreshKey`) rather than keeping the button in the body. A `size="sm"` button in a report toolbar takes `size="md"` in that header.

A switcher list too long to scan takes `group` on its items (`ReportSwitcher` groups in `REPORT_CATEGORIES` order); sections follow the order their first item appears in, so ordering happens in the caller. An item with no `group` renders ungrouped, so a menu whose sections would be a lone heading over everything is better emitted with none at all -- and whether that heading has anything under it is decided by the items the switcher will actually OFFER, since it drops the entity already on screen (the Transactions account widget sections only when a starred account other than the current one exists).

**Which accounts a picker offers, and in what order, is `orderAccountsForPicker`** (`lib/account-utils.ts`): the starred accounts by `favouriteSortOrder` -- the order the user dragged them into -- then everything else by name. It hands back the two halves rather than one list, because each caller needs the boundary as well as the order (`buildAccountDropdownOptions` rules a separator across it; the two account switchers put a section heading above each side), and a flat list would have each of them re-deriving where favourites stop.

Two details it decides so no caller has to. **The favourites are alphabetical within the arrangement**, because `favourite_sort_order` defaults to 0 -- a user who has starred three accounts and never dragged them has three ties, and a stable sort leaves those in whatever order the API answered in, so the same accounts read differently on two screens. And **the name it sorts on is the one the picker DISPLAYS**, which is why `orderForPicker` takes a reader rather than only accepting `Account`: the detail page's switcher shows a linked brokerage/cash pair under one stripped `displayName`, and ordering that list on the stored name reads as unsorted. A pair's star is the *primary's*, because that is the row the accounts list draws and stars.

Four surfaces order account favourites, and they all go through this: both switchers, `buildAccountDropdownOptions`, the Transactions filter's favourite chips (which sit on the same page as one of the switchers, so a second arrangement there is visible drift) and the CSV transfer-rule picker, which held a hand-copied version of the whole rule. The dashboard's `FavouriteAccounts` deliberately does not -- it is the drag-to-arrange surface itself, and its order is the thing being edited.

## A category picker lists every category in tree order as "Parent: Child"

However a surface selects a category, the option list is one shape: built from `buildCategoryTree` (each parent followed by its children), a child labelled `Parent: Child`, a top-level category by its bare name, and **every row selectable, parents included**. `CategorySwitcher` carries the regression tests.

**A picker the user types into creates through `createCategoryFromInput` (`lib/category-create.ts`), never inline.** It owns title casing and the `Parent: Child` shorthand (create or reuse the parent, then the child), and returns every row it created so the caller can append all of them. The guard in `src/test/ui-conventions.test.ts` fails on a second `categoriesApi.create` call site outside the helper and the Categories page's own full create form.

Whether a picker *offers* to create is a property of the surface, not the field: a form that can create passes the creator to **every** category picker it renders, split lines included (`SplitEditor`'s lines silently discarded unmatched text while the Category field offered "+ Create" -- issue #1187). An asynchronous create addresses the row it came from **by id** (rows can move while the request is in flight), and the new category's `isIncome` comes from what the creator returned.

## An account balance is coloured by its sign -- `balanceColor`, never by account type

`balanceColor` (`lib/format.ts`) is the one rule: negative is red, everything else neutral. Do not add `|| isLiability` (or any `accountType` test) -- a credit card at a credit balance is not in the red, and the sign already carries the meaning. `gainLossColor` is the sibling for a *change* in value (green when up), not for a balance.

## A header panel is `fixed` inside a transformed ancestor -- give it a height, never a bottom anchor

The sliding `AppHeader` always carries a `transform` (`useHideOnScroll`), which makes the header -- not the viewport -- the containing block for every `position: fixed` descendant. A panel mounted in the header (the notifications dropdown, `ActionHistoryPanel`) that anchors with `bottom-0`/`inset-0` is therefore capped at the header's own ~56px box: the full-screen notifications panel only *looked* full while rows overflowed it, and collapsed when empty. Size such a panel with an explicit height (`h-dvh` for the mobile full-screen treatment) and edge offsets that grow past the containing block; `NotificationList.test.tsx` pins the class shape.

## A menu anchored to a caret is portalled and clamped, never an `absolute` box

`EntitySwitcher` renders its menu through `createPortal` at a fixed position measured from the caret and clamped to the viewport (`placeMenu`, tested pure), the way `MultiSelect`, `CalendarPopover` and the portal `InfoTooltip` place theirs. The `absolute left-0 w-72` box it replaced was fine beside a page title at the left edge and wrong the first time the caret sat anywhere else: in the Transactions page's Account Info widget it followed a long account name off the right of a phone, and on a desktop the widget column is `overflow-hidden` and translated -- which clips an absolute child *and* makes the column the containing block of a fixed one (the header rule above, again). A popover that can be opened from inside a card, a column or a table cell goes through a portal with a viewport clamp, and on scroll and resize it **re-measures the anchor, never closes**: opening is itself a scroll and a resize (focusing the filter scrolls its container into view; a phone's keyboard shrinks the viewport), so the first cut, which closed on both like `MultiSelect`, flashed open and shut. Focus the filter with `preventScroll`, not `autoFocus`, and only for a mouse: on a touch device focus raises the keyboard over the list the reader opened the menu to see, so the filter waits to be tapped -- decided by `isTouchDevice`, never the viewport, per the rule above. `EntitySwitcher.test.tsx` holds the clamp, the portal, the flip, the menu surviving its own opening, and the keyboard staying down.

## A control is not offered when nothing can answer it -- and which question to ask depends on the control

Two hooks, because two different prerequisites. A control whose one possible outcome is "configure something first" is worse than an absent one: it costs a click to learn nothing.

- **A payee contact lookup asks `hooks/useContactLookupAvailable.ts`.** Google Places can answer that lookup as well as an AI provider, so the question is "can a lookup run", never "is there a model". Gated on the AI hook instead, the button disappears for a user who configured Places and no AI -- exactly the configuration the feature exists for. The surfaces are the payee form's and detail card's lookup buttons, the transaction page's quick-create confirmation, and the automatic-lookup toggle in Settings. The guard in `src/test/ui-conventions.test.ts` fails any file that reaches a lookup API and imports `useAiConfigured`.

  **A control the user is looking AT is disabled, not hidden.** The buttons on the payee form and detail card are withheld when nothing can answer, because their surface says nothing about why. The automatic-lookup toggle sits directly under the two source rows that cause the state, so switching the last source off makes it read off and disabled (with copy naming the repair) rather than vanish -- a control that disappears under the change you just made reads as a bug. It shows off without WRITING false: switching a source back on restores the setting the user chose.

  **The hook is read once on mount, so the one surface that changes the answer re-reads it.** `refresh()` exists for `PayeeLookupSection` alone: it writes the switches that decide `available`, and `payeeLookupApi.updateSettings` dropping the cache does nothing for a hook already holding its value. It is awaited inside the save, while the card is still in its saving state, so the toggle never renders live against a source that was just switched off. Re-deriving availability from the settings row on the client instead is the thing not to do -- the server's answer already folds in the spent cap and a key it cannot decrypt.
- **The assistant asks `hooks/useAiConfigured.ts`**, because a chat genuinely needs a model: the floating bubble and its own settings toggle.

**A preference outlives the provider that justified it.** `aiBubbleEnabled` stays true after the last provider is deleted, so the floating chat bubble gates on the provider as well as on the opt-in; without that it sits on every page and opens a chat that can only fail. Any future preference guarding provider-backed work inherits the same pair.

The hook answers `configured: false` until the status settles **and** for a status read that failed -- deliberately, because "we could not ask" is not "there is a provider", and it is also what keeps a control from flashing in and vanishing. Read the cached `aiApi.getStatus` through the hook rather than fetching status again: one request serves every mounted surface, and a provider added or removed in Settings drops that cache.

## A `<details>` disclosure is controlled, because jsdom half-implements it

`<details>`/`<summary>` is the disclosure this codebase uses (`PushDiagnostics`, and the foldable Browser push block beside it): native keyboard operation, and the expanded state announced without an `aria-expanded` of our own. But React does not manage `open` the way it manages an input's `value` -- it writes the attribute and stops -- so a component that renders anything off "is this open" must hold that in state, pass `open={state}`, and move it itself. **`onToggle` cannot be the only mover**: jsdom flips `open` on a summary click and fires no `toggle` event at all, so the behaviour is untestable through it and a browser that misses the event leaves the summary describing the wrong state. Handle the summary's `onClick`, `preventDefault()` to cancel the element's own activation behaviour, and toggle state there (Enter and Space on a focused summary dispatch a click, so the keyboard comes with it); keep `onToggle` wired for the toggles no click produces, such as Chrome expanding a `<details>` to reveal a find-in-page match.

**What a collapsed summary stands in for is not the same text the open block shows.** It replaces the block, so it answers the question the block would have -- Browser push collapses to how many devices can be *delivered to*, retired rows named separately rather than summed in, and "Device list unavailable" where the read failed, never the `0` an empty `devices` array would give (the failed-lookup rule, one more time). And a block whose whole content is one sentence explaining why a feature is unavailable does not get a disclosure: hiding the reason behind a click is worse than not folding.

**Which Settings sections are folded is remembered by one store, `settingsSectionStore`** (`monize-settings-sections`), read through `useSettingsSectionCollapsed(section)`. Browser-local for the reason row density is: whether a panel is worth its height is a fact about the screen in front of the reader, not about the account. The store is the density store's lesson applied before it can be relearned -- a second foldable section adds a member to `SettingsSectionId` and a default to `SETTINGS_SECTION_DEFAULT_COLLAPSED` (a `Record` over the union, so the compiler asks for that default), never a second store and never a second line in `persisted-storage.guard.test.ts`. Every default is `false` and that is the rule, not today's coincidence: a section that folds itself before the reader asked has to be found before it can be read. A stored value that is not a boolean, and a key naming a section that no longer exists, both fall back to the default rather than hiding a panel behind a corrupted entry.

**A persisted fold outlives a test, so a suite that drives one resets the store.** `setup.ts` clears `localStorage` between tests and cannot reach a store that has already read it, so the first test to collapse a section leaves it collapsed for the rest of the file -- reset it in `beforeEach`, where nothing is mounted and the write needs no `act()`. And assert the fold on `details.open`, not on the content having gone: jsdom applies no user-agent stylesheet, so the children stay in the document whatever `open` says, and "the button is not there" would pass in a browser and fail here for a reason that is nothing to do with the component.

## A settings screen has one save contract, and it is save-on-change

`PreferencesSection` had two: language, theme and colour theme persisted the
moment they changed (each selector owns its own write, because each has work to
do beyond it), and the other thirteen controls waited for a "Save Preferences"
button -- with nothing on screen saying which a given control followed, so a
change made and navigated away from was silently lost. Every field now writes as
it changes, through `useSavedPreference` (`hooks/useSavedPreference.ts`) and the
one `commitPreference` the section owns: optimistic local state, the PATCH, and
on failure a revert to the value THAT change replaced plus an error toast --
the same shape the notification toggles already used.

Three properties the hook carries, each with a test:

- **The patch is the one field that changed**, never a resend of everything the
  screen holds. The bulk payload had the opposite failure mode: a field left out
  of it was reset the next time anything else was saved.
- **A control re-emitting the value it already holds writes nothing.** A request
  per non-edit is a toast per non-edit.
- **The revert closes over the value of its own change**, so two changes in
  flight cannot restore each other's.

Do not reintroduce a Save button beside auto-saving controls. Where a field
genuinely needs one -- a multi-part form that is invalid mid-edit -- the whole
screen takes that contract, not one control on it.

## A password field declares what may be autofilled into it

Every `<Input type="password">` carries an `autoComplete`: `current-password` when it really is this account's password, `new-password` when one is being set here, `off` when it is not a credential of this site at all. Omitting it is not neutral -- a password manager fills a bare box with the saved credential, and the form submits it as typed: the AI provider's API key field silently replaced the stored key ("Saved" on screen, provider dead, row shows `****` either way), and the backup export password is the same shape and worse. `ui-conventions.test.ts` fails on a password input with no `autoComplete`, and on a value outside those three.

## A view that graduates to its own page -- delete the modal, do not flag it

Remove the modal mode instead of keeping it behind a prop: an `onClose?` nobody passes and an `embedded` flag whose only caller always sets it leave every `!embedded` branch compiling, tested and unreachable, still fetching data they no longer show. Delete the props, those branches, the orphaned catalog strings in every locale, and whatever in a shared component only that modal used.

## Copy -- `--` is comment style, never UI text

The repo writes `--` in code comments, and the habit leaks into catalog strings, where it renders literally. In copy use an em dash, or recast the sentence. `messages.punctuation.test.ts` fails the build on a new one (shrink-only baseline for existing). The same applies to anything else that is punctuation rather than words: compose it in the catalog, not in JSX -- `"{units} ({share})"` is one string a translator can reorder; `{value}{' ('}{share}{')'}` is three fragments they cannot reach.

## A transfer's direction comes from the row's own amount -- `transferDirection`

Money leaving an account went **to** the counterpart; money arriving came **from** it. The two legs of one transfer are labelled differently and both are right, and a split line pointing at another account is asked with *its* own amount, not the parent's. `transferDirection` (`lib/transfer-label.ts`) is the only place that decision is made; `transferCsvLabel` is the export's rendering, and the register renders the same decision as its arrow chip. A `ui-conventions.test.ts` guard fails on a new `? 'to' : 'from'` outside the helper.

Coerce before comparing: `'-67.9900' < 0` is false, and a decimal string is what the API sends.

## A transaction's payee display is `usePayeeDisplay`, never a bare `payeeName` read

A transfer created with a blank payee is PERSISTED blank (issue #1214); migration 161 blanked the legacy-stamped rows. The label is resolved at render time: `usePayeeDisplay()` (`hooks/usePayeeDisplay.ts`) returns the stored payee when there is one, otherwise for a transfer leg the localized `common.transferPayee` string built from `linkedTransaction.account.name` -- the counterpart's CURRENT name, so renames and language switches reach every historical row. A surface reading `tx.payeeName || tx.payee?.name` directly shows those transfers as unnamed. English CSV exports use `transferPayeeCsvLabel` (`lib/transfer-label.ts`), byte-identical twin of the backend's `transferPayeeLabel`.

## A description is plain text that RENDERS as a link -- `LinkifiedText`

A transaction's description is where a ticket, receipt or order page ends up, so
the address in it is clickable. What makes that safe is that nothing about the
storage changed: the field is still plain text, `@SanitizeHtml()` still strips
`<` and `>` on write, and `dangerouslySetInnerHTML` still appears **nowhere** in
this tree. `linkifySegments` (`lib/linkify.ts`) splits the stored string into
prose and addresses, and `LinkifiedText` (`components/ui/LinkifiedText.tsx`)
draws the anchors -- around text it hands back verbatim. An `href` is only ever
built through `toSafeExternalUrl`, and only from an explicit `http`/`https`
scheme -- a bare `www.example.com` stays text, because a guessed host is a link
to somewhere the writer did not name.

**A label has to be honest to a reader, not only to `===`.** Three properties
carry that, and each is a test rather than prose: the segments concatenate back
to the input exactly; the label and the `href` are one string, because
`NoteLink` takes no children and so has no second value to disagree; and that
string contains no character that changes how it renders. The third is the one
that was missing. `https://evil.test/<U+202E>moc.knab//:sptth` READS as
`https://evil.test/https://bank.com` and navigates to `evil.test` -- label and
`href` equal as strings, different on screen -- and `@SanitizeHtml()` strips
none of it, since its job is `<` and `>`. So an address ENDS at the first bidi
control, zero-width or C0/C1 character (`INVISIBLE_CHARS` in `lib/linkify.ts`;
none is legitimate in an RFC 3986 address, and the remainder stays in the prose
where it can mislead nobody about where a click goes), and the anchor carries
`dir="ltr"` with `unicode-bidi: isolate` so an override elsewhere in the note --
or an RTL locale around it -- cannot reorder the label either. A homograph host
(Cyrillic `a` in `bank.com`) is deliberately NOT claimed: that is the browser's
punycode job, and asserting it here would be a worse promise than the one this
replaced.

This matters more than it looks: a description is visible to joint owners and
delegates, so the field is a cross-tenant surface. Storing markup there and
rendering it would be stored XSS with an audience.

**An anchor in the register is a control inside a clickable row**, so it stops
the event the way the favourite star and `RowActions` do -- `click`, `mousedown`,
`touchstart` and `contextmenu`, or a tap opens the ticket page *and* the edit
modal behind it. Stopping no more than that keeps the rest of the cell opening
the transaction, which is the dead-area mistake the row-click rule warns about.

**A note being EDITED gets the same affordance a different way.** A `<textarea>`
renders no elements, so the address in a draft cannot be anchored in place --
before this, reaching a link meant saving, finding the row in the register and
clicking it there. `NoteLinks` (same file) lists the addresses beneath the field
instead, live as the text is typed, and renders nothing when there are none.
It shares `LinkifiedText`'s single `NoteLink` anchor, so `target`, `rel` and the
event-stopping cannot drift between reading a note and writing one; the guard
fails a second `<a>` in that file. Its label is the address for the same reason
as everywhere else -- there is no `children` to pass.

**Which surfaces linkify is a decision recorded in both directions.**
`src/test/linkified-description.guard.test.ts` names the four that draw links in
place (the register row and the three report tables) and every other place a
`.description` or `.memo` reaches the screen as text, each with the reason it
stays inert -- a different entity's field, a row not saved yet, or text inside a
`<button>`. It does the same for the note editors: the two that make up the
New/Edit Transaction modal offer `NoteLinks` (both, because the modal swaps the
plain description for `SplitTransactionFields` in split mode, and covering one
leaves the link unreachable for half the transactions a user creates), and the
other six say why they do not. The two lists must between them account for every
form the length guard names, so a new note field cannot ship with no way to
reach the address in it.

## Nothing interactive goes inside a `<button>` or an `<a>`

The parser closes the outer element at the inner tag, so the click target ends where the nested control begins and the server's HTML stops matching React's -- a hydration mismatch. Fix it at the call site by making the two **siblings**: a wrapper carrying the border and hover, with the navigation button and the nested control side by side. Do not demote the inner control to a focusable `<span>` -- its implicit role is generic, screen readers drop its `aria-label`, and the result is a tab stop announcing nothing. `ui-conventions.test.ts` scans for this; changing a shared component's trigger element is a change to every call site, and the guard tells you which.
