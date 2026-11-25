"use strict";

/**
 * Yandex Cloud Function для каталога аудиокниг («Аудиотека»).
 * Нулевые внешние зависимости — только встроенные модули Node.js (>= 18).
 *
 * Переменные окружения (Environment Variables):
 *   YANDEX_CLIENT_ID       — ID приложения из oauth.yandex.ru
 *   YANDEX_CLIENT_SECRET   — Пароль (secret) приложения из oauth.yandex.ru
 *   ADMIN_YANDEX_ID        — Ваш логин или числовой UID в Яндексе (можно несколько через запятую)
 *   SESSION_SECRET         — Случайная секретная строка (от 16 символов) для подписи JWT-сессий
 *   YANDEX_REFRESH_TOKEN   — Refresh-токен администратора (указывается 1 раз после первого входа админа)
 *   YANDEX_ACCESS_TOKEN    — (необязательно) Запасной OAuth-токен администратора
 *   CATALOG_PUBLIC_URL     — Публичная ссылка на папку с книгами на Яндекс Диске
 *   ALLOWED_ORIGINS        — Разрешённые Origin для CORS (по умолчанию "*")
 */

const crypto = require("node:crypto");

const DEFAULT_CATALOG_URL = "https://disk.yandex.com/d/Qb_HBohs2k5iEg";
const YANDEX_DISK_API = "https://cloud-api.yandex.net/v1/disk";
const YANDEX_OAUTH_TOKEN_URL = "https://oauth.yandex.ru/token";
const YANDEX_LOGIN_INFO_URL = "https://login.yandex.ru/info?format=json";

const APP_SUBFOLDERS = ["users", "progress", "cache", "stats"];
const USER_SESSION_TTL_SEC = 90 * 24 * 3600;
const ADMIN_SESSION_TTL_SEC = 30 * 24 * 3600;
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCK_MS = 15 * 60 * 1000;

// Кэш access_token в памяти тёплого контейнера
const tokenCache = {
  accessToken: null,
  refreshToken: null,
  expiresAt: 0,
};

// -------------------- Конфиг и утилиты --------------------

function getEnv(name, fallback = "") {
  const v = process.env[name];
  return typeof v === "string" ? v.trim() : fallback;
}

function getCatalogPublicUrl() {
  const raw = getEnv("CATALOG_PUBLIC_URL", DEFAULT_CATALOG_URL);
  return cleanYandexUrl(raw || DEFAULT_CATALOG_URL);
}

function cleanYandexUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return String(url || "").split("#")[0].split("?")[0];
  }
}

function normalizeDiskPath(p) {
  if (!p || p === "/") return "/";
  let s = String(p).replace(/\/+/g, "/");
  if (!s.startsWith("/")) s = "/" + s;
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

function normalizeUserName(name) {
  return String(name || "").trim().replace(/\s+/g, " ");
}

function hashUserName(name) {
  const key = normalizeUserName(name).toLowerCase();
  return crypto.createHash("sha256").update(key, "utf8").digest("hex").slice(0, 24);
}

function isValidHexId(val) {
  return /^[a-f0-9]{16,64}$/i.test(String(val || ""));
}

function isValidUserId(val) {
  return /^(u|admin)_[a-zA-Z0-9_-]{3,48}$/.test(String(val || ""));
}

function isValidPin(pin) {
  return /^\d{4,6}$/.test(String(pin || ""));
}

function randomToken(bytes = 16) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function hashPin(pin, salt) {
  return crypto.pbkdf2Sync(String(pin), String(salt), 100000, 32, "sha256").toString("hex");
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function getSessionSecret() {
  const sec = getEnv("SESSION_SECRET");
  if (!sec || sec.length < 16) {
    throw httpError(500, "На сервере не задана безопасная переменная SESSION_SECRET (минимум 16 символов).");
  }
  return sec;
}

function signJwt(payload, ttlSec) {
  const secret = getSessionSecret();
  const nowSec = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ ...payload, iat: nowSec, exp: nowSec + ttlSec })).toString("base64url");
  const data = `${header}.${body}`;
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function verifyJwt(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const secret = getSessionSecret();
  const expectedSig = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  if (!safeEqual(sig, expectedSig)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const nowSec = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < nowSec) return null;
    return payload;
  } catch {
    return null;
  }
}

function httpError(statusCode, message, extra = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.extra = extra;
  return err;
}

function decodeTextBuffer(buf) {
  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      text = new TextDecoder("windows-1251").decode(buf);
    } catch {
      text = new TextDecoder("utf-8").decode(buf);
    }
  }
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
}

// -------------------- OAuth и токен администратора --------------------

async function exchangeAuthCode(code, redirectUri) {
  const clientId = getEnv("YANDEX_CLIENT_ID");
  const clientSecret = getEnv("YANDEX_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw httpError(500, "На сервере не заданы YANDEX_CLIENT_ID и YANDEX_CLIENT_SECRET.");
  }
  const params = new URLSearchParams();
  params.set("grant_type", "authorization_code");
  params.set("code", String(code));
  params.set("client_id", clientId);
  params.set("client_secret", clientSecret);
  if (redirectUri) params.set("redirect_uri", String(redirectUri));

  const res = await fetch(YANDEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw httpError(401, data.error_description || data.error || "Не удалось обменять код авторизации Яндекса.");
  }
  return data;
}

async function refreshAdminAccessToken(refreshToken) {
  const clientId = getEnv("YANDEX_CLIENT_ID");
  const clientSecret = getEnv("YANDEX_CLIENT_SECRET");
  if (!clientId || !clientSecret || !refreshToken) {
    throw httpError(503, "Не настроен YANDEX_REFRESH_TOKEN для доступа к папке администратора.");
  }
  const params = new URLSearchParams();
  params.set("grant_type", "refresh_token");
  params.set("refresh_token", refreshToken);
  params.set("client_id", clientId);
  params.set("client_secret", clientSecret);

  const res = await fetch(YANDEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw httpError(503, "Не удалось обновить токен Яндекса: " + (data.error_description || data.error || res.status));
  }
  const ttlMs = Math.max(60, (Number(data.expires_in) || 3600) - 300) * 1000;
  tokenCache.accessToken = data.access_token;
  tokenCache.refreshToken = data.refresh_token || refreshToken;
  tokenCache.expiresAt = Date.now() + ttlMs;
  return tokenCache.accessToken;
}

async function getAdminDiskToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && tokenCache.accessToken && tokenCache.expiresAt > now) {
    return tokenCache.accessToken;
  }
  const envRefresh = getEnv("YANDEX_REFRESH_TOKEN") || tokenCache.refreshToken;
  if (envRefresh) {
    return refreshAdminAccessToken(envRefresh);
  }
  const envAccess = getEnv("YANDEX_ACCESS_TOKEN");
  if (envAccess) {
    tokenCache.accessToken = envAccess;
    tokenCache.expiresAt = now + 30 * 60 * 1000;
    return envAccess;
  }
  if (tokenCache.accessToken) return tokenCache.accessToken;
  throw httpError(503, "Хранилище администратора ещё не подключено: администратор должен войти через Яндекс и сохранить YANDEX_REFRESH_TOKEN.");
}

async function fetchYandexUserInfo(accessToken) {
  const res = await fetch(YANDEX_LOGIN_INFO_URL, {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    throw httpError(401, "Не удалось получить профиль пользователя Яндекса.");
  }
  return data;
}

function isAllowedAdminYandexUser(info) {
  const allowedRaw = getEnv("ADMIN_YANDEX_ID");
  if (!allowedRaw) {
    throw httpError(500, "На сервере не задана переменная ADMIN_YANDEX_ID (ваш логин или ID в Яндексе).");
  }
  const allowedList = allowedRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const uid = String(info.id || "").toLowerCase();
  const login = String(info.login || "").toLowerCase();
  return allowedList.includes(uid) || (login && allowedList.includes(login));
}

// -------------------- Клиент Яндекс Диска (app:/) --------------------

async function diskApiFetch(endpoint, options = {}, overrideToken = null, retryAuth = true) {
  const token = overrideToken || (await getAdminDiskToken(false));
  const res = await fetch(`${YANDEX_DISK_API}${endpoint}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `OAuth ${token}`,
    },
  });
  if (res.status === 401 && retryAuth && !overrideToken) {
    const freshToken = await getAdminDiskToken(true);
    return diskApiFetch(endpoint, options, freshToken, false);
  }
  return res;
}

async function diskEnsureFolder(appPath, overrideToken = null) {
  const res = await diskApiFetch(
    `/resources?path=${encodeURIComponent(appPath)}`,
    { method: "PUT" },
    overrideToken
  );
  if (res.status === 201 || res.status === 409 || res.ok) return true;
  const errData = await res.json().catch(() => ({}));
  throw httpError(502, `Не удалось создать папку ${appPath}: ${errData.message || res.status}`);
}

async function diskReadJson(appPath, fallback = null, overrideToken = null) {
  const res = await diskApiFetch(
    `/resources/download?path=${encodeURIComponent(appPath)}`,
    { method: "GET" },
    overrideToken
  );
  if (res.status === 404) return fallback;
  const meta = await res.json().catch(() => ({}));
  if (!res.ok || !meta.href) {
    if (res.status === 404) return fallback;
    throw httpError(502, `Ошибка чтения ${appPath}: ${meta.message || res.status}`);
  }
  const dlRes = await fetch(meta.href);
  if (dlRes.status === 404) return fallback;
  if (!dlRes.ok) throw httpError(502, `Не удалось скачать ${appPath}: HTTP ${dlRes.status}`);
  const text = await dlRes.text();
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function diskWriteJson(appPath, data, overrideToken = null) {
  const res = await diskApiFetch(
    `/resources/upload?path=${encodeURIComponent(appPath)}&overwrite=true`,
    { method: "GET" },
    overrideToken
  );
  const meta = await res.json().catch(() => ({}));
  if (!res.ok || !meta.href) {
    throw httpError(502, `Ошибка подготовки записи ${appPath}: ${meta.message || res.status}`);
  }
  const upRes = await fetch(meta.href, {
    method: meta.method || "PUT",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(data, null, 2),
  });
  if (!upRes.ok) {
    throw httpError(502, `Ошибка записи файла ${appPath}: HTTP ${upRes.status}`);
  }
  return true;
}

async function diskDelete(appPath, overrideToken = null) {
  const res = await diskApiFetch(
    `/resources?path=${encodeURIComponent(appPath)}&permanently=true`,
    { method: "DELETE" },
    overrideToken
  );
  if (res.status === 204 || res.status === 202 || res.status === 404 || res.ok) return true;
  const errData = await res.json().catch(() => ({}));
  throw httpError(502, `Ошибка удаления ${appPath}: ${errData.message || res.status}`);
}

async function diskListAppDir(appPath, overrideToken = null) {
  let all = [];
  let offset = 0;
  const limit = 200;
  for (let i = 0; i < 20; i++) {
    const res = await diskApiFetch(
      `/resources?path=${encodeURIComponent(appPath)}&limit=${limit}&offset=${offset}`,
      { method: "GET" },
      overrideToken
    );
    if (res.status === 404) return [];
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw httpError(502, `Ошибка чтения папки ${appPath}: ${data.message || res.status}`);
    }
    const items = (data._embedded && data._embedded.items) || [];
    const total = (data._embedded && typeof data._embedded.total === "number") ? data._embedded.total : items.length;
    all = all.concat(items);
    offset += items.length;
    if (!items.length || offset >= total) break;
  }
  return all;
}

async function diskCheckExists(appPath, overrideToken = null) {
  const res = await diskApiFetch(
    `/resources?path=${encodeURIComponent(appPath)}&limit=1`,
    { method: "GET" },
    overrideToken
  );
  return res.ok;
}

async function ensureStorageInitialized(adminInfo = null, overrideToken = null) {
  for (const sub of APP_SUBFOLDERS) {
    await diskEnsureFolder(`app:/${sub}`, overrideToken);
  }
  let config = await diskReadJson("app:/config.json", null, overrideToken);
  const now = Date.now();
  if (!config) {
    config = {
      version: 1,
      adminYandexId: adminInfo ? String(adminInfo.id) : "",
      adminLogin: adminInfo ? String(adminInfo.login || "") : "",
      catalogPublicUrl: getCatalogPublicUrl(),
      activeInviteCode: randomToken(9),
      inviteCreatedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await diskWriteJson("app:/config.json", config, overrideToken);
  } else if (!config.activeInviteCode) {
    config.activeInviteCode = randomToken(9);
    config.inviteCreatedAt = now;
    config.updatedAt = now;
    await diskWriteJson("app:/config.json", config, overrideToken);
  }
  return config;
}

// -------------------- Прогресс и умное слияние --------------------

function createEmptyProgress(userId) {
  return {
    version: 2,
    userId,
    updatedAt: Date.now(),
    tracks: {},
    bookmarks: {},
    bookmarksMeta: {},
    settings: {},
    settingsUpdatedAt: 0,
  };
}

function normalizeTrackRecord(tr, fallbackUrl) {
  if (!tr || typeof tr !== "object") return null;
  const completed = typeof tr.completed === "boolean" ? tr.completed : Boolean(tr.finished);
  const lastPlayedAt = Number(tr.lastPlayedAt || tr.updatedAt || 0);
  const completedAt = Number(tr.completedAt || (completed ? (tr.updatedAt || 0) : 0));
  return {
    url: tr.url || fallbackUrl || "",
    title: tr.title || "",
    size: tr.size ?? null,
    mime: tr.mime ?? null,
    duration: typeof tr.duration === "number" ? tr.duration : null,
    position: typeof tr.position === "number" ? tr.position : 0,
    completed,
    completedAt,
    completedBy: tr.completedBy || (completed ? "auto" : null),
    lastPlayedAt,
    inHistory: tr.inHistory !== false,
    rate: typeof tr.rate === "number" ? tr.rate : null,
    folderName: tr.folderName || null,
    folderUrl: tr.folderUrl || null,
    filePath: tr.filePath || null,
    bookPath: tr.bookPath || null,
    updatedAt: Math.max(lastPlayedAt, completedAt, Number(tr.updatedAt || 0)),
  };
}

function mergeTrackState(remoteRaw, localRaw, key) {
  const remote = normalizeTrackRecord(remoteRaw, key);
  const local = normalizeTrackRecord(localRaw, key);
  if (!remote) return local;
  if (!local) return remote;

  const playSource = (local.lastPlayedAt || 0) >= (remote.lastPlayedAt || 0) ? local : remote;
  const compSource = (local.completedAt || 0) >= (remote.completedAt || 0) ? local : remote;

  return {
    url: playSource.url || remote.url || local.url || key,
    title: playSource.title || remote.title || local.title || "",
    size: playSource.size ?? remote.size ?? local.size ?? null,
    mime: playSource.mime || remote.mime || local.mime || null,
    duration: playSource.duration ?? remote.duration ?? local.duration ?? null,
    position: playSource.position || 0,
    lastPlayedAt: playSource.lastPlayedAt || 0,
    inHistory: playSource.inHistory !== false,
    rate: playSource.rate ?? remote.rate ?? local.rate ?? null,
    folderName: playSource.folderName || remote.folderName || local.folderName || null,
    folderUrl: playSource.folderUrl || remote.folderUrl || local.folderUrl || null,
    filePath: playSource.filePath || remote.filePath || local.filePath || null,
    bookPath: playSource.bookPath || remote.bookPath || local.bookPath || null,
    completed: Boolean(compSource.completed),
    completedAt: compSource.completedAt || 0,
    completedBy: compSource.completedBy || null,
    updatedAt: Math.max(playSource.lastPlayedAt || 0, compSource.completedAt || 0),
  };
}

function mergeProgressDocuments(existingRaw, incomingRaw, userId) {
  const existing = existingRaw && typeof existingRaw === "object" ? existingRaw : createEmptyProgress(userId);
  const incoming = incomingRaw && typeof incomingRaw === "object" ? incomingRaw : {};

  const tracks = {};
  const existingTracks = existing.tracks || {};
  const incomingTracks = incoming.tracks || {};
  const allKeys = new Set([...Object.keys(existingTracks), ...Object.keys(incomingTracks)]);
  for (const key of allKeys) {
    if (!key || key.startsWith("blob:")) continue;
    const merged = mergeTrackState(existingTracks[key], incomingTracks[key], key);
    if (merged) tracks[key] = merged;
  }

  const bookmarks = { ...(existing.bookmarks || {}) };
  const bookmarksMeta = { ...(existing.bookmarksMeta || {}) };
  const inBookmarks = incoming.bookmarks || {};
  const inMeta = incoming.bookmarksMeta || {};
  for (const key of new Set([...Object.keys(inBookmarks), ...Object.keys(inMeta)])) {
    const inUpdated = Number(inMeta[key] || 0);
    const exUpdated = Number(bookmarksMeta[key] || 0);
    if (inUpdated >= exUpdated) {
      const list = Array.isArray(inBookmarks[key]) ? inBookmarks[key].slice(0, 100) : [];
      if (list.length) bookmarks[key] = list;
      else delete bookmarks[key];
      bookmarksMeta[key] = inUpdated || Date.now();
    }
  }

  const exSetAt = Number(existing.settingsUpdatedAt || 0);
  const inSetAt = Number(incoming.settingsUpdatedAt || 0);
  const settings = inSetAt >= exSetAt && incoming.settings && typeof incoming.settings === "object"
    ? { ...(existing.settings || {}), ...incoming.settings }
    : (existing.settings || {});

  return {
    version: 2,
    userId,
    updatedAt: Date.now(),
    tracks,
    bookmarks,
    bookmarksMeta,
    settings,
    settingsUpdatedAt: Math.max(exSetAt, inSetAt),
  };
}

// -------------------- Публичный Яндекс Диск и кэш каталога --------------------

function naturalSort(a, b) {
  return String(a.name || "").localeCompare(String(b.name || ""), "ru", { numeric: true, sensitivity: "base" });
}
function isAudioFileItem(item) {
  if (!item || item.type !== "file") return false;
  const mime = (item.mime_type || "").toLowerCase();
  if (mime.startsWith("audio/")) return true;
  return /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm)$/i.test(item.name || "");
}
function isImageFileItem(item) {
  if (!item || item.type !== "file") return false;
  const mime = (item.mime_type || "").toLowerCase();
  if (mime.startsWith("image/")) return true;
  return /\.(jpe?g|png|webp|gif|avif|bmp)$/i.test(item.name || "");
}
function isTextFileItem(item) {
  if (!item || item.type !== "file") return false;
  const mime = (item.mime_type || "").toLowerCase();
  if (mime.startsWith("text/")) return true;
  return /\.(txt|md|nfo|desc)$/i.test(item.name || "");
}
function pickCoverItem(items) {
  const imgs = (items || []).filter(isImageFileItem).slice().sort(naturalSort);
  if (!imgs.length) return null;
  const preferred = imgs.find((it) => /^(cover|обложка|poster|front|folder|thumb|art)$/i.test((it.name || "").replace(/\.[^.]+$/, "")));
  return preferred || imgs[0];
}
function pickDescItem(items) {
  const txts = (items || []).filter(isTextFileItem).slice().sort(naturalSort);
  if (!txts.length) return null;
  const preferred = txts.find((it) => /^(description|описание|about|info|readme|аннотация|annotation|desc)$/i.test((it.name || "").replace(/\.[^.]+$/, "")));
  return preferred || txts[0];
}

async function listPublicFolder(publicUrl, path = "/") {
  const cleanFolder = cleanYandexUrl(publicUrl);
  const normPath = normalizeDiskPath(path);
  const limit = 100;
  let allItems = [];
  let offset = 0;
  let total = Infinity;
  let folderName = null;
  let first = true;

  for (let guard = 0; guard < 20; guard++) {
    let api = `${YANDEX_DISK_API}/public/resources?public_key=${encodeURIComponent(cleanFolder)}&limit=${limit}&offset=${offset}`;
    if (normPath && normPath !== "/") api += `&path=${encodeURIComponent(normPath)}`;
    const res = await fetch(api);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.type !== "dir") {
      throw httpError(res.status >= 400 ? res.status : 502, data.message || data.description || "Не удалось прочитать публичную папку Яндекс Диска.");
    }
    if (first) {
      folderName = data.name || "Каталог";
      first = false;
    }
    const items = (data._embedded && data._embedded.items) || [];
    total = data._embedded && typeof data._embedded.total === "number" ? data._embedded.total : items.length;
    allItems = allItems.concat(items);
    offset += items.length;
    if (!items.length || offset >= total) break;
  }
  return { name: folderName, items: allItems, total: total === Infinity ? allItems.length : total };
}

async function resolvePublicDownloadHref(publicUrl, filePath) {
  const cleanFolder = cleanYandexUrl(publicUrl);
  const normPath = normalizeDiskPath(filePath);
  const api = `${YANDEX_DISK_API}/public/resources/download?public_key=${encodeURIComponent(cleanFolder)}&path=${encodeURIComponent(normPath)}`;
  const res = await fetch(api);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.href) {
    throw httpError(res.status >= 400 ? res.status : 502, data.message || data.description || "Яндекс не вернул ссылку для скачивания.");
  }
  return data.href;
}

async function fetchPublicTextFile(publicUrl, filePath, directHref = null) {
  const href = directHref || (await resolvePublicDownloadHref(publicUrl, filePath));
  const res = await fetch(href);
  if (!res.ok) throw httpError(502, `Не удалось загрузить текст: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return decodeTextBuffer(buf);
}

async function rebuildCatalogCache(overrideToken = null) {
  const publicUrl = getCatalogPublicUrl();
  const folders = {};
  const queue = ["/"];
  const visited = new Set();
  let audioCount = 0;
  let bookCount = 0;

  async function processFolder(normPath) {
    const res = await listPublicFolder(publicUrl, normPath);
    const items = res.items || [];
    const dirs = items
      .filter((it) => it && it.type === "dir")
      .map((d) => ({
        name: d.name,
        path: normalizeDiskPath(d.path || `${normPath === "/" ? "" : normPath}/${d.name}`),
      }))
      .sort(naturalSort);

    const audios = items
      .filter(isAudioFileItem)
      .map((a) => ({
        name: a.name,
        path: normalizeDiskPath(a.path || `${normPath === "/" ? "" : normPath}/${a.name}`),
        size: a.size,
        mime_type: a.mime_type,
      }))
      .sort(naturalSort);

    const coverRaw = pickCoverItem(items);
    const descRaw = pickDescItem(items);

    const coverItem = coverRaw
      ? {
          name: coverRaw.name,
          path: normalizeDiskPath(coverRaw.path || `${normPath === "/" ? "" : normPath}/${coverRaw.name}`),
          mime_type: coverRaw.mime_type,
        }
      : null;

    const descItem = descRaw
      ? {
          name: descRaw.name,
          path: normalizeDiskPath(descRaw.path || `${normPath === "/" ? "" : normPath}/${descRaw.name}`),
          mime_type: descRaw.mime_type,
        }
      : null;

    let descText = "";
    if (descItem) {
      try {
        descText = await fetchPublicTextFile(publicUrl, descItem.path, descRaw.file || null);
      } catch {
        descText = "";
      }
    }

    const parentSegs = normPath.split("/").filter(Boolean);
    parentSegs.pop();
    const pPath = parentSegs.length ? `/${parentSegs.join("/")}` : "/";

    folders[normPath] = {
      path: normPath,
      name: res.name || (normPath === "/" ? "Аудиотека" : normPath.split("/").pop()),
      parentPath: pPath,
      dirs,
      audios,
      coverItem,
      descItem,
      descText,
      descLoaded: true,
    };

    if (audios.length > 0) {
      audioCount += audios.length;
      bookCount += 1;
    }

    const depth = normPath === "/" ? 0 : normPath.split("/").filter(Boolean).length;
    if (depth < 3) {
      for (const d of dirs) {
        if (!visited.has(d.path)) queue.push(d.path);
      }
    }
  }

  // Сначала корень
  visited.add("/");
  await processFolder("/");

  // Затем параллельный обход подпапок
  const CONCURRENCY = 6;
  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      if (!p || visited.has(p)) continue;
      visited.add(p);
      try {
        await processFolder(p);
      } catch {
        // Пропускаем проблемную папку, чтобы не сорвать весь индекс
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const indexDoc = {
    version: 1,
    rootUrl: publicUrl,
    generatedAt: Date.now(),
    folderCount: Object.keys(folders).length,
    bookCount,
    audioCount,
    folders,
  };
  await diskWriteJson("app:/cache/catalog-index.json", indexDoc, overrideToken);
  return indexDoc;
}

// -------------------- Агрегация статистики для админки --------------------

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await fn(items[cur], cur);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, () => worker()));
  return results;
}

async function buildAdminUsersAndStats(overrideToken = null) {
  const [config, userItems, progressItems, catalogIndex] = await Promise.all([
    diskReadJson("app:/config.json", {}, overrideToken),
    diskListAppDir("app:/users", overrideToken),
    diskListAppDir("app:/progress", overrideToken),
    diskReadJson("app:/cache/catalog-index.json", null, overrideToken),
  ]);

  const userFiles = userItems.filter((it) => it.type === "file" && /\.json$/i.test(it.name));
  const rawUsers = await mapWithConcurrency(userFiles, 6, async (it) => {
    const u = await diskReadJson(`app:/users/${it.name}`, null, overrideToken);
    if (!u) return null;
    return { ...u, nameHash: it.name.replace(/\.json$/i, "") };
  });

  const progressFiles = progressItems.filter((it) => it.type === "file" && /\.json$/i.test(it.name));
  const progressMap = new Map();
  await mapWithConcurrency(progressFiles, 6, async (it) => {
    const p = await diskReadJson(`app:/progress/${it.name}`, null, overrideToken);
    if (p && p.userId) progressMap.set(p.userId, p);
  });

  // Индекс книг по путям, если кэш собран
  const bookAudioTotals = new Map();
  if (catalogIndex && catalogIndex.folders) {
    Object.values(catalogIndex.folders).forEach((f) => {
      if (f && Array.isArray(f.audios) && f.audios.length > 0) {
        bookAudioTotals.set(f.path, { name: f.name, totalFiles: f.audios.length });
      }
    });
  }

  const bookStatsMap = new Map();
  const usersOut = [];
  const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
  let activeLast7d = 0;
  let totalCompletedFiles = 0;
  let totalListenedSeconds = 0;

  const validUsers = rawUsers.filter(Boolean).sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));

  for (const u of validUsers) {
    const prog = progressMap.get(u.id);
    const tracks = (prog && prog.tracks) || {};
    const booksByUser = new Map();
    let userCompletedFiles = 0;
    let userListenedSec = 0;
    let userLastActivity = u.lastSeenAt || 0;

    for (const [key, rawTr] of Object.entries(tracks)) {
      const tr = normalizeTrackRecord(rawTr, key);
      if (!tr) continue;
      if (tr.updatedAt > userLastActivity) userLastActivity = tr.updatedAt;

      if (tr.completed) {
        userCompletedFiles++;
        if (tr.duration && tr.duration > 0) userListenedSec += tr.duration;
      } else if (tr.position > 0) {
        userListenedSec += Math.min(tr.position, tr.duration || tr.position);
      }

      const bPath = tr.bookPath || "/";
      if (!booksByUser.has(bPath)) {
        const catMeta = bookAudioTotals.get(bPath);
        booksByUser.set(bPath, {
          bookPath: bPath,
          bookName: tr.folderName || (catMeta && catMeta.name) || (bPath === "/" ? "Каталог" : bPath.split("/").pop()),
          completedFiles: 0,
          startedFiles: 0,
          totalFiles: catMeta ? catMeta.totalFiles : 0,
          lastUpdatedAt: 0,
          listenedSeconds: 0,
        });
      }
      const bs = booksByUser.get(bPath);
      if (tr.updatedAt > bs.lastUpdatedAt) bs.lastUpdatedAt = tr.updatedAt;
      if (tr.completed) {
        bs.completedFiles++;
        if (tr.duration) bs.listenedSeconds += tr.duration;
      } else if (tr.position > 5) {
        bs.startedFiles++;
        bs.listenedSeconds += tr.position;
      }
    }

    if (userLastActivity >= sevenDaysAgo && !u.blocked) activeLast7d++;
    totalCompletedFiles += userCompletedFiles;
    totalListenedSeconds += userListenedSec;

    const userBooksList = Array.from(booksByUser.values()).map((b) => {
      const denom = b.totalFiles || (b.completedFiles + b.startedFiles);
      const isDone = b.totalFiles > 0 ? b.completedFiles >= b.totalFiles : (b.completedFiles > 0 && b.startedFiles === 0);
      const pct = denom > 0 ? Math.min(100, Math.round((b.completedFiles / denom) * 100)) : 0;
      return { ...b, isDone, pct };
    }).sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);

    let completedBooks = 0;
    let inProgressBooks = 0;
    for (const b of userBooksList) {
      if (b.isDone) completedBooks++;
      else if (b.startedFiles > 0 || b.completedFiles > 0) inProgressBooks++;

      if (!bookStatsMap.has(b.bookPath)) {
        bookStatsMap.set(b.bookPath, {
          bookPath: b.bookPath,
          bookName: b.bookName,
          completedUsers: 0,
          inProgressUsers: 0,
          lastActivityAt: 0,
        });
      }
      const globalBook = bookStatsMap.get(b.bookPath);
      if (b.isDone) globalBook.completedUsers++;
      else if (b.startedFiles > 0 || b.completedFiles > 0) globalBook.inProgressUsers++;
      if (b.lastUpdatedAt > globalBook.lastActivityAt) globalBook.lastActivityAt = b.lastUpdatedAt;
    }

    usersOut.push({
      id: u.id,
      name: u.name,
      nameHash: u.nameHash,
      blocked: Boolean(u.blocked),
      lockedUntil: u.lockedUntil || 0,
      failedAttempts: u.failedAttempts || 0,
      createdAt: u.createdAt || 0,
      lastSeenAt: userLastActivity,
      completedFiles: userCompletedFiles,
      completedBooks,
      inProgressBooks,
      listenedMinutes: Math.round(userListenedSec / 60),
      books: userBooksList.slice(0, 30),
    });
  }

  const bookStats = Array.from(bookStatsMap.values()).sort(
    (a, b) => (b.completedUsers * 3 + b.inProgressUsers) - (a.completedUsers * 3 + a.inProgressUsers) || b.lastActivityAt - a.lastActivityAt
  );

  const summary = {
    generatedAt: Date.now(),
    totals: {
      totalUsers: usersOut.length,
      blockedUsers: usersOut.filter((u) => u.blocked).length,
      activeLast7d,
      totalCompletedFiles,
      totalListenedHours: Math.round((totalListenedSeconds / 3600) * 10) / 10,
    },
    bookStats: bookStats.slice(0, 50),
  };

  // Сохраняем сводку в app:/stats/summary.json
  try {
    await diskWriteJson("app:/stats/summary.json", summary, overrideToken);
  } catch {
    // Не срываем ответ админки, если запись сводки не удалась
  }

  return {
    config: {
      activeInviteCode: config?.activeInviteCode || "",
      inviteCreatedAt: config?.inviteCreatedAt || 0,
      catalogPublicUrl: config?.catalogPublicUrl || getCatalogPublicUrl(),
      adminLogin: config?.adminLogin || "",
    },
    users: usersOut,
    bookStats: summary.bookStats,
    totals: summary.totals,
    cacheInfo: catalogIndex
      ? {
          exists: true,
          generatedAt: catalogIndex.generatedAt || 0,
          folderCount: catalogIndex.folderCount || 0,
          bookCount: catalogIndex.bookCount || 0,
          audioCount: catalogIndex.audioCount || 0,
        }
      : { exists: false },
  };
}

// -------------------- Авторизация запросов --------------------

function extractBearerToken(headers) {
  const auth = headers.authorization || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return "";
}

async function requireAuth(headers, requireAdmin = false) {
  const token = extractBearerToken(headers);
  const payload = verifyJwt(token);
  if (!payload || !payload.sub) {
    throw httpError(401, "Требуется вход в систему.");
  }
  if (requireAdmin && payload.role !== "admin") {
    throw httpError(403, "Доступ разрешён только администратору.");
  }
  if (payload.role === "user") {
    if (!isValidHexId(payload.nameHash) || !isValidUserId(payload.sub)) {
      throw httpError(401, "Некорректная сессия.");
    }
    const user = await diskReadJson(`app:/users/${payload.nameHash}.json`, null);
    if (!user || user.id !== payload.sub) {
      throw httpError(401, "Профиль не найден или был удалён.");
    }
    if (user.blocked) {
      throw httpError(403, "Ваш профиль заблокирован администратором.");
    }
    if ((user.tokenVersion || 1) !== (payload.v || 1)) {
      throw httpError(401, "PIN-код был изменён или сессия сброшена. Войдите заново.");
    }
    return { payload, user };
  }
  return { payload, user: null };
}

// -------------------- Роутер обработчиков --------------------

async function handleAction(action, method, query, body, headers) {
  // 1. Публичный bootstrap (без авторизации)
  if (action === "public/bootstrap" && method === "GET") {
    const hasRefresh = Boolean(getEnv("YANDEX_REFRESH_TOKEN") || tokenCache.refreshToken);
    const hasAccess = Boolean(getEnv("YANDEX_ACCESS_TOKEN") || tokenCache.accessToken);
    return {
      ok: true,
      authEnabled: true,
      yandexClientId: getEnv("YANDEX_CLIENT_ID"),
      adminConfigured: Boolean(getEnv("ADMIN_YANDEX_ID")),
      diskConfigured: hasRefresh || hasAccess,
      catalogPublicUrl: getCatalogPublicUrl(),
    };
  }

  // 2. Вход администратора через Яндекс OAuth (code -> token -> проверка UID)
  if (action === "auth/admin-yandex" && method === "POST") {
    const code = body && body.code;
    const redirectUri = body && body.redirectUri;
    if (!code) throw httpError(400, "Отсутствует код авторизации Яндекса.");

    const oauthData = await exchangeAuthCode(code, redirectUri);
    const info = await fetchYandexUserInfo(oauthData.access_token);
    if (!isAllowedAdminYandexUser(info)) {
      throw httpError(403, `Аккаунт Яндекса «${info.login || info.id}» не является администратором этого каталога.`);
    }

    const ttlMs = Math.max(60, (Number(oauthData.expires_in) || 3600) - 300) * 1000;
    tokenCache.accessToken = oauthData.access_token;
    if (oauthData.refresh_token) tokenCache.refreshToken = oauthData.refresh_token;
    tokenCache.expiresAt = Date.now() + ttlMs;

    const config = await ensureStorageInitialized(info, oauthData.access_token);
    const adminUserId = `admin_${String(info.id).replace(/[^a-zA-Z0-9_-]/g, "")}`;
    let progress = await diskReadJson(`app:/progress/${adminUserId}.json`, null, oauthData.access_token);
    if (!progress) {
      progress = createEmptyProgress(adminUserId);
      await diskWriteJson(`app:/progress/${adminUserId}.json`, progress, oauthData.access_token);
    }

    const displayName = info.display_name || info.real_name || info.login || "Администратор";
    const sessionToken = signJwt(
      { sub: adminUserId, name: displayName, login: info.login || "", role: "admin" },
      ADMIN_SESSION_TTL_SEC
    );

    const needsEnvRefresh = !getEnv("YANDEX_REFRESH_TOKEN") && !getEnv("YANDEX_ACCESS_TOKEN");
    return {
      ok: true,
      sessionToken,
      user: { id: adminUserId, name: displayName, login: info.login || "", role: "admin" },
      progress,
      configSummary: {
        activeInviteCode: config.activeInviteCode,
        inviteCreatedAt: config.inviteCreatedAt,
      },
      setupPending: needsEnvRefresh && oauthData.refresh_token
        ? { refreshToken: oauthData.refresh_token }
        : null,
    };
  }

  // 3. Проверка пригласительной ссылки
  if (action === "auth/invite-check" && method === "GET") {
    const code = String(query.code || "").trim();
    if (!code) return { ok: true, valid: false };
    const config = await diskReadJson("app:/config.json", null);
    const valid = Boolean(config && config.activeInviteCode && safeEqual(code, config.activeInviteCode));
    return { ok: true, valid };
  }

  // 4. Регистрация по пригласительной ссылке (Имя + PIN 4–6 цифр)
  if (action === "auth/register" && method === "POST") {
    const inviteCode = String(body?.inviteCode || "").trim();
    const name = normalizeUserName(body?.name);
    const pin = String(body?.pin || "").trim();

    if (!inviteCode) throw httpError(400, "Отсутствует пригласительный код.");
    if (name.length < 2 || name.length > 40) throw httpError(400, "Имя должно содержать от 2 до 40 символов.");
    if (!isValidPin(pin)) throw httpError(400, "PIN-код должен состоять из 4–6 цифр.");

    const config = await ensureStorageInitialized();
    if (!config.activeInviteCode || !safeEqual(inviteCode, config.activeInviteCode)) {
      throw httpError(403, "Пригласительная ссылка устарела или была отозвана. Запросите новую у администратора.");
    }

    const nameHash = hashUserName(name);
    const userPath = `app:/users/${nameHash}.json`;
    const existing = await diskReadJson(userPath, null);
    if (existing) {
      throw httpError(409, "Пользователь с таким именем уже зарегистрирован. Перейдите на обычный вход по имени и PIN.");
    }

    const now = Date.now();
    const userId = `u_${crypto.randomBytes(6).toString("hex")}`;
    const pinSalt = crypto.randomBytes(16).toString("hex");
    const pinHash = hashPin(pin, pinSalt);

    const userRecord = {
      id: userId,
      name,
      nameKey: name.toLowerCase(),
      pinSalt,
      pinHash,
      role: "user",
      blocked: false,
      tokenVersion: 1,
      failedAttempts: 0,
      lockedUntil: 0,
      createdAt: now,
      lastSeenAt: now,
      pinUpdatedAt: now,
    };

    const progress = createEmptyProgress(userId);
    await diskWriteJson(userPath, userRecord);
    await diskWriteJson(`app:/progress/${userId}.json`, progress);

    const sessionToken = signJwt({ sub: userId, name, nameHash, role: "user", v: 1 }, USER_SESSION_TTL_SEC);
    return {
      ok: true,
      sessionToken,
      user: { id: userId, name, role: "user" },
      progress,
    };
  }

  // 5. Вход пользователя по имени и PIN-коду
  if (action === "auth/login" && method === "POST") {
    const name = normalizeUserName(body?.name);
    const pin = String(body?.pin || "").trim();
    if (!name || !isValidPin(pin)) {
      throw httpError(400, "Введите имя и PIN-код из 4–6 цифр.");
    }

    const nameHash = hashUserName(name);
    const userPath = `app:/users/${nameHash}.json`;
    const user = await diskReadJson(userPath, null);
    if (!user) {
      throw httpError(401, "Неверное имя или PIN-код.");
    }
    if (user.blocked) {
      throw httpError(403, "Профиль заблокирован администратором.");
    }

    const now = Date.now();
    if (user.lockedUntil && now < user.lockedUntil) {
      const waitMin = Math.max(1, Math.ceil((user.lockedUntil - now) / 60000));
      throw httpError(429, `Слишком много неверных попыток. Повторите через ${waitMin} мин.`);
    }

    const candidateHash = hashPin(pin, user.pinSalt);
    if (!safeEqual(candidateHash, user.pinHash)) {
      const prevFails = user.lockedUntil && now >= user.lockedUntil ? 0 : (user.failedAttempts || 0);
      const nextFails = prevFails + 1;
      user.failedAttempts = nextFails;
      if (nextFails >= MAX_PIN_ATTEMPTS) {
        user.lockedUntil = now + PIN_LOCK_MS;
      } else {
        user.lockedUntil = 0;
      }
      await diskWriteJson(userPath, user);
      const left = MAX_PIN_ATTEMPTS - nextFails;
      if (left <= 0) {
        throw httpError(429, "Превышено число попыток. Вход временно заблокирован на 15 минут.");
      }
      throw httpError(401, `Неверный PIN-код. Осталось попыток: ${left}.`);
    }

    if (user.failedAttempts || user.lockedUntil || now - (user.lastSeenAt || 0) > 5 * 60 * 1000) {
      user.failedAttempts = 0;
      user.lockedUntil = 0;
      user.lastSeenAt = now;
      await diskWriteJson(userPath, user);
    }

    let progress = await diskReadJson(`app:/progress/${user.id}.json`, null);
    if (!progress) {
      progress = createEmptyProgress(user.id);
      await diskWriteJson(`app:/progress/${user.id}.json`, progress);
    }

    const sessionToken = signJwt(
      { sub: user.id, name: user.name, nameHash, role: "user", v: user.tokenVersion || 1 },
      USER_SESSION_TTL_SEC
    );

    return {
      ok: true,
      sessionToken,
      user: { id: user.id, name: user.name, role: "user" },
      progress,
    };
  }

  // 6. Текущая сессия (/me)
  if (action === "auth/me" && method === "GET") {
    const { payload, user } = await requireAuth(headers, false);
    if (user && Date.now() - (user.lastSeenAt || 0) > 15 * 60 * 1000) {
      user.lastSeenAt = Date.now();
      diskWriteJson(`app:/users/${payload.nameHash}.json`, user).catch(() => {});
    }
    const progress = (await diskReadJson(`app:/progress/${payload.sub}.json`, null)) || createEmptyProgress(payload.sub);
    return {
      ok: true,
      user: {
        id: payload.sub,
        name: user ? user.name : payload.name,
        login: payload.login || "",
        role: payload.role,
      },
      progress,
    };
  }

  // 7. Загрузка / синхронизация прогресса пользователя
  if (action === "progress/get" && method === "GET") {
    const { payload } = await requireAuth(headers, false);
    const progress = (await diskReadJson(`app:/progress/${payload.sub}.json`, null)) || createEmptyProgress(payload.sub);
    return { ok: true, progress };
  }

  if (action === "progress/sync" && method === "POST") {
    const { payload, user } = await requireAuth(headers, false);
    const progressPath = `app:/progress/${payload.sub}.json`;
    const existing = await diskReadJson(progressPath, null);
    const merged = mergeProgressDocuments(existing, body, payload.sub);
    await diskWriteJson(progressPath, merged);
    if (user && Date.now() - (user.lastSeenAt || 0) > 5 * 60 * 1000) {
      user.lastSeenAt = Date.now();
      diskWriteJson(`app:/users/${payload.nameHash}.json`, user).catch(() => {});
    }
    return { ok: true, progress: merged };
  }

  // 8. Каталог и прокси публичного Яндекс Диска (для авторизованных)
  if (action === "catalog/index" && method === "GET") {
    await requireAuth(headers, false);
    const index = await diskReadJson("app:/cache/catalog-index.json", null);
    return { ok: true, cached: Boolean(index), index };
  }

  if (action === "disk/list" && method === "GET") {
    await requireAuth(headers, false);
    const path = normalizeDiskPath(query.path || "/");
    const data = await listPublicFolder(getCatalogPublicUrl(), path);
    return { ok: true, ...data };
  }

  if (action === "disk/download" && method === "GET") {
    await requireAuth(headers, false);
    const path = normalizeDiskPath(query.path || "/");
    const href = await resolvePublicDownloadHref(getCatalogPublicUrl(), path);
    return { ok: true, href };
  }

  if (action === "disk/text" && method === "GET") {
    await requireAuth(headers, false);
    const path = normalizeDiskPath(query.path || "/");
    const text = await fetchPublicTextFile(getCatalogPublicUrl(), path);
    return { ok: true, text };
  }

  // 9. Администраторские маршруты (только role === "admin")
  if (action === "admin/init" && method === "POST") {
    await requireAuth(headers, true);
    const config = await ensureStorageInitialized();
    return { ok: true, config };
  }

  if (action === "admin/status" && method === "GET") {
    await requireAuth(headers, true);
    const folderChecks = await Promise.all(
      APP_SUBFOLDERS.map(async (f) => ({ name: f, exists: await diskCheckExists(`app:/${f}`) }))
    );
    const config = await diskReadJson("app:/config.json", null);
    const cacheIndex = await diskReadJson("app:/cache/catalog-index.json", null);
    return {
      ok: true,
      env: {
        refreshTokenConfigured: Boolean(getEnv("YANDEX_REFRESH_TOKEN")),
        accessTokenConfigured: Boolean(getEnv("YANDEX_ACCESS_TOKEN")),
        catalogPublicUrl: getCatalogPublicUrl(),
      },
      folders: folderChecks,
      configExists: Boolean(config),
      config: config
        ? {
            activeInviteCode: config.activeInviteCode,
            inviteCreatedAt: config.inviteCreatedAt,
            adminLogin: config.adminLogin || "",
          }
        : null,
      cacheInfo: cacheIndex
        ? {
            exists: true,
            generatedAt: cacheIndex.generatedAt,
            folderCount: cacheIndex.folderCount,
            bookCount: cacheIndex.bookCount,
            audioCount: cacheIndex.audioCount,
          }
        : { exists: false },
    };
  }

  if (action === "admin/invite-rotate" && method === "POST") {
    await requireAuth(headers, true);
    const config = await ensureStorageInitialized();
    config.activeInviteCode = randomToken(9);
    config.inviteCreatedAt = Date.now();
    config.updatedAt = Date.now();
    await diskWriteJson("app:/config.json", config);
    return {
      ok: true,
      activeInviteCode: config.activeInviteCode,
      inviteCreatedAt: config.inviteCreatedAt,
    };
  }

  if (action === "admin/cache-rebuild" && method === "POST") {
    await requireAuth(headers, true);
    await ensureStorageInitialized();
    const indexDoc = await rebuildCatalogCache();
    return {
      ok: true,
      cacheInfo: {
        exists: true,
        generatedAt: indexDoc.generatedAt,
        folderCount: indexDoc.folderCount,
        bookCount: indexDoc.bookCount,
        audioCount: indexDoc.audioCount,
      },
      index: indexDoc,
    };
  }

  if (action === "admin/stats" && method === "GET") {
    await requireAuth(headers, true);
    const data = await buildAdminUsersAndStats();
    return { ok: true, ...data };
  }

  if (action === "admin/user-reset-pin" && method === "POST") {
    await requireAuth(headers, true);
    const nameHash = String(body?.nameHash || "").trim();
    const newPin = String(body?.newPin || "").trim();
    if (!isValidHexId(nameHash)) throw httpError(400, "Некорректный идентификатор пользователя.");
    if (!isValidPin(newPin)) throw httpError(400, "Новый PIN должен содержать 4–6 цифр.");

    const userPath = `app:/users/${nameHash}.json`;
    const user = await diskReadJson(userPath, null);
    if (!user) throw httpError(404, "Пользователь не найден.");

    const pinSalt = crypto.randomBytes(16).toString("hex");
    user.pinSalt = pinSalt;
    user.pinHash = hashPin(newPin, pinSalt);
    user.failedAttempts = 0;
    user.lockedUntil = 0;
    user.tokenVersion = (user.tokenVersion || 1) + 1;
    user.pinUpdatedAt = Date.now();
    await diskWriteJson(userPath, user);

    return { ok: true, userId: user.id, name: user.name };
  }

  if (action === "admin/user-toggle-block" && method === "POST") {
    await requireAuth(headers, true);
    const nameHash = String(body?.nameHash || "").trim();
    if (!isValidHexId(nameHash)) throw httpError(400, "Некорректный идентификатор пользователя.");

    const userPath = `app:/users/${nameHash}.json`;
    const user = await diskReadJson(userPath, null);
    if (!user) throw httpError(404, "Пользователь не найден.");

    user.blocked = Boolean(body?.blocked);
    if (user.blocked) user.tokenVersion = (user.tokenVersion || 1) + 1;
    await diskWriteJson(userPath, user);

    return { ok: true, userId: user.id, blocked: user.blocked };
  }

  if (action === "admin/user-delete" && method === "POST") {
    await requireAuth(headers, true);
    const nameHash = String(body?.nameHash || "").trim();
    if (!isValidHexId(nameHash)) throw httpError(400, "Некорректный идентификатор пользователя.");

    const userPath = `app:/users/${nameHash}.json`;
    const user = await diskReadJson(userPath, null);
    if (user && isValidUserId(user.id)) {
      await diskDelete(`app:/progress/${user.id}.json`);
    }
    await diskDelete(userPath);
    return { ok: true };
  }

  if (action === "admin/backup" && method === "GET") {
    await requireAuth(headers, true);
    const [config, userItems, progressItems, catalogIndex] = await Promise.all([
      diskReadJson("app:/config.json", {}),
      diskListAppDir("app:/users"),
      diskListAppDir("app:/progress"),
      diskReadJson("app:/cache/catalog-index.json", null),
    ]);
    const users = (
      await mapWithConcurrency(
        userItems.filter((it) => it.type === "file" && /\.json$/i.test(it.name)),
        6,
        async (it) => {
          const u = await diskReadJson(`app:/users/${it.name}`, null);
          if (!u) return null;
          const { pinHash, pinSalt, ...safeUser } = u;
          return { ...safeUser, nameHash: it.name.replace(/\.json$/i, "") };
        }
      )
    ).filter(Boolean);

    const progress = {};
    await mapWithConcurrency(
      progressItems.filter((it) => it.type === "file" && /\.json$/i.test(it.name)),
      6,
      async (it) => {
        const p = await diskReadJson(`app:/progress/${it.name}`, null);
        if (p && p.userId) progress[p.userId] = p;
      }
    );

    return {
      ok: true,
      backup: {
        exportedAt: Date.now(),
        config,
        users,
        progress,
        catalogIndex,
      },
    };
  }

  throw httpError(404, `Неизвестный маршрут: ${action || "(пусто)"}`);
}

// -------------------- Точка входа Yandex Cloud Functions --------------------

function buildCorsHeaders(headers) {
  const allowed = getEnv("ALLOWED_ORIGINS", "*");
  const reqOrigin = headers.origin || "";
  let allowOrigin = "*";
  if (allowed && allowed !== "*") {
    const list = allowed.split(",").map((s) => s.trim()).filter(Boolean);
    allowOrigin = list.includes(reqOrigin) ? reqOrigin : (list[0] || "*");
  } else if (reqOrigin) {
    allowOrigin = reqOrigin;
  }
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function normalizeHeaders(rawHeaders) {
  const out = {};
  if (!rawHeaders || typeof rawHeaders !== "object") return out;
  for (const [k, v] of Object.entries(rawHeaders)) {
    out[String(k).toLowerCase()] = v;
  }
  return out;
}

function parseBody(event) {
  if (!event || !event.body) return {};
  let raw = event.body;
  if (typeof raw === "string" && event.isBase64Encoded) {
    raw = Buffer.from(raw, "base64").toString("utf8");
  }
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function resolveAction(event, query) {
  if (query && query.action) return String(query.action).replace(/^\/+/, "");
  const p = String((event && (event.path || event.url)) || "").split("?")[0];
  return p.replace(/^\/?(api\/)?/, "").replace(/\/+$/, "");
}

exports.handler = async function handler(event) {
  const headers = normalizeHeaders(event && event.headers);
  const corsHeaders = buildCorsHeaders(headers);
  const method = String((event && event.httpMethod) || "GET").toUpperCase();

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  const query = (event && event.queryStringParameters) || {};
  const action = resolveAction(event, query);
  const body = parseBody(event);

  try {
    const result = await handleAction(action, method, query, body, headers);
    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(result),
    };
  } catch (err) {
    const statusCode = Number(err && err.statusCode) || 500;
    const message = (err && err.message) || "Внутренняя ошибка сервера.";
    return {
      statusCode,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        ok: false,
        error: message,
        ...(err && err.extra ? err.extra : {}),
      }),
    };
  }
};

// Экспорт внутренних функций для модульного тестирования
exports._internal = {
  hashUserName,
  hashPin,
  signJwt,
  verifyJwt,
  mergeTrackState,
  mergeProgressDocuments,
  normalizeTrackRecord,
  tokenCache,
};
