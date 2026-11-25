"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function createMockPlatform() {
  const appFiles = new Map(); // "app:/..." -> string
  const appDirs = new Set(["app:/"]);
  const publicTree = {
    "/": {
      name: "Аудиотека",
      items: [
        { type: "dir", name: "Книга 1", path: "/Книга 1" },
        { type: "dir", name: "Цикл", path: "/Цикл" },
      ],
    },
    "/Книга 1": {
      name: "Книга 1",
      items: [
        { type: "file", name: "01.mp3", path: "/Книга 1/01.mp3", size: 1200, mime_type: "audio/mpeg" },
        { type: "file", name: "02.mp3", path: "/Книга 1/02.mp3", size: 1400, mime_type: "audio/mpeg" },
        { type: "file", name: "cover.jpg", path: "/Книга 1/cover.jpg", mime_type: "image/jpeg" },
        { type: "file", name: "описание.txt", path: "/Книга 1/описание.txt", mime_type: "text/plain" },
      ],
    },
    "/Цикл": {
      name: "Цикл",
      items: [
        { type: "dir", name: "Том 1", path: "/Цикл/Том 1" },
      ],
    },
    "/Цикл/Том 1": {
      name: "Том 1",
      items: [
        { type: "file", name: "глава1.mp3", path: "/Цикл/Том 1/глава1.mp3", size: 800, mime_type: "audio/mpeg" },
      ],
    },
  };

  let uploadSeq = 0;
  const pendingUploads = new Map();
  let currentYandexUser = { id: "100500", login: "admin_user", display_name: "Главный Админ" };
  let publicAuthHeadersSeen = [];

  // Windows-1251 bytes for "Привет мир"
  const win1251Text = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x20, 0xec, 0xe8, 0xf0]);

  async function mockFetch(url, options = {}) {
    const u = new URL(String(url));
    const method = (options.method || "GET").toUpperCase();
    const headers = options.headers || {};

    if (u.origin === "https://oauth.yandex.ru" && u.pathname === "/token") {
      const params = new URLSearchParams(options.body || "");
      const gt = params.get("grant_type");
      if (gt === "authorization_code") {
        return jsonRes(200, {
          access_token: "acc_admin_1",
          refresh_token: "ref_admin_1",
          expires_in: 3600,
        });
      }
      if (gt === "refresh_token") {
        return jsonRes(200, {
          access_token: "acc_admin_refreshed",
          refresh_token: params.get("refresh_token"),
          expires_in: 3600,
        });
      }
    }

    if (u.origin === "https://login.yandex.ru" && u.pathname === "/info") {
      return jsonRes(200, currentYandexUser);
    }

    if (u.origin === "https://cloud-api.yandex.net") {
      // Публичный диск (должен вызываться БЕЗ Authorization заголовка!)
      if (u.pathname === "/v1/disk/public/resources") {
        publicAuthHeadersSeen.push(headers.Authorization || headers.authorization || null);
        const dirPath = u.searchParams.get("path") || "/";
        const node = publicTree[dirPath];
        if (!node) return jsonRes(404, { message: "Not found" });
        return jsonRes(200, {
          type: "dir",
          name: node.name,
          _embedded: { items: node.items, total: node.items.length },
        });
      }
      if (u.pathname === "/v1/disk/public/resources/download") {
        publicAuthHeadersSeen.push(headers.Authorization || headers.authorization || null);
        const fp = u.searchParams.get("path") || "/";
        return jsonRes(200, { href: "https://dl.mock.yandex.net/public?path=" + encodeURIComponent(fp) });
      }

      // Приватный app:/ диск (требует Authorization: OAuth ...)
      const auth = headers.Authorization || headers.authorization || "";
      if (!auth.startsWith("OAuth ")) {
        return jsonRes(401, { message: "Unauthorized" });
      }

      const diskPath = u.searchParams.get("path") || "";
      if (u.pathname === "/v1/disk/resources" && method === "PUT") {
        if (appDirs.has(diskPath)) return jsonRes(409, { message: "Exists" });
        appDirs.add(diskPath);
        return jsonRes(201, { path: diskPath });
      }
      if (u.pathname === "/v1/disk/resources" && method === "DELETE") {
        appFiles.delete(diskPath);
        appDirs.delete(diskPath);
        return { ok: true, status: 204, json: async () => ({}), text: async () => "" };
      }
      if (u.pathname === "/v1/disk/resources" && method === "GET") {
        if (appDirs.has(diskPath)) {
          const prefix = diskPath.endsWith("/") ? diskPath : diskPath + "/";
          const items = [];
          for (const k of appFiles.keys()) {
            if (k.startsWith(prefix) && !k.slice(prefix.length).includes("/")) {
              items.push({ type: "file", name: k.slice(prefix.length), path: k });
            }
          }
          return jsonRes(200, { type: "dir", _embedded: { items, total: items.length } });
        }
        if (appFiles.has(diskPath)) {
          return jsonRes(200, { type: "file", path: diskPath });
        }
        return jsonRes(404, { message: "Not found" });
      }
      if (u.pathname === "/v1/disk/resources/download") {
        if (!appFiles.has(diskPath)) return jsonRes(404, { message: "Not found" });
        return jsonRes(200, { href: "https://dl.mock.yandex.net/app?path=" + encodeURIComponent(diskPath) });
      }
      if (u.pathname === "/v1/disk/resources/upload") {
        const upId = "u" + ++uploadSeq;
        pendingUploads.set(upId, diskPath);
        return jsonRes(200, { href: "https://ul.mock.yandex.net/" + upId, method: "PUT" });
      }
    }

    if (u.origin === "https://dl.mock.yandex.net" && u.pathname === "/app") {
      const dp = u.searchParams.get("path");
      if (!appFiles.has(dp)) return { ok: false, status: 404, text: async () => "" };
      const txt = appFiles.get(dp);
      return { ok: true, status: 200, text: async () => txt };
    }

    if (u.origin === "https://dl.mock.yandex.net" && u.pathname === "/public") {
      const fp = u.searchParams.get("path");
      if (fp === "/Книга 1/описание.txt") {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => win1251Text.buffer.slice(win1251Text.byteOffset, win1251Text.byteOffset + win1251Text.byteLength),
        };
      }
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from("text").buffer };
    }

    if (u.origin === "https://ul.mock.yandex.net") {
      const upId = u.pathname.slice(1);
      const targetPath = pendingUploads.get(upId);
      appFiles.set(targetPath, String(options.body || ""));
      return { ok: true, status: 201, text: async () => "" };
    }

    throw new Error("Unexpected fetch: " + url);
  }

  function jsonRes(status, obj) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => obj,
      text: async () => JSON.stringify(obj),
    };
  }

  return {
    mockFetch,
    appFiles,
    appDirs,
    setYandexUser(u) { currentYandexUser = u; },
    getPublicAuthHeaders() { return publicAuthHeadersSeen; },
  };
}

async function invoke(handler, action, method = "GET", { body, query, token } = {}) {
  const event = {
    httpMethod: method,
    headers: {
      origin: "https://seva41seva.github.io",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    queryStringParameters: { action, ...(query || {}) },
    body: body ? JSON.stringify(body) : "",
  };
  const res = await handler(event);
  return { statusCode: res.statusCode, headers: res.headers, data: res.body ? JSON.parse(res.body) : null };
}

test("Cloud Function end-to-end flow: admin OAuth, invites, PIN auth, lockout, progress merge, cache & security", async () => {
  const envBackup = { ...process.env };
  process.env.YANDEX_CLIENT_ID = "cid_123";
  process.env.YANDEX_CLIENT_SECRET = "csec_456";
  process.env.ADMIN_YANDEX_ID = "100500,admin_user";
  process.env.SESSION_SECRET = "super-secret-key-for-tests-123456";
  process.env.CATALOG_PUBLIC_URL = "https://disk.yandex.com/d/Qb_HBohs2k5iEg";
  delete process.env.YANDEX_REFRESH_TOKEN;
  delete process.env.YANDEX_ACCESS_TOKEN;

  const platform = createMockPlatform();
  const origFetch = global.fetch;
  global.fetch = platform.mockFetch;

  const modPath = path.resolve(__dirname, "../cloud-function/index.js");
  delete require.cache[modPath];
  const gw = require(modPath);

  try {
    // 1. Bootstrap check
    const boot = await invoke(gw.handler, "public/bootstrap");
    assert.equal(boot.statusCode, 200);
    assert.equal(boot.data.yandexClientId, "cid_123");
    assert.equal(boot.data.diskConfigured, false);

    // 2. Non-admin Yandex login rejected with ID hint
    platform.setYandexUser({ id: "999", login: "stranger", display_name: "Чужой" });
    const badAdmin = await invoke(gw.handler, "auth/admin-yandex", "POST", {
      body: { code: "oauth_code_1", redirectUri: "https://seva41seva.github.io/audiobook-catalog/" },
    });
    assert.equal(badAdmin.statusCode, 403);
    assert.match(badAdmin.data.error, /ID: 999/);

    // isAllowedAdminYandexUser tolerates @yandex.ru, quotes, @prefix, and default_email
    const prevAdminEnv = process.env.ADMIN_YANDEX_ID;
    process.env.ADMIN_YANDEX_ID = '"seva41seva@yandex.ru", @other_admin';
    assert.equal(gw._internal.isAllowedAdminYandexUser({ id: "123", login: "seva41seva" }), true);
    assert.equal(gw._internal.isAllowedAdminYandexUser({ id: "123", login: "other_admin" }), true);
    assert.equal(gw._internal.isAllowedAdminYandexUser({ id: "123", login: "stranger" }), false);
    process.env.ADMIN_YANDEX_ID = prevAdminEnv;

    // 3. Valid admin login initializes app:/ and returns setupPending refresh token
    platform.setYandexUser({ id: "100500", login: "admin_user", display_name: "Главный Админ" });
    const adminLogin = await invoke(gw.handler, "auth/admin-yandex", "POST", {
      body: { code: "oauth_code_2", redirectUri: "https://seva41seva.github.io/audiobook-catalog/" },
    });
    assert.equal(adminLogin.statusCode, 200);
    assert.equal(adminLogin.data.user.role, "admin");
    assert.equal(adminLogin.data.setupPending.refreshToken, "ref_admin_1");
    const adminToken = adminLogin.data.sessionToken;
    const inviteCode1 = adminLogin.data.configSummary.activeInviteCode;
    assert.ok(inviteCode1.length >= 10);
    assert.ok(platform.appDirs.has("app:/users"));
    assert.ok(platform.appDirs.has("app:/progress"));
    assert.ok(platform.appDirs.has("app:/cache"));
    assert.ok(platform.appDirs.has("app:/stats"));

    // 4. Invite check & user registration
    const chk1 = await invoke(gw.handler, "auth/invite-check", "GET", { query: { code: inviteCode1 } });
    assert.equal(chk1.data.valid, true);

    const badPinReg = await invoke(gw.handler, "auth/register", "POST", {
      body: { inviteCode: inviteCode1, name: "Мама", pin: "12" },
    });
    assert.equal(badPinReg.statusCode, 400);

    const reg = await invoke(gw.handler, "auth/register", "POST", {
      body: { inviteCode: inviteCode1, name: "  Мама  ", pin: "1234" },
    });
    assert.equal(reg.statusCode, 200);
    assert.equal(reg.data.user.name, "Мама");
    assert.equal(reg.data.user.role, "user");
    let mamaToken = reg.data.sessionToken;

    // Duplicate registration rejected
    const dupReg = await invoke(gw.handler, "auth/register", "POST", {
      body: { inviteCode: inviteCode1, name: "мама", pin: "5678" },
    });
    assert.equal(dupReg.statusCode, 409);

    // Non-admin cannot access admin endpoints
    const forbiddenAdmin = await invoke(gw.handler, "admin/stats", "GET", { token: mamaToken });
    assert.equal(forbiddenAdmin.statusCode, 403);

    // 5. Invite rotation invalidates old invite for registration, keeps existing user login working
    const rot = await invoke(gw.handler, "admin/invite-rotate", "POST", { token: adminToken });
    assert.equal(rot.statusCode, 200);
    const inviteCode2 = rot.data.activeInviteCode;
    assert.notEqual(inviteCode2, inviteCode1);

    const oldInviteReg = await invoke(gw.handler, "auth/register", "POST", {
      body: { inviteCode: inviteCode1, name: "Папа", pin: "4321" },
    });
    assert.equal(oldInviteReg.statusCode, 403);

    const reloginMama = await invoke(gw.handler, "auth/login", "POST", {
      body: { name: "мама", pin: "1234" },
    });
    assert.equal(reloginMama.statusCode, 200);

    // 6. Progress sync: decoupling completed from clearHistory / position
    const trackKey = "https://disk.yandex.com/d/Qb_HBohs2k5iEg|||/Книга 1/01.mp3";
    const sync1 = await invoke(gw.handler, "progress/sync", "POST", {
      token: mamaToken,
      body: {
        tracks: {
          [trackKey]: {
            url: trackKey,
            title: "01.mp3",
            duration: 600,
            position: 120,
            lastPlayedAt: 1000,
            inHistory: true,
            completed: true,
            completedAt: 2000,
            completedBy: "manual",
            bookPath: "/Книга 1",
            folderName: "Книга 1",
          },
        },
        bookmarks: { [trackKey]: [{ t: 55, label: "00:55", createdAt: 1000 }] },
        bookmarksMeta: { [trackKey]: 1000 },
      },
    });
    assert.equal(sync1.statusCode, 200);
    assert.equal(sync1.data.progress.tracks[trackKey].completed, true);

    // Simulate another device clearing history while keeping completed=true OR older uncompleted sync
    const sync2 = await invoke(gw.handler, "progress/sync", "POST", {
      token: mamaToken,
      body: {
        tracks: {
          [trackKey]: {
            url: trackKey,
            title: "01.mp3",
            duration: 600,
            position: 0,
            lastPlayedAt: 3000,
            inHistory: false,
            completed: true,
            completedAt: 2000,
            completedBy: "manual",
            bookPath: "/Книга 1",
            folderName: "Книга 1",
          },
        },
      },
    });
    assert.equal(sync2.data.progress.tracks[trackKey].inHistory, false);
    assert.equal(sync2.data.progress.tracks[trackKey].completed, true);

    // 7. Catalog cache rebuild & public proxy WITHOUT Authorization header + windows-1251 decoding
    const rebuild = await invoke(gw.handler, "admin/cache-rebuild", "POST", { token: adminToken });
    assert.equal(rebuild.statusCode, 200);
    assert.equal(rebuild.data.cacheInfo.bookCount, 2);
    assert.equal(rebuild.data.cacheInfo.audioCount, 3);
    assert.equal(rebuild.data.index.folders["/Книга 1"].descText, "Привет мир");
    assert.ok(platform.getPublicAuthHeaders().every((h) => h === null));

    const catIdx = await invoke(gw.handler, "catalog/index", "GET", { token: mamaToken });
    assert.equal(catIdx.statusCode, 200);
    assert.equal(catIdx.data.cached, true);

    const diskTxt = await invoke(gw.handler, "disk/text", "GET", {
      token: mamaToken,
      query: { path: "/Книга 1/описание.txt" },
    });
    assert.equal(diskTxt.statusCode, 200);
    assert.equal(diskTxt.data.text, "Привет мир");

    // 8. Admin stats & backup never leak PIN hashes
    const stats = await invoke(gw.handler, "admin/stats", "GET", { token: adminToken });
    assert.equal(stats.statusCode, 200);
    assert.equal(stats.data.users.length, 1);
    assert.equal(stats.data.users[0].completedFiles, 1);
    assert.equal(stats.data.users[0].pinHash, undefined);
    assert.equal(stats.data.users[0].pinSalt, undefined);

    const backup = await invoke(gw.handler, "admin/backup", "GET", { token: adminToken });
    assert.equal(backup.statusCode, 200);
    assert.equal(backup.data.backup.users[0].pinHash, undefined);

    // 9. Admin reset PIN invalidates old tokenVersion
    const nameHash = stats.data.users[0].nameHash;
    const resetRes = await invoke(gw.handler, "admin/user-reset-pin", "POST", {
      token: adminToken,
      body: { nameHash, newPin: "9876" },
    });
    assert.equal(resetRes.statusCode, 200);

    const staleMe = await invoke(gw.handler, "auth/me", "GET", { token: mamaToken });
    assert.equal(staleMe.statusCode, 401);

    // 10. Brute-force PIN lockout persists in app:/users/<hash>.json
    for (let i = 1; i <= 4; i++) {
      const bad = await invoke(gw.handler, "auth/login", "POST", { body: { name: "Мама", pin: "0000" } });
      assert.equal(bad.statusCode, 401);
    }
    const locked = await invoke(gw.handler, "auth/login", "POST", { body: { name: "Мама", pin: "0000" } });
    assert.equal(locked.statusCode, 429);

    // Even right PIN is locked during 15 min window
    const lockedValid = await invoke(gw.handler, "auth/login", "POST", { body: { name: "Мама", pin: "9876" } });
    assert.equal(lockedValid.statusCode, 429);

    // Admin blocking + unblocking + delete
    const blk = await invoke(gw.handler, "admin/user-toggle-block", "POST", {
      token: adminToken,
      body: { nameHash, blocked: true },
    });
    assert.equal(blk.statusCode, 200);
    const blockedLogin = await invoke(gw.handler, "auth/login", "POST", { body: { name: "Мама", pin: "9876" } });
    assert.equal(blockedLogin.statusCode, 403);

    const del = await invoke(gw.handler, "admin/user-delete", "POST", {
      token: adminToken,
      body: { nameHash },
    });
    assert.equal(del.statusCode, 200);
    const afterDelStats = await invoke(gw.handler, "admin/stats", "GET", { token: adminToken });
    assert.equal(afterDelStats.data.users.length, 0);
  } finally {
    global.fetch = origFetch;
    Object.keys(process.env).forEach((k) => {
      if (!(k in envBackup)) delete process.env[k];
      else process.env[k] = envBackup[k];
    });
  }
});
