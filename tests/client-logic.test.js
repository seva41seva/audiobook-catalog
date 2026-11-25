"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function extractScriptFromHtml(html) {
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(m, "Expected <script> block in index.html");
  return m[1];
}

function createFakeElement(tag, id, className) {
  const classes = new Set((className || "").split(/\s+/).filter(Boolean));
  const attrs = new Map();
  const listeners = new Map();
  const children = [];
  let _innerHTML = "";
  let _textContent = "";

  const el = {
    tagName: String(tag || "div").toUpperCase(),
    id: id || "",
    style: {},
    dataset: {},
    value: "",
    checked: false,
    disabled: false,
    required: false,
    title: "",
    src: "",
    alt: "",
    href: "",
    children,
    classList: {
      add(...cs) { cs.forEach((c) => classes.add(c)); },
      remove(...cs) { cs.forEach((c) => classes.delete(c)); },
      toggle(c, force) {
        if (force === undefined) {
          if (classes.has(c)) { classes.delete(c); return false; }
          classes.add(c); return true;
        }
        if (force) classes.add(c); else classes.delete(c);
        return !!force;
      },
      contains(c) { return classes.has(c); },
    },
    get className() { return Array.from(classes).join(" "); },
    set className(v) {
      classes.clear();
      String(v || "").split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    },
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    removeAttribute(k) { attrs.delete(k); },
    addEventListener(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(fn);
    },
    removeEventListener(ev, fn) {
      const arr = listeners.get(ev) || [];
      listeners.set(ev, arr.filter((x) => x !== fn));
    },
    dispatchEvent(evObj) {
      const arr = listeners.get(evObj.type) || [];
      for (const fn of arr) fn(evObj);
    },
    click() { el.dispatchEvent({ type: "click", preventDefault() {}, stopPropagation() {} }); },
    focus() {},
    scrollIntoView() {},
    remove() {},
    appendChild(child) { children.push(child); return child; },
    getBoundingClientRect() { return { top: 0, bottom: 200 }; },
    set innerHTML(v) { _innerHTML = String(v || ""); children.length = 0; },
    get innerHTML() { return _innerHTML; },
    set textContent(v) { _textContent = String(v ?? ""); },
    get textContent() { return _textContent; },
    querySelector(sel) {
      if (sel === ".title" || sel === ".meta" || sel === ".mini-progress > div" || sel === ".chapter-check-btn" || sel === "span" || sel === ".kpi-val" || sel === ".kpi-lbl") {
        return createFakeElement("div");
      }
      return null;
    },
    querySelectorAll() { return []; },
  };
  return el;
}

function buildDomHarness(html, { hash = "#catalog", search = "", apiBaseUrlOverride = null } = {}) {
  let script = extractScriptFromHtml(html);
  if (apiBaseUrlOverride !== null) {
    script = script.replace(/apiBaseUrl:\s*"[^"]*"/, `apiBaseUrl: ${JSON.stringify(apiBaseUrlOverride)}`);
  }
  // Expose internal state/helpers at the end of IIFE for verification
  script = script.replace(
    /initApp\(\);\s*\}\)\(\);/,
    `initApp();
    window.__TEST__ = {
      isNearTrackEnd,
      setTrackCompleted,
      setBookCompleted,
      getBookProgress,
      collectFolderAudioEntries,
      clearAllHistory,
      storageKeyFor,
      upsertTrack,
      getTrack,
      loadTracks,
      loadJSON,
      saveJSON,
      foldersByPath,
      createEmptyFolderRecord,
      applySettingsToUI,
      showView,
      setUserForTest(u, tok){ currentUser = u; currentSessionToken = tok || null; },
      getState(){ return { activeView, currentUser, currentSessionToken, ROOT_URL }; },
      dom: {
        headerAdminBtn: $("#headerAdminBtn"),
        headerUserBtn: $("#headerUserBtn"),
        authView: $("#authView"),
        catalogView: $("#catalogView"),
        adminView: $("#adminView"),
        bookMarkDoneBtn: $("#bookMarkDoneBtn"),
        trackDoneBtn: $("#trackDoneBtn"),
      },
    };
    })();`
  );

  const byId = new Map();
  for (const m of html.matchAll(/<([a-z0-9-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const tag = m[1];
    const attrsStr = m[2];
    const id = m[3];
    const clsM = attrsStr.match(/\bclass="([^"]+)"/);
    byId.set(id, createFakeElement(tag, id, clsM ? clsM[1] : ""));
  }

  const lsMap = new Map();
  const localStorage = {
    getItem(k) { return lsMap.has(k) ? lsMap.get(k) : null; },
    setItem(k, v) { lsMap.set(k, String(v)); },
    removeItem(k) { lsMap.delete(k); },
    clear() { lsMap.clear(); },
  };

  const docListeners = new Map();
  const document = {
    title: "",
    visibilityState: "visible",
    body: createFakeElement("body"),
    querySelector(sel) {
      if (sel.startsWith("#")) {
        const id = sel.slice(1);
        if (!byId.has(id)) byId.set(id, createFakeElement("div", id));
        return byId.get(id);
      }
      return null;
    },
    querySelectorAll() { return []; },
    createElement(tag) { return createFakeElement(tag); },
    addEventListener(ev, fn) {
      if (!docListeners.has(ev)) docListeners.set(ev, []);
      docListeners.get(ev).push(fn);
    },
    removeEventListener() {},
  };
  // Patch audio element with extra playback methods/props
  const audioEl = byId.get("audio");
  Object.assign(audioEl, {
    currentTime: 0,
    duration: NaN,
    volume: 1,
    playbackRate: 1,
    paused: true,
    muted: false,
    buffered: { length: 0, end: () => 0 },
    load() {},
    play() { return Promise.resolve(); },
    pause() { this.paused = true; },
  });

  const loc = {
    origin: "https://seva41seva.github.io",
    pathname: "/audiobook-catalog/",
    hash,
    search,
    protocol: "https:",
    assign() {},
  };

  const context = {
    console,
    Math,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    RegExp,
    JSON,
    URL,
    URLSearchParams,
    Error,
    Promise,
    TextDecoder,
    AbortController,
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    requestAnimationFrame: (fn) => 1,
    confirm: () => true,
    alert: () => {},
    prompt: () => "",
    localStorage,
    location: loc,
    history: {
      pushState(_s, _t, u) { if (String(u).startsWith("#")) loc.hash = u; },
      replaceState(_s, _t, u) { const i = String(u).indexOf("#"); if (i >= 0) loc.hash = String(u).slice(i); },
    },
    navigator: {
      clipboard: { writeText: async () => {} },
    },
    matchMedia: () => ({ matches: false }),
    crypto: require("node:crypto").webcrypto,
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        ok: true,
        type: "dir",
        name: "Аудиотека",
        _embedded: { items: [], total: 0 },
      }),
      json: async () => ({ ok: true }),
    }),
    document,
  };
  context.window = context;
  context.window.addEventListener = () => {};
  context.window.scrollTo = () => {};

  vm.runInNewContext(script, context);
  return { T: context.__TEST__, localStorage, loc, lsMap };
}

test("index.html listened/progress logic: adaptive near-end, recursive folders, decoupled clearAllHistory & user isolation", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8");
  const { T, lsMap } = buildDomHarness(html, { apiBaseUrlOverride: "" });

  // 1. Adaptive isNearTrackEnd
  assert.equal(T.isNearTrackEnd(18.2, 20), true); // short 20s track: 2s margin -> 18s+ is near end
  assert.equal(T.isNearTrackEnd(10, 20), false);
  assert.equal(T.isNearTrackEnd(1792, 1800), true); // 30-min track: 10s margin -> 1790s+ is near end
  assert.equal(T.isNearTrackEnd(1780, 1800), false);

  // 2. Recursive multi-subfolder book progress & smart next-chapter selection
  const rootUrl = T.getState().ROOT_URL;
  const book = T.createEmptyFolderRecord("/Цикл", "Цикл");
  book.loaded = true;
  book.dirs = [
    { name: "Том 1", path: "/Цикл/Том 1" },
    { name: "Том 2", path: "/Цикл/Том 2" },
  ];
  const vol1 = T.createEmptyFolderRecord("/Цикл/Том 1", "Том 1");
  vol1.loaded = true;
  vol1.audios = [
    { name: "01.mp3", path: "/Цикл/Том 1/01.mp3", size: 100 },
    { name: "02.mp3", path: "/Цикл/Том 1/02.mp3", size: 100 },
  ];
  const vol2 = T.createEmptyFolderRecord("/Цикл/Том 2", "Том 2");
  vol2.loaded = true;
  vol2.audios = [
    { name: "03.mp3", path: "/Цикл/Том 2/03.mp3", size: 100 },
    { name: "04.mp3", path: "/Цикл/Том 2/04.mp3", size: 100 },
  ];
  T.foldersByPath.set("/Цикл", book);
  T.foldersByPath.set("/Цикл/Том 1", vol1);
  T.foldersByPath.set("/Цикл/Том 2", vol2);

  // Mark vol1 completed manually (without playing!)
  T.setBookCompleted(vol1, true);
  let prog = T.getBookProgress(book);
  assert.equal(prog.status, "in_progress");
  assert.equal(prog.pct, 50);
  assert.equal(prog.finishedCount, 2);
  assert.equal(prog.totalCount, 4);
  // Should suggest first uncompleted chapter (03.mp3 in Том 2)
  assert.equal(prog.resumeItem.path, "/Цикл/Том 2/03.mp3");
  assert.equal(prog.resumeBookPath, "/Цикл/Том 2");

  // Simulate playing 03.mp3 and finishing it -> should suggest 04.mp3
  const k3 = `${rootUrl}|||/Цикл/Том 2/03.mp3`;
  T.upsertTrack(k3, { position: 0, duration: 500, lastPlayedAt: Date.now(), inHistory: true, completed: true, completedBy: "auto", completedAt: Date.now() });
  prog = T.getBookProgress(book);
  assert.equal(prog.pct, 75);
  assert.equal(prog.resumeItem.path, "/Цикл/Том 2/04.mp3");

  // Mark whole parent book done -> 100% done
  T.setBookCompleted(book, true);
  prog = T.getBookProgress(book);
  assert.equal(prog.status, "done");
  assert.equal(prog.pct, 100);
  assert.equal(prog.finishedCount, 4);

  // 3. clearAllHistory clears positions & inHistory, keeps completed marks!
  const k4 = `${rootUrl}|||/Цикл/Том 2/04.mp3`;
  T.upsertTrack(k4, { position: 150, duration: 500, lastPlayedAt: Date.now(), inHistory: true });
  T.clearAllHistory();
  const afterClearBookProg = T.getBookProgress(book);
  assert.equal(afterClearBookProg.status, "done");
  assert.equal(T.getTrack(k4).position, 0);
  assert.equal(T.getTrack(k4).inHistory, false);
  assert.equal(T.getTrack(k4).completed, true);

  // 4. Per-user localStorage isolation
  T.setUserForTest({ id: "u_alice", name: "Алиса", role: "user" }, "tok_a");
  assert.equal(T.storageKeyFor("tracks"), "yd-player-u-v2::u_alice::tracks");
  T.setTrackCompleted(`${rootUrl}|||/Цикл/Том 1/01.mp3`, true, { title: "01.mp3" });
  T.setUserForTest({ id: "u_bob", name: "Боб", role: "user" }, "tok_b");
  assert.equal(T.storageKeyFor("tracks"), "yd-player-u-v2::u_bob::tracks");
  assert.equal(T.getTrack(`${rootUrl}|||/Цикл/Том 1/01.mp3`), null);
  assert.ok(lsMap.has("yd-player-u-v2::u_alice::tracks"));
});

test("index.html Cloud Mode auth gate & admin tab visibility", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8");
  const { T } = buildDomHarness(html, { apiBaseUrlOverride: "https://functions.yandexcloud.net/testfunc" });

  // Unauthenticated in Cloud mode -> stays on auth view, admin & user pills hidden
  assert.equal(T.getState().activeView, "auth");
  assert.equal(T.dom.authView.classList.contains("hidden"), false);
  assert.equal(T.dom.catalogView.classList.contains("hidden"), true);
  assert.equal(T.dom.headerAdminBtn.classList.contains("hidden"), true);
  assert.equal(T.dom.headerUserBtn.classList.contains("hidden"), true);

  // Regular user -> Admin button stays hidden even if showView("admin") is attempted!
  T.setUserForTest({ id: "u_mama", name: "Мама", role: "user" }, "tok_mama");
  T.showView("admin");
  assert.equal(T.getState().activeView, "catalog");
  assert.equal(T.dom.headerAdminBtn.classList.contains("hidden"), true);
  assert.equal(T.dom.headerUserBtn.classList.contains("hidden"), false);
  assert.equal(T.dom.adminView.classList.contains("hidden"), true);

  // Admin user -> Admin button visible and admin view accessible
  T.setUserForTest({ id: "admin_1", name: "Админ", role: "admin" }, "tok_admin");
  T.showView("admin");
  assert.equal(T.getState().activeView, "admin");
  assert.equal(T.dom.headerAdminBtn.classList.contains("hidden"), false);
  assert.equal(T.dom.adminView.classList.contains("hidden"), false);
});
