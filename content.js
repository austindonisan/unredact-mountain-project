/*
 * Unredact Mountain Project — content script
 *
 * Mountain Project replaces names it has withdrawn with a placeholder built
 * from the parent crag name and the last four digits of the object's ID:
 *
 *     route 108006303  ->  "4X4 | 6303"
 *     area  105789303  ->  "Quail Springs Area | 9303"
 *
 * That construction is documented on the /updates/ page itself, and it is the
 * basis of every safety check here: a string is only ever treated as a
 * placeholder when its four digits match the last four digits of an ID we
 * independently know (from a link's href, or from the page URL). A genuinely
 * named route called "Foo | 1234" is left alone unless it happens to live at an
 * ID ending in 1234.
 */

'use strict';

(() => {
  const api = typeof browser !== 'undefined' ? browser : chrome;

  const MARK_CLASS = 'umpx-name';
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'TITLE', 'SVG']);

  const TIP_CLASS = 'umpx-tooltip';

  /*
   * Regions the extension never reads from or writes to.
   *
   * User-written content is left exactly as posted: `.comments` is the outer
   * container Mountain Project wraps the whole discussion in on both route and
   * area pages (`<div class="comments" id="comments-Climb-Lib-Models-...">`);
   * the rest are listed defensively because the comment list is re-rendered by
   * the site's own AJAX after the initial page load.
   *
   * The extension's own tooltip is listed too — it quotes the placeholder, so
   * without this the sweep would rewrite the inside of its own hint.
   */
  const EXCLUDED_SELECTOR = [
    '.comments',
    '.comments-body',
    '.comment-list',
    '.comment-box',
    '.comment-body',
    '.comment-form-container',
    '.add-comment-form',
    '[id^="comments-Climb-Lib-Models-"]',
    `.${TIP_CLASS}`
  ].join(',');
  const MODEL = { route: 'Climb-Lib-Models-Route', area: 'Climb-Lib-Models-Area' };
  const FETCH_CONCURRENCY = 2;
  const POLL_INTERVAL_MS = 500;
  const POLL_ATTEMPTS = 6;
  const DEBOUNCE_MS = 250;

  // id -> string (resolved name) | null (known-unresolvable). Page-lifetime only.
  const resolved = new Map();
  // id -> {type, placeholder} discovered so far on this page.
  const known = new Map();
  const inFlight = new Set();

  let enabled = true;
  let applying = false;

  /* ---------------------------------------------------------------- *
   * Placeholder recognition
   * ---------------------------------------------------------------- */

  const PLACEHOLDER_RE = /^(.{1,80}?)\s\|\s(\d{4})$/;

  /** Returns the 4-digit suffix if `text` looks like a placeholder, else null. */
  function placeholderDigits(text) {
    const m = PLACEHOLDER_RE.exec(text.trim());
    return m ? m[2] : null;
  }

  /** A placeholder is only trusted when its digits match the entity's own ID. */
  function validates(text, id) {
    const digits = placeholderDigits(text);
    if (!digits) return false;
    const s = String(id);
    return s.length >= 4 && s.slice(-4) === digits;
  }

  /**
   * Pulls a placeholder off the front of a text node belonging to a known
   * entity, returning the literal substring so it can be matched verbatim later.
   *
   * Needed because a placeholder is not always alone in its text node — the
   * breadcrumb on an /updates/ page renders as
   *     "4X4 | 6303            (" <span>5.13+</span> …
   * so an exact whole-node comparison would miss it. The match is anchored to
   * the start of the node and to the entity's own last four digits, which keeps
   * it from swallowing surrounding prose.
   */
  function placeholderAtStart(text, id) {
    const s = String(id);
    if (s.length < 4) return null;
    const last4 = s.slice(-4);
    const re = new RegExp(`^\\s*([^|\\n]{1,80}?\\s\\|\\s${last4})(?!\\d)`);
    const m = re.exec(text);
    return m ? m[1] : null;
  }

  /** Extracts {type, id} from an <a> pointing at a route or area, else null. */
  function entityFromAnchor(a) {
    const raw = a.getAttribute('href');
    if (!raw) return null;
    let u;
    try { u = new URL(raw, location.href); } catch { return null; }
    if (u.hostname && !/(^|\.)mountainproject\.com$/i.test(u.hostname)) return null;
    const m = /^\/(route|area)\/(\d{4,})(?:\/|$)/.exec(u.pathname);
    if (!m) return null;
    return { type: m[1], id: Number(m[2]) };
  }

  /** Extracts {type, id} for the entity this page is *about*, else null. */
  function pageEntity() {
    const m = /^\/(route|area)\/(?:classics\/)?(\d{4,})(?:\/|$)/.exec(location.pathname);
    if (!m) return null;
    return { type: m[1], id: Number(m[2]), classics: location.pathname.startsWith('/area/classics/') };
  }

  /* ---------------------------------------------------------------- *
   * Discovery
   * ---------------------------------------------------------------- */

  /** True if the element sits inside the comment section. */
  function isExcluded(el) {
    return !!(el && typeof el.closest === 'function' && el.closest(EXCLUDED_SELECTOR));
  }

  function inSkippedSubtree(node) {
    if (isExcluded(node.parentElement)) return true;
    for (let el = node.parentElement; el; el = el.parentElement) {
      // SVG elements report a lowercase tagName, unlike HTML ones.
      if (SKIP_TAGS.has(String(el.tagName).toUpperCase())) return true;
      if (el.classList && el.classList.contains(MARK_CLASS)) return true;
    }
    return false;
  }

  /**
   * Finds every placeholder we can prove the identity of, and records it in
   * `known`. Sources, in order of reliability:
   *   1. text inside a link to /route/<id> or /area/<id>
   *   2. the <h1> of a route or area page (ID comes from the URL)
   *   3. the <h1> of an area's classics page, after stripping the known prefix
   */
  function discover(root) {
    const scope = root && root.querySelectorAll ? root : document;

    // 1. Link-scoped placeholders — area sidebars, classics lists, breadcrumbs.
    const anchors = scope.querySelectorAll('a[href]');
    for (const a of anchors) {
      const ent = entityFromAnchor(a);
      if (!ent || known.has(ent.id)) continue;
      // Skip discovery inside comments too, so a placeholder that appears only
      // in a comment never triggers a lookup we would not act on.
      if (isExcluded(a)) continue;
      const walker = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const found = node.nodeValue && placeholderAtStart(node.nodeValue, ent.id);
        if (!found) continue;
        known.set(ent.id, { type: ent.type, placeholder: found });
        break;
      }
    }

    // 2 & 3. The page's own entity, whose ID we take from the URL.
    const page = pageEntity();
    if (page && !known.has(page.id)) {
      for (const h1 of document.querySelectorAll('h1')) {
        // Only the h1's own text, never nested edit/tooltip links.
        for (const child of h1.childNodes) {
          if (child.nodeType !== Node.TEXT_NODE) continue;
          const text = child.nodeValue.trim();
          if (!text) continue;

          if (validates(text, page.id)) {
            known.set(page.id, { type: page.type, placeholder: text });
            break;
          }
          // "Classic  Climbs for <placeholder>" — the only place the
          // placeholder is embedded in a longer string with no link to anchor
          // it, so the prefix is stripped explicitly rather than guessed.
          if (page.classics) {
            const stripped = text.replace(/^Classic\s+Climbs\s+for\s+/i, '').trim();
            if (stripped !== text && validates(stripped, page.id)) {
              known.set(page.id, { type: page.type, placeholder: stripped });
              break;
            }
          }
        }
        if (known.has(page.id)) break;
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Resolution (local DB first, network only for genuine misses)
   * ---------------------------------------------------------------- */

  function send(msg) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      try {
        const maybe = api.runtime.sendMessage(msg, (resp) => {
          void api.runtime.lastError; // extension context torn down mid-navigation
          done(resp);
        });
        if (maybe && typeof maybe.then === 'function') maybe.then(done, () => done(null));
      } catch { done(null); }
    });
  }

  /** Pulls the original name out of an /updates/ page. */
  function parseUpdatesPage(html) {
    let doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch { return null; }
    const root = doc.querySelector('#page-updates-details') || doc.body;
    if (!root) return null;

    for (const p of root.querySelectorAll('p')) {
      if (!/chosen not to display the original name/i.test(p.textContent)) continue;
      const em = p.querySelector('em');
      if (!em) continue;
      const name = em.textContent.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
      if (!name || name.length > 200) continue;
      if (placeholderDigits(name)) continue; // never store a placeholder as a name
      return name;
    }
    return null;
  }

  async function fetchName(type, id) {
    // The slug segment is ignored by the server, so the ID alone is enough.
    const url = `${location.origin}/updates/${MODEL[type] || MODEL.route}/${id}/x`;
    let res;
    try {
      res = await fetch(url, { credentials: 'include', redirect: 'follow' });
    } catch { return undefined; } // network error: don't record a tombstone
    if (!res.ok) return null;
    let html;
    try { html = await res.text(); } catch { return undefined; }
    return parseUpdatesPage(html);
  }

  async function runPool(items, worker) {
    const queue = items.slice();
    const runners = [];
    for (let i = 0; i < Math.min(FETCH_CONCURRENCY, queue.length); i++) {
      runners.push((async () => {
        while (queue.length) await worker(queue.shift());
      })());
    }
    await Promise.all(runners);
  }

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Ensures `resolved` has an answer for every id in `ids` that we can get. */
  async function resolveNames(ids) {
    const wanted = ids.filter((id) => !resolved.has(id) && !inFlight.has(id));
    if (!wanted.length) return;
    wanted.forEach((id) => inFlight.add(id));

    try {
      const cached = await send({ cmd: 'lookup', ids: wanted });
      let missing = wanted;
      if (cached && cached.ok) {
        for (const [id, name] of Object.entries(cached.result.hits)) resolved.set(Number(id), name);
        missing = cached.result.missing;
      }
      if (!missing.length) return;

      // Don't duplicate a fetch another tab is already making.
      let mine = missing;
      let waitFor = [];
      const claimed = await send({ cmd: 'claim', ids: missing });
      if (claimed && claimed.ok) {
        mine = claimed.result.granted;
        waitFor = claimed.result.denied;
      }

      const entries = [];
      await runPool(mine, async (id) => {
        const meta = known.get(id) || { type: 'route' };
        const name = await fetchName(meta.type, id);
        if (name === undefined) return; // transient failure — try again next load
        resolved.set(id, name);
        entries.push({ id, type: meta.type, name, placeholder: meta.placeholder, source: 'fetch' });
      });

      if (entries.length) await send({ cmd: 'put', entries });
      if (mine.length) await send({ cmd: 'release', ids: mine });

      // Poll for the IDs another tab claimed.
      for (let attempt = 0; attempt < POLL_ATTEMPTS && waitFor.length; attempt++) {
        await delay(POLL_INTERVAL_MS);
        const again = await send({ cmd: 'lookup', ids: waitFor });
        if (!again || !again.ok) break;
        for (const [id, name] of Object.entries(again.result.hits)) resolved.set(Number(id), name);
        waitFor = again.result.missing;
      }
    } finally {
      wanted.forEach((id) => inFlight.delete(id));
    }
  }

  /* ---------------------------------------------------------------- *
   * Replacement
   * ---------------------------------------------------------------- */

  function marker(name, placeholder) {
    const span = document.createElement('span');
    span.className = MARK_CLASS;
    span.dataset.umpxPlaceholder = placeholder;
    // Deliberately no `title` attribute: native tooltips cannot be styled and
    // look markedly different in Chrome and Firefox. See the tooltip section.
    span.textContent = name;
    return span;
  }

  /**
   * Rewrites every occurrence of a known placeholder in the document's text
   * nodes. Only literal, already-validated strings are substituted, and only
   * text nodes are touched — the surrounding tooltip links, "suggest change"
   * icons and sort attributes are left intact.
   */
  function sweep(pairs) {
    if (!pairs.length || !document.body) return 0;
    let count = 0;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || node.nodeValue.length < 6) return NodeFilter.FILTER_REJECT;
        for (const [placeholder] of pairs) {
          if (node.nodeValue.includes(placeholder)) {
            return inSkippedSubtree(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
          }
        }
        return NodeFilter.FILTER_REJECT;
      }
    });

    const hits = [];
    let node;
    while ((node = walker.nextNode())) hits.push(node);

    for (const textNode of hits) {
      const parent = textNode.parentNode;
      if (!parent) continue;
      const value = textNode.nodeValue;

      // Longest placeholder first, so overlapping candidates can't half-match.
      const active = pairs
        .filter(([p]) => value.includes(p))
        .sort((a, b) => b[0].length - a[0].length);
      if (!active.length) continue;

      const frag = document.createDocumentFragment();
      let rest = value;
      let guard = 0;
      while (rest && guard++ < 50) {
        let bestIdx = -1;
        let best = null;
        for (const pair of active) {
          const idx = rest.indexOf(pair[0]);
          if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) { bestIdx = idx; best = pair; }
        }
        if (best === null) break;
        if (bestIdx > 0) frag.appendChild(document.createTextNode(rest.slice(0, bestIdx)));
        frag.appendChild(marker(best[1], best[0]));
        rest = rest.slice(bestIdx + best[0].length);
        count++;
      }
      if (rest) frag.appendChild(document.createTextNode(rest));
      parent.replaceChild(frag, textNode);
    }

    return count;
  }

  function updateTitle(pairs) {
    let title = document.title;
    for (const [placeholder, name] of pairs) {
      if (title.includes(placeholder)) title = title.split(placeholder).join(name);
    }
    if (title !== document.title) document.title = title;
  }

  /* ---------------------------------------------------------------- *
   * Tooltip
   * ---------------------------------------------------------------- *
   * Drawn by the extension rather than left to the browser's `title` handling,
   * which is unstyleable and renders very differently between Chrome and
   * Firefox. A single element is reused for every hint and lives directly on
   * <body> with position:fixed — several of the places a name appears sit
   * inside an overflow:hidden `.text-truncate` wrapper, which would clip an
   * absolutely positioned tooltip.
   */

  const TIP_DELAY_MS = 200;
  const TIP_GAP = 7;
  let tip = null;
  let tipTimer = null;
  let tipTarget = null;

  function ensureTip() {
    if (tip && tip.isConnected) return tip;
    tip = document.createElement('div');
    tip.className = TIP_CLASS;
    tip.setAttribute('role', 'tooltip');
    tip.setAttribute('aria-hidden', 'true');
    tip.hidden = true;
    document.body.appendChild(tip);
    return tip;
  }

  function positionTip(el) {
    const anchor = el.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const viewW = document.documentElement.clientWidth;
    const viewH = document.documentElement.clientHeight;

    let top = anchor.top - box.height - TIP_GAP;
    let placement = 'top';
    if (top < TIP_GAP) {
      const below = anchor.bottom + TIP_GAP;
      if (below + box.height <= viewH - TIP_GAP || below < top) {
        top = below;
        placement = 'bottom';
      } else {
        top = TIP_GAP;
      }
    }

    const centred = anchor.left + anchor.width / 2 - box.width / 2;
    const left = Math.max(TIP_GAP, Math.min(centred, viewW - box.width - TIP_GAP));

    tip.style.top = `${Math.round(top)}px`;
    tip.style.left = `${Math.round(left)}px`;
    tip.dataset.placement = placement;
  }

  function showTip(el) {
    const placeholder = el.dataset.umpxPlaceholder;
    if (!placeholder || !document.body) return;
    ensureTip();
    tip.textContent = `Mountain Project shows this as “${placeholder}”`;
    tip.hidden = false;
    tip.setAttribute('aria-hidden', 'false');
    positionTip(el);
  }

  function hideTip() {
    clearTimeout(tipTimer);
    tipTarget = null;
    if (tip) {
      tip.hidden = true;
      tip.setAttribute('aria-hidden', 'true');
    }
  }

  function markerUnder(node) {
    if (!node) return null;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return el && el.closest ? el.closest(`.${MARK_CLASS}`) : null;
  }

  function onPointerOver(e) {
    const el = markerUnder(e.target);
    if (!el) return;
    if (el === tipTarget) return;
    hideTip();
    tipTarget = el;
    tipTimer = setTimeout(() => { if (tipTarget === el) showTip(el); }, TIP_DELAY_MS);
  }

  function onPointerOut(e) {
    const el = markerUnder(e.target);
    if (!el) return;
    // Ignore moves between child nodes of the same name.
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    hideTip();
  }

  function bindTooltip() {
    document.addEventListener('mouseover', onPointerOver, true);
    document.addEventListener('mouseout', onPointerOut, true);
    document.addEventListener('click', hideTip, true);
    window.addEventListener('scroll', hideTip, true);
    window.addEventListener('resize', hideTip);
    window.addEventListener('blur', hideTip);
  }

  /* ---------------------------------------------------------------- *
   * Orchestration
   * ---------------------------------------------------------------- */

  async function run(root) {
    if (!enabled || applying) return;

    discover(root);
    const pending = [...known.keys()].filter((id) => !resolved.has(id));
    if (pending.length) await resolveNames(pending);

    const pairs = [];
    for (const [id, meta] of known) {
      const name = resolved.get(id);
      if (typeof name === 'string' && name && name !== meta.placeholder) {
        pairs.push([meta.placeholder, name]);
      }
    }
    if (!pairs.length) return;

    applying = true;
    try {
      sweep(pairs);
      updateTitle(pairs);
    } finally {
      applying = false;
    }
  }

  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => { run(document).catch(() => {}); }, DEBOUNCE_MS);
  }

  function observe() {
    const observer = new MutationObserver((records) => {
      if (applying) return;
      for (const r of records) {
        if (!r.addedNodes || !r.addedNodes.length) continue;
        if (tip && (r.target === tip || tip.contains(r.target))) continue; // our own tooltip
        schedule();
        return;
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  async function init() {
    const stored = await new Promise((resolve) => {
      try {
        const maybe = api.storage.local.get({ enabled: true }, (v) => {
          void api.runtime.lastError;
          resolve(v || { enabled: true });
        });
        if (maybe && typeof maybe.then === 'function') maybe.then(resolve, () => resolve({ enabled: true }));
      } catch { resolve({ enabled: true }); }
    });
    enabled = stored.enabled !== false;
    if (!enabled) return;

    await run(document);
    bindTooltip();
    observe();
  }

  // Exposed so the logic can be exercised directly in tests.
  if (typeof window !== 'undefined') {
    window.__umpx = { discover, sweep, updateTitle, known, resolved, validates, entityFromAnchor, pageEntity, parseUpdatesPage };
  }

  init().catch(() => {});
})();
