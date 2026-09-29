/* ============================================================
 * Monochrome pocket — Cloudflare Worker relay — worker.js
 * BUILD: mp service 1.0
 *   Deploy check: /__status on the worker URL must answer
 *   "mp service 1.0".
 * ------------------------------------------------------------
 * WHAT THIS DOES (the "no-navigation" architecture, ported from
 * the z.ai pocket relay to monochrome.tf / monochrome.st)
 *
 *   The saved pocket file (PocketMonochrome.html) never
 *   navigates anywhere. It fetches documents through this
 *   worker (plain CORS fetch) and paints them into a
 *   null-origin sandboxed iframe (srcdoc). Every byte of the
 *   Monochrome web app (https://monochrome.tf — served at
 *   monochrome.st) flows through the relay:
 *
 *     /  -> a neutral "service online" page. NEVER Monochrome
 *           content, so nothing at this origin looks like a
 *           music app to a classifier.
 *     /__status -> {ok, name, time, session, session_mode,
 *           entry} — the entry is the tokenized ROOT DOCUMENT
 *           path; the pocket fetches it to boot the app.
 *     /__t/<token> -> an opaque token (the absolute upstream
 *           URL, XOR-encrypted + base64url'd). The app entry,
 *           and every URL the runtime patch maps at run time.
 *     /__o/<origin-token><path> -> path-preserving form so
 *           relative resolution (dynamic import("./chunk.js"),
 *           css url(), <base>-resolved runtime urls) works.
 *     /__session -> the relay-held session (single user):
 *           the newest cookies + Bearer the relay saw in the
 *           proxied traffic. GET returns it, DELETE forgets.
 *     /__diag    -> live upstream probe report.
 *     /__clear   -> expire session cookies.
 *     /p/<host>/* -> legacy form, still accepted, never emitted.
 *     anything else (bare path) -> neutral 404 JSON.
 *
 * UPSTREAMS (all first-party Monochrome family):
 *   monochrome.st   — the web app itself (monochrome.tf 503-
 *                     refreshes here; the worker fetches the
 *                     .st origin directly)
 *   auth.monochrome.st — Better-Auth API (login, session,
 *                     collections, files/token …)
 *   data.monochrome.st — PocketBase data API
 *   tracks.monochrome.st — the Hi-Fi streaming API (v2.10)
 *   hot.monochrome.tf  — explore/hot endpoints
 *   resources.tidal.com — album art (public CDN)
 *
 * NO OWNER KEY. This relay is deliberately open: there is no
 * key box, no keyed mode, nothing to type. The relay keeps the
 * signed-in session (see /__session) for whoever uses it —
 * one relay, one user, the way the z.ai pocket's auto mode
 * works, minus the key minting. Sign out inside the app (or
 * the Forget button in the pocket) and the relay forgets.
 *
 * ENV (all optional):
 *   MONO_UPSTREAM — override the app origin (default
 *                   https://monochrome.st)
 *   PROXY_TOKEN   — optional access token gate (landing page)
 *   EXTRA_HOSTS   — "a.com,b.com" additional allowlisted
 *                   host suffixes
 * ============================================================ */

const VERSION = 'mp service 1.2';

/* Monochrome first-party family (suffix match — covers subdomains) */
const ALLOW = [
  'monochrome.st',      // the app + auth. + data. + tracks. subdomains
  'monochrome.tf',      // the canonical name + hot. explore endpoints
  'monochrome.qzz.io',  // PocketBase file storage (uploads. + images.)
  'resources.tidal.com',// album-art CDN the app embeds
  'auth.tidal.com',     // TIDAL OAuth token refresh (playback gate)
  'api.tidal.com',      // TIDAL catalog + stream manifests
  'openapi.tidal.com',  // TIDAL open API (search fallback)
  'tidal.com',          // www. + plain redirects
  'audioscrobbler.com', // last.fm scrobbling (ws.)
  'api.podcastindex.org',// podcast search
  'github.com',         // AutoEq EQ profile browser (api. + raw.)
  'githubusercontent.com',
  'fonts.googleapis.com',// webfont css (preconnected at boot)
  'fonts.gstatic.com'   // webfont files
];

/* ---- opaque request tokens ----------------------------------------
 * Every upstream URL this worker embeds in a response and every
 * cross-host URL the runtime patch maps in the browser becomes
 * /__t/<token> — XOR-obfuscated + base64url'd — so NO upstream
 * hostname (monochrome.st, tidal.com …) is ever readable in a
 * request the phone makes. The key is shared with the runtime
 * patch via window.__MP__.key. */
const TOK_KEY = 'mpwtok-1-0-0-K9mVx2qT';

function encTok(u) {
  const bytes = new TextEncoder().encode(String(u));
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i] ^ TOK_KEY.charCodeAt(i % TOK_KEY.length));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decTok(t) {
  try {
    const s = atob(String(t || '').replace(/-/g, '+').replace(/_/g, '/').trim());
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
      bytes[i] = s.charCodeAt(i) ^ TOK_KEY.charCodeAt(i % TOK_KEY.length);
    }
    return new TextDecoder().decode(bytes);
  } catch (e) { return null; }
}

function tokPath(absUrl) {
  try { return '/__t/' + encTok(absUrl); } catch (e) { return null; }
}

/* path-preserving origin-token form — '/__o/<encTok(origin)><path><search>'.
 * Relative URL resolution (dynamic import("./chunk.js"), css url(),
 * <base>-resolved runtime urls) needs the upstream PATH to ride along
 * in cleartext; the HOSTNAME stays encrypted. */
function oTokPath(absUrl) {
  try {
    const u = new URL(absUrl);
    const ot = encTok(u.origin);
    if (!ot) return null;
    return '/__o/' + ot + u.pathname + u.search;
  } catch (e) { return null; }
}

/* upstream origins (env overrides for staging) */
function monoUpstream(event) { return envOf(event).MONO_UPSTREAM || 'https://monochrome.st'; }
function monoHost(event) {
  try { return new URL(monoUpstream(event)).host; } catch (e) { return 'monochrome.st'; }
}
/* the auth/Better-Auth API origin the app talks to (Bearer + cookies land
 * here) — derived from the app host: auth.<that host>, normalized to the
 * monochrome.st family (monochrome.tf serves from monochrome.st). */
function authUpstream(event) {
  const mh = monoHost(event).replace(/^www\./, '');
  return 'https://auth.' + (mh === 'monochrome.tf' ? 'monochrome.st' : mh);
}
function authHost(event) {
  try { return new URL(authUpstream(event)).host; } catch (e) { return 'auth.monochrome.st'; }
}

/* ============================================================
 * The RUNTIME PATCH — injected by this worker into every proxied
 * HTML document as the FIRST script inside <head>. It rewrites
 * every network call, navigation and popup so the Monochrome SPA
 * believes it lives on its real origin while every byte actually
 * flows through the worker.
 *
 * NOTE: this source is embedded inside a script element in proxied
 * pages AND inside the pocket's JSON island, so it must never
 * contain the literal sequence "</scr" + "ipt>" — keep it that
 * way (same rule the z.ai relay follows).
 * ============================================================ */
const PATCH_JS = `
/* ============================================================
 * Monochrome pocket — runtime patch (v1)
 * Injected by the proxy worker into every proxied HTML document
 * as the FIRST script inside <head>.
 * ============================================================ */
(function () {
  'use strict';
  if (window.__MP_PATCHED__) return;
  window.__MP_PATCHED__ = true;

  var CFG = window.__MP__ || {};
  var PFX = CFG.pfx || '';            // proxy prefix for this document, '' = transparent root
  var HOST = (CFG.host || '').toLowerCase(); // upstream host this document belongs to
  var WORKER = CFG.worker || '';      // worker origin, e.g. https://name.workers.dev
  var TOKEN = CFG.token || '';        // optional shared proxy token
  var ALLOW = CFG.allow || [];        // allowlisted host suffixes
  var KEY = CFG.key || '';            // opaque-token key (shared with the worker)
  var TOK = !!CFG.tok;                // true when this doc was served through /__t/<token>
  var DOC = CFG.doc || '';            // that token's absolute upstream URL (TOK mode)
  var SD = !!CFG.sd;                  // sandbox mode — this document is being
                                      // painted into a null-origin srcdoc frame by
                                      // the pocket shell. NEVER navigate: every
                                      // destination goes to the shell by postMessage.

  var jar = [];                       // fallback cookie jar (mirrored by the shell)
  var lsMirror = {};                  // fallback localStorage mirror (for browsers that block it in iframes)
  var __histState = undefined;        // history.state payload parked by the pushState/replaceState shims (sandbox)

  /* ---------- absolute worker URLs --------------------------------
   * Inside the sandbox frame the document sits at about:srcdoc, so a
   * mapped path like /__t/<token> is unresolvable on its own — it must
   * be absolutized against the worker origin for fetch/XHR/ES/beacons. */
  function absW(p) {
    try {
      if (!SD || typeof p !== 'string' || !/^\\//.test(p)) return p;
      return WORKER.replace(/\\/$/, '') + p;
    } catch (e) { return p; }
  }

  /* ---------- is this URL the WORKER's own (already proxied)? ------
   * The worker rewrites HTML attrs into ABSOLUTE worker URLs. Those
   * are NOT "external" — but the allowlist only knows upstream hosts,
   * so every nav branch must recognize worker-origin URLs FIRST. */
  function isWorkerUrl(u) {
    try {
      if (!SD || !WORKER) return false;
      var s = String(u || '');
      var w = WORKER.replace(/\\/$/, '');
      return s === w || s.indexOf(w + '/') === 0 || s.indexOf(w.replace(/^http/, 'ws')) === 0;
    } catch (e) { return false; }
  }

  /* ---------- navigation request to the shell ---------------------
   * nav(u) sends the shell everything it needs to re-render the app at
   * a new URL as a FRESH sandboxed document: the worker path to fetch
   * (tokenized here) and the upstream URL for its address bar /
   * history entry. POST navigations (form submits) carry
   * method/body/content-type too. */
  function nav(u, method, body, ct) {
    try {
      var s = (u == null) ? '' : String(u);
      var mapped = mapUrl(s);
      var upUrl = '';
      try { upUrl = new URL(s, DOC || location.href).href; } catch (eU) { upUrl = s; }
      up({ type: 'navreq', url: mapped, up: upUrl, method: method || 'GET', body: body || null, ct: ct || null });
      return s;
    } catch (e) { return u; }
  }

  /* ---------- fake location (window.__mpLoc) ----------------------
   * The worker's JS pass rewrites location.<prop> tokens in served
   * scripts to __mpLoc.<prop>. Reads answer the REAL upstream URL
   * (SPA routers hydrate as if the page lived at monochrome.st); the
   * href setter (and assign/replace/reload) turn navigations into
   * nav() postMessages instead of steering the sandbox frame anywhere.
   * The underlying URL is MUTABLE — the pushState/replaceState shims
   * advance it so a router that re-reads window.location.pathname
   * after an SPA transition sees the NEW path, like the real thing. */
  var LOC = { u: null };
  try { LOC.u = DOC ? new URL(DOC) : null; } catch (eLoc0) { LOC.u = null; }
  function setLoc(abs) {
    try { LOC.u = new URL(String(abs)); } catch (eSet) { /* keep old */ }
  }
  function makeLoc() {
    function prop(name, fb) {
      try { return LOC.u ? LOC.u[name] : fb; } catch (e) { return fb; }
    }
    var loc = {};
    Object.defineProperty(loc, 'href', {
      get: function () { return LOC.u ? LOC.u.href : (DOC || 'about:srcdoc'); },
      set: function (v) { nav(v); return v; },
      configurable: true
    });
    loc.assign = function (v) { nav(v); };
    loc.replace = function (v) { nav(v); };
    loc.reload = function () { up({ type: 'reloadreq' }); };
    loc.toString = function () { return LOC.u ? LOC.u.href : (DOC || 'about:srcdoc'); };
    ['origin', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'].forEach(function (k) {
      try {
        var def = {
          get: function () {
            if (!LOC.u) return k === 'origin' || k === 'host' || k === 'hostname' ? '' : (k === 'protocol' ? 'https:' : (k === 'pathname' ? '/' : ''));
            return LOC.u[k];
          },
          configurable: true
        };
        /* writable location parts: a hash write stays in-document (the
         * router polls it); pathname/search writes are navigations. */
        if (k === 'hash') {
          def.set = function (v) {
            try {
              var base = LOC.u ? LOC.u.href.replace(/#.*$/, '') : (DOC || '/');
              setLoc(base + '#' + String(v).replace(/^#/, ''));
              try { window.dispatchEvent(new Event('hashchange')); } catch (eHG) { /* ignore */ }
            } catch (eH) { /* ignore */ }
          };
        } else if (k === 'pathname' || k === 'search') {
          def.set = function (v) {
            try { var u = new URL(String(v), LOC.u || DOC || '/'); nav(u.href); } catch (eS) { /* ignore */ }
          };
        }
        Object.defineProperty(loc, k, def);
      } catch (e) { /* ignore */ }
    });
    return loc;
  }
  if (SD) {
    try { window.__mpLoc = makeLoc(); } catch (eL) { /* ignore */ }
    /* document.URL / baseURI / documentURI — the parser reports
     * about:srcdoc; SPA hydration wants the real upstream URL. These
     * are plain accessors on Document.prototype (NOT unforgeable). */
    try {
      ['URL', 'baseURI', 'documentURI'].forEach(function (k) {
        Object.defineProperty(Document.prototype, k, {
          get: function () { return DOC || 'about:srcdoc'; },
          configurable: true
        });
      });
    } catch (eD) { /* ignore */ }
  }

  /* ---------- boot hydration ---------------------------------------
   * The shell injects the session snapshot as a REAL script element at the
   * very top of the document (window.__MP_SEED__), because Chrome
   * never copies window.name into a null-origin sandbox frame. The
   * frame.name stamp stays as the fallback for older shells.
   * Whichever way the snapshot arrives it is readable synchronously
   * here, so the app's own scripts (which run after this patch) find
   * their session cookies and localStorage already populated. */
  try {
    var boot = null;
    try { if (window.__MP_SEED__ && window.__MP_SEED__.mp === 1) boot = window.__MP_SEED__; } catch (eSS) { boot = null; }
    if (!boot && SD && window.name) { try { boot = JSON.parse(window.name); } catch (eSN) { boot = null; } }
    if (boot && boot.mp === 1) {
      if (boot.ls && typeof boot.ls === 'object') {
        Object.keys(boot.ls).forEach(function (k) { if (!(k in lsMirror)) lsMirror[k] = String(boot.ls[k]); });
      }
      if (Array.isArray(boot.jar)) {
        var jarMap = {};
        jar.forEach(function (c) { if (c && c.name) jarMap[c.name] = c; });
        boot.jar.forEach(function (c) { if (c && c.name) jarMap[c.name] = c; });
        jar = Object.keys(jarMap).map(function (k) { return jarMap[k]; });
      }
    }
  } catch (eN) { /* ignore */ }

  /* ---------- messaging ---------- */
  function up(msg, transfer) {
    try {
      msg.mp = 1;
      if (window.parent && window.parent !== window) {
        /* a transfer list (ArrayBuffers the caller hands away) rides
         * the postMessage itself — big worker payloads stay zero-copy
         * on the way up; anything not transferable falls back to a
         * plain structured clone. */
        if (transfer && transfer.length) {
          try { window.parent.postMessage(msg, '*', transfer); return; } catch (eT) { /* plain clone below */ }
        }
        window.parent.postMessage(msg, '*');
      }
    } catch (e) { /* ignore */ }
  }

  /* ---------- on-page toast (top-level mode: no shell above us) ---------- */
  var toastCount = 0;
  function pageToast(msg) {
    try {
      if (window.parent && window.parent !== window) return; // shell handles messages
      if (toastCount >= 4) return;
      toastCount++;
      var d = document.createElement('div');
      d.textContent = msg;
      d.setAttribute('style', 'position:fixed;left:12px;right:12px;bottom:max(18px,env(safe-area-inset-bottom));z-index:2147483647;background:#20232F;color:#E7E9EE;border:1px solid rgba(255,255,255,.16);border-radius:14px;padding:13px 15px;font:13px/1.5 -apple-system,BlinkMacSystemFont,system-ui,"Segoe UI",Roboto,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.45);word-break:break-all;opacity:0;transition:opacity .25s;pointer-events:none');
      (document.body || document.documentElement).appendChild(d);
      var raf = window.requestAnimationFrame || function (f) { setTimeout(f, 16); };
      raf(function () { d.style.opacity = '1'; });
      setTimeout(function () {
        try { d.style.opacity = '0'; setTimeout(function () { d.remove(); }, 300); } catch (e) { /* ignore */ }
      }, 4500);
    } catch (e) { /* ignore */ }
  }

  /* ---------- host matching ---------- */
  function allowedHost(h) {
    h = (h || '').toLowerCase().replace(/\\.$/, '');
    if (!h) return false;
    for (var i = 0; i < ALLOW.length; i++) {
      var a = String(ALLOW[i]).toLowerCase();
      if (h === a || h.slice(-(a.length + 1)) === '.' + a) return true;
    }
    return false;
  }

  /* ---------- opaque tokens (mirror of the worker's encTok) ---------- */
  function encTok(u) {
    try {
      if (!KEY) return null;
      var bytes = new TextEncoder().encode(String(u));
      var s = '';
      for (var i = 0; i < bytes.length; i++) {
        s += String.fromCharCode(bytes[i] ^ KEY.charCodeAt(i % KEY.length));
      }
      return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
    } catch (e) { return null; }
  }
  function tokPath(absUrl) {
    var t = encTok(absUrl);
    return t ? '/__t/' + t : null;
  }

  /* ---------- proxy-path bookkeeping ---------- */
  function originStr() {
    try { return location.origin || (location.protocol + '//' + location.host); } catch (e) { return ''; }
  }
  function hasPfx(str) {
    if (!PFX) return true;
    if (str === PFX) return true;
    return str.indexOf(PFX) === 0 && /^[\\/?#;]/.test(str.charAt(PFX.length));
  }
  function isCrossHostPath(str) { // "/p/<allowlisted host>/..."
    if (/^\\/p\\//.test(str)) {
      var h = str.slice(3).split(/[\\/?#]/)[0].toLowerCase();
      if (allowedHost(h)) return true;
    }
    return false;
  }
  function isProxyPath(p) {
    if (!p) return false;
    if (hasPfx(p)) return true;
    if (isCrossHostPath(p)) return true;
    if (/^\\/__(t|o)\\//.test(p)) return true; // token paths (full-URL / origin+path)
    if (/^\\/__(status|clear)([\\/?#]|$)/.test(p)) return true;
    return false;
  }

  /* ---------- URL mapping (opaque tokens for cross-host URLs) ----------
   * absolute / protocol-relative allowlisted URLs -> /__t/<token>
   * same-host absolute URLs -> bare worker paths (no hostname)
   * root-absolute paths -> PFX + path  (they belong to this doc's upstream host)
   * relative / data: / blob: / #...   -> untouched
   * TOK mode (doc served through /__t/<token>): every reference is
   *   absolutized against DOC and tokenized. */
  function mapUrl(u) {
    /* sandbox wrapper: every mapped worker path becomes ABSOLUTE
     * (https://worker/__t/...) because about:srcdoc has no base to
     * resolve "/__t/..." against. absW() is idempotent, and in
     * non-sandbox mode it is a no-op. */
    return absW(mapUrl0(u));
  }

  function mapUrl0(u) {
    try {
      if (u == null) return u;
      if (typeof u === 'object' && u instanceof URL) {
        var s0 = mapUrl(u.href);
        return s0;
      }
      if (typeof u !== 'string') return u;
      var str = u.trim();
      if (!str) return str;
      if (/^(data|blob|about|javascript|mailto|tel|sms|intent|ms-|chrome|file|ws|wss):/i.test(str)) {
        // wss/ws handled by the WebSocket wrapper below; here pass through
        return str;
      }
      if (str.charAt(0) === '#') return str;
      var m;
      if ((m = str.match(/^https?:\\/\\/([^\\/?#]+)/i))) {
        var host = m[1].toLowerCase();
        var org = originStr();
        if (org && (str === org || str.indexOf(org + '/') === 0)) {
          // same-origin (worker) absolute URL — either already proxied
          // ("/...", "/p/host/...", "/__t/...") or a bare worker-root path that
          // still belongs to this document's upstream
          var sp = str.slice(org.length) || '/';
          if (isProxyPath(sp)) return sp;
          return PFX + sp;
        }
        if (!allowedHost(host)) return str;                    // external: leave
        if (host === HOST && !TOK) {
          var rest = str.slice(m[0].length) || '/';
          return PFX + rest;                                    // app host: bare worker path
        }
        var t1 = tokPath(str);                                 // everything else: opaque token
        if (t1) return t1;
        return '/p/' + host + (str.slice(m[0].length) || '/'); // keyless legacy fallback
      }
      if ((m = str.match(/^\\/\\/([^\\/?#]+)/))) {
        var h2 = m[1].toLowerCase();
        if (!allowedHost(h2)) return str;
        if (h2 === HOST && !TOK) {
          var rest2 = str.slice(m[0].length) || '/';
          return PFX + rest2;
        }
        var t2 = tokPath('https:' + str);
        if (t2) return t2;
        return '/p/' + h2 + (str.slice(m[0].length) || '/');
      }
      if (str.charAt(0) === '/' && str.charAt(1) !== '/') {
        /* TOK mode: there IS no prefix to carry — a root-absolute path
         * belongs to the DOC's upstream and MUST be absolutized +
         * tokenized. But the EXPLICIT already-proxied forms pass
         * through untouched — hasPfx() alone would swallow EVERYTHING
         * when PFX is ''. */
        if (TOK && DOC) {
          if (/^\\/__(t|o)\\//.test(str)) return str;
          if (isCrossHostPath(str)) return str;
          if (/^\\/__(status|clear|diag)([\\/?#]|$)/.test(str)) return str;
          try {
            var t3 = tokPath(new URL(str, DOC).href);
            if (t3) return t3;
          } catch (e3) { /* fall through */ }
        }
        if (hasPfx(str)) return str;          // already carries this doc's proxy prefix
        if (isCrossHostPath(str)) return str; // already a legacy /p/<host>/ proxy path
        if (/^\\/__(t|o)\\//.test(str)) return str; // already a token path
        return PFX + str;
      }
      if (TOK && DOC && !/^[a-z][a-z0-9+.-]*:/i.test(str)) {
        try {
          var t4 = tokPath(new URL(str, DOC).href);
          if (t4) return t4;
        } catch (e4) { /* fall through */ }
      }
      return str; // relative -> resolves against the proxied document URL
    } catch (e) { return u; }
  }

  /* ---------- cookies ---------- */
  function docCookies() {
    var out = [];
    if (SD) {
      /* sandbox: document.cookie is shimmed to the memory jar below —
       * reads come from the jar (seeded at boot and refreshed by
       * x-set-cookie on every proxied response). */
      jar.forEach(function (c) { if (c && c.name && !c.del) out.push(c.name + '=' + c.value); });
      return out;
    }
    try {
      (document.cookie || '').split(';').forEach(function (kv) {
        kv = kv.trim();
        if (kv) out.push(kv);
      });
    } catch (e) { /* ignore */ }
    return out;
  }

  function cookieHeader() {
    var seen = {};
    var parts = [];
    docCookies().forEach(function (kv) {
      var name = kv.split('=')[0];
      if (!seen[name]) { seen[name] = 1; parts.push(kv); }
    });
    jar.forEach(function (c) {
      if (c && c.name && !seen[c.name]) { seen[c.name] = 1; parts.push(c.name + '=' + c.value); }
    });
    return parts.join('; ');
  }

  function ingestSetCookie(hdrVal) {
    try {
      if (!hdrVal) return;
      var arr = JSON.parse(decodeURIComponent(hdrVal));
      if (!Array.isArray(arr)) return;
      var map = {};
      jar.forEach(function (c) { map[c.name] = c; });
      arr.forEach(function (raw) {
        var bits = String(raw).split(';');
        var nv = bits[0];
        var eq = nv.indexOf('=');
        if (eq < 1) return;
        var c = { name: nv.slice(0, eq).trim(), value: nv.slice(eq + 1).trim() };
        for (var i = 1; i < bits.length; i++) {
          var b = bits[i].trim();
          var k = b.split('=')[0].toLowerCase();
          if (k === 'max-age') {
            var ma = parseInt(b.slice(8), 10);
            if (ma === 0) { c.del = true; }
            c.maxAge = ma;
          }
        }
        if (c.del) delete map[c.name];
        else map[c.name] = c;
      });
      jar = [];
      Object.keys(map).forEach(function (k) { jar.push(map[k]); });
      up({ type: 'cookies', cookies: jar });
    } catch (e) { /* ignore */ }
  }

  function seedDocumentCookies() {
    if (SD) return; /* sandbox: cookies live in the memory jar only */
    jar.forEach(function (c) {
      try {
        document.cookie = c.name + '=' + c.value + '; path=/; Max-Age=31536000; Secure; SameSite=None; Partitioned';
      } catch (e) { /* ignore */ }
    });
  }

  /* ---------- document.cookie shim (sandbox mode) --------------------
   * In a null-origin srcdoc frame real cookie writes go nowhere (and
   * reads can throw on some engines). The instance property is
   * shadowed with an in-memory jar view: reads join the jar, writes
   * merge into it and are echoed to the shell so the session survives
   * the next srcdoc swap. Cookie-header replay to the worker rides on
   * the x-cookie header the wrappers already set. */
  try {
    if (SD) {
      Object.defineProperty(document, 'cookie', {
        get: function () { return docCookies().join('; '); },
        set: function (str) {
          try {
            var bits = String(str).split(';');
            var nv = bits[0];
            var eq = nv.indexOf('=');
            if (eq >= 0) {
              var name = nv.slice(0, eq).trim();
              var value = nv.slice(eq + 1).trim();
              var del = false;
              for (var i = 1; i < bits.length; i++) {
                var b = bits[i].trim().toLowerCase();
                if (b === 'max-age=0' || b.indexOf('expires=thu, 01 jan 1970') === 0) del = true;
              }
              if (name) {
                var found = false;
                for (var j = 0; j < jar.length; j++) {
                  if (jar[j].name === name) { found = true; if (del) { jar.splice(j, 1); } else { jar[j].value = value; } break; }
                }
                if (!found && !del) jar.push({ name: name, value: value });
                up({ type: 'cookies', cookies: jar });
              }
            }
          } catch (eC) { /* ignore */ }
        },
        configurable: true
      });
    }
  } catch (eCookieShim) { /* ignore */ }

  /* ---------- header injection ---------- */
  function applyHeaders(h) {
    try {
      /* ALWAYS refresh x-cookie with the current jar — it is this
       * runtime's own header (no site code sets it), so overwriting
       * it is always safe and always freshest. */
      var ch = cookieHeader();
      if (ch) h.set('x-cookie', ch);
      else { try { h.delete('x-cookie'); } catch (eDel) { /* ignore */ } }
      if (TOKEN && !h.has('x-proxy-token')) h.set('x-proxy-token', TOKEN);
    } catch (e) { /* ignore */ }
    return h;
  }

  /* ---------- fetch ---------- */
  var _fetch = window.fetch ? window.fetch.bind(window) : null;
  if (_fetch) {
    window.fetch = function (input, init) {
      try {
        if (input && typeof input === 'object' && typeof input.url === 'string' && input.constructor && input.constructor.name === 'Request') {
          var mapped = mapUrl(input.url);
          if (mapped !== input.url) {
            try { input = new Request(absW(mapped), input); } catch (e2) { /* keep original */ }
          }
          /* a Request OBJECT built with credentials:'include' is the one
           * fragile-webview path the init-form strip below can never
           * reach (its credentials live inside the object). In sandbox
           * mode rebuild it omit-mode — cookies ride on x-cookie. */
          if (SD) {
            try {
              var R0 = (input && typeof input === 'object' && typeof input.url === 'string') ? input : null;
              if (R0 && R0.credentials === 'include') {
                var iOpt = { method: R0.method, headers: R0.headers, credentials: 'omit',
                  cache: R0.cache, redirect: R0.redirect, referrer: R0.referrer, integrity: R0.integrity };
                if (R0.method !== 'GET' && R0.method !== 'HEAD') { iOpt.body = R0.body; iOpt.duplex = 'half'; }
                input = new Request(R0.url, iOpt);
              }
            } catch (eCR) { /* keep the include-mode request */ }
          }
        } else if (typeof input === 'string' || input instanceof URL) {
          var u2 = mapUrl(String(input));
          if (u2 !== String(input)) input = absW(u2);
        }
        init = init || {};
        /* in sandbox mode (null-origin srcdoc) credentialed fetches are
         * the fragile path — some mobile browsers and viewer-app webviews
         * refuse them outright. The session already rides on the x-cookie
         * header this wrapper sets, so 'include' adds nothing here. */
        if (SD && init.credentials === 'include') {
          try { init.credentials = 'omit'; } catch (eC1) { /* keep */ }
        }
        var H;
        try {
          if (init.headers) {
            H = (init.headers instanceof Headers) ? init.headers : new Headers(init.headers);
          } else if (input && typeof input === 'object' && typeof input.headers !== 'undefined') {
            /* a fetch(Request) call: setting init.headers below would
             * REPLACE the Request's own headers per spec, silently
             * dropping the app's Authorization. Merge instead. */
            H = new Headers();
            try { input.headers.forEach(function (v, k) { H.set(k, v); }); } catch (eIH) { /* ignore */ }
          } else { H = new Headers(); }
        } catch (e3) { H = new Headers(); }
        init.headers = applyHeaders(H);
        var iu = '';
        try { iu = (typeof input === 'string') ? input : (input && typeof input.url === 'string') ? input.url : ''; } catch (eIU) { iu = ''; }
        var meth = 'GET';
        try { meth = (init && init.method) || (input && input.method) || 'GET'; } catch (eM) { meth = 'GET'; }
        var isApiGet = /^GET$/i.test(meth) && /\\/api\\//.test(String(iu));
        var iR0 = init; /* the retry snapshot: init is final by this point */
        var p = _fetch(input, init);
        /* network-level retry for first-boot GET api calls. On a fresh
         * sandbox boot the app's api fetches queue behind resource
         * loads on a null-origin context and occasionally die at the
         * network level - and the app CACHES those rejected promises.
         * One delayed GET-only retry before the rejection is allowed. */
        var pr = p.then(function (r) {
          try { ingestSetCookie(r.headers && r.headers.get('x-set-cookie')); } catch (e4) { /* ignore */ }
          return r;
        }, function (err) {
          /* network-level failure: one delayed retry for GET api calls */
          try {
            if (SD && isApiGet && !init.__mpR) {
              return new Promise(function (res2, rej2) {
                setTimeout(function () {
                  var i3 = {};
                  for (var k3 in iR0) { try { i3[k3] = iR0[k3]; } catch (eK3) { /* ignore */ } }
                  var H3 = new Headers(i3.headers || {});
                  var ch3 = cookieHeader();
                  if (ch3) H3.set('x-cookie', ch3);
                  i3.headers = H3;
                  i3.__mpR = 1;
                  _fetch(iu, i3).then(res2, rej2);
                }, 350);
              });
            }
          } catch (eNet) { /* ignore */ }
          throw err;
        });
        return pr;
      } catch (e) {
        return _fetch(input, init);
      }
    };
  }

  /* ---------- XMLHttpRequest ---------- */
  try {
    var _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        var mu = mapUrl(String(url));
        if (mu !== String(url)) {
          mu = absW(mu);
          if (arguments.length > 2) {
            arguments[1] = mu;
            return _open.apply(this, arguments);
          }
          return _open.call(this, method, mu);
        }
      } catch (e) { /* ignore */ }
      return _open.apply(this, arguments);
    };
    var _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      try {
        /* same reasoning as the fetch wrapper — in sandbox mode
         * withCredentials buys nothing (cookies ride on x-cookie) and
         * trips credentialed-CORS rules on fragile webviews. */
        if (SD) { try { this.withCredentials = false; } catch (eWC) { /* keep */ } }
        var ch = cookieHeader();
        if (ch) this.setRequestHeader('x-cookie', ch);
        if (TOKEN) this.setRequestHeader('x-proxy-token', TOKEN);
      } catch (e) { /* ignore */ }
      var xhr = this;
      try {
        xhr.addEventListener('loadend', function () {
          try { ingestSetCookie(xhr.getResponseHeader && xhr.getResponseHeader('x-set-cookie')); } catch (e2) { /* ignore */ }
        });
      } catch (e3) { /* ignore */ }
      return _send.apply(this, arguments);
    };
  } catch (e) { /* ignore */ }

  /* ---------- EventSource ---------- */
  try {
    if (window.EventSource) {
      var _ES = window.EventSource;
      window.EventSource = function (url, cfg) {
        try {
          var mu = absW(mapUrl(String(url)));
          /* EventSource cannot set headers — carry the token in the query */
          if (TOKEN && mu !== String(url) && String(mu).indexOf('__t=') < 0) {
            mu += (mu.indexOf('?') < 0 ? '?' : '&') + '__t=' + encodeURIComponent(TOKEN);
          }
          url = mu;
        } catch (e) { /* ignore */ }
        return new _ES(url, cfg);
      };
      window.EventSource.prototype = _ES.prototype;
    }
  } catch (e) { /* ignore */ }

  /* ---------- WebSocket ---------- */
  try {
    if (window.WebSocket) {
      var _WS = window.WebSocket;
      window.WebSocket = function (url, protocols) {
        try {
          var s = String(url);
          var m = s.match(/^(wss?):\\/\\/([^\\/?#]+)(\\/.*)?$/i);
          if (m) {
            var host = m[2].toLowerCase();
            var scheme = m[1].toLowerCase() === 'ws' ? 'ws' : 'wss';
            if (allowedHost(host)) {
              var rest = m[3] || '/';
              var path;
              if (host === HOST && !TOK) {
                path = PFX + rest; // app host: the worker root IS the ws endpoint
              } else {
                var wtok = encTok(s); // the whole original ws:// URL in one opaque token
                path = wtok ? '/__t/' + wtok : '/p/' + host + rest; // keyless legacy fallback
              }
              if (TOKEN && path.indexOf('__t=') < 0) {
                path += (path.indexOf('?') < 0 ? '?' : '&') + '__t=' + encodeURIComponent(TOKEN);
              }
              /* sandbox: location.host is EMPTY at about:srcdoc — the
               * worker origin comes from cfg instead. */
              var wOrigin = (SD && WORKER) ? WORKER : (location.protocol + '//' + location.host);
              url = (wOrigin.indexOf('https:') === 0 ? 'wss' : scheme) + '://' + wOrigin.replace(/^https?:\\/\\/i/, '') + path;
            }
          }
        } catch (e) { /* ignore */ }
        return protocols === undefined ? new _WS(url) : new _WS(url, protocols);
      };
      window.WebSocket.prototype = _WS.prototype;
      window.WebSocket.CONNECTING = _WS.CONNECTING;
      window.WebSocket.OPEN = _WS.OPEN;
      window.WebSocket.CLOSING = _WS.CLOSING;
      window.WebSocket.CLOSED = _WS.CLOSED;
    }
  } catch (e) { /* ignore */ }

  /* ---------- sendBeacon ---------- */
  try {
    if (navigator.sendBeacon) {
      var _sb = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function (url, data) {
        try {
          var mu = absW(mapUrl(String(url)));
          if (mu !== String(url)) {
            // beacons cannot carry custom headers; fall back to keepalive fetch
            return _fetch(mu, { method: 'POST', body: data, keepalive: true, mode: 'no-cors' }) ? true : true;
          }
        } catch (e) { /* ignore */ }
        return _sb(url, data);
      };
    }
  } catch (e) { /* ignore */ }

  /* ---------- navigation reporting ---------- */
  function curUrl() {
    if (SD) return DOC || 'about:srcdoc'; /* the shell wants the real upstream URL */
    return location.pathname + location.search + location.hash;
  }
  function reportNav() { up({ type: 'nav', url: curUrl(), title: document.title || '' }); }

  try {
    var _push = history.pushState;
    var _replace = history.replaceState;
    // SPA history entries must stay inside the proxy prefix.
    function fixHistUrl(u) {
      try {
        var s = String(u);
        if (!s || s.charAt(0) === '#') return s;
        var org = originStr();
        if (org && (s === org || s.indexOf(org + '/') === 0)) {
          var p = s.slice(org.length) || '/';
          if (isProxyPath(p)) return p;
          return PFX + p;
        }
        var mapped = mapUrl(s);
        if (/^(https?:)?\\/\\//i.test(mapped)) return curUrl(); // cross-origin -> would throw
        return mapped;
      } catch (e) { return u; }
    }
    history.pushState = function () {
      if (SD) {
        /* sandbox: native pushState throws SecurityError (the URL is
         * cross-origin to about:srcdoc) and would kill the SPA. Treat it
         * as a SOFT transition: tell the shell the new URL (worker path +
         * upstream URL). ALSO advance the fake location — routers re-read
         * window.location.pathname to re-resolve routes after SPA
         * transitions — and park the caller's state object on
         * __histState so history.state reads back like the real thing. */
        try {
          __histState = (arguments.length > 0) ? arguments[0] : undefined;
          var su = (arguments.length > 2 && arguments[2] != null) ? String(arguments[2]) : '';
          if (su && su.charAt(0) !== '#') {
            var sAbs = '';
            try { sAbs = new URL(su, LOC.u || DOC || 'about:srcdoc').href; } catch (eA) { sAbs = su; }
            setLoc(sAbs);
            up({ type: 'hist', url: mapUrl(sAbs), up: sAbs });
          } else if (su && su.charAt(0) === '#') {
            /* hash-only push: the path stays, the hash moves */
            try { setLoc(String(LOC.u ? LOC.u.href : (DOC || '/')).replace(/#.*$/, '') + su); } catch (eHh) { /* ignore */ }
          }
        } catch (eH) { /* ignore */ }
        reportNav();
        return undefined;
      }
      try { if (arguments.length > 2 && arguments[2] != null) arguments[2] = fixHistUrl(arguments[2]); } catch (e2) { /* ignore */ }
      var r = _push.apply(this, arguments); reportNav(); return r;
    };
    history.replaceState = function () {
      if (SD) {
        try {
          __histState = (arguments.length > 0) ? arguments[0] : undefined;
          var ru = (arguments.length > 2 && arguments[2] != null) ? String(arguments[2]) : '';
          if (ru && ru.charAt(0) !== '#') {
            var rAbs = '';
            try { rAbs = new URL(ru, LOC.u || DOC || 'about:srcdoc').href; } catch (eB) { rAbs = ru; }
            setLoc(rAbs);
            up({ type: 'hist', url: mapUrl(rAbs), up: rAbs, replace: true });
          } else if (ru && ru.charAt(0) === '#') {
            try { setLoc(String(LOC.u ? LOC.u.href : (DOC || '/')).replace(/#.*$/, '') + ru); } catch (eRh) { /* ignore */ }
          }
        } catch (eH2) { /* ignore */ }
        reportNav();
        return undefined;
      }
      try { if (arguments.length > 2 && arguments[2] != null) arguments[2] = fixHistUrl(arguments[2]); } catch (e2) { /* ignore */ }
      var r = _replace.apply(this, arguments); reportNav(); return r;
    };
    window.addEventListener('popstate', reportNav);
    window.addEventListener('hashchange', reportNav);
    window.addEventListener('pageshow', reportNav);
  } catch (e) { /* ignore */ }

  /* ---------- Navigation API interception (Chrome/Edge) ----------
   * catches location.href=..., form submits, link clicks — anything
   * that would navigate this frame to an absolute or external URL.
   * sandbox: EVERY navigation is intercepted — the frame must never
   * go anywhere; the shell re-renders a fresh srcdoc instead. */
  try {
    if (window.navigation && window.navigation.addEventListener) {
      window.navigation.addEventListener('navigate', function (e) {
        try {
          if (!e.destination || e.destination.sameDocument) return;
          var dest = String(e.destination.url || '');
          if (!dest) return;
          if (SD) {
            /* canIntercept is false for cross-origin destinations, but
             * preventDefault still works there - only intercept() would
             * not - so the gate is dropped in sandbox mode: EVERY
             * navigation must be stopped, the shell re-renders instead. */
            try { e.preventDefault(); } catch (ePV) { /* ignore */ }
            if (isWorkerUrl(dest)) { nav(dest); return; } /* already proxied */
            if (/^https?:\\/\\//i.test(dest) && !allowedHost((dest.match(/^https?:\\/\\/([^\\/?#]+)/i) || [])[1])) {
              up({ type: 'ext', url: dest });
              pageToast('Blocked (outside the proxy): ' + dest);
              return;
            }
            nav(dest);
            return;
          }
          if (!e.canIntercept) return;
          var org = originStr();
          if (org && (dest === org || dest.indexOf(org + '/') === 0)) {
            var p = dest.slice(org.length) || '/';
            if (isProxyPath(p)) return;
            e.preventDefault();
            location.href = PFX + p;
            return;
          }
          var mapped = mapUrl(dest);
          if (mapped !== dest) {
            // Monochrome-family absolute URL -> swap for the proxied path
            e.preventDefault();
            location.href = mapped;
            return;
          }
          if (/^https?:\\/\\//i.test(dest) || /^\\/\\//.test(dest)) {
            // external site — the phone will block it anyway; tell the user
            e.preventDefault();
            up({ type: 'ext', url: dest });
            pageToast('Blocked (outside the proxy): ' + dest);
          }
          // relative destinations proceed natively
        } catch (err) { /* ignore */ }
      });
    }
  } catch (e) { /* ignore */ }

  /* ---------- window.open ---------- */
  function stubWindow() {
    return {
      closed: false,
      close: function () { this.closed = true; },
      focus: function () {}, blur: function () {},
      postMessage: function () {},
      location: { href: 'about:blank', replace: function () {}, assign: function () {} },
      document: { write: function () {}, open: function () {}, close: function () {}, createElement: function () { return { setAttribute: function () {}, appendChild: function () {} }; } }
    };
  }
  window.open = function (url) {
    try {
      var u = url == null ? '' : String(url);
      if (!u || u === 'about:blank') return stubWindow();
      if (SD) {
        /* no popups from the sandbox — in-app navigation or the
         * external notice, never a real window. */
        if (isWorkerUrl(u)) { nav(u); return stubWindow(); }
        if (/^https?:\\/\\//i.test(u) && !allowedHost((u.match(/^https?:\\/\\/([^\\/?#]+)/i) || [])[1])) {
          up({ type: 'ext', url: u });
          pageToast('Blocked (outside the proxy): ' + u);
          return stubWindow();
        }
        nav(u);
        return stubWindow();
      }
      var mapped = mapUrl(u);
      if (mapped !== u) { location.href = mapped; return stubWindow(); }
      if (/^(https?:)?\\/\\//i.test(u)) { up({ type: 'ext', url: u }); pageToast('Blocked (outside the proxy): ' + u); return stubWindow(); }
      location.href = u;
      return stubWindow();
    } catch (e) { return stubWindow(); }
  };

  /* ---------- the download bridge ------------------------------------
   * An <a download> click inside the locked sandbox can never rely on
   * the frame's own download plumbing - mobile webviews and null-origin
   * iframes kill it, and the app then reports "Download failed". So
   * the click is swallowed here, the bytes are fetched THROUGH the
   * relay (the jar rides exactly like on every other call), and the
   * finished Blob is handed to the pocket shell, which saves it from
   * the file:// page with the phone's native save flow. Covers blob:,
   * data: and any relay-mappable http(s) destination; a plain
   * navigation that answers content-disposition: attachment is caught
   * by the shell's loader sniff instead. */
  function dlNameFrom(u, mime) {
    try {
      var s = String(u || '');
      var m = s.match(/[/?#]([^/?#]+)(?:[?#].*)?$/);
      var n = m ? m[1] : '';
      try { n = decodeURIComponent(n); } catch (eDC) { /* keep raw */ }
      if (n && /\\.[a-z0-9]{1,8}$/i.test(n)) return n;
      var ext = (String(mime || '').split('/')[1] || '').split(';')[0];
      return (n || 'download') + (ext ? '.' + ext : '');
    } catch (e) { return 'download'; }
  }
  function bridgeDownload(href, name) {
    var url = String(href || '');
    var nm = String(name || '').trim();
    if (nm === 'true' || nm === 'false') nm = '';
    var dest = url;
    try { if (!/^(data|blob):/i.test(url)) dest = mapUrl(url); } catch (eM) { dest = url; }
    up({ type: 'dlbegin', name: nm || dlNameFrom(url, '') });
    try {
      window.fetch(dest).then(function (r) {
        if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status));
        var cdf = '';
        try {
          var cd = r.headers.get('content-disposition') || '';
          var mm = cd.match(/filename[*]?=((?:"([^"]+)")|([^;\\s]+))/i) || [];
          cdf = (mm[2] || mm[3] || '').replace(/^UTF-8''/i, '');
          try { cdf = decodeURIComponent(cdf); } catch (eD2) { /* keep raw */ }
        } catch (eH) { /* ignore */ }
        return r.blob().then(function (b) {
          up({ type: 'dl', name: nm || cdf || dlNameFrom(url, b.type), mime: b.type || '', blob: b });
        });
      }, function (eN) {
        up({ type: 'dlerr', name: nm || dlNameFrom(url, ''), why: 'the relay did not answer' });
      }).catch(function (eC) {
        up({ type: 'dlerr', name: nm || dlNameFrom(url, ''), why: String((eC && eC.message) || eC).slice(0, 80) });
      });
    } catch (eS) {
      up({ type: 'dlerr', name: nm || 'download', why: 'blocked before it started' });
    }
  }
  if (SD) {
    /* capture-phase download tap - registered BEFORE the nav capture
     * below so an <a download> never becomes a sandbox navigation. */
    document.addEventListener('click', function (e) {
      try {
        if (e.button !== undefined && e.button !== 0) return;
        var t = e.target;
        var a = t && t.closest ? t.closest('a[download]') : null;
        if (!a) return;
        var href = a.getAttribute('href') || '';
        if (!href || href.charAt(0) === '#' || /^javascript:/i.test(href)) return;
        e.preventDefault();
        e.stopPropagation();
        try { e.stopImmediatePropagation(); } catch (eSI) { /* ignore */ }
        bridgeDownload(href, a.getAttribute('download') || '');
      } catch (eDL) { /* the bridge must never break a click */ }
    }, true);
  }

  /* ---------- click / submit capture (fallback layer) ---------- */
  document.addEventListener('click', function (e) {
    try {
      if (e.defaultPrevented || (e.button !== undefined && e.button !== 0)) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var el = e.target;
      var a = el && el.closest ? el.closest('a[' + 'href]') : null;
      if (!a) return;
      var href = a.getAttribute('href') || '';
      if (!href || href.charAt(0) === '#' || /^(data|blob|javascript|mailto|tel):/i.test(href)) return;
      var target = (a.target || '').toLowerCase();
      if (SD) {
        /* sandbox: the APP's own router owns same-app links now — its
         * delegated body listener compares the anchor origin with
         * location.origin (the anchor shim makes both read as the
         * upstream origin) and turns clicks into SPA transitions
         * through the pushState shim. Same-app clicks are NOT
         * intercepted here; anything the router declines falls through
         * to a native navigation, which the Navigation-API watcher
         * converts into a shell re-render. Only shapes that would
         * break the sandbox outright are stopped in this layer. */
        var mHost = (href.match(/^https?:\\/\\/([^\\/?#]+)/i) || [])[1];
        if (mHost && isWorkerUrl(href)) {
          /* the worker rewrites the app's OWN links into absolute
           * worker URLs (/__o/… tokens) — the sidebar, the cards and
           * the settings links all arrive in this shape. Those are SPA
           * routes, not external sites: the app router owns them
           * exactly like the relative form, and flagging them
           * "outside" was a false alarm that complained at the bottom
           * of the page while the app still loaded fine. */
          return;
        }
        if (mHost && !allowedHost(mHost)) {
          /* external site — never leaves the sandbox */
          e.preventDefault();
          up({ type: 'ext', url: href });
          pageToast('Blocked (outside the proxy): ' + href);
          return;
        }
        if (target === '_top' || target === '_parent' || target === '_blank') {
          /* popups are impossible without allow-popups — open in-frame */
          e.preventDefault();
          nav(href);
          return;
        }
        /* allowlisted / worker / relative hrefs: the app's router has
         * the click; the nav-API watcher is the safety net */
        return;
      }
      var mapped = mapUrl(href);
      if (mapped !== href) {
        if (target === '_top' || target === '_parent' || target === '_blank') {
          e.preventDefault();
          location.href = mapped;
        } else {
          a.setAttribute('href', mapped); // let native navigation use the proxied href
        }
        return;
      }
      if (/^(https?:)?\\/\\//i.test(href)) {
        e.preventDefault();
        up({ type: 'ext', url: href });
        pageToast('Blocked (outside the proxy): ' + href);
        return;
      }
      if (target === '_top' || target === '_parent') {
        e.preventDefault();
        location.href = href;
      }
    } catch (err) { /* ignore */ }
  }, true);

  /* ---------- form serialization (sandbox submits) ---------------------
   * A form submit must become a POST navigation the SHELL performs via
   * fetch(): method + enctype + all successful controls. Multipart
   * forms ship the FormData object itself (postMessage structured-clones
   * it); urlencoded forms ship a plain string. */
  function serializeForm(f) {
    var enctype = (f.getAttribute('enctype') || 'application/x-www-form-urlencoded').toLowerCase();
    var method = (f.getAttribute('method') || 'GET').toUpperCase();
    if (enctype.indexOf('multipart') >= 0) {
      try {
        var fd = new FormData(f);
        return { method: method === 'GET' ? 'POST' : method, body: fd, ct: null };
      } catch (eFD) { /* fall through to urlencoded */ }
    }
    var parts = [];
    try {
      var els = f.elements;
      for (var i = 0; i < els.length; i++) {
        var fe = els[i];
        if (!fe.name || fe.disabled) continue;
        var ft = (fe.type || '').toLowerCase();
        if (ft === 'checkbox' || ft === 'radio') { if (fe.checked) parts.push([fe.name, fe.value || '']); continue; }
        if (ft === 'file') {
          try {
            if (fe.files && fe.files[0]) parts.push([fe.name, fe.files[0].name]);
          } catch (eF) { /* ignore */ }
          continue;
        }
        if (ft === 'submit' || ft === 'button' || ft === 'image' || ft === 'reset') continue;
        if (fe.tagName === 'SELECT') {
          var opts = fe.selectedOptions || [];
          for (var oi = 0; oi < opts.length; oi++) parts.push([fe.name, opts[oi].value || '']);
          continue;
        }
        parts.push([fe.name, fe.value || '']);
      }
    } catch (eE) { /* ignore */ }
    /* the submit button that fired (name+value) is not in elements' values */
    try {
      if (f.__mpSubBtn && f.__mpSubBtn.name) parts.push([f.__mpSubBtn.name, f.__mpSubBtn.value || '']);
    } catch (eS) { /* ignore */ }
    var qs = parts.map(function (p) { return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1] || ''); }).join('&');
    var ct = enctype.indexOf('text/plain') >= 0 ? 'text/plain' : 'application/x-www-form-urlencoded';
    return { method: method, body: qs, ct: ct };
  }
  try {
    if (SD) {
      /* remember the submit button that fired (its name/value is part of
       * the successful controls set per HTML spec) */
      document.addEventListener('click', function (e) {
        try {
          var b = e.target && e.target.closest ? e.target.closest('button, input[type=submit], input[type=image]') : null;
          if (b && b.form) b.form.__mpSubBtn = b;
        } catch (eB) { /* ignore */ }
      }, true);
      document.addEventListener('submit', function (e) {
        try {
          var f = e.target;
          if (!f || !f.getAttribute) return;
          /* ALWAYS preventDefault: a native submission would navigate
           * the sandbox frame. */
          e.preventDefault();
          var action = f.getAttribute('action') || '';
          /* SPA-managed forms (NO action attribute — the app's own
           * onsubmit handler owns the submit: search boxes, fetch-based
           * logins) must be LEFT ALONE. Only forms that actually target
           * a server endpoint (a real action) become shell navigations. */
          if (!action || action === '#' || action.charAt(0) === '#' || /^javascript:/i.test(action)) return;
          var dest = action;
          if (isWorkerUrl(dest)) {
            /* the action was already rewritten to the worker origin —
             * navigate straight to it (the shell strips the origin) */
            var serW = serializeForm(f);
            if ((serW.method || 'GET') === 'GET') {
              var baseW = dest.split('#')[0].split('?')[0];
              nav(baseW + (serW.body ? '?' + serW.body : ''));
            } else {
              nav(dest, serW.method, serW.body, serW.ct);
            }
            return;
          }
          if (/^https?:\\/\\//i.test(dest) && !allowedHost((dest.match(/^https?:\\/\\/([^\\/?#]+)/i) || [])[1])) {
            up({ type: 'ext', url: dest });
            return;
          }
          var ser = serializeForm(f);
          if ((ser.method || 'GET') === 'GET') {
            /* GET forms: the body becomes the destination query */
            var base = dest.split('#')[0].split('?')[0];
            dest = base + (ser.body ? '?' + ser.body : '');
            nav(dest);
          } else {
            nav(dest, ser.method, ser.body, ser.ct);
          }
        } catch (errS) { /* ignore */ }
      }, true);
    }
  } catch (eSubArm) { /* ignore */ }

  document.addEventListener('submit', function (e) {
    try {
      if (SD) return; /* handled by the sandbox submit arm above */
      var f = e.target;
      if (!f || !f.getAttribute) return;
      var action = f.getAttribute('action') || '';
      if (action) {
        var mapped = mapUrl(action);
        if (mapped !== action) f.setAttribute('action', mapped);
      }
      var target = (f.target || '').toLowerCase();
      if (target === '_top' || target === '_parent' || target === '_blank') {
        e.preventDefault();
        var dest = f.getAttribute('action') || curUrl();
        if (/^(https?:)?\\/\\//i.test(dest) && mapUrl(dest) === dest) { up({ type: 'ext', url: dest }); return; }
        location.href = dest;
      }
    } catch (err) { /* ignore */ }
  }, true);

  /* ---------- service worker: never register ----------
   * a SW would bypass every patch we installed. In the sandbox the
   * navigator.serviceWorker PROPERTY itself throws SecurityError on
   * access (opaque origin) — so the whole getter is stubbed first. */
  try {
    var SW_STUB = {
      register: function () { return Promise.resolve({ scope: '/', active: null, installing: null, waiting: null, unregister: function () { return Promise.resolve(true); }, addEventListener: function () {}, state: 'activated' }); },
      getRegistration: function () { return Promise.resolve(undefined); },
      getRegistrations: function () { return Promise.resolve([]); },
      addEventListener: function () {},
      removeEventListener: function () {},
      ready: new Promise(function () {}),
      controller: null
    };
    if (SD) {
      try {
        Object.defineProperty(Navigator.prototype, 'serviceWorker', { configurable: true, get: function () { return SW_STUB; } });
      } catch (eSWP) {
        try { Object.defineProperty(navigator, 'serviceWorker', { configurable: true, get: function () { return SW_STUB; } }); } catch (eSWI) { /* ignore */ }
      }
    } else if (navigator.serviceWorker && navigator.serviceWorker.register) {
      navigator.serviceWorker.register = SW_STUB.register;
    }
  } catch (e) { /* ignore */ }

  /* ---------- dynamic subresource rewriting ----------
   * The SPA builds absolute URLs at runtime for images, scripts,
   * stylesheets and downloads (album art on resources.tidal.com,
   * tracks on tracks.monochrome.st). Those would leave the proxy and
   * die on a network that can only reach the worker. Rewrite them as
   * they are inserted — hosts that are not allowlisted are left
   * untouched.
   */
  var RES_ATTRS = { IMG: ['src', 'srcset'], SCRIPT: ['src'], LINK: ['href'], SOURCE: ['src', 'srcset'], AUDIO: ['src', 'poster'], VIDEO: ['src', 'poster'], IFRAME: ['src'], OBJECT: ['data'], EMBED: ['src'], IMAGE: ['href'] };
  function fixEl(el) {
    try {
      if (!el || !el.tagName || !el.getAttribute || !el.setAttribute) return;
      var attrs = RES_ATTRS[el.tagName.toUpperCase()];
      if (!attrs) return;
      for (var i = 0; i < attrs.length; i++) {
        var a = attrs[i];
        var v = el.getAttribute(a);
        if (!v) continue;
        var nv = mapUrl(v);
        if (nv !== v) el.setAttribute(a, nv);
      }
    } catch (e) { /* ignore */ }
  }
  function scanTree(node) {
    try {
      if (!node || node.nodeType !== 1) return;
      fixEl(node);
      if (node.tagName && node.tagName.toUpperCase() === 'STYLE') {
        try {
          var st = node.textContent;
          if (st) {
            var nst = mapCssUrls(st);
            if (nst !== st) node.textContent = nst;
          }
        } catch (e2) { /* ignore */ }
      }
      if (node.querySelectorAll) {
        var els = node.querySelectorAll('img,script,link,source,audio,video,iframe,object,embed,image,style');
        for (var i = 0; i < els.length; i++) {
          fixEl(els[i]);
          if (els[i].tagName && els[i].tagName.toUpperCase() === 'STYLE') {
            try {
              var st2 = els[i].textContent;
              if (st2) {
                var nst2 = mapCssUrls(st2);
                if (nst2 !== st2) els[i].textContent = nst2;
              }
            } catch (e3) { /* ignore */ }
          }
        }
      }
    } catch (e) { /* ignore */ }
  }
  try {
    if (window.MutationObserver && document.documentElement) {
      var mo = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var m = muts[i];
          if (m.type === 'attributes') { fixEl(m.target); continue; }
          if (m.type === 'characterData') {
            /* text data changed inside a <style> (appendData/insertData) */
            try {
              var pn = m.target && m.target.parentNode;
              if (pn && pn.tagName === 'STYLE') {
                var ts2 = pn.textContent;
                if (ts2) {
                  var mts2 = mapCssUrls(ts2);
                  if (mts2 !== ts2) pn.textContent = mts2;
                }
              }
            } catch (e6) { /* ignore */ }
            continue;
          }
          for (var j = 0; j < m.addedNodes.length; j++) {
            var an = m.addedNodes[j];
            if (an.nodeType === 3 && m.target && m.target.tagName === 'STYLE') {
              /* a raw text node was appended into a <style> */
              try {
                var ts = m.target.textContent;
                if (ts) {
                  var mts = mapCssUrls(ts);
                  if (mts !== ts) m.target.textContent = mts;
                }
              } catch (e5) { /* ignore */ }
            } else {
              scanTree(an);
            }
          }
        }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['src', 'href', 'srcset', 'poster', 'data'] });
    }
  } catch (e) { /* ignore */ }

  /* Detached elements bypass the observer: the app sets img.src (or
   * setAttribute) without ever entering the DOM. Patch the property
   * setter and setAttribute so those URLs are mapped onto the worker
   * as well. */
  try {
    var imgProto = window.HTMLImageElement && window.HTMLImageElement.prototype;
    var srcDesc = imgProto && Object.getOwnPropertyDescriptor(imgProto, 'src');
    if (srcDesc && srcDesc.set) {
      Object.defineProperty(imgProto, 'src', {
        get: function () { return srcDesc.get.call(this); },
        set: function (v) {
          try {
            var mu = mapUrl(String(v));
            if (mu !== String(v)) v = mu;
          } catch (e) { /* ignore */ }
          return srcDesc.set.call(this, v);
        },
        configurable: true,
        enumerable: srcDesc.enumerable
      });
    }
  } catch (e) { /* ignore */ }

  try {
    var _setattr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      try {
        var n = String(name).toLowerCase();
        if ((n === 'src' || n === 'href' || n === 'srcset' || n === 'poster' || n === 'data') &&
            typeof value === 'string' && this && this.tagName) {
          var attrs = RES_ATTRS[this.tagName.toUpperCase()];
          if (attrs && attrs.indexOf(n) >= 0) {
            var mu = mapUrl(value);
            if (mu !== value) value = mu;
          }
        }
      } catch (e) { /* ignore */ }
      return _setattr.call(this, name, value);
    };
  } catch (e) { /* ignore */ }

  /* ---------- property-setter + CSSOM coverage (leak hardening) ----
   * Frameworks assign .src/.href as PROPERTIES (bypassing setAttribute)
   * and paint backgrounds through the CSSOM (bypassing the style
   * attribute). Wrap the setters so mapUrl still catches them. */
  function wrapProp(proto, prop, cssMode) {
    try {
      var d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.set) return;
      Object.defineProperty(proto, prop, {
        get: d.get,
        set: function (v) {
          try {
            if (typeof v === 'string') {
              var nv = cssMode ? (v.indexOf('url(') >= 0 ? mapCssUrls(v) : v) : mapUrl(v);
              if (nv !== v) v = nv;
            }
          } catch (e) { /* ignore */ }
          return d.set.call(this, v);
        },
        configurable: true,
        enumerable: d.enumerable
      });
    } catch (e) { /* ignore */ }
  }
  try {
    if (window.HTMLMediaElement) wrapProp(HTMLMediaElement.prototype, 'src');
    if (window.HTMLScriptElement) wrapProp(HTMLScriptElement.prototype, 'src');
    if (window.HTMLLinkElement) wrapProp(HTMLLinkElement.prototype, 'href');
    if (window.HTMLIFrameElement) wrapProp(HTMLIFrameElement.prototype, 'src');
  } catch (e) { /* ignore */ }

  /* CSSOM writes: style.setProperty('background', 'url(https://...)) and
   * the background-family property setters must map their url()s too.
   * Also maps @import "..." strings and is reused for every CSS-TEXT
   * injection channel (style textContent, insertRule, replaceSync) —
   * CSS fetched at runtime and re-injected as text would otherwise send
   * the browser straight to the upstream host. */
  function mapCssUrls(val) {
    try {
      var s = String(val);
      if (!/url\\(|@import/i.test(s)) return s;
      s = s.replace(/url\\(\\s*(['\"]?)([^'\")]+)\\1\\s*\\)/gi, function (w, q, u) {
        var nu = mapUrl(u);
        return nu === u ? w : 'url("' + nu + '")';
      });
      s = s.replace(/@import\\s*(['\"])([^'\"]+)\\1/gi, function (w, q, u) {
        /* minified css ships @import"https://..." with no space */
        var nu = mapUrl(u);
        return nu === u ? w : '@import ' + q + nu + q;
      });
      return s;
    } catch (e) { return val; }
  }
  try {
    var _sp = CSSStyleDeclaration.prototype.setProperty;
    if (_sp) {
      CSSStyleDeclaration.prototype.setProperty = function (name, value, pri) {
        try {
          if (typeof value === 'string' && value.indexOf('url(') >= 0) value = mapCssUrls(value);
        } catch (e) { /* ignore */ }
        return _sp.call(this, name, value, pri);
      };
    }
  } catch (e) { /* ignore */ }
  try {
    if (window.CSSStyleDeclaration) {
      ['background', 'backgroundImage', 'content', 'maskImage', 'listStyleImage', 'borderImage'].forEach(function (prop) {
        wrapProp(CSSStyleDeclaration.prototype, prop, true);
      });
    }
  } catch (e) { /* ignore */ }

  /* CSS TEXT injection channels — anything that hands raw CSS text to
   * the CSS engine at runtime: styleEl.textContent = '...', 
   * sheet.insertRule('...'), sheet.replaceSync('...') / replace('...'),
   * <style> nodes arriving through the MutationObserver. Every
   * url()/@import inside that text is mapped BEFORE the CSS engine
   * ever sees it. */
  try {
    var _tcDesc = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
    if (_tcDesc && _tcDesc.set) {
      Object.defineProperty(Node.prototype, 'textContent', {
        get: _tcDesc.get,
        set: function (v) {
          try {
            if (this && this.tagName === 'STYLE' && typeof v === 'string') {
              var nv = mapCssUrls(v);
              if (nv !== v) v = nv;
            }
          } catch (e) { /* ignore */ }
          return _tcDesc.set.call(this, v);
        },
        configurable: true,
        enumerable: _tcDesc.enumerable
      });
    }
  } catch (e) { /* ignore */ }
  try {
    if (window.CSSStyleSheet) {
      var _ir = CSSStyleSheet.prototype.insertRule;
      if (_ir) {
        CSSStyleSheet.prototype.insertRule = function (rule, idx) {
          try {
            if (typeof rule === 'string') { var nr = mapCssUrls(rule); if (nr !== rule) rule = nr; }
          } catch (e) { /* ignore */ }
          return _ir.call(this, rule, idx);
        };
      }
      var _rsync = CSSStyleSheet.prototype.replaceSync;
      if (_rsync) {
        CSSStyleSheet.prototype.replaceSync = function (txt) {
          try { if (typeof txt === 'string') { var nt = mapCssUrls(txt); if (nt !== txt) txt = nt; } } catch (e) { /* ignore */ }
          return _rsync.call(this, txt);
        };
      }
      var _rpl = CSSStyleSheet.prototype.replace;
      if (_rpl) {
        CSSStyleSheet.prototype.replace = function (txt) {
          try { if (typeof txt === 'string') { var nt2 = mapCssUrls(txt); if (nt2 !== txt) txt = nt2; } } catch (e) { /* ignore */ }
          return _rpl.call(this, txt);
        };
      }
    }
  } catch (e) { /* ignore */ }

  /* ---------- analytics shims (their hosts are blocked anyway) ---------- */
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };

  /* ---------- localStorage fallback for browsers that block it in iframes ----
   * backed by the shell through postMessage so sessions survive reloads.
   * In a null-origin frame ACCESSING window.localStorage THROWS
   * SecurityError — the access must happen in its own try BEFORE the
   * usable() probe, or the exception skips the shim entirely (the
   * site's own 'window.localStorage && ...' guard would then throw and
   * silently kill its boot logic). */
  (function setupStorage() {
    function usable(store) {
      try {
        var k = '__mp_probe__';
        store.setItem(k, '1');
        store.removeItem(k);
        return true;
      } catch (e) { return false; }
    }
    function makeShim(name) {
      var mem = (name === 'localStorage') ? lsMirror : {};
      /* real Storage objects accept BOTH method calls and plain property
       * access (Monochrome's bundle reads hifi_token with getItem and
       * writes some keys as plain properties). This Proxy routes
       * property get/set/delete through the storage methods so the shim
       * behaves like the real thing. */
      var proto = {
        getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
        setItem: function (k, v) { k = String(k); mem[k] = String(v); up({ type: 'ls', store: name, k: k, v: String(v) }); },
        removeItem: function (k) { k = String(k); if (Object.prototype.hasOwnProperty.call(mem, k)) { delete mem[k]; up({ type: 'ls', store: name, k: k, v: null }); } },
        clear: function () { Object.keys(mem).forEach(function (k) { delete mem[k]; }); up({ type: 'ls', store: name, k: '__clear__', v: null }); },
        key: function (i) { return Object.keys(mem)[i] || null; }
      };
      /* in-place clear() above keeps the lsMirror alias intact (boot
       * hydration + shell 'init' write straight into lsMirror). */
      try { Object.defineProperty(proto, 'length', { get: function () { return Object.keys(mem).length; }, configurable: true }); } catch (eLen) { /* ignore */ }
      var target = Object.create(proto);
      try {
        return new Proxy(target, {
          get: function (t, p) {
            if (typeof p === 'symbol') return t[p];
            if (Object.prototype.hasOwnProperty.call(mem, p)) return mem[p];
            var v = t[p];
            return (v === undefined && p !== 'length') ? null : v;
          },
          set: function (t, p, v) {
            if (typeof p === 'symbol') { t[p] = v; return true; }
            proto.setItem(p, v);
            return true;
          },
          deleteProperty: function (t, p) {
            if (typeof p === 'symbol') { delete t[p]; return true; }
            if (Object.prototype.hasOwnProperty.call(mem, p)) proto.removeItem(p);
            return true;
          },
          has: function (t, p) {
            if (typeof p === 'symbol') return p in t;
            return Object.prototype.hasOwnProperty.call(mem, p) || (p in t);
          },
          ownKeys: function (t) { return Object.keys(mem); },
          getOwnPropertyDescriptor: function (t, p) {
            if (typeof p === 'string' && Object.prototype.hasOwnProperty.call(mem, p)) {
              return { value: mem[p], writable: true, enumerable: true, configurable: true };
            }
            return undefined;
          }
        });
      } catch (ePx) { return target; } /* engine without Proxy: method-only fallback */
    }
    ['localStorage', 'sessionStorage'].forEach(function (name) {
      var native = null;
      try { native = window[name]; } catch (eAcc) { native = null; }
      if (native && usable(native)) return; /* native storage works — keep it */
      try {
        Object.defineProperty(window, name, { value: makeShim(name), configurable: true, writable: false });
      } catch (eDef) { /* ignore */ }
    });
  })();

  /* ---------- title watcher ---------- */
  function watchTitle() {
    try {
      var t = document.querySelector('title');
      if (t && window.MutationObserver) {
        new MutationObserver(reportNav).observe(t, { childList: true, characterData: true, subtree: true });
      }
    } catch (e) { /* ignore */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchTitle);
  else watchTitle();

  /* ---------- error forwarding (diagnostics) ---------- */
  var errCount = 0;
  window.addEventListener('error', function (e) {
    var msg = String((e && e.message) || e).slice(0, 300);
    if (errCount < 10) up({ type: 'err', msg: msg });
    if (errCount < 3) pageToast('Page error: ' + msg);
    errCount++;
  });

  /* ---------- shell commands ---------- */
  window.addEventListener('message', function (e) {
    try {
      var d = e.data;
      if (!d || d.mp !== 1 || !d.cmd) return;
      /* capability-bridge events (v1.2) arrive FIRST: worker pipes and
       * save-picker answers. They only ever come from the parent shell,
       * they carry app data rather than commands, and they must not be
       * mistaken for navigation. */
      if (e.source === window.parent && window.parent !== window) {
        if (d.cmd === 'wmsg') {
          try { wDispatch(d.wid, 'message', new MessageEvent('message', { data: d.data })); } catch (eM) { /* ignore */ }
          return;
        }
        if (d.cmd === 'werr') {
          try { wDispatch(d.wid, 'error', new ErrorEvent('error', { message: d.message || 'worker failed' })); } catch (eE) { /* ignore */ }
          return;
        }
        if (d.cmd === 'sfpok') {
          try { mpSfpOk(d.pid); } catch (eS) { /* ignore */ }
          return;
        }
      }
      /* trusted senders: the worker itself, and the saved pocket file
       * (file:// origin on Chrome, null on Safari) hosting the
       * sandboxed app view */
      if (e.origin !== 'null' && e.origin !== 'file://' && WORKER && e.origin !== WORKER) return;
      if (SD && d.cmd !== 'init' && d.cmd !== 'getstate') {
        /* sandbox: back/forward/reload/navigate are SHELL-owned — the
         * shell re-renders entries itself; only state exchange reaches
         * the frame. */
        if (d.cmd === 'back') { up({ type: 'goback' }); return; }
        if (d.cmd === 'forward') { up({ type: 'gofwd' }); return; }
        if (d.cmd === 'reload') { up({ type: 'reloadreq' }); return; }
        if (d.cmd === 'navigate') { if (d.url) nav(String(d.url)); return; }
      }
      switch (d.cmd) {
        case 'init':
          if (Array.isArray(d.jar)) {
            var jarM = {};
            jar.forEach(function (c) { if (c && c.name) jarM[c.name] = c; });
            d.jar.forEach(function (c) { if (c && c.name) jarM[c.name] = c; });
            jar = Object.keys(jarM).map(function (k) { return jarM[k]; });
          }
          if (d.ls) {
            Object.keys(d.ls).forEach(function (k) {
              if (!(k in lsMirror)) lsMirror[k] = d.ls[k];
            });
          }
          seedDocumentCookies();
          reportNav();
          break;
        case 'back': history.back(); break;
        case 'forward': history.forward(); break;
        case 'reload': location.reload(); break;
        case 'navigate':
          if (d.url) location.href = mapUrl(String(d.url));
          break;
        case 'getstate': reportNav(); break;
        case 'probe':
          /* debug channel: the shell (or a test) asks, the frame answers
           * with the state the app actually sees. */
          try {
            var pScripts = [];
            try {
              var pList = document.querySelectorAll('script[src]');
              for (var pi = 0; pi < pList.length && pi < 14; pi++) pScripts.push(pList[pi].getAttribute('src'));
            } catch (eSl) { /* ignore */ }
            up({
              type: 'probe',
              doc: DOC || '',
              locHref: (window.__mpLoc && window.__mpLoc.href) || '',
              realHref: (function () { try { return location.href; } catch (eR) { return '(throws)'; } })(),
              scripts: pScripts,
              forms: (function () { var n = 0; try { n = document.querySelectorAll('form').length; } catch (eF) { } return n; })(),
              title: document.title || ''
            });
          } catch (eP) { /* ignore */ }
          break;
      }
    } catch (err) { /* ignore */ }
  });

  /* ---------- sandbox shims: history state, anchors, clipboard ------
   * Monochrome is a real SPA: its router pushes history entries and
   * re-dispatches popstate, its link handler compares anchor origins
   * with location.origin, and parts of its UI keep state on
   * history.state. In a null-origin frame all of that needs help. */

  /* history.state: the pushState/replaceState shims below cannot mint
   * real entries (the native calls would throw), so they park the
   * caller's state object on __histState and this getter serves it. */
  try {
    if (SD) {
      var hsDesc = Object.getOwnPropertyDescriptor(History.prototype, 'state');
      if (hsDesc && hsDesc.get) {
        Object.defineProperty(History.prototype, 'state', {
          get: function () { return __histState; },
          configurable: true
        });
      }
      /* native back/forward would walk stale srcdoc snapshots — the
       * shell owns the real stack, so route these to it. */
      history.back = function () { up({ type: 'goback' }); };
      history.forward = function () { up({ type: 'gofwd' }); };
      history.go = function (d) { up({ type: (d < 0) ? 'goback' : 'gofwd' }); };
    }
  } catch (eHist) { /* ignore */ }

  /* decode an opaque token (mirror of the worker's decTok) */
  function decTok(t) {
    try {
      if (!KEY) return null;
      var b64 = atob(String(t || '').replace(/-/g, '+').replace(/_/g, '/'));
      var bytes = new Uint8Array(b64.length);
      for (var i = 0; i < b64.length; i++) bytes[i] = b64.charCodeAt(i) ^ KEY.charCodeAt(i % KEY.length);
      return new TextDecoder().decode(bytes);
    } catch (eDT) { return null; }
  }

  /* the upstream URL an href really points to: worker /__o/ and /__t/
   * URLs are decoded back to their upstream form, plain allowlisted
   * and relative hrefs are resolved against the upstream doc URL. */
  function upstreamOfHref(raw) {
    try {
      var s = String(raw == null ? '' : raw);
      if (!s || s.charAt(0) === '#') return null;
      if (/^(data|blob|about|javascript|mailto|tel|sms|intent|ms-|chrome|file):/i.test(s)) return null;
      var workerOrigin = String(WORKER || '').replace(/\\/$/, '');
      var wOrg = '';
      try { if (workerOrigin) wOrg = new URL(workerOrigin).origin; } catch (eWO) { wOrg = ''; }
      var u = null;
      try { u = new URL(s, workerOrigin || DOC || 'https://x.invalid/'); } catch (eU) { return null; }
      if (!u) return null;
      if (wOrg && u.origin === wOrg) {
        var mO = u.pathname.match(/^\\/__o\\/([A-Za-z0-9_-]{8,})(\\/.*)?$/);
        if (mO) {
          var org = decTok(mO[1]);
          if (!org) return null;
          try { return new URL(org + (mO[2] || '/') + u.search + u.hash); } catch (eO) { return null; }
        }
        var mT = u.pathname.match(/^\\/__t\\/([A-Za-z0-9_-]{8,})$/);
        if (mT) {
          var full = decTok(mT[1]);
          if (!full) return null;
          try { return new URL(full); } catch (eT) { return null; }
        }
        return null; /* other worker paths are not app links */
      }
      var u2 = null;
      try { u2 = new URL(s, DOC || undefined); } catch (eR) { return null; }
      if (!u2) return null;
      if (!/^https?:$/.test(u2.protocol)) return null;
      return u2;
    } catch (eUU) { return null; }
  }

  /* anchor property shim: a.origin/pathname/host/... report the
   * UPSTREAM values, so the app's link router
   * (a.origin === location.origin) recognizes its own links and turns
   * clicks into SPA transitions instead of full navigations. The href
   * ATTRIBUTE stays the worker URL — every proxy mechanism (click
   * capture, download bridge, nav watcher) keeps working unchanged. */
  (function shimAnchors() {
    try {
      if (!SD) return;
      var proto = window.HTMLAnchorElement && window.HTMLAnchorElement.prototype;
      if (!proto) return;
      ['origin', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'].forEach(function (k) {
        try {
          var d = Object.getOwnPropertyDescriptor(proto, k);
          if (!d || !d.get) return;
          Object.defineProperty(proto, k, {
            get: function () {
              try {
                var raw = this.getAttribute('href');
                var up = raw == null ? null : upstreamOfHref(raw);
                if (up && allowedHost(up.hostname)) return up[k];
              } catch (eG) { /* fall through to native */ }
              return d.get.call(this);
            },
            configurable: true,
            enumerable: d.enumerable
          });
        } catch (eP) { /* ignore */ }
      });
    } catch (eSA) { /* ignore */ }
  })();

  /* clipboard: the sandbox cannot touch the real one — hand writes to
   * the shell, which copies from the trusted file:// page. */
  try {
    if (SD && navigator.clipboard) {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        get: function () {
          return {
            writeText: function (t) { up({ type: 'copy', text: String(t) }); return Promise.resolve(undefined); },
            readText: function () { return Promise.reject(new Error('the clipboard is not readable inside the sandbox')); }
          };
        }
      });
    }
  } catch (eClip) { /* ignore */ }

  /* ---------- in-memory IndexedDB (sandbox) ---------------------------
   * A null-origin frame cannot open IndexedDB at all — the call throws
   * SecurityError — and Monochrome's whole boot chain awaits its
   * storage layer (settings, favorites, history, pinned items, the
   * response cache). One throw there leaves the UI rendered but inert:
   * no handlers, no router, nothing clickable. This shim installs a
   * compact in-memory IndexedDB that answers everything the app asks
   * for (open + upgrade, transactions, stores, indexes, cursors,
   * key ranges) and mirrors writes to the shell so settings and
   * favorites survive srcdoc swaps and file reloads. */
  (function setupIDB() {
    if (!SD) return;
    var probeOK = true;
    try { window.indexedDB.open('__mp_idb_probe__', 1); } catch (ePr) { probeOK = false; }
    if (probeOK) return; /* real IndexedDB works here — leave it alone */

    /* the TTL response cache never persists — only the app's own DB */
    var PERSIST_DBS = { MonochromeDB: 1 };

    /* -- tiny event machinery -- */
    function Ev(name) { this.type = name; this.target = null; this.defaultPrevented = false; }
    Ev.prototype.preventDefault = function () { this.defaultPrevented = true; };
    Ev.prototype.stopPropagation = function () { };
    Ev.prototype.stopImmediatePropagation = function () { };
    function Emitter() { this.__h = {}; }
    Emitter.prototype.addEventListener = function (t, fn) { if (typeof fn === 'function') { (this.__h[t] = this.__h[t] || []).push(fn); } };
    Emitter.prototype.removeEventListener = function (t, fn) { var a = this.__h[t]; if (!a) return; var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
    Emitter.prototype.dispatchEvent = function (ev) {
      try { ev.target = ev.target || this; } catch (eT) { /* ignore */ }
      var a = this.__h[ev.type];
      if (a) {
        a = a.slice();
        for (var i = 0; i < a.length; i++) { try { a[i].call(this, ev); } catch (eH) { /* ignore */ } }
      }
      var f = this['on' + ev.type];
      if (typeof f === 'function') { try { f.call(this, ev); } catch (eF) { /* ignore */ } }
      return !ev.defaultPrevented;
    };
    var sched = function (f) { setTimeout(f, 0); };

    /* -- keys -- */
    function typeOrd(k) {
      if (typeof k === 'number') return 0;
      if (k instanceof Date) return 1;
      if (typeof k === 'string') return 2;
      if (Array.isArray(k)) return 3;
      return 4;
    }
    function cmpKeys(a, b) {
      var ta = typeOrd(a), tb = typeOrd(b);
      if (ta !== tb) return ta < tb ? -1 : 1;
      if (ta === 0) return a < b ? -1 : (a > b ? 1 : 0);
      if (ta === 1) { var x = a.getTime(), y = b.getTime(); return x < y ? -1 : (x > y ? 1 : 0); }
      if (ta === 2) return a < b ? -1 : (a > b ? 1 : 0);
      if (ta === 3) {
        var n = Math.min(a.length, b.length);
        for (var i = 0; i < n; i++) { var c = cmpKeys(a[i], b[i]); if (c) return c; }
        return a.length - b.length;
      }
      return 0;
    }
    function inRange(k, r) {
      if (!r) return true;
      try {
        if (r.lower !== undefined && r.lower !== null) {
          var c = cmpKeys(k, r.lower);
          if (c < 0 || (c === 0 && r.lowerOpen)) return false;
        }
        if (r.upper !== undefined && r.upper !== null) {
          var c2 = cmpKeys(k, r.upper);
          if (c2 > 0 || (c2 === 0 && r.upperOpen)) return false;
        }
      } catch (eR) { /* treat as in-range */ }
      return true;
    }
    function errObj(name, msg) { var e = new Error(msg || name); e.name = name; return e; }
    function keyPathValue(val, kp) {
      if (kp == null) return undefined;
      if (typeof kp === 'string') {
        if (kp.indexOf('.') < 0) { try { return val == null ? undefined : val[kp]; } catch (e) { return undefined; } }
        var cur = val, parts = kp.split('.');
        for (var i = 0; i < parts.length; i++) {
          if (cur == null) return undefined;
          try { cur = cur[parts[i]]; } catch (e2) { return undefined; }
        }
        return cur;
      }
      if (Array.isArray(kp)) {
        var out = [];
        for (var j = 0; j < kp.length; j++) out.push(keyPathValue(val, kp[j]));
        return out;
      }
      return undefined;
    }
    function kser(k) {
      if (typeof k === 'number') return 'n:' + k;
      if (typeof k === 'string') return 's:' + k;
      if (k instanceof Date) return 'd:' + k.getTime();
      try { return 'j:' + JSON.stringify(k); } catch (e) { return 's:' + String(k); }
    }
    function kunser(s) {
      try {
        var t = String(s || '').charAt(0), rest = String(s).slice(2);
        if (t === 'n') { var n = Number(rest); return isNaN(n) ? rest : n; }
        if (t === 'd') { var d = new Date(Number(rest)); return isNaN(d.getTime()) ? rest : d; }
        if (t === 'j') { try { return JSON.parse(rest); } catch (eJ) { return rest; } }
        return rest;
      } catch (e) { return s; }
    }
    function persist(db, store, op, k, v) {
      try {
        if (!PERSIST_DBS[db]) return;
        var msg = { type: 'idb', db: db, store: store, op: op };
        if (op === 'put') { msg.ks = kser(k); msg.v = v; }
        else if (op === 'del') msg.ks = kser(k);
        up(msg);
      } catch (eP) { /* ignore */ }
    }

    /* -- object store -- */
    function IDBStore(db, name, opts) {
      Emitter.call(this);
      this.__db = db;
      this.name = name;
      this.keyPath = (opts && opts.keyPath !== undefined) ? opts.keyPath : null;
      this.autoIncrement = !!(opts && opts.autoIncrement);
      this.__data = new Map();
      this.__keyGen = 1;
      this.__indexes = {};
    }
    IDBStore.prototype = Object.create(Emitter.prototype);
    IDBStore.prototype.__indexOne = function (ix, pk, value) {
      var ik = keyPathValue(value, ix.keyPath);
      if (ik === undefined || ik === null) return;
      if (ix.unique) { ix.map.set(ik, [pk]); return; }
      var arr = ix.map.get(ik);
      if (!arr) { ix.map.set(ik, [pk]); return; }
      if (arr.indexOf(pk) < 0) arr.push(pk);
    };
    IDBStore.prototype.__unindexOne = function (ix, pk, oldValue) {
      var ik = keyPathValue(oldValue, ix.keyPath);
      if (ik === undefined || ik === null) return;
      var arr = ix.map.get(ik);
      if (!arr) return;
      var i = arr.indexOf(pk);
      if (i >= 0) arr.splice(i, 1);
      if (!arr.length) ix.map.delete(ik);
    };
    IDBStore.prototype.__indexAdd = function (pk, value) {
      var names = Object.keys(this.__indexes);
      for (var i = 0; i < names.length; i++) this.__indexOne(this.__indexes[names[i]], pk, value);
    };
    IDBStore.prototype.__indexRemove = function (pk, oldValue) {
      var names = Object.keys(this.__indexes);
      for (var i = 0; i < names.length; i++) this.__unindexOne(this.__indexes[names[i]], pk, oldValue);
    };
    IDBStore.prototype.createIndex = function (name, keyPath, opts) {
      if (this.__indexes[name]) throw errObj('ConstraintError', 'index already exists: ' + name);
      var ix = { name: name, keyPath: keyPath, unique: !!(opts && opts.unique), multiEntry: !!(opts && opts.multiEntry), map: new Map() };
      this.__indexes[name] = ix;
      var self = this;
      this.__data.forEach(function (v, k) { self.__indexOne(ix, k, v); });
      return new IndexView(null, this, ix);
    };
    IDBStore.prototype.deleteIndex = function (name) { delete this.__indexes[name]; };

    function namesList(names) {
      var o = { length: names.length, item: function (i) { return names[i] || null; }, contains: function (n) { return names.indexOf(String(n)) >= 0; } };
      for (var i = 0; i < names.length; i++) o[i] = names[i];
      return o;
    }

    /* -- request -- */
    function IDBRequest(source, tx) {
      Emitter.call(this);
      this.__source = source || null;
      this.transaction = tx || null;
      this.result = undefined;
      this.error = null;
      this.readyState = 'pending';
    }
    IDBRequest.prototype = Object.create(Emitter.prototype);
    Object.defineProperty(IDBRequest.prototype, 'source', { get: function () { return this.__source; }, configurable: true });
    function okReq(r, res) {
      r.readyState = 'done';
      r.result = res;
      r.dispatchEvent(new Ev('success'));
    }
    function failReq(r, err) {
      r.readyState = 'done';
      r.error = err;
      r.dispatchEvent(new Ev('error'));
    }

    /* -- transaction -- */
    function IDBTx(db, names, mode) {
      Emitter.call(this);
      this.__db = db;
      this.mode = mode || 'readonly';
      this.__names = names.slice();
      this.__active = true;
      this.__pend = 0;
      this.__dead = false;
      this.error = null;
      this.oncomplete = null; this.onabort = null; this.onerror = null;
    }
    IDBTx.prototype = Object.create(Emitter.prototype);
    Object.defineProperty(IDBTx.prototype, 'objectStoreNames', { get: function () { return namesList(this.__names); }, configurable: true });
    IDBTx.prototype.objectStore = function (name) {
      if (this.__names.indexOf(name) < 0) throw errObj('NotFoundError', 'store not in this transaction: ' + name);
      if (!this.__active) throw errObj('TransactionInactiveError', 'transaction is no longer active');
      var st = this.__db.__stores[name];
      if (!st) throw errObj('NotFoundError', 'no such store: ' + name);
      return new StoreView(this, st);
    };
    IDBTx.prototype.__arm = function () {
      var self = this;
      sched(function () { self.__checkComplete(); });
    };
    IDBTx.prototype.__checkComplete = function () {
      if (this.__dead || this.__pend > 0) return;
      this.__dead = true;
      this.__active = false;
      var self = this;
      sched(function () { self.dispatchEvent(new Ev('complete')); });
    };
    IDBTx.prototype.__reqDone = function () { this.__pend--; this.__checkComplete(); };
    IDBTx.prototype.__reqFail = function (err) { this.__pend--; this.error = err; this.__checkComplete(); };
    IDBTx.prototype.abort = function () {
      if (this.__dead) return;
      this.__dead = true;
      this.__active = false;
      this.dispatchEvent(new Ev('abort'));
    };
    IDBTx.prototype.commit = function () { /* writes apply in place — nothing to flush */ };

    /* -- store view (what tx.objectStore() hands out) -- */
    function StoreView(tx, store) {
      this.__tx = tx;
      this.__st = store;
      tx.__pend++;
      var self = this;
      sched(function () { self.__tx.__reqDone(); }); /* views count as one pending op so empty txs still complete */
    }
    function viewNames(v) { return namesList(Object.keys(v.__st.__indexes)); }

    StoreView.prototype = {
      __count: function () { this.__tx.__pend++; },
      get name() { return this.__st.name; },
      get keyPath() { return this.__st.keyPath; },
      get autoIncrement() { return this.__st.autoIncrement; },
      get indexNames() { return viewNames(this); },
      index: function (n) {
        var ix = this.__st.__indexes[n];
        if (!ix) throw errObj('NotFoundError', 'no such index: ' + n);
        return new IndexView(this, this.__st, ix);
      },
      createIndex: function (n, kp, o) { return this.__st.createIndex(n, kp, o); },
      deleteIndex: function (n) { this.__st.deleteIndex(n); },
      get: function (key) {
        var r = new IDBRequest(this, this.__tx);
        var st = this.__st, tx = this.__tx;
        this.__count();
        sched(function () {
          try { okReq(r, st.__data.get(key)); tx.__reqDone(); }
          catch (e) { failReq(r, e); tx.__reqFail(e); }
        });
        return r;
      },
      getAll: function (range) {
        var r = new IDBRequest(this, this.__tx);
        var st = this.__st, tx = this.__tx;
        this.__count();
        sched(function () {
          try {
            var out = [];
            var keys = [];
            st.__data.forEach(function (v, k) { if (inRange(k, range)) keys.push(k); });
            keys.sort(function (a, b) { return cmpKeys(a, b); });
            keys.forEach(function (k) { out.push(st.__data.get(k)); });
            okReq(r, out); tx.__reqDone();
          } catch (e) { failReq(r, e); tx.__reqFail(e); }
        });
        return r;
      },
      getAllKeys: function (range) {
        var r = new IDBRequest(this, this.__tx);
        var st = this.__st, tx = this.__tx;
        this.__count();
        sched(function () {
          try {
            var keys = [];
            st.__data.forEach(function (v, k) { if (inRange(k, range)) keys.push(k); });
            keys.sort(function (a, b) { return cmpKeys(a, b); });
            okReq(r, keys); tx.__reqDone();
          } catch (e) { failReq(r, e); tx.__reqFail(e); }
        });
        return r;
      },
      count: function () {
        var r = new IDBRequest(this, this.__tx);
        var st = this.__st, tx = this.__tx;
        this.__count();
        sched(function () {
          try { okReq(r, st.__data.size); tx.__reqDone(); }
          catch (e) { failReq(r, e); tx.__reqFail(e); }
        });
        return r;
      },
      put: function (value, key) { return this.__write('put', value, key); },
      add: function (value, key) { return this.__write('add', value, key); },
      __write: function (kind, value, key) {
        var r = new IDBRequest(this, this.__tx);
        var st = this.__st, tx = this.__tx;
        this.__count();
        sched(function () {
          try {
            var k = (key !== undefined && key !== null) ? key : (st.keyPath != null ? keyPathValue(value, st.keyPath) : undefined);
            if (k === undefined || k === null) {
              if (st.autoIncrement) { k = st.__keyGen++; }
              else { var de = errObj('DataError', 'the object could not be keyed'); failReq(r, de); tx.__reqFail(de); return; }
            }
            var old = st.__data.get(k);
            if (kind === 'add' && old !== undefined) { var ce = errObj('ConstraintError', 'key already exists'); failReq(r, ce); tx.__reqFail(ce); return; }
            if (old !== undefined) st.__indexRemove(k, old);
            st.__data.set(k, value);
            st.__indexAdd(k, value);
            if (typeof k === 'number' && k >= st.__keyGen) st.__keyGen = k + 1;
            persist(st.__db.name, st.name, 'put', k, value);
            okReq(r, k); tx.__reqDone();
          } catch (e) { failReq(r, e); tx.__reqFail(e); }
        });
        return r;
      },
      delete: function (key) {
        var r = new IDBRequest(this, this.__tx);
        var st = this.__st, tx = this.__tx;
        this.__count();
        sched(function () {
          try {
            var old = st.__data.get(key);
            if (old !== undefined) {
              st.__data.delete(key);
              st.__indexRemove(key, old);
              persist(st.__db.name, st.name, 'del', key);
            }
            okReq(r, undefined); tx.__reqDone();
          } catch (e) { failReq(r, e); tx.__reqFail(e); }
        });
        return r;
      },
      clear: function () {
        var r = new IDBRequest(this, this.__tx);
        var st = this.__st, tx = this.__tx;
        this.__count();
        sched(function () {
          try {
            if (st.__data.size) { st.__data.clear(); Object.keys(st.__indexes).forEach(function (n) { st.__indexes[n].map.clear(); }); persist(st.__db.name, st.name, 'clear'); }
            okReq(r, undefined); tx.__reqDone();
          } catch (e) { failReq(r, e); tx.__reqFail(e); }
        });
        return r;
      },
      openCursor: function (range, dir) { return openCursorReq(this, this.__st, null, range, dir); }
    };

    /* -- index view -- */
    function IndexView(view, store, ix) {
      this.__view = view;
      this.__st = store;
      this.__ix = ix;
    }
    IndexView.prototype = {
      get name() { return this.__ix.name; },
      get keyPath() { return this.__ix.keyPath; },
      get unique() { return this.__ix.unique; },
      get multiEntry() { return this.__ix.multiEntry; },
      get objectStore() { return this.__st; },
      __pairs: function (range, dir) {
        var pairs = [];
        this.__ix.map.forEach(function (pks, ik) {
          pks.forEach(function (pk) { pairs.push({ ik: ik, pk: pk }); });
        });
        pairs.sort(function (a, b) { var c = cmpKeys(a.ik, b.ik); if (c) return c; return cmpKeys(a.pk, b.pk); });
        if (String(dir || 'next').indexOf('prev') === 0) pairs.reverse();
        return pairs.filter(function (p) { return inRange(p.ik, range); });
      },
      get: function (k) {
        var r = new IDBRequest(this, this.__view ? this.__view.__tx : null);
        var st = this.__st, ix = this.__ix, tx = this.__view ? this.__view.__tx : null;
        if (tx) tx.__pend++;
        sched(function () {
          try {
            var pks = ix.map.get(k);
            var v = pks && pks.length ? st.__data.get(pks[0]) : undefined;
            okReq(r, v === undefined ? undefined : v);
            if (tx) tx.__reqDone();
          } catch (e) { failReq(r, e); if (tx) tx.__reqFail(e); }
        });
        return r;
      },
      getAll: function (range) {
        var r = new IDBRequest(this, this.__view ? this.__view.__tx : null);
        var st = this.__st, self = this, tx = this.__view ? this.__view.__tx : null;
        if (tx) tx.__pend++;
        sched(function () {
          try {
            var out = self.__pairs(range, 'next').map(function (p) { return st.__data.get(p.pk); });
            okReq(r, out);
            if (tx) tx.__reqDone();
          } catch (e) { failReq(r, e); if (tx) tx.__reqFail(e); }
        });
        return r;
      },
      getAllKeys: function (range) {
        var r = new IDBRequest(this, this.__view ? this.__view.__tx : null);
        var self = this, tx = this.__view ? this.__view.__tx : null;
        if (tx) tx.__pend++;
        sched(function () {
          try {
            okReq(r, self.__pairs(range, 'next').map(function (p) { return p.pk; }));
            if (tx) tx.__reqDone();
          } catch (e) { failReq(r, e); if (tx) tx.__reqFail(e); }
        });
        return r;
      },
      count: function (range) {
        var r = new IDBRequest(this, this.__view ? this.__view.__tx : null);
        var self = this, tx = this.__view ? this.__view.__tx : null;
        if (tx) tx.__pend++;
        sched(function () {
          try { okReq(r, self.__pairs(range, 'next').length); if (tx) tx.__reqDone(); }
          catch (e) { failReq(r, e); if (tx) tx.__reqFail(e); }
        });
        return r;
      },
      openCursor: function (range, dir) { return openCursorReq(this, this.__st, this.__ix, range, dir); }
    };

    /* -- cursor -- */
    function openCursorReq(view, store, ix, range, dir) {
      var tx = view ? (view.__tx || (view.__view && view.__view.__tx)) : null;
      var r = new IDBRequest(view, tx);
      var cur = new IDBCursor(view, store, ix, range, dir, r);
      if (tx) tx.__pend++;
      cur.__step(0);
      return r;
    }
    function IDBCursor(view, store, ix, range, dir, req) {
      this.__view = view;
      this.__st = store;
      this.__ix = ix;
      this.__range = range;
      this.__dir = String(dir || 'next');
      this.__req = req;
      this.direction = this.__dir;
      this.source = ix ? new IndexView(view, store, ix) : view;
      var entries = [];
      var self = this;
      if (ix) {
        var pairs = [];
        ix.map.forEach(function (pks, ik) { pks.forEach(function (pk) { pairs.push({ ik: ik, pk: pk }); }); });
        pairs.sort(function (a, b) { var c = cmpKeys(a.ik, b.ik); if (c) return c; return cmpKeys(a.pk, b.pk); });
        if (this.__dir.indexOf('prev') === 0) pairs.reverse();
        pairs.forEach(function (p) { if (inRange(p.ik, range)) entries.push(p); });
      } else {
        var ks = [];
        store.__data.forEach(function (v, k) { ks.push(k); });
        ks.sort(function (a, b) { return cmpKeys(a, b); });
        if (this.__dir.indexOf('prev') === 0) ks.reverse();
        ks.forEach(function (k) { if (inRange(k, range)) entries.push({ ik: k, pk: k }); });
      }
      if (this.__dir.indexOf('unique') >= 0) {
        var seen = {}, ded = [];
        entries.forEach(function (p) {
          var id = kser(p.ik);
          if (!seen[id]) { seen[id] = 1; ded.push(p); }
        });
        entries = ded;
      }
      this.__entries = entries;
      this.__pos = -1;
      this.key = undefined;
      this.primaryKey = undefined;
      this.value = undefined;
    }
    IDBCursor.prototype.__step = function (n) {
      var self = this;
      this.__pos += (n || 1);
      sched(function () {
        var e = self.__entries[self.__pos];
        var req = self.__req;
        var tx = req ? req.transaction : null;
        if (!e) {
          if (req) { req.readyState = 'done'; req.result = null; req.dispatchEvent(new Ev('success')); }
          if (tx) tx.__reqDone();
          return;
        }
        if (self.__ix) { self.key = e.ik; } else { self.key = e.pk; }
        self.primaryKey = e.pk;
        self.value = self.__st.__data.get(e.pk);
        if (req) { req.readyState = 'done'; req.result = self; req.dispatchEvent(new Ev('success')); }
      });
    };
    IDBCursor.prototype.continue = function () { this.__step(1); };
    IDBCursor.prototype.advance = function (n) { this.__step(Math.max(1, n | 0)); };
    IDBCursor.prototype.delete = function () {
      var view = this.__view;
      var r = new IDBRequest(view, view && view.__tx);
      var st = this.__st, pk = this.primaryKey, tx = view && view.__tx;
      if (tx) tx.__pend++;
      var self = this;
      sched(function () {
        try {
          var old = st.__data.get(pk);
          if (old !== undefined) {
            st.__data.delete(pk);
            st.__indexRemove(pk, old);
            persist(st.__db.name, st.name, 'del', pk);
          }
          okReq(r, undefined);
          if (tx) tx.__reqDone();
        } catch (e) { failReq(r, e); if (tx) tx.__reqFail(e); }
      });
      return r;
    };
    IDBCursor.prototype.update = function (value) {
      var view = this.__view;
      var r = new IDBRequest(view, view && view.__tx);
      var st = this.__st, pk = this.primaryKey, tx = view && view.__tx;
      if (tx) tx.__pend++;
      var self = this;
      sched(function () {
        try {
          var old = st.__data.get(pk);
          if (old !== undefined) st.__indexRemove(pk, old);
          st.__data.set(pk, value);
          st.__indexAdd(pk, value);
          persist(st.__db.name, st.name, 'put', pk, value);
          self.value = value;
          okReq(r, pk);
          if (tx) tx.__reqDone();
        } catch (e) { failReq(r, e); if (tx) tx.__reqFail(e); }
      });
      return r;
    };

    /* -- database -- */
    function IDBDatabase(name) {
      Emitter.call(this);
      this.name = name;
      this.version = 0;
      this.__stores = {};
      this.__closed = false;
      this.__everOpened = false;
    }
    IDBDatabase.prototype = Object.create(Emitter.prototype);
    Object.defineProperty(IDBDatabase.prototype, 'objectStoreNames', { get: function () { return namesList(Object.keys(this.__stores)); }, configurable: true });
    IDBDatabase.prototype.createObjectStore = function (name, opts) {
      if (this.__stores[name]) throw errObj('ConstraintError', 'store already exists: ' + name);
      var st = new IDBStore(this, name, opts);
      this.__stores[name] = st;
      return new StoreView(new IDBTx(this, [name], 'versionchange'), st);
    };
    IDBDatabase.prototype.deleteObjectStore = function (name) { delete this.__stores[name]; };
    IDBDatabase.prototype.transaction = function (names, mode) {
      if (this.__closed) throw errObj('InvalidStateError', 'database is closed');
      var arr = (typeof names === 'string') ? [names] : names.slice();
      if (!arr.length) throw errObj('InvalidAccessError', 'no stores requested');
      for (var i = 0; i < arr.length; i++) {
        if (!this.__stores[arr[i]]) throw errObj('NotFoundError', 'no such store: ' + arr[i]);
      }
      var tx = new IDBTx(this, arr, mode || 'readonly');
      tx.__arm();
      return tx;
    };
    IDBDatabase.prototype.close = function () { this.__closed = true; };

    /* seed: the shell's snapshot of previously persisted writes */
    var SEED_IDB = null;
    try {
      if (window.__MP_SEED__ && window.__MP_SEED__.mp === 1 && window.__MP_SEED__.idb && typeof window.__MP_SEED__.idb === 'object') SEED_IDB = window.__MP_SEED__.idb;
    } catch (eSeed) { SEED_IDB = null; }
    function applySeed(db) {
      try {
        if (!SEED_IDB || !PERSIST_DBS[db.name]) return;
        var stores = SEED_IDB[db.name];
        if (!stores) return;
        Object.keys(stores).forEach(function (sn) {
          var st = db.__stores[sn];
          if (!st) return;
          var entries = stores[sn];
          if (!entries) return;
          Object.keys(entries).forEach(function (ks) {
            try {
              var k = kunser(ks);
              var v = entries[ks];
              st.__data.set(k, v);
              st.__indexAdd(k, v);
              if (typeof k === 'number' && k >= st.__keyGen) st.__keyGen = k + 1;
            } catch (eE) { /* ignore */ }
          });
        });
      } catch (eAS) { /* ignore */ }
    }

    /* -- factory -- */
    var DBS = {};
    function openDB(name, version) {
      var req = new IDBRequest(null, null);
      var rec = DBS[name];
      if (rec && version !== undefined && version !== null && rec.db.version > version) {
        sched(function () { failReq(req, errObj('VersionError', 'requested version is lower than the existing one')); });
        return req;
      }
      if (!rec) { rec = { db: new IDBDatabase(name) }; DBS[name] = rec; }
      var db = rec.db;
      var oldV = db.version;
      var doUpgrade = !db.__everOpened || (version !== undefined && version !== null && version > db.version);
      if (version !== undefined && version !== null) db.version = version;
      else if (!db.version) db.version = 1;
      db.__closed = false;
      var self = this;
      sched(function () {
        try {
          /* result is visible from upgradeneeded on — the app's upgrade
           * handler reads r.target.result to createObjectStore, so it
           * must be the db BEFORE that event fires (a plain-undefined
           * result there kills the whole store schema). */
          db.__everOpened = true;
          req.result = db;
          if (doUpgrade) {
            var vtx = new IDBTx(db, [], 'versionchange');
            var ev = new Ev('upgradeneeded');
            ev.target = req;
            ev.oldVersion = oldV;
            ev.newVersion = db.version;
            req.transaction = vtx;
            req.dispatchEvent(ev);
            req.transaction = null;
          }
          applySeed(db);
          req.readyState = 'done';
          req.dispatchEvent(new Ev('success'));
        } catch (eO) {
          failReq(req, eO);
        }
      });
      return req;
    }
    var factory = {
      open: function (name, version) { return openDB(name, version); },
      deleteDatabase: function (name) {
        var r = new IDBRequest(null, null);
        delete DBS[name];
        sched(function () { okReq(r, undefined); });
        return r;
      },
      databases: function () {
        return Promise.resolve(Object.keys(DBS).map(function (n) { return { name: n, version: DBS[n].db.version }; }));
      },
      cmp: function (a, b) { return cmpKeys(a, b); }
    };
    try {
      Object.defineProperty(window, 'indexedDB', { value: factory, configurable: true, writable: false });
    } catch (eDef) {
      try { window.indexedDB = factory; } catch (eSet) { /* ignore */ }
    }
  })();


  /* ---------- capability bridges (v1.2) --------------------------------
   * Monochrome's download engine leans on three powers a null-origin
   * sandbox can never grant, and every one of them threw SecurityError
   * there, which is why downloads died:
   *   1. Web Workers from cross-origin scripts — the ffmpeg.wasm
   *      transcoder behind every "MP3 320 / 256 / 128 kbps" quality
   *      preset (the size never changed because the worker never ran).
   *   2. showSaveFilePicker — the default zip writer.
   *   3. showDirectoryPicker — the folder / local-media writers.
   * Each is bridged to the pocket shell, which CAN do it: workers are
   * spawned in the shell and message-piped both ways; the save pickers
   * answer fake handles whose createWritable() is a REAL WritableStream
   * (so pipeTo / write / close all behave) that hands the finished
   * bytes to the shell's native save path — the true OS save-as when
   * the browser allows it, the normal download flow otherwise. */

  /* ---- Web Worker bridge ---- */
  var REAL_WORKER = null;
  try { REAL_WORKER = window.Worker; } catch (eRW) { REAL_WORKER = null; }
  var WSEQ = 0;
  var WBR = {};
  function wDispatch(wid, type, ev) {
    var w = WBR[wid];
    if (!w) return;
    var f = null;
    try { f = w['on' + type]; } catch (eF) { f = null; }
    if (typeof f === 'function') { try { f(ev); } catch (eRun) { /* listener errors are not ours */ } }
    var ls = w.__ls && w.__ls[type];
    if (ls) for (var i = 0; i < ls.length; i++) { try { ls[i](ev); } catch (eL) { /* ignore */ } }
  }
  /* blob: urls the app hands a worker (the ffmpeg core + wasm it
   * gunzipped itself) belong to THIS opaque origin — a shell-side
   * worker could never load them. Every blob: string in a message is
   * re-read here and shipped as bytes, so the shell can mint its own
   * blob: urls on the far side. */
  function mpScanBlobs(obj, found, depth) {
    try {
      if (obj == null || depth > 8) return;
      var t = typeof obj;
      if (t === 'string') {
        if (obj.length > 5 && obj.slice(0, 5).toLowerCase() === 'blob:') found.push(obj);
        return;
      }
      if (t !== 'object') return;
      if (obj instanceof Blob || obj instanceof ArrayBuffer) return;
      if (Array.isArray(obj)) { for (var i = 0; i < obj.length; i++) mpScanBlobs(obj[i], found, depth + 1); return; }
      var ks = Object.keys(obj);
      for (var k = 0; k < ks.length; k++) mpScanBlobs(obj[ks[k]], found, depth + 1);
    } catch (eS) { /* never let a scan break a message */ }
  }
  function mpShipW(wid, data, transfer) {
    var found = [];
    mpScanBlobs(data, found, 0);
    if (!found.length) {
      try {
        if (transfer && transfer.length) {
          try { up({ type: 'wpost', wid: wid, data: data, transfer: transfer }, transfer); return; } catch (eT) { /* plain clone below */ }
        }
        up({ type: 'wpost', wid: wid, data: data });
      } catch (eU) { /* ignore */ }
      return;
    }
    var uniq = found.filter(function (u, i) { return found.indexOf(u) === i; });
    var jobs = uniq.map(function (u) {
      return window.fetch(u).then(function (r) {
        if (!r || !r.ok) throw new Error('blob read failed');
        return r.blob();
      }).then(function (b) {
        return b.arrayBuffer().then(function (buf) { return { u: u, buf: buf, mime: b.type || '' }; });
      });
    });
    Promise.all(jobs).then(function (list) {
      try {
        up({
          type: 'wpost',
          wid: wid,
          data: data,
          brefs: list.map(function (x) { return x.u; }),
          bmimes: list.map(function (x) { return x.mime; }),
          bbufs: list.map(function (x) { return x.buf; })
        });
      } catch (eU2) { /* ignore */ }
    }, function () {
      try { up({ type: 'wpost', wid: wid, data: data }); } catch (eU3) { /* ignore */ }
    });
  }
  function MPWorkerShim(url, opts) {
    /* same-origin shapes (blob:, data:) still run natively — only the
     * cross-origin scripts the sandbox forbids are bridged. */
    try { return new REAL_WORKER(url, opts); } catch (eW) { /* bridged below */ }
    var wid = ++WSEQ;
    /* the shell can only spawn workers it can address: relative urls
     * are resolved against the UPSTREAM document and mapped to the
     * relay, exactly like every other cross-origin reference here. */
    var uSend = String(url);
    try {
      if (!/^(blob:|data:|https?:|about:)/i.test(uSend)) {
        var abs = new URL(uSend, DOC || location.href).href;
        var aHost = (abs.match(/^https?:\\/\\/([^\\/?#]+)/i) || [])[1];
        uSend = (aHost && allowedHost(aHost)) ? (mapUrl(abs) || abs) : abs;
      }
    } catch (eU) { /* keep raw */ }
    var w = {
      onmessage: null,
      onerror: null,
      __ls: {},
      __q: Promise.resolve(),
      postMessage: function (data, transfer) {
        /* serialized per worker so blob re-reads can never reorder
         * two messages from the same caller */
        w.__q = w.__q.then(function () { mpShipW(wid, data, transfer); });
      },
      terminate: function () {
        try { up({ type: 'wend', wid: wid }); } catch (eE) { /* ignore */ }
        delete WBR[wid];
      },
      addEventListener: function (type, fn) {
        if (typeof fn !== 'function') return;
        (w.__ls[type] || (w.__ls[type] = [])).push(fn);
      },
      removeEventListener: function (type, fn) {
        var ls = w.__ls[type] || [];
        var ix = ls.indexOf(fn);
        if (ix >= 0) ls.splice(ix, 1);
      }
    };
    WBR[wid] = w;
    up({
      type: 'wopen',
      wid: wid,
      url: uSend,
      opts: (opts && typeof opts === 'object') ? { type: opts.type || 'classic', name: String(opts.name || '') } : null
    });
    return w;
  }
  try {
    if (SD && REAL_WORKER) {
      window.Worker = MPWorkerShim;
      try { MPWorkerShim.prototype = REAL_WORKER.prototype; } catch (eProto) { /* instanceof is cosmetic */ }
    }
  } catch (eWDef) { /* ignore */ }

  /* ---- save-picker bridge (fake handles over a real WritableStream) -- */
  var PICKSEQ = 0;
  var MPICKS = {};
  function mpChunkPlain(chunk) {
    try {
      if (chunk && typeof chunk === 'object' && chunk.type === 'write' && ('data' in chunk)) return chunk.data;
    } catch (eC) { /* keep whole */ }
    return chunk;
  }
  function mpFakeWritable(name, pid, mime) {
    var parts = [];
    /* the REAL WritableStream is what makes pipeTo(body, dest) accept
     * it (it checks the brand); write/seek/truncate are added as own
     * methods so the FileSystemWritableFileStream call shape works
     * too. Both roads land in the same sink. */
    var ws = new WritableStream({
      write: function (chunk) {
        /* positional write forms ({type:'write',position,data}, seek,
         * truncate) approximate to append — the app writes strictly
         * front-to-back, so the bytes land in order either way. */
        parts.push(mpChunkPlain(chunk));
        return Promise.resolve();
      },
      close: function () {
        var b = null;
        try { b = new Blob(parts, { type: mime || '' }); } catch (eB) { b = new Blob(parts); }
        delete MPICKS[pid];
        up({ type: 'dl', pid: pid, name: String(name), mime: (b && b.type) || '', blob: b });
        return Promise.resolve();
      },
      abort: function () {
        delete MPICKS[pid];
        up({ type: 'sfpabort', pid: pid });
        return Promise.resolve();
      }
    });
    try {
      var wr = null;
      var lock = function () { if (!wr) { try { wr = ws.getWriter(); } catch (eG) { wr = null; } } return wr; };
      ws.write = function (chunk) {
        var w = lock();
        if (w) return w.write(mpChunkPlain(chunk));
        return Promise.resolve();
      };
      ws.seek = function () { return Promise.resolve(); };
      ws.truncate = function () { return Promise.resolve(); };
      ws.close = function () {
        var w = lock();
        return w ? w.close() : Promise.resolve();
      };
      ws.abort = function () {
        var w = lock();
        return w ? w.abort() : Promise.resolve();
      };
    } catch (eExt) { /* a frozen stream still serves pipeTo callers */ }
    return ws;
  }
  function mpFakeFileHandle(name, pid, mime) {
    return {
      kind: 'file',
      name: String(name || 'download'),
      isFile: true,
      isDirectory: false,
      createWritable: function () { return Promise.resolve(mpFakeWritable(name, pid, mime)); },
      createSyncAccessHandle: function () { return Promise.reject(new Error('sync handles are not available in the pocket')); },
      getFile: function () { return Promise.reject(new Error('the file is not written yet')); },
      queryPermission: function () { return Promise.resolve('granted'); },
      requestPermission: function () { return Promise.resolve('granted'); },
      isSameEntry: function (other) { return Promise.resolve(!!other && other.pid === pid); }
    };
  }
  function mpEmptyAsyncIter() {
    return {
      next: function () { return Promise.resolve({ done: true, value: undefined }); },
      return: function () { return Promise.resolve({ done: true, value: undefined }); }
    };
  }
  function mpFakeDirHandle(name) {
    return {
      kind: 'directory',
      name: String(name || 'folder'),
      isFile: false,
      isDirectory: true,
      pid: null,
      getDirectoryHandle: function (n) { return Promise.resolve(mpFakeDirHandle(n)); },
      getFileHandle: function (n) {
        var pid = ++PICKSEQ;
        var mime = '';
        try { var ext = String(n || '').split('.').pop().toLowerCase(); mime = ({ mp3: 'audio/mpeg', m4a: 'audio/mp4', flac: 'audio/flac', ogg: 'audio/ogg', wav: 'audio/wav', zip: 'application/zip', jpg: 'image/jpeg', png: 'image/png', lrc: 'text/plain', ttml: 'text/xml' })[ext] || ''; } catch (eX) { mime = ''; }
        return Promise.resolve(mpFakeFileHandle(n, pid, mime));
      },
      queryPermission: function () { return Promise.resolve('granted'); },
      requestPermission: function () { return Promise.resolve('granted'); },
      removeEntry: function () { return Promise.resolve(); },
      values: function () { return mpEmptyAsyncIter(); },
      keys: function () { return mpEmptyAsyncIter(); },
      entries: function () { return mpEmptyAsyncIter(); },
      isSameEntry: function () { return Promise.resolve(false); }
    };
  }
  function mpSfpOk(pid) {
    var p = MPICKS[pid];
    if (!p) return;
    delete MPICKS[pid];
    try { p.resolve(mpFakeFileHandle(p.name, pid, p.mime || '')); } catch (eR) { /* ignore */ }
  }
  function mpSfpTimeout(pid) {
    var p = MPICKS[pid];
    if (!p) return;
    delete MPICKS[pid];
    try { p.reject(new DOMException('The save picker did not answer in time.', 'AbortError')); } catch (eR) { try { p.reject(new Error('The save picker did not answer in time.')); } catch (eR2) { /* ignore */ } }
  }
  try {
    if (SD) {
      if (typeof window.showSaveFilePicker === 'function' || !('showSaveFilePicker' in window)) {
        window.showSaveFilePicker = function (opts) {
          var pid = ++PICKSEQ;
          var nm = String((opts && opts.suggestedName) || 'download');
          var pr = new Promise(function (resolve, reject) {
            MPICKS[pid] = { resolve: resolve, reject: reject, name: nm, mime: '' };
            setTimeout(function () { mpSfpTimeout(pid); }, 90000);
          });
          up({ type: 'sfp', pid: pid, name: nm });
          return pr;
        };
      }
      if (typeof window.showDirectoryPicker === 'function' || !('showDirectoryPicker' in window)) {
        window.showDirectoryPicker = function () {
          /* folder mode: a virtual folder whose files each go through
           * the native save flow — the app sees a working directory,
           * the phone sees one save per file, nothing is lost. */
          return Promise.resolve(mpFakeDirHandle('Monochrome'));
        };
      }
    }
  } catch (ePick) { /* ignore */ }


  /* ---------- escape sentinel ------------------------------------------
   * pagehide fires when this frame navigates ANYWHERE (the one thing
   * the location rewrites could not catch — e.g. 'window.location = X'
   * left raw on purpose, or location.reload()). The shell re-arms this
   * around intentional srcdoc swaps; an UNARMED 'bye' means the document
   * escaped — the shell recovers by re-rendering the current entry. */
  try {
    if (SD) window.addEventListener('pagehide', function () { up({ type: 'bye' }); });
  } catch (eBye) { /* ignore */ }

  /* ---------- boot ---------- */
  up({ type: 'hello', url: curUrl(), title: document.title || '' });
  reportNav();
  try {
    setTimeout(function () {
      up({
        type: 'bootdiag',
        doc: DOC || '',
        fakeHref: (window.__mpLoc && window.__mpLoc.href) || '',
        fakePath: (window.__mpLoc && window.__mpLoc.pathname) || '',
        realHref: (function () { try { return location.href; } catch (e) { return '(throws)'; } })(),
        title: document.title || ''
      });
    }, 2500);
  } catch (eDiag) { /* ignore */ }
})();
`;

/* ============================================================ */

/* ============================================================
 * /__session — the relay-held session (single user, no keys)
 * ------------------------------------------------------------
 * The relay already sees every byte of the session: Monochrome's
 * account lives in Better-Auth cookies (auth.monochrome.st set-cookie
 * headers), and the streaming token (hifi_token) rides on
 * Authorization: Bearer headers the app sends to the auth and
 * tracks APIs. The worker captures both PASSIVELY (zero client
 * help) into one edge-cache slot:
 *
 *   GET    /__session -> {ok, has, savedAt, token, id, email, name, jar}
 *   DELETE /__session -> forget it AND fire the upstream sign-out
 *
 * The pocket fetches it once per open, before the first document
 * load, so the app boots already signed in — on ANY phone, no
 * matter what its viewer does to localStorage. A sign-out inside
 * the app (the worker sees the /api/auth/sign-out call) clears the
 * slot. Every operation reads/writes the edge cache directly (no
 * isolate memory), so every Cloudflare isolate stays coherent.
 * ============================================================ */

const sessionHits = new Map(); /* ip -> {n, t} — /__session ops in the window */
const SESSION_EMPTY = { jar: {}, token: '', id: '', em: '', nm: '', stale: 0, ts: 0 };

async function sha256Hex(str) {
  const dig = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  let out = '';
  const b = new Uint8Array(dig);
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0');
  return out;
}

function sessionRateOk(req) {
  /* light cap: 120 ops / 2 min / IP */
  const ip = String(req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || 'unknown').slice(0, 64);
  const now = Date.now();
  if (sessionHits.size > 4096) {
    for (const [k, v] of sessionHits) { if (now - v.t > 120000) sessionHits.delete(k); }
  }
  const e = sessionHits.get(ip);
  if (e && now - e.t < 120000) { e.n++; return e.n <= 120; }
  sessionHits.set(ip, { n: 1, t: now });
  return true;
}

async function sessionKeyUrl(req) {
  const origin = new URL(req.url).origin;
  return origin + '/__session/' + (await sha256Hex(TOK_KEY + '|mp-session-v1'));
}

async function sessionRead(req) {
  try {
    const hit = await caches.default.match(await sessionKeyUrl(req));
    if (hit) {
      const j = JSON.parse(await hit.text());
      if (j && typeof j === 'object') {
        return {
          jar: (j.jar && typeof j.jar === 'object' && !Array.isArray(j.jar)) ? j.jar : {},
          token: typeof j.token === 'string' ? j.token : '',
          id: typeof j.id === 'string' ? j.id : '',
          em: typeof j.em === 'string' ? j.em : '',
          nm: typeof j.nm === 'string' ? j.nm : '',
          stale: j.stale || 0,
          ts: j.ts || 0,
        };
      }
    }
  } catch (eR) { /* cache hiccup: act empty */ }
  return { jar: {}, token: '', id: '', em: '', nm: '', stale: 0, ts: 0 };
}

async function sessionWrite(req, st) {
  try {
    const body = JSON.stringify({ jar: st.jar, token: st.token, id: st.id, em: st.em || '', nm: st.nm || '', stale: st.stale || 0, ts: st.ts });
    const toStore = new Response(body, {
      headers: { 'content-type': 'application/json', 'cache-control': 'max-age=2592000' }, /* 30 days */
    });
    await caches.default.put(await sessionKeyUrl(req), toStore);
  } catch (eW) { /* cache write hiccup — the answer already went out */ }
}

/* fold upstream set-cookie strings into the jar map (dead cookies removed) */
function sessionEatSetCookies(st, list) {
  try {
    (list || []).forEach((raw) => {
      const bits = String(raw).split(';');
      const nv = bits[0];
      const eq = nv.indexOf('=');
      if (eq < 1) return;
      const name = nv.slice(0, eq).trim();
      let del = false;
      for (let i = 1; i < bits.length; i++) {
        const b = bits[i].trim().toLowerCase();
        if (b === 'max-age=0' || b.indexOf('expires=thu, 01 jan 1970') === 0) del = true;
      }
      if (del) delete st.jar[name];
      else st.jar[name] = nv.slice(eq + 1).trim();
    });
  } catch (eC) { /* ignore */ }
  return st;
}

/* passive capture: bearer + set-cookies + (optionally) a parsed
 * session/user JSON object from a get-session style answer */
async function sessionCapture(req, bearer, setCookieList, userObj) {
  const st = await sessionRead(req);
  if (bearer) st.token = String(bearer);
  if (userObj) {
    if (userObj.id) st.id = String(userObj.id);
    if (userObj.em) st.em = String(userObj.em);
    if (userObj.nm) st.nm = String(userObj.nm);
    st.stale = 0;
  }
  if (setCookieList && setCookieList.length) sessionEatSetCookies(st, setCookieList);
  /* an emptied jar (logout set-cookies are dead-cookie removals)
   * means signed-out — drop the token too so a wiped file boots
   * signed out instead of replaying a dead Bearer */
  if (!userObj && setCookieList && setCookieList.length && !Object.keys(st.jar).length) {
    st.token = '';
    st.id = '';
    st.em = '';
    st.nm = '';
  }
  st.ts = Date.now();
  await sessionWrite(req, st);
  return st;
}

/* the honest-status keepalive: a slot idle > 6h gets a live
 * get-session probe; a dead sign-in is marked stale instead of
 * claiming an email that no longer applies. */
async function sessionKeepAlive(req, event) {
  try {
    const st = await sessionRead(req);
    if (!st.token && !Object.keys(st.jar).length) return st;
    const au = new URL(authUpstream(event) + '/api/auth/get-session');
    const h = new Headers({ 'accept': 'application/json' });
    const ck = Object.keys(st.jar).map((k) => k + '=' + st.jar[k]).join('; ');
    if (ck) h.set('cookie', ck);
    if (st.token) h.set('authorization', 'Bearer ' + st.token);
    h.set('origin', 'https://' + au.host);
    h.set('referer', 'https://' + au.host + '/');
    const r = await fetch(au.toString(), { method: 'POST', headers: h, redirect: 'manual' });
    if (r.status === 401 || r.status === 403) {
      st.stale = 1;
      await sessionWrite(req, st);
      return st;
    }
    try {
      const j = JSON.parse(await r.text());
      if (j && j.user) {
        st.stale = 0;
        if (j.user.id) st.id = String(j.user.id);
        if (j.user.email) st.em = String(j.user.email);
        if (j.user.name) st.nm = String(j.user.name);
        await sessionWrite(req, st);
      } else if (r.ok) {
        /* 200 with no user = signed out upstream */
        st.stale = 1;
        await sessionWrite(req, st);
      }
    } catch (eJ) { /* non-json answer — leave the slot alone */ }
    return st;
  } catch (eKA) { return null; }
}

/* DELETE /__session ALSO fires the upstream sign-out (a real sign-out) */
async function sessionUpstreamSignout(event, st) {
  try {
    const au = new URL(authUpstream(event) + '/api/auth/sign-out');
    const h = new Headers({ 'accept': 'application/json' });
    const ck = Object.keys(st.jar).map((k) => k + '=' + st.jar[k]).join('; ');
    if (ck) h.set('cookie', ck);
    if (st.token) h.set('authorization', 'Bearer ' + st.token);
    h.set('origin', 'https://' + au.host);
    h.set('referer', 'https://' + au.host + '/');
    await fetch(au.toString(), { method: 'POST', headers: h, redirect: 'manual' });
  } catch (eSo) { /* best effort — the slot is already forgotten */ }
}

async function handleSession(req, url, event) {
  if (!sessionRateOk(req)) return json({ ok: false, error: 'too many session operations' }, req, 429);
  if (req.method === 'DELETE') {
    const st = await sessionRead(req);
    const pOut = sessionUpstreamSignout(event, st);
    if (event && typeof event.waitUntil === 'function') { try { event.waitUntil(pOut); } catch (eWO) { pOut.catch(function () { }); } }
    else pOut.catch(function () { });
    try { await caches.default.delete(await sessionKeyUrl(req)); } catch (eFd) { /* idempotent */ }
    return json({ ok: true, forgotten: true }, req);
  }
  /* GET */
  let st = await sessionRead(req);
  if (st.ts && (Date.now() - st.ts) > 6 * 3600 * 1000) {
    const pKA = sessionKeepAlive(req, event);
    if (event && typeof event.waitUntil === 'function') { try { event.waitUntil(pKA); } catch (eWK) { pKA.catch(function () { }); } }
    else pKA.catch(function () { });
  }
  const has = !!(st.token || Object.keys(st.jar).length);
  return json({
    ok: true,
    has: has,
    savedAt: st.ts || 0,
    token: st.token || '',
    id: st.id || '',
    email: st.em || '',
    name: st.nm || '',
    stale: !!st.stale,
    unclaimed: !has,
    jar: has ? Object.keys(st.jar).map((k) => ({ name: k, value: st.jar[k] })) : []
  }, req);
}

/* ============================================================ */

addEventListener('fetch', (event) => {
  event.respondWith(handle(event.request, event).catch((err) => {
    return new Response(JSON.stringify({ error: 'worker crashed', detail: String(err && err.message || err) }), { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }));
});

async function handle(req, event) {
  try {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();

    /* ---- CORS preflight ---- */
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(req, new Headers()) });
    }

    /* ---- public endpoints ---- */
    if (url.pathname === '/__status') {
      const env = envOf(event);
      const token = env.PROXY_TOKEN || '';
      let tokenOk = null;
      if (token) {
        const supplied = url.searchParams.has('__t') || req.headers.get('x-proxy-token') != null;
        if (supplied) tokenOk = (url.searchParams.get('__t') === token || req.headers.get('x-proxy-token') === token);
      }
      /* "entry" is the tokenized ROOT DOCUMENT path — the saved
       * pocket file fetches it to boot the app without ever knowing
       * the token key or the upstream host. Neutral JSON: no
       * Monochrome strings anywhere in this body. */
      const entry = tokPath(monoUpstream(event) + '/');
      /* sessions are ALWAYS on; this relay has no key mode — the
       * relay keeps the session of whoever signs in on it, and the
       * Forget button (or an in-app sign-out) clears it. */
      return json({ ok: true, name: VERSION, time: new Date().toISOString(), token_required: !!token, token_ok: tokenOk, session: true, session_mode: 'auto', entry: entry }, req);
    }

    /* ---- neutral favicon: never a proxied page ---- */
    if (url.pathname === '/favicon.ico' || url.pathname === '/favicon.png') {
      return new Response(null, { status: 204, headers: corsHeaders(req, new Headers()) });
    }

    /* ---- live upstream probe report ---- */
    if (url.pathname === '/__diag') {
      return diagPage(req, event);
    }

    /* ---- the relay-held session ---- */
    if (url.pathname === '/__session') {
      return handleSession(req, url, event);
    }

    /* ---- token gate ---- */
    const env = envOf(event);
    const token = env.PROXY_TOKEN || '';
    if (token && !(await checkToken(req, url, token))) {
      const accept = req.headers.get('accept') || '';
      if (method === 'GET' && accept.includes('text/html')) {
        const attempted = url.searchParams.has('__t') || req.headers.get('x-proxy-token') != null;
        return landing(event, attempted);
      }
      return json({ error: 'unauthorized', hint: 'set X-Proxy-Token header or __t query param' }, req, 401);
    }

    /* ---- token was supplied in the query: remember it, clean the URL ---- */
    if (token && url.searchParams.has('__t')) {
      const clean = new URL(req.url);
      clean.searchParams.delete('__t');
      const h = new Headers({ location: clean.pathname + (clean.search || ''), 'cache-control': 'no-store' });
      h.append('set-cookie', tokenCookie(token));
      return new Response(null, { status: 302, headers: corsHeaders(req, h) });
    }

    /* ---- the root is a NEUTRAL service page ------------------
     * The phone never navigates here for content — and it must
     * never serve Monochrome HTML, so a content classifier that
     * fetches the root sees a boring status page. */
    if (url.pathname === '/') {
      return servicePage(req);
    }

    /* ---- session cookie clear ---- */
    if (url.pathname === '/__clear') {
      const h = new Headers({ location: '/', 'cache-control': 'no-store' });
      const ck = req.headers.get('cookie') || '';
      const seen = new Set(['__mp_t']);
      ck.split(';').forEach((kv) => {
        const n = kv.split('=')[0].trim();
        if (n) seen.add(n);
      });
      seen.forEach((n) => h.append('set-cookie', n + '=; Path=/; Max-Age=0; Secure; SameSite=None; Partitioned'));
      return new Response(null, { status: 302, headers: corsHeaders(req, h) });
    }

    /* ---- websocket upgrade ---- */
    if (req.headers.get('upgrade') === 'websocket') {
      return proxyWebsocket(req, url, event);
    }

    /* ---- route resolution ---- */
    let pfx = '';       // proxy prefix for this document ('' = transparent)
    let upstream = null; // absolute upstream URL
    let host = null;     // upstream host
    let tokMode = false; // this request came through /__t/<token> or /__o/<origin-token>

    if (url.pathname.startsWith('/__t/')) {
      /* opaque token (full absolute URL). The form for the entry boot
       * handle and every URL the runtime patch maps at run time. */
      const tok = url.pathname.slice(5);
      const dec = decTok(tok);
      if (!dec || !/^https?:\/\//i.test(dec)) {
        return json({ error: 'bad token' }, req, 400);
      }
      const du = new URL(dec);
      if (!hostAllowed(du.host, event)) {
        return json({ error: 'host not allowed', allowed_suffixes: allowList(event) }, req, 403);
      }
      host = du.host;
      pfx = '';
      upstream = du.toString();
      tokMode = true;
    } else if (url.pathname.startsWith('/__o/')) {
      /* path-preserving origin token: '/__o/<otok>/<upstream path>'.
       * Everything the worker embeds in HTML/CSS/redirect Locations
       * uses this form so RELATIVE references (dynamic import(), css
       * url(), <base>-resolved runtime URLs) resolve to worker URLs
       * that still carry the upstream path. */
      const rest0 = url.pathname.slice(5);
      const slash = rest0.indexOf('/');
      const otok = slash < 0 ? rest0 : rest0.slice(0, slash);
      const upath = slash < 0 ? '/' : rest0.slice(slash);
      const dec = decTok(otok);
      if (!otok || !dec || !/^https?:\/\/[a-z0-9.:-]+\/?$/i.test(dec)) {
        return json({ error: 'bad origin token' }, req, 400);
      }
      const origin = dec.replace(/\/+$/, '');
      const ou = new URL(origin + '/');
      if (!hostAllowed(ou.host, event)) {
        return json({ error: 'host not allowed', allowed_suffixes: allowList(event) }, req, 403);
      }
      host = ou.host;
      pfx = '';
      upstream = origin + upath + url.search;
      tokMode = true;
    } else if (url.pathname.startsWith('/p/')) {
      const rest = url.pathname.slice(3); // "<host>/path..."
      const slash = rest.indexOf('/');
      host = slash < 0 ? rest : rest.slice(0, slash);
      const path = slash < 0 ? '/' : rest.slice(slash);
      if (!hostAllowed(host, event)) {
        return json({ error: 'host not allowed', host: host, allowed_suffixes: allowList(event) }, req, 403);
      }
      pfx = '/p/' + host;
      upstream = 'https://' + host + path + url.search;
    } else {
      /* bare paths mirror nothing — the transparent catch-all is GONE.
       * Nothing navigates to this worker; the only content route is
       * /__t/<token>. Answer a neutral 404 so the origin never serves
       * anything classifiable. */
      return json({ ok: false, service: 'mp', status: 404, note: 'nothing is served at this path' }, req, 404);
    }

    /* ---- query handling ----
     * Token requests carry their whole query INSIDE the token; any
     * extra params the browser appended (e.g. EventSource adding __t)
     * are merged in, minus __t. */
    const upUrl = new URL(upstream);
    if (tokMode) {
      for (const [k, v] of url.searchParams) {
        if (k === '__t') continue;
        if (!upUrl.searchParams.has(k)) upUrl.searchParams.set(k, v);
      }
    } else if (upUrl.searchParams.has('__t')) {
      upUrl.searchParams.delete('__t');
    }

    /* ---- build upstream request ---- */
    const h = new Headers();
    const skipReq = new Set(['host', 'origin', 'referer', 'cookie', 'connection', 'keep-alive', 'upgrade',
      'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'content-length', 'accept-encoding',
      'x-cookie', 'x-proxy-token', 'x-set-cookie']);
    /* Cloudflare's edge injects its own connection headers
     * (cf-connecting-ip, cf-ray, x-forwarded-for, ...) into every
     * request that reaches this worker. Forwarding them to
     * monochrome.st — which runs behind Cloudflare itself — sends
     * forged edge headers into another zone's WAF. Dropped, always. */
    const dropExact = new Set(['cdn-loop', 'true-client-ip', 'x-real-ip']);
    const dropPrefix = ['cf-', 'x-forwarded'];
    for (const [k, v] of req.headers) {
      const lk = k.toLowerCase();
      if (skipReq.has(lk)) continue;
      if (dropExact.has(lk)) continue;
      let drop = false;
      for (let i = 0; i < dropPrefix.length; i++) { if (lk.startsWith(dropPrefix[i])) { drop = true; break; } }
      if (drop) continue;
      h.set(k, v);
    }
    h.set('accept-encoding', 'gzip, deflate, br');
    /* stream calls (the app's realtime SSE posts carry Accept:
     * text/event-stream) ask the upstream for IDENTITY encoding — a
     * compressed event-stream is a stream some upstream CDNs buffer. */
    try {
      const acc = (req.headers.get('accept') || '').toLowerCase();
      if (acc.includes('text/event-stream')) {
        h.set('accept-encoding', 'identity');
      }
    } catch (eAE) { /* keep */ }
    h.set('cookie', mergeCookies(req.headers.get('cookie') || '', req.headers.get('x-cookie') || ''));
    h.set('origin', 'https://' + host);
    h.set('referer', 'https://' + host + '/');

    let body = undefined;
    let needDuplex = false;
    if (method !== 'GET' && method !== 'HEAD') {
      const cl = parseInt(req.headers.get('content-length') || '0', 10);
      if (cl > 0 && cl < 32 * 1024 * 1024) {
        body = await req.arrayBuffer(); // keeps Content-Length intact
        h.set('content-length', String(body.byteLength));
      } else {
        body = req.body; // stream big/unknown-size uploads
        needDuplex = true;
      }
    }

    /* ---- an explicit in-app sign-out forgets the relay-held session
     * (POST /api/auth/sign-out — verified in the app's own bundle).
     * NOTHING else may ever drop it: boot flailing, guest sessions,
     * new pages and wiped phones must all stay inert. The request
     * itself still goes through untouched, so Monochrome kills its
     * side of the session too. */
    const isSignoutCall = host === authHost(event) && /^\/api\/auth\/sign-out\/?$/.test(upUrl.pathname) && method === 'POST';
    if (isSignoutCall) {
      try {
        const pForget = (async function () {
          try { await caches.default.delete(await sessionKeyUrl(req)); } catch (eFd) { /* idempotent */ }
        })();
        if (event && typeof event.waitUntil === 'function') { try { event.waitUntil(pForget); } catch (eWf) { pForget.catch(function () { }); } }
        else pForget.catch(function () { });
      } catch (eFo) { /* best effort */ }
    }

    let res;
    try {
      const fetchInit = { method: method, headers: h, redirect: 'manual' };
      if (body !== undefined) fetchInit.body = body;
      if (needDuplex) fetchInit.duplex = 'half';
      res = await fetch(upUrl.toString(), fetchInit);
    } catch (errUp) {
      return json({ error: 'upstream unreachable', detail: String(errUp && errUp.message || err).slice(0, 120) }, req, 502);
    }

    /* ---- passive session capture (the relay keeps the sign-in).
     * Reads only headers (set-cookie) + the request's Bearer, plus a
     * small JSON clone when this response IS a session answer — the
     * original response body is never consumed. Runs via waitUntil so
     * the proxy answer is never delayed by the cache write. The
     * signout call itself is never captured (its token is dead by
     * design). */
    try {
      if (host === authHost(event) && !isSignoutCall) {
        const scAll = (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []);
        let userObj = null;
        const sessAnswer = (method === 'POST' || method === 'GET') &&
          /^\/api\/auth\/(get-session|sign-in-email|sign-up-email|update-user)\/?$/.test(upUrl.pathname);
        if (res.status === 200 && sessAnswer &&
            (res.headers.get('content-type') || '').toLowerCase().includes('json')) {
          try {
            const probe = res.clone();
            const aj = JSON.parse(await probe.text());
            if (aj) {
              const u = aj.user || aj.record || null;
              if (u && typeof u === 'object') {
                userObj = { id: u.id || '', em: u.email || '', nm: u.name || u.username || '' };
              } else if (aj.token && aj.id) {
                userObj = { id: aj.id, em: aj.email || '', nm: aj.name || '' };
              }
            }
          } catch (ePr) { userObj = null; }
        }
        let bearer = '';
        const authzCap = req.headers.get('authorization') || '';
        const mB = authzCap.match(/^\s*Bearer\s+(\S+)\s*$/i);
        if (mB) bearer = mB[1];
        if (scAll.length || bearer || userObj) {
          const pCap = sessionCapture(req, bearer, scAll, userObj);
          if (event && typeof event.waitUntil === 'function') { try { event.waitUntil(pCap); } catch (eWu) { pCap.catch(function () { }); } }
          else pCap.catch(function () { });
        }
      }
    } catch (eSC) { /* capture must never break the proxy */ }

    /* ---- redirect handling: rewrite Location and let the browser follow inside the worker ---- */
    const loc = res.headers.get('location');
    if (loc && res.status >= 300 && res.status < 400 && res.status !== 304) {
      const mapped = mapLocation(loc, upUrl, event, tokMode);
      const rh = scrubHeaders(res.headers);
      reissueCookies(res, rh, event);
      rh.set('location', mapped);
      maybeSetTokenCookie(req, rh, event);
      return new Response(null, { status: res.status, headers: corsHeaders(req, rh) });
    }

    /* ---- normal responses ---- */
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const outHeaders = scrubHeaders(res.headers);
    reissueCookies(res, outHeaders, event);
    maybeSetTokenCookie(req, outHeaders, event);
    outHeaders.set('x-final-url', res.url || upUrl.toString());
    const outCt = corsHeaders(req, outHeaders);

    if (ct.includes('text/html')) {
      const text = await res.text();
      const html = rewriteHtml(text, pfx, host, new URL(req.url).origin, token, allowList(event),
        tokMode ? upUrl.toString() : null);
      const htmlRes = new Response(html, { status: res.status, headers: outCt });
      /* ---- boot cookie-seed ---------------------------------------
       * When the pocket's document fetch arrived with REAL browser
       * cookies for this worker (credentials:'include' mode), the
       * browser's cookie store may be holding a live session the
       * pocket's own jar lost. Echo any such cookies back as
       * x-jar-seed so the shell can merge them into its jar before the
       * sandbox boots. Anonymous/analytics cookies are skipped. */
      try {
        const browserCk = req.headers.get('cookie') || '';
        if (browserCk) {
          const have = new Set();
          (req.headers.get('x-cookie') || '').split(';').forEach(function (kv) {
            const n = kv.split('=')[0].trim(); if (n) have.add(n);
          });
          const seeds = [];
          browserCk.split(';').forEach(function (kv) {
            kv = kv.trim(); if (!kv) return;
            const eq = kv.indexOf('=');
            if (eq < 1) return;
            const name = kv.slice(0, eq).trim();
            if (!name || name === '__mp_t' || have.has(name)) return;
            if (/^(cf_|__cf|_ga|_gat|_gid|__utm)/i.test(name)) return;
            seeds.push({ name: name, value: kv.slice(eq + 1).trim() });
          });
          if (seeds.length) htmlRes.headers.set('x-jar-seed', encodeURIComponent(JSON.stringify(seeds)));
        }
      } catch (eSeed) { /* never let the seed break a document */ }
      return htmlRes;
    }
    if (ct.includes('text/css')) {
      const text = await res.text();
      const css = rewriteCss(text, pfx, host, allowList(event), tokMode ? upUrl.toString() : null, new URL(req.url).origin);
      return new Response(css, { status: res.status, headers: outCt });
    }
    /* ---- JavaScript location-assignment rewrite ----------------
     * Inside the sandbox frame the document lives at about:srcdoc; a
     * script that does location.href = X (or location.assign/replace)
     * would navigate the frame OUT of the sandbox. Rewriting those
     * tokens to __mpLoc (the fake location object the runtime patch
     * installs BEFORE any site script runs) turns every SPA redirect
     * into a postMessage that the pocket shell turns into a fresh
     * sandboxed document. Conservative patterns only — an aggressive
     * wrap can emit a syntax error and kill an entire bundle at parse
     * time. */
    if (tokMode && /javascript|ecmascript|text\/jscript/i.test(ct)) {
      const text = await res.text();
      const js = rewriteJsLocation(text);
      if (js !== text) {
        const h2 = new Headers(outCt);
        h2.set('x-mp-jsrw', '1');
        return new Response(js, { status: res.status, headers: h2 });
      }
      return new Response(text, { status: res.status, headers: outCt });
    }

    /* ---- event-stream passthrough hardening ----------------
     * The realtime SSE responses pass through UNTOUCHED (res.body
     * streams chunk-for-chunk). These two extra headers tell any
     * intermediary that may still sit between this worker and the
     * phone not to buffer a live stream. */
    if (ct.includes('text/event-stream')) {
      outHeaders.set('x-accel-buffering', 'no');
      outHeaders.set('cache-control', 'no-store');
    }

    return new Response(res.body, { status: res.status, headers: outCt });
  } catch (err) {
    return json({ error: 'proxy error', detail: String(err && err.message || err) }, req, 500);
  }
}

/* ============================================================ helpers */

function envOf(event) {
  return (event && event.env) || globalThis.__MP_ENV || {};
}
function allowList(event) {
  const extra = envOf(event).EXTRA_HOSTS || '';
  const arr = ALLOW.slice();
  String(extra).split(',').forEach((h) => {
    h = h.trim().toLowerCase();
    if (h && arr.indexOf(h) < 0) arr.push(h);
  });
  return arr;
}
function hostAllowed(host, event) {
  host = String(host || '').toLowerCase();
  const list = allowList(event);
  for (const a of list) {
    if (host === a || host.endsWith('.' + a)) return true;
  }
  return false;
}
async function checkToken(req, url, token) {
  if (req.headers.get('x-proxy-token') === token) return true;
  if (url.searchParams.get('__t') === token) return true;
  const ck = req.headers.get('cookie') || '';
  const m = ck.match(/(?:^|;\s*)__mp_t=([^;]+)/);
  if (m && decodeURIComponent(m[1]) === token) return true;
  return false;
}
function tokenCookie(token) {
  return '__mp_t=' + encodeURIComponent(token) + '; Path=/; Max-Age=31536000; Secure; SameSite=None; Partitioned';
}
function redirect(req, to) {
  const h = new Headers({ location: to, 'cache-control': 'no-store' });
  return new Response(null, { status: 302, headers: corsHeaders(req, h) });
}
function maybeSetTokenCookie(req, h, event) {
  const token = envOf(event).PROXY_TOKEN || '';
  if (!token) return;
  const ck = req.headers.get('cookie') || '';
  if (ck.indexOf('__mp_t=') >= 0) return;
  h.append('set-cookie', tokenCookie(token));
}

function mergeCookies(a, b) {
  const seen = new Map();
  /* this worker's OWN cookies never belong upstream — __mp_t is
   * the token cookie; it lives on the relay origin only. */
  const own = new Set(['__mp_t']);
  const add = (str) => {
    if (!str) return;
    str.split(';').forEach((kv) => {
      kv = kv.trim();
      if (!kv) return;
      const name = kv.split('=')[0];
      if (own.has(name)) return;
      if (!seen.has(name)) seen.set(name, kv);
    });
  };
  add(a); // browser-native cookies win
  add(b); // patch-supplied fallback cookies fill gaps
  return Array.from(seen.values()).join('; ');
}

/* response headers we must not forward */
const SCRUB = new Set(['content-security-policy', 'content-security-policy-report-only', 'x-frame-options',
  'strict-transport-security', 'cross-origin-opener-policy', 'cross-origin-embedder-policy',
  'cross-origin-resource-policy', 'content-encoding', 'content-length', 'transfer-encoding',
  'connection', 'keep-alive', 'upgrade', 'set-cookie', 'report-to', 'nel', 'vary']);

function scrubHeaders(headers) {
  const h = new Headers();
  for (const [k, v] of headers) {
    if (!SCRUB.has(k.toLowerCase())) h.set(k, v);
  }
  return h;
}

/* re-issue upstream cookies for this worker's domain (CHIPS-partitioned so they work in the app iframe) */
function reissueCookies(res, h, event) {
  try {
    let raw = [];
    if (typeof res.headers.getSetCookie === 'function') raw = res.headers.getSetCookie();
    else {
      const single = res.headers.get('set-cookie');
      if (single) raw = [single];
    }
    if (!raw.length) return;
    raw.forEach((sc) => {
      const parts = String(sc).split(';');
      const nv = parts[0].trim();
      if (!nv) return;
      let expires = null, maxAge = null, httpOnly = false;
      for (let i = 1; i < parts.length; i++) {
        const p = parts[i].trim();
        const k = p.split('=')[0].toLowerCase();
        if (k === 'expires') expires = p.slice(8).trim();
        else if (k === 'max-age') maxAge = p.slice(8).trim();
        else if (k === 'httponly') httpOnly = true;
      }
      let out = nv + '; Path=/; Secure; SameSite=None; Partitioned';
      if (expires) out += '; Expires=' + expires;
      if (maxAge !== null && maxAge !== undefined && maxAge !== '') out += '; Max-Age=' + maxAge;
      if (httpOnly) out += '; HttpOnly';
      h.append('set-cookie', out);
    });
    /* expose the raw cookies so the patch/shell can mirror them */
    h.set('x-set-cookie', encodeURIComponent(JSON.stringify(raw)));
  } catch (e) { /* ignore */ }
}

function corsHeaders(req, h) {
  /* credentialed CORS for EVERY caller. The Monochrome app calls
   * its APIs with credentials:"include" — and a browser REFUSES
   * Access-Control-Allow-Origin:* on credentialed cross-origin
   * fetches. Echo the origin back plus allow-credentials so
   * cookies actually flow. ANY well-formed Origin is echoed (phones
   * open the saved pocket file through viewer apps that serve it
   * from http://localhost:PORT or a custom app scheme). No-Origin
   * (server-to-server) requests keep the wildcard. */
  const org = (req.headers.get('origin') || '').trim();
  const echoable = org === 'null' ||
    (org.length > 0 && org.length < 256 && /^[!-~]+$/.test(org) && org.indexOf('://') > 0);
  if (org && echoable) {
    h.set('access-control-allow-origin', org);
    h.set('access-control-allow-credentials', 'true');
  } else {
    h.set('access-control-allow-origin', '*');
  }
  h.set('access-control-allow-methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
  const reqH = req.headers.get('access-control-request-headers');
  h.set('access-control-allow-headers', reqH || '*');
  h.set('access-control-expose-headers', 'content-disposition, content-type, x-set-cookie, x-final-url, filename, x-mp-jsrw, x-jar-seed');
  h.set('access-control-max-age', '86400');
  return h;
}

function json(obj, req, status) {
  const h = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  return new Response(JSON.stringify(obj), { status: status || 200, headers: corsHeaders(req, h) });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---- /__diag — live upstream probes ------------------------------------
 * Three GETs against the app upstream, each shaped like a different
 * worker generation, so the page shows exactly WHICH request style
 * the upstream blocks (if any) from this worker's egress. */
async function diagProbe(event, kind) {
  const host = monoHost(event);
  const up = monoUpstream(event) + '/';
  const h = new Headers();
  const ua = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36';
  if (kind === 'app') {
    h.set('accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    h.set('user-agent', ua);
    h.set('accept-language', 'en-US,en;q=0.9');
  } else if (kind === 'minimal') {
    h.set('accept', '*/*');
    h.set('user-agent', 'curl/8.5.0');
  } else {
    h.set('accept', 'text/html');
    h.set('user-agent', ua);
    /* the forged shape: what a v2-era worker actually forwarded */
    h.set('cf-connecting-ip', '203.0.113.7');
    h.set('cf-ray', '8f' + Math.random().toString(16).slice(2, 10));
    h.set('x-forwarded-for', '203.0.113.7');
    h.set('x-forwarded-proto', 'https');
  }
  h.set('origin', 'https://' + host);
  h.set('referer', 'https://' + host + '/');
  const t0 = Date.now();
  try {
    const r = await fetch(up, { method: 'GET', headers: h, redirect: 'manual' });
    const text = (await r.text()).slice(0, 400);
    return {
      error: false, status: r.status, ms: Date.now() - t0,
      type: (r.headers.get('content-type') || '').slice(0, 60),
      server: (r.headers.get('server') || '').slice(0, 40),
      ray: (r.headers.get('cf-ray') || '').slice(0, 32),
      mitigated: (r.headers.get('cf-mitigated') || '').slice(0, 24),
      location: (r.headers.get('location') || '').slice(0, 120),
      snippet: text
    };
  } catch (e) {
    return { error: true, detail: String(e && e.message || e).slice(0, 200), ms: Date.now() - t0 };
  }
}

function verdictOf(pr) {
  if (pr.error) return 'error: ' + pr.detail;
  return String(pr.status);
}

async function diagPage(req, event) {
  const [app, mini, forged] = await Promise.all([diagProbe(event, 'app'), diagProbe(event, 'minimal'), diagProbe(event, 'forged')]);
  const incoming = [];
  try {
    for (const [k, v] of req.headers) {
      const lk = k.toLowerCase();
      if (lk.startsWith('cf-') || lk.startsWith('x-forwarded')) incoming.push(k + ': ' + String(v).slice(0, 60));
    }
  } catch (eI) { /* ignore */ }

  let verdict, verdictColor;
  if (app.error) {
    verdict = 'The worker could not fetch the app page from ' + esc(monoHost(event)) + ' (' + esc(app.detail) + '). Check MONO_UPSTREAM or try again — the app cannot work until this is fixed.';
    verdictColor = '#F87171';
  } else if (app.status === 200 || app.status === 304) {
    verdict = 'The upstream answers this worker normally. If the app still shows a block page, the block is NOT between this worker and monochrome — it is between your phone and this worker (network filter / browser). Try this page from a different network to compare.';
    verdictColor = '#4ADE80';
  } else {
    verdict = 'The upstream answered HTTP ' + esc(String(app.status)) + ' for a browser-shaped request. That may be a redirect or a soft block — see the probes below.';
    verdictColor = '#FBBF24';
  }

  const probeRow = (name, desc, pr) =>
    '<div class="probe"><div class="ph"><b>' + name + '</b><span class="code">' + esc(desc) + '</span></div>' +
    '<div class="line">status: <b class="' + (pr.error ? 'bad' : (pr.status === 200 ? 'ok' : (pr.status === 403 || pr.status === 429 ? 'bad' : 'warn'))) + '">' + esc(verdictOf(pr)) + '</b> <span class="meta">(' + esc(String(pr.ms)) + ' ms)</span></div>' +
    (pr.error ? '<div class="line">error: ' + esc(pr.detail) + '</div>' :
      '<div class="line meta">type ' + esc(pr.type) + ' · server ' + esc(pr.server) + ' · cf-ray ' + esc(pr.ray) +
      (pr.mitigated ? ' · cf-mitigated ' + esc(pr.mitigated) : '') +
      (pr.location ? ' · location ' + esc(pr.location) : '') + '</div>' +
      '<div class="snip">' + esc(pr.snippet) + '</div>') +
    '</div>';

  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<title>mp service — worker diagnostics</title>' +
    '<style>' +
    ':root{--bg:#0B0D12;--panel:#14161F;--panel2:#1A1D28;--line:rgba(255,255,255,.08);--txt:#E7E9EE;--sub:#9AA1AD}' +
    '*{box-sizing:border-box}body{margin:0;padding:18px 14px 40px;background:var(--bg);color:var(--txt);font-family:-apple-system,BlinkMacSystemFont,system-ui,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.55}' +
    'h1{font-size:18px;margin:0 0 2px}.tag{color:var(--sub);font-size:12.5px;margin-bottom:14px}' +
    '.verdict{padding:12px 14px;border-radius:12px;background:rgba(255,255,255,.05);border-left:3px solid ' + verdictColor + ';margin-bottom:14px;font-size:13.5px}' +
    '.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:13px 14px;margin-bottom:12px}' +
    '.card b{font-size:13px}.card .code,.snip{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:#B9BFC9;word-break:break-all}' +
    '.probe{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:13px 14px;margin-bottom:12px}' +
    '.ph{display:flex;justify-content:space-between;gap:10px;align-items:baseline;margin-bottom:6px}' +
    '.ph .code{color:var(--sub);font-size:10.5px}' +
    '.line{font-size:12.5px;color:#C4C9D4;margin:2px 0}.line b{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}' +
    '.ok{color:#4ADE80}.bad{color:#F87171}.warn{color:#FBBF24}' +
    '.meta{color:var(--sub)}.snip{margin-top:7px;padding:9px 10px;border-radius:9px;background:var(--panel2);border:1px solid var(--line);max-height:110px;overflow:hidden}' +
    'ul{margin:6px 0 0;padding-left:18px}li{font-size:12px;color:var(--sub);margin:3px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}' +
    '.foot{color:var(--sub);font-size:11.5px;line-height:1.6}' +
    '</style></head><body>' +
    '<h1>mp service — worker diagnostics</h1>' +
    '<div class="tag">' + esc(VERSION) + ' · ' + esc(new Date().toISOString()) + '</div>' +
    '<div class="verdict">' + esc(verdict) + '</div>' +
    probeRow('Probe 1 · as the app', 'browser-like, CF headers stripped', app) +
    probeRow('Probe 2 · minimal', 'accept + user-agent + origin only', mini) +
    probeRow('Probe 3 · old v2 style', 'browser-like + forwarded CF headers', forged) +
    '<div class="card"><b>What your request arrived with</b>' +
    (incoming.length ? '<ul>' + incoming.map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul>' :
      '<ul><li>(no Cloudflare edge headers seen — this request did not come through a Cloudflare edge)</li></ul>') +
    '<div class="foot">These headers were what a v2-era worker wrongly forwarded upstream. This build strips them; Probe 3 shows what the upstream thinks of them.</div></div>' +
    '<div class="foot">This page made three live calls to ' + esc(monoUpstream(event)) + '/ from inside the worker. It works with or without the PROXY_TOKEN, in any cookie state.</div>' +
    '</body></html>';

  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

/* map a Location header value into proxy space */
function mapLocation(loc, upUrl, event, tokMode) {
  try {
    const abs = new URL(loc, upUrl);
    if (abs.protocol !== 'https:' && abs.protocol !== 'http:') return loc;
    if (!hostAllowed(abs.host, event)) return loc; // external redirect — pass through untouched
    if (tokMode) {
      /* this response came from a /__t/ or /__o/ request — there is no
       * path prefix: EVERY allowed target becomes a worker handle,
       * path-preserving so the destination keeps resolving relatives. */
      const op = oTokPath(abs.toString());
      return op || tokPath(abs.toString());
    }
    if (abs.host === upUrl.host) {
      const pfx = prefixForHost(upUrl.host, event);
      return pfx + abs.pathname + abs.search;
    }
    return tokPath(abs.toString()); // opaque token, host stays unreadable
  } catch (e) {
    return loc;
  }
}
function prefixForHost(host, event) {
  if (host === monoHost(event)) return ''; // transparent: the app lives at /
  return '/p/' + host;
}

/* ---------------- HTML rewriting ---------------- */
/* Map a URL-ish attribute value into proxy space.
 * tokDoc: set when this document was itself served through
 *         /__t/<token> — it has NO path prefix to re-attach, so
 *         every URL it references (absolute, root-relative,
 *         relative) must be absolutized against tokDoc and
 *         tokenized: that is what keeps the whole app sandboxed
 *         inside opaque worker paths.
 * In tokDoc mode the token path is emitted ABSOLUTE (worker
 *         origin + /__t/…) because the document is painted into an
 *         about:srcdoc frame — a relative "/__t/…" cannot resolve
 *         against about:srcdoc's inherited file:// base, so every
 *         subresource (script, css, img) would silently fail. */
function mapAttr(v, pfx, host, allow, tokDoc, workerOrigin) {
  try {
    const s = String(v || '').trim();
    if (!s) return v;
    if (/^(data|blob|about|javascript|mailto|tel|sms|intent|ms-|chrome|file|#)/i.test(s)) return v;
    if (tokDoc) {
      const abs = new URL(s, tokDoc);
      if (abs.protocol !== 'https:' && abs.protocol !== 'http:') return v;
      const ok = allow.some((a) => abs.host === a || abs.host.endsWith('.' + a));
      if (!ok) return v;
      /* path-preserving form (absolute). The upstream PATH rides along
       * so relative references against this URL — dynamic import() of
       * sibling chunks above all — resolve to worker URLs that
       * reconstruct the right upstream file. */
      const op = oTokPath(abs.toString());
      return op ? (workerOrigin ? workerOrigin.replace(/\/$/, '') + op : op) : v;
    }
    let m;
    if ((m = s.match(/^https?:\/\/([^\/?#]+)/i))) {
      const h = m[1].toLowerCase();
      const ok = allow.some((a) => h === a || h.endsWith('.' + a));
      if (!ok) return v;
      if (h === host) {
        const rest = s.slice(m[0].length) || '/';
        return pfx + rest;
      }
      return tokPath(s); // opaque token, host stays unreadable
    }
    if ((m = s.match(/^\/\/([^\/?#]+)/))) {
      const h = m[1].toLowerCase();
      const ok = allow.some((a) => h === a || h.endsWith('.' + a));
      if (!ok) return v;
      if (h === host) {
        const rest = s.slice(m[0].length) || '/';
        return pfx + rest;
      }
      return tokPath('https:' + s); // protocol-relative → https token
    }
    if (s.charAt(0) === '/' && s.charAt(1) !== '/') return pfx + s;
    return v;
  } catch (e) {
    return v;
  }
}

const ATTR_NAMES = 'href|src|action|formaction|poster|data-src|data-href|data-url|data-background';

function rewriteHtml(text, pfx, host, workerOrigin, token, allow, tokDoc) {
  try {
    /* strip CSP meta tags and base targets */
    text = text.replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '');
    text = text.replace(/<base\b([^>]*?)\s+target\s*=\s*["'][^"']*["']/gi, '<base$1');

    /* rewrite URL attributes */
    const attrRe = new RegExp('(\\s(?:' + ATTR_NAMES + ')\\s*=\\s*)("([^"]*)"|\'([^\']*)\')', 'gi');
    text = text.replace(attrRe, (whole, pre, quoted, dq, sq) => {
      const v = dq !== undefined ? dq : sq;
      const nv = mapAttr(v, pfx, host, allow, tokDoc, workerOrigin);
      if (nv === v) return whole;
      return pre + '"' + String(nv).replace(/"/g, '%22') + '"';
    });

    /* srcset lists */
    const ssRe = /(\ssrcset\s*=\s*)("([^"]*)"|'([^']*)')/gi;
    text = text.replace(ssRe, (whole, pre, quoted, dq, sq) => {
      const v = dq !== undefined ? dq : sq;
      const nv = v.split(',').map((cand) => {
        const t = cand.trim();
        if (!t) return '';
        const sp = t.indexOf(' ');
        const u = sp < 0 ? t : t.slice(0, sp);
        const rest = sp < 0 ? '' : t.slice(sp);
        const nu = mapAttr(u, pfx, host, allow, tokDoc, workerOrigin);
        return nu === u ? t : nu + rest;
      }).filter(Boolean).join(', ');
      if (nv === v) return whole;
      return pre + '"' + nv + '"';
    });

    /* url() inside style="..." attributes only (inline JS safety) */
    const styleRe = /(\sstyle\s*=\s*)("([^"]*)"|'([^']*)')/gi;
    text = text.replace(styleRe, (whole, pre, quoted, dq, sq) => {
      const v = dq !== undefined ? dq : sq;
      const nv = v.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (w, q, u) => {
        const nu = mapAttr(u, pfx, host, allow, tokDoc, workerOrigin);
        return nu === u ? w : "url('" + nu + "')";
      });
      if (nv === v) return whole;
      return pre + '"' + nv.replace(/"/g, '&quot;') + '"';
    });

    /* inject config + runtime patch as the first script; also inject
     * a <base> pointing at this document's /__o/ mirror — the sandbox
     * document sits at about:srcdoc where relative URLs resolve against
     * NOTHING, so runtime-created refs (img.src = "foo.png", dynamic
     * import("./chunk.js") inside inline scripts, form submits without
     * actions) would all die. With <base> they resolve onto the worker,
     * path-preserved. The runtime's document.baseURI override still
     * reports the upstream URL to the app, so routers hydrate right. */
    const cfg = { pfx: pfx, host: host, worker: workerOrigin, token: token || '', allow: allow,
      key: TOK_KEY, tok: !!tokDoc, doc: tokDoc || '', sd: !!tokDoc };
    let inject = '<scr' + 'ipt>window.__MP__=' + JSON.stringify(cfg) + ';' + PATCH_JS + '</scr' + 'ipt>';
    if (tokDoc) {
      try {
        const bOp = oTokPath(tokDoc);
        if (bOp) inject = '<base href="' + (workerOrigin ? workerOrigin.replace(/\/$/, '') : '') + bOp + '">' + inject;
      } catch (eB) { /* ignore */ }
    }
    if (/<head[^>]*>/i.test(text)) text = text.replace(/<head[^>]*>/i, (m) => m + inject);
    else if (/<html[^>]*>/i.test(text)) text = text.replace(/<html[^>]*>/i, (m) => m + inject);
    else text = inject + text;
    return text;
  } catch (e) {
    return text;
  }
}

function rewriteCss(text, pfx, host, allow, tokDoc, workerOrigin) {
  try {
    text = text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (w, q, u) => {
      const nu = mapAttr(u, pfx, host, allow, tokDoc, workerOrigin);
      return nu === u ? w : 'url("' + nu + '")';
    });
    text = text.replace(/@import\s*(['"])([^'"]+)\1/gi, (w, q, u) => {
      /* \s* — minified css ships @import"https://…" with NO space and
       * NO parens. That exact form leaked the upstream hostname
       * straight to the browser once. */
      const nu = mapAttr(u, pfx, host, allow, tokDoc, workerOrigin);
      return nu === u ? w : '@import "' + nu + '"';
    });
    return text;
  } catch (e) {
    return text;
  }
}

/* ---------------- JS location-assignment rewrite ----------------
 * Served scripts may navigate the sandbox frame with
 *   location.href = X · location.assign/replace(X)
 * and SPA routers read location.href / pathname / origin to hydrate.
 * Inside the sandbox the document sits at about:srcdoc, so reads are
 * nonsense and writes navigate OUT. Every occurrence of those tokens
 * becomes __mpLoc.<prop> — the fake location the runtime patch
 * installs first. Patterns are deliberately conservative — one bad
 * wrap is a parse-time syntax error that kills a whole bundle.
 * `location = X` / `window.location = X` LVALUE forms are left RAW
 * (a real navigation the shell's escape recovery catches). */
function rewriteJsLocation(text) {
  try {
    if (!/location\b/.test(text)) return text;
    let out = text;
    /* member forms, prefixed (window/document/self/top/parent/globalThis).
     * `location?.` (optional chain) rewrites the same way — __mpLoc is
     * never null, so the semantics only get more reliable. */
    out = out.replace(/(?<![.\w$])(?:window|document|self|top|parent|globalThis|global)\.location\??\.(href|assign|replace|reload|pathname|search|hash|origin|host|hostname|protocol|port|toString)\b/gi,
      (w, prop) => '__mpLoc.' + prop);
    /* bare location.<prop> — the leading (?<![.\w$]) stops it from
     * matching x.location.href (nested-frame access) or mylocation.href: */
    out = out.replace(/(?<![.\w$])location\??\.(href|assign|replace|reload|pathname|search|hash|origin|host|hostname|protocol|port|toString)\b/gi,
      (w, prop) => '__mpLoc.' + prop);
    /* whole-object `window.location` READS (not followed by a member
     * access, not an lvalue write). Guards:
     *   - leading (?<![.\w$]) — contentWindow.location / x.location
     *     (real nested-frame access) stay untouched;
     *   - (?![.\w$]) — window.locationFoo never matches;
     *   - (?!\s*=(?!=)) — `window.location = X` writes stay REAL. */
    out = out.replace(/(?<![.\w$])(?:window|document|self|top|parent|globalThis|global)\.location(?![.\w$])(?!\s*=(?!=))/g,
      (w) => '__mpLoc');
    return out;
  } catch (e) {
    return text;
  }
}

/* ---------------- neutral service page (the root) ----------------
 * Everything a classifier can crawl at this origin must look like a
 * boring uptime page: no product names, no music UI, no Monochrome
 * strings. The real app only ever lives behind opaque /__t/<token>
 * fetches. */
function servicePage(req) {
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>service</title>' +
    '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0B0D12;color:#E7E9EE;font:15px/1.5 -apple-system,BlinkMacSystemFont,system-ui,"Segoe UI",Roboto,sans-serif}' +
    '.c{text-align:center}.d{width:44px;height:44px;margin:0 auto 14px;border-radius:50%;background:#2A2D36;display:flex;align-items:center;justify-content:center}.d svg{width:24px;height:24px}' +
    'h1{margin:0;font-size:17px;font-weight:600;color:#F5F6F8}p{margin:6px 0 0;color:#9AA1AD;font-size:13px}' +
    'code{font:12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;background:#1A1D28;border-radius:6px;padding:2px 6px;color:#C9CDD6}</style></head>' +
    '<body><div class="c"><div class="d"><svg viewBox="0 0 64 64"><path d="M18 34l10 10 20-24" stroke="#E7E9EE" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' +
    '<h1>Service online</h1>' +
    '<p>Relay endpoint &middot; status at <code>/__status</code></p>' +
    '</div></body></html>';
  return new Response(html, { status: 200, headers: corsHeaders(req, new Headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })) });
}

/* ---------------- websocket proxy ---------------- */
async function proxyWebsocket(req, url, event) {
  try {
    /* resolve upstream ws url */
    let target;
    let tokMode = false;
    if (url.pathname.startsWith('/__t/')) {
      /* opaque token (encodes the original ws/wss or http/https URL) */
      const dec = decTok(url.pathname.slice(5));
      if (!dec) return json({ error: 'bad token' }, req, 400);
      let t = dec;
      if (/^https?:\/\//i.test(t)) t = t.replace(/^http/i, 'ws');
      if (!/^wss?:\/\//i.test(t)) return json({ error: 'bad token' }, req, 400);
      const tu = new URL(t);
      if (!hostAllowed(tu.host, event)) return json({ error: 'host not allowed' }, req, 403);
      target = t;
      tokMode = true;
    } else if (url.pathname.startsWith('/p/')) {
      const rest = url.pathname.slice(3);
      const slash = rest.indexOf('/');
      const host = slash < 0 ? rest : rest.slice(0, slash);
      const path = slash < 0 ? '/' : rest.slice(slash);
      if (!hostAllowed(host, event)) return json({ error: 'host not allowed' }, req, 403);
      target = 'wss://' + host + path + url.search;
    } else {
      target = monoUpstream(event).replace(/^http/, 'ws') + url.pathname + url.search;
    }
    const t = new URL(target);
    if (tokMode) {
      /* merge browser-appended query params (minus __t) into the token's URL */
      for (const [k, v] of url.searchParams) {
        if (k === '__t') continue;
        if (!t.searchParams.has(k)) t.searchParams.set(k, v);
      }
    }
    if (t.searchParams.has('__t')) t.searchParams.delete('__t');

    const upHeaders = new Headers({ 'Upgrade': 'websocket' });
    const ck = mergeCookies(req.headers.get('cookie') || '', req.headers.get('x-cookie') || '');
    if (ck) upHeaders.set('cookie', ck);
    upHeaders.set('origin', 'https://' + t.host);

    const upRes = await fetch(t.toString(), { headers: upHeaders });
    const upWs = upRes.webSocket;
    if (!upWs) return json({ error: 'upstream refused websocket' }, req, 502);
    upWs.accept();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    client.accept();

    upWs.addEventListener('message', (e) => { try { client.send(e.data); } catch (err) { /* ignore */ } });
    client.addEventListener('message', (e) => { try { upWs.send(e.data); } catch (err) { /* ignore */ } });
    upWs.addEventListener('close', (e) => { try { client.close(e.code || 1000, e.reason || ''); } catch (err) { /* ignore */ } });
    client.addEventListener('close', (e) => { try { upWs.close(e.code || 1000, e.reason || ''); } catch (err) { /* ignore */ } });
    upWs.addEventListener('error', () => { try { client.close(); } catch (err) { /* ignore */ } });

    return new Response(null, { status: 101, webSocket: client });
  } catch (err) {
    return json({ error: 'websocket proxy failed', detail: String(err && err.message || err) }, req, 500);
  }
}

/* ---------------- landing / token setup page ---------------- */
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#171A23"/><path d="M16 44V20h6l10 14 10-14h6v24h-6V30L32 43 22 30v14z" fill="#E7E9EE"/></svg>';

function landing(event, bad) {
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<meta name="theme-color" content="#0B0D12">' +
    '<title>mp service — setup</title>' +
    '<link rel="icon" href="data:image/svg+xml,' + encodeURIComponent(FAVICON_SVG) + '">' +
    '<style>' +
    ':root{--bg:#0B0D12;--panel:#14161F;--panel2:#1A1D28;--line:rgba(255,255,255,.08);--txt:#E7E9EE;--sub:#9AA1AD;--acc:#D4D7DE;--bad:#9AA1AD}' +
    '*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}' +
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg);color:var(--txt);font-family:-apple-system,BlinkMacSystemFont,system-ui,"Segoe UI",Roboto,sans-serif;font-size:15px;line-height:1.5}' +
    '.card{width:100%;max-width:400px;background:var(--panel);border:1px solid var(--line);border-radius:22px;padding:28px 22px;box-shadow:0 24px 60px rgba(0,0,0,.5)}' +
    '.logoRow{display:flex;align-items:center;gap:12px;margin-bottom:18px}' +
    '.logo{width:46px;height:46px;border-radius:13px;background:linear-gradient(135deg,#2E313B,#1C1E26);display:flex;align-items:center;justify-content:center;flex:none;box-shadow:0 8px 24px rgba(0,0,0,.5)}' +
    '.logo svg{width:26px;height:26px}' +
    'h1{margin:0;font-size:21px;letter-spacing:.2px}' +
    '.tag{color:var(--sub);font-size:13px;margin-top:2px}' +
    'label{display:block;font-size:12.5px;color:var(--sub);margin:14px 0 7px;font-weight:600;letter-spacing:.3px}' +
    '.inWrap{display:flex;align-items:center;background:var(--panel2);border:1px solid var(--line);border-radius:13px;padding:0 12px;transition:border-color .15s}' +
    '.inWrap:focus-within{border-color:var(--acc)}' +
    'input{flex:1;background:none;border:none;outline:none;padding:13px 0;font-size:15px;color:var(--txt);min-width:0}' +
    'input::placeholder{color:#5b6270}' +
    '.btn{display:flex;align-items:center;justify-content:center;width:100%;margin-top:16px;padding:14px;border:none;border-radius:14px;font:inherit;font-weight:650;font-size:15px;background:var(--acc);color:#0B0D12;cursor:pointer}' +
    '.btn:active{transform:scale(.985)}' +
    '.err{margin-top:12px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,.06);border:1px solid var(--line);color:#C9CDD6;font-size:13px;line-height:1.5}' +
    '.hint{margin-top:14px;color:var(--sub);font-size:12.5px;line-height:1.6}' +
    '.hint b{color:var(--txt)}' +
    '</style></head><body><div class="card">' +
    '<div class="logoRow"><div class="logo"><svg viewBox="0 0 64 64"><path d="M16 44V20h6l10 14 10-14h6v24h-6V30L32 43 22 30v14z" fill="#E7E9EE"/></svg></div>' +
    '<div><h1>mp service</h1><div class="tag">This endpoint is protected by an access token.</div></div></div>' +
    (bad ? '<div class="err">That token was not accepted — check it and try again.</div>' : '') +
    '<form method="GET" action="/">' +
    '<label for="t">PROXY TOKEN</label>' +
    '<div class="inWrap"><input id="t" name="__t" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="paste your PROXY_TOKEN" autofocus></div>' +
    '<button class="btn" type="submit">Continue&nbsp;&rarr;</button></form>' +
    '<div class="hint">The token lives in your worker\u2019s <b>Settings &rarr; Variables &rarr; PROXY_TOKEN</b> on dash.cloudflare.com. ' +
    'It is stored in a cookie on this device, so you only enter it once.</div>' +
    '</div></body></html>';
  return new Response(html, { status: bad ? 401 : 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
