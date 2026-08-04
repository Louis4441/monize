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
_headers                       security headers + long cache on /assets/*
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
`TIMELINE`, `FEATURES`, `TOUR`, `REPORTS`, `QA`, `CODE`, `STACK`, `SECURITY`, `FORMATS`, `FAQ`, `GALLERY`, `MARQUEE`, `BUDGET`.
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

## Licence

Same spirit as the app: AGPL-3.0. Screenshots and the Monize name belong to the Monize project.
