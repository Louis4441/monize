# monize-site

The marketing / "what is Monize" site. One page, no framework, no build step, no dependencies.
Three files do the work: `index.html`, `assets/css/styles.css`, `assets/js/app.js`.

* Live app demo: https://demo.monize.net
* Source: https://github.com/kenlasko/monize

## Run it locally

Open `index.html` in a browser, or serve the folder so relative paths and `_headers` behave:

```bash
npx serve .          # or: python -m http.server 8080
```

## Deploy to Cloudflare Pages (free plan)

The site is a Pages project. There is no `wrangler.jsonc` and no Workers build:
a Workers config in this folder makes Cloudflare's Workers Builds pick the site
up and deploy it a second way, alongside Pages. Deploy it through one of the
three options below and leave the folder without one.

### Option A - drag and drop (fastest, ~60 seconds)

1. Cloudflare dashboard -> **Workers & Pages** -> **Create** -> **Pages** -> **Upload assets**.
2. Name the project `monize-site`.
3. Drag this whole folder onto the upload area (not a zip of the folder - the folder itself).
4. **Deploy site**. You get `https://monize-site.pages.dev`.
5. **Custom domains** -> add `monize.net` / `www.monize.net`. If the DNS is already on Cloudflare it wires itself up.

### Option B - Wrangler CLI

```bash
npm i -g wrangler
wrangler login
wrangler pages deploy . --project-name=monize-site
```

### Option C - Git (auto-deploy on push)

Push this folder to a repo, then Pages -> **Connect to Git** -> pick it, and use:

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Build command | *(leave empty)* |
| Build output directory | `/` |

There is nothing to compile, so builds finish instantly and stay inside the free tier.

## Files

```
index.html                     the whole page
404.html                       friendly not-found page
_headers                       security headers + revalidate-always caching
_redirects                     /demo /github /docs /wiki /issues short links
robots.txt, sitemap.xml        change the domain if it is not monize.net
assets/css/styles.css          all styling, light + dark themes
assets/js/app.js               all interactivity and page data
assets/img/monize-logo.svg     favicon + header mark
assets/img/screenshots/        optional local copies of the wiki screenshots
scripts/fetch-screenshots.sh   downloads them (macOS/Linux)
scripts/fetch-screenshots.ps1  downloads them (Windows)
```

## Screenshots

Every screenshot is loaded from `assets/img/screenshots/<name>.png` **first**, and falls back to
`https://raw.githubusercontent.com/wiki/kenlasko/monize/images/<name>.png` if that file is not there.
So the site looks complete out of the box, and gets faster the moment you run the fetch script.

If an image exists in neither place, a tidy "Screenshot pending - <name>.png" placeholder appears
instead of a broken image. Dropping the PNG into `assets/img/screenshots/` fixes it with no code change.

## Editing

All copy and data live in plain arrays near the top of `assets/js/app.js`:
`FEATURES`, `TOUR`, `REPORTS`, `QA`, `CODE`, `STACK`, `SECURITY`, `FORMATS`, `FAQ`, `GALLERY`, `MARQUEE`, `BUDGET`.
Add a feature card or a gallery image by adding one line - no rebuild, just refresh.

The content arrays hold **text, never markup.** Nothing in `app.js` assigns a
string to `innerHTML`: nodes are built with `el(tag, className, ...children)`
and placed with `fill(node, ...)` / `clear(node)`, so no entry in those arrays
can be parsed as HTML. Three conventions follow from that, and each replaced
markup that used to live in the data:

- Emphasis in `QA` answers is written as `*asterisks*`; `rich()` turns those
  runs into `<b>`.
- `CODE` samples are `[className, text]` token pairs (`''` plain, `'c'` comment,
  `'k'` key, `'s'` string) rather than pre-highlighted HTML. Write the text
  literally - `&&` and `<`, not `&amp;&amp;` and `&lt;` - because nothing
  unescapes entities on the way in.
- Randomness uses `rnd()`, which is `crypto.getRandomValues`, not `Math.random`.

**A name that becomes a URL is looked up, never trusted.** A screenshot name
is parked in `data-shot` between a paint and the click that opens the lightbox,
so it arrives back as DOM text -- and five `img.src = BASE + name + '.png'`
lines meant any attribute on the page was a request to a URL the site never
chose (CodeQL: "DOM text reinterpreted as HTML"). Every name now goes through
`shotName()` / `shotUrl()` / `full()`, which resolve it against a vocabulary
built from `TOUR` and `GALLERY` and return the literal from that content model
rather than the string that was read; the logo's `data-fallback` is likewise a
key into `REPO_FILES`, not a path. Anything outside the vocabulary resolves to
`null` and shows the "Screenshot pending" placeholder instead of loading.

So **a new screenshot has to be in `TOUR` or `GALLERY` before an `<img
data-shot>` anywhere can load it** -- including the ones written directly into
`index.html`. Concatenating a name into a `src` is what the resolvers exist to
replace, and `website-dom-safety.test.ts` fails on a `.src` assignment
containing a `+`.

Tag names live in the `TAGS` map, which constructs each one from a literal
`document.createElement('div')`. Adding an element the page has not used before
means adding a line there first - `el()` throws on an unknown tag rather than
quietly producing an `HTMLUnknownElement`. A parameterised
`document.createElement(t)` reads as a dynamic HTML sink to any scanner, which
cannot see that every call site passes a hardcoded tag.

This is enforced, not just documented: `frontend/src/test/website-dom-safety.test.ts`
scans every file in `assets/js/` and fails on an `innerHTML`/`outerHTML`
assignment, `insertAdjacentHTML`, `document.write`, `Math.random`, or a
`document.createElement` whose tag is not a literal. The site
has no build step, no framework escaping and no CSP behind it, so the DOM-builder
shape is the whole defence - and Bearer fails the pipeline on the alternative.

Brand colour is `--brand` in `styles.css` (teal `#4fa091`, taken from the app logo).

## Layout on a phone

A long list does not collapse to one column below the phone breakpoint -- it
becomes a horizontal strip. The features section is twenty-eight cards and the
gallery is forty-two screenshots; stacked, either is a couple of screens of
thumb-scrolling to reach the next section. `.strip` in the `max-width:640px`
block is the shape: `display:grid` (which is also what turns the gallery's
masonry off), cleared `grid-template-columns`, `grid-auto-flow:column` with a
`grid-auto-columns` under 100% so the next item peeks, `overflow-x:auto`, and
`scroll-snap-type:x`.

The rule names its consumers -- `.grid.strip,.gal.strip` -- rather than being a
bare `.strip`, because the collapse rules in the same block set
`grid-template-columns` and `columns` at the same specificity and a single class
would win on source order alone. **Putting a third list in a strip means adding
it to that selector as well as to the markup**; the class on its own is styled by
nothing.

Where the pictures are the content, as in the gallery, give them a width *and* a
height so they crop to a common size. `object-fit` crops the picture to the
element's box, but a height alone leaves the box at whatever the aspect ratio
makes it, so a portrait screenshot sits in a narrow box with the card blank
beside it.

Three rules come with all this, and each is scanned by
`frontend/src/test/website-mobile-layout.test.ts`:

- **Markup, rule and selector have to agree.** The scan fails if a listed strip
  is missing the class, if the rule is missing any of the declarations that make
  it a strip, or if no selector on that rule actually reaches the element.

- **Every sideways scroller sets `overscroll-behavior-x:contain`.** A swipe that
  reaches the end of a strip otherwise chains outward until the browser takes it
  as a back-navigation gesture, off the site.
- **A strip whose contents are replaced rewinds its own `scrollLeft`.** A scroll
  offset survives a repaint, clamped to the new content, so filtering the features
  down to two cards left the strip parked at the end of the two. Move the
  container's own `scrollLeft` -- never `scrollIntoView`, which scrolls every
  scrollable ancestor up to the document.

Both of those live in `asStrip()` / `rewind()` in `app.js`: register the list
once with the name a screen reader should announce, and call `rewind()` at the
end of its paint function. Nothing inside a feature card or a gallery figure is
focusable, so the strip takes a `tabindex` and that name while it can scroll --
asked of the element (`scrollWidth > clientWidth`) rather than by repeating the
breakpoint in JavaScript, so the two files cannot disagree after a breakpoint
moves.

## Licence

Same spirit as the app: AGPL-3.0. Screenshots and the Monize name belong to the Monize project.
