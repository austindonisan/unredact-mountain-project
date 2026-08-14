# Unredact Mountain Project

Mountain Project withholds certain route and area names, replacing them with a
placeholder built from the parent crag name and the last four digits of the
object's ID:

| Displayed | Actual object | Original name |
|---|---|---|
| `4X4 \| 6303` | route `108006303` | Carbondale Short Bus |
| `Quail Springs Area \| 9303` | area `105789303` | Negropolis Hillside |

The original is not hidden — it is published on the object's own *Name History*
page, linked from the tooltip beside the placeholder. This extension reads that
page once, remembers the answer, and substitutes the name wherever the
placeholder appears.

## Install

The same unpacked directory loads in both browsers.

**Chrome / Edge** — `chrome://extensions` → enable *Developer mode* → *Load
unpacked* → select this folder.

**Firefox** — `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on*
→ select `manifest.json`. For a permanent install the folder must be zipped and
signed through addons.mozilla.org.

> On Firefox, MV3 host permissions are opt-in. This extension does not depend on
> them: lookups are issued from the content script, where a request to
> `/updates/…` is same-origin and always permitted.

### The background-key warnings are expected

Chrome says:

```
'background.scripts' requires manifest version of 2 or lower.
```

and `web-ext lint` says the reverse, that Firefox ignores
`background.service_worker`. Both are correct, both are harmless, and neither can
be silenced from a single manifest — the two browsers support mutually exclusive
keys for the same job:

| | Chrome MV3 | Firefox MV3 |
|---|---|---|
| `background.service_worker` | required | [not implemented](https://bugzil.la/1573659) |
| `background.scripts` | MV2 only | required |

Declaring both is [Mozilla's own cross-browser recommendation](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background):
each browser uses the key it understands and warns about the other. `background.js`
is written as a classic script so the same file serves as a Chrome service worker
and a Firefox event page. The end-to-end tests load the extension in Chrome for
real and confirm the service worker starts and IndexedDB persists.

Emitting a separate build per browser would remove both warnings, if that ever
becomes worth the extra packaging step.

## How it works

### Recognising a placeholder

Every substitution is gated on one rule, taken from Mountain Project's own
wording on the Name History page: *"This placeholder uses the crag name and the
last four digits of the unique area or route ID number."*

A string is only treated as a placeholder when it matches `<name> | NNNN` **and**
`NNNN` equals the last four digits of an ID established independently — from the
`href` of the link containing the text, or from the page URL. A route genuinely
named `Some Crag | 4242` living at ID `105718387` is left alone.

Placeholders are discovered from three sources:

1. **Link text** — any text inside an `<a>` pointing at `/route/<id>` or
   `/area/<id>`. Covers area sidebars, both responsive variants of the classics
   list, search results and breadcrumbs. Matching is anchored to the start of the
   text node rather than requiring the whole node to match, because breadcrumbs
   render the name and the following `(` inside a single text node.
2. **The page's `<h1>`** — only its own direct text nodes, never the nested
   tooltip and "suggest change" links. The ID comes from the URL.
3. **A classics page `<h1>`** — `Classic Climbs for <placeholder>`, where the
   known prefix is stripped explicitly rather than guessed, since there is no
   link on that page to anchor the area's identity.

### Resolving a name

Resolution order is local database → network, never the reverse:

1. The content script asks the background worker for every discovered ID.
2. Anything already stored comes back immediately. **A page whose names are all
   cached issues zero requests.**
3. Genuine misses are claimed (so two tabs cannot fetch the same ID at once) and
   fetched from `/updates/<Model>/<id>/x`, at most two at a time. The URL slug is
   ignored by the server, so the ID alone is sufficient.
4. The original name is read from the `<em>` inside the paragraph containing
   *"chosen not to display the original name"*, parsed via `DOMParser` — which
   builds an inert document, executing no scripts and loading no subresources.
5. The result is written to the database and applied.

Over a browsing session this costs **one request per redacted object, ever** —
not one per page view.

### Applying it

Only text nodes are rewritten, never `innerHTML`, so the tooltip link, the
"suggest change" icon and the sidebar's sort attributes all survive. Each
substitution is wrapped in:

```html
<span class="umpx-name" data-umpx-placeholder="4X4 | 6303">Carbondale Short Bus</span>
```

The span inherits all typography from its surroundings and adds only a faint
dotted underline (suppressed when printing). `document.title` is updated too, so
tabs and bookmarks read correctly. Nothing else in `<head>` is touched — the
`og:` tags and the JSON-LD block keep the placeholder.

### The tooltip

Hovering a substituted name shows the placeholder it replaced. This is drawn by
the extension rather than left to a `title` attribute, because native tooltips
cannot be styled at all and Chrome renders them quite differently from Firefox.
A single reused element carries the hint, and it lives directly on `<body>` with
`position: fixed` — several of the places a name appears sit inside an
`overflow: hidden` `.text-truncate` wrapper that would clip an absolutely
positioned tooltip. It flips below the anchor when there is no room above,
clamps to the viewport horizontally, sets `pointer-events: none` so it can never
swallow a click, and hides on mouse-out, click, scroll, resize or window blur.

A debounced `MutationObserver` reruns discovery on inserted content, covering the
sidebar's client-side re-sort, AJAX-loaded photos, and the search page's React
re-renders.

### What is never touched

User-written content is left exactly as posted. The comment section — Mountain
Project's `<div class="comments" id="comments-Climb-Lib-Models-…">` and
everything inside it — is excluded from both replacement *and* discovery, so a
placeholder appearing only in a comment does not even trigger a lookup. The
exclusion is re-checked on every pass, so it still holds after the site's own
AJAX re-renders the comment list.

Any failure — network error, unparseable page, extension unavailable — leaves the
page exactly as Mountain Project served it.

## The local database

IndexedDB `unredact-mp`, object store `names`, keyed on the Mountain Project
object ID. Route and area IDs come from one global sequence, so a single keyspace
is safe and a pre-crawled database can later be merged in row for row.

```js
{
  id: 108006303,                  // primary key
  type: "route" | "area",
  name: "Carbondale Short Bus",   // null = tombstone
  placeholder: "4X4 | 6303",
  source: "fetch" | "bundled",
  entryVersion: 1,
  fetchedAt: 1755000000000
}
```

**Entries are permanent.** Original names do not change, so there is no TTL and
nothing is ever re-checked on a timer. `DATA_VERSION` in `background.js` is the
single lever: bump it and every entry written by an earlier release is treated as
stale and refetched on next encounter. `schemaVersion` tracks structural changes
to the store itself.

`source` is what makes a shipped pre-crawled database drop in cleanly later —
seed it on install, let user-fetched rows fill the gaps, and the two remain
distinguishable.

**Tombstones** (`name: null`) record "asked, got nothing" — a deleted route, a
restored name, a parser break. They are retried after 30 days rather than on
every page view, so a regression costs one request a month instead of one per
load. Transient network failures do *not* write a tombstone.

## Popup

Shows how many names are cached (split by routes/areas), how many lookups came
back empty, and the current data version. Offers a global enable toggle and a
cache reset.

## Tests

`test/run.mjs` replays the content script over the six saved pages under their
real URLs via request interception, asserting the exact number of substitutions,
the exact number of network lookups, that no placeholder survives, that a decoy
name whose digits don't match its ID is untouched, and that comment text is
preserved verbatim while the same placeholder outside the comment section is
still replaced.

`test/e2e.mjs` loads the built extension in Chromium for real — actual manifest,
service worker and IndexedDB — and verifies that a second page load performs no
network lookup at all, and that the tooltip appears on hover, escapes the
`overflow: hidden` wrapper, stays on screen and carries no native `title`.

`test/shot.mjs` renders `tooltip-preview.png` for a quick look at the styling.

```
node test/run.mjs   # 36/36
node test/e2e.mjs   # 18/18
```

`web-ext lint` reports zero errors. Three warnings remain, all benign: Firefox
ignores the `background.service_worker` key (Chrome uses it; Firefox uses
`background.scripts`, both are declared), and `data_collection_permissions` —
declared as `none` — postdates the `strict_min_version` of 115, where it is
simply ignored.

## Known limits

- The search page is server-rendered and works today, but it is a hydrating React
  app; substitutions there rely on the observer catching re-renders after sorting
  or filtering. It has had less hardening than the three Blade-rendered page
  types.
- A redacted *area* viewed on its own classics page is recognised via the `h1`
  prefix rule; that path is exercised by logic but not by a captured fixture.
- Forum posts are outside the extension's page scope and are not modified.
