// Pure browser-local YouTube identity and bookmark helpers.
//
// This module has no Chrome, network, account, cookie, or native-app authority.
// Runtime handlers may use its output only as input to their existing local
// proposal validation and navigation paths.

const DEFAULT_YOUTUBE_ORIGIN = "https://www.youtube.com";
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const MAX_POSITION_SECONDS = 31_536_000;
const MAX_LABEL_CHARS = 80;
const MAX_NOTE_CHARS = 280;
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);

function cleanText(value, maxChars) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function normalizeYouTubeVideoId(value) {
  const candidate = String(value ?? "").trim();
  return VIDEO_ID_RE.test(candidate) ? candidate : null;
}

function normalizePreferredYouTubeOrigin(value = DEFAULT_YOUTUBE_ORIGIN) {
  try {
    const url = new URL(String(value || DEFAULT_YOUTUBE_ORIGIN));
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function normalizePositionSeconds(value) {
  const number = typeof value === "string" && /^\d+$/.test(value.trim())
    ? Number(value.trim())
    : value;
  if (!Number.isFinite(number) || number < 0 || number > MAX_POSITION_SECONDS) return null;
  return Math.floor(number);
}

function parseTimestamp(value) {
  if (value == null || value === "") return 0;
  const raw = String(value).trim().toLowerCase();
  if (/^\d+s?$/.test(raw)) return normalizePositionSeconds(raw.replace(/s$/, ""));
  const match = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match || !match[0] || !match.slice(1).some(Boolean)) return null;
  return normalizePositionSeconds(
    Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0),
  );
}

function allowedWatchOrigin(url, preferredOrigin) {
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return true;
  const preferred = normalizePreferredYouTubeOrigin(preferredOrigin);
  return Boolean(preferred && url.origin === preferred);
}

function parseYouTubeWatchUrl(value, options = {}) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const hostname = url.hostname.toLowerCase();
  let candidate = "";
  let sourceOrigin = url.origin;
  if (hostname === "youtu.be") {
    const match = url.pathname.match(/^\/([A-Za-z0-9_-]{11})\/?$/);
    if (!match) return null;
    candidate = match[1];
    sourceOrigin = DEFAULT_YOUTUBE_ORIGIN;
  } else if (YOUTUBE_HOSTS.has(hostname) && /^\/shorts\//.test(url.pathname)) {
    const match = url.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})\/?$/);
    if (!match) return null;
    candidate = match[1];
  } else {
    if (!allowedWatchOrigin(url, options.preferredOrigin) || url.pathname !== "/watch") return null;
    const videoIds = url.searchParams.getAll("v");
    if (videoIds.length !== 1) return null;
    candidate = videoIds[0];
  }
  const videoId = normalizeYouTubeVideoId(candidate);
  if (!videoId) return null;

  const rawTimestamps = [...url.searchParams.getAll("t"), ...url.searchParams.getAll("start")];
  if (rawTimestamps.length > 1) return null;
  const positionSeconds = parseTimestamp(rawTimestamps[0]);
  if (positionSeconds == null) return null;
  const origin = normalizePreferredYouTubeOrigin(options.preferredOrigin || sourceOrigin);
  if (!origin) return null;

  return {
    video_id: videoId,
    position_seconds: positionSeconds,
    watch_url: buildYouTubeWatchUrl({
      videoId,
      positionSeconds,
      preferredOrigin: origin,
    }),
    web_origin: origin,
  };
}

function buildYouTubeWatchUrl({
  videoId,
  video_id: snakeVideoId,
  positionSeconds = 0,
  position_seconds: snakePositionSeconds,
  preferredOrigin = DEFAULT_YOUTUBE_ORIGIN,
} = {}) {
  const id = normalizeYouTubeVideoId(videoId ?? snakeVideoId);
  const seconds = normalizePositionSeconds(snakePositionSeconds ?? positionSeconds);
  const origin = normalizePreferredYouTubeOrigin(preferredOrigin);
  if (!id || seconds == null || !origin) return null;
  const url = new URL("/watch", `${origin}/`);
  url.searchParams.set("v", id);
  if (seconds > 0) url.searchParams.set("t", `${seconds}s`);
  return url.href;
}

function canonicalizeYouTubeWatchUrl(value, options = {}) {
  return parseYouTubeWatchUrl(value, options)?.watch_url || null;
}

function youtubeBookmarkCreateCommand(input = {}) {
  const suppliedWatchUrl = input.watchUrl ?? input.watch_url;
  const fromUrl = suppliedWatchUrl
    ? parseYouTubeWatchUrl(suppliedWatchUrl, {
        preferredOrigin: input.preferredOrigin,
      })
    : null;
  if (suppliedWatchUrl && !fromUrl) return null;
  const videoId = fromUrl?.video_id || normalizeYouTubeVideoId(input.videoId ?? input.video_id);
  const positionSeconds = normalizePositionSeconds(
    input.positionSeconds ?? input.position_seconds ?? fromUrl?.position_seconds ?? 0,
  );
  const origin = normalizePreferredYouTubeOrigin(
    input.preferredOrigin || fromUrl?.web_origin || DEFAULT_YOUTUBE_ORIGIN,
  );
  const label = cleanText(input.label, MAX_LABEL_CHARS);
  if (!videoId || positionSeconds == null || !origin || !label) return null;

  return {
    version: 1,
    type: "media.bookmark",
    operation: "create",
    label,
    note: cleanText(input.note, MAX_NOTE_CHARS),
    media: {
      provider: "youtube",
      video_id: videoId,
      position_seconds: positionSeconds,
      watch_url: buildYouTubeWatchUrl({ videoId, positionSeconds, preferredOrigin: origin }),
      web_origin: origin,
    },
  };
}

function youtubeBookmarkOpenCommand(bookmark = {}, options = {}) {
  const media = bookmark.media && typeof bookmark.media === "object" ? bookmark.media : bookmark;
  if (media.provider != null && media.provider !== "youtube") return null;
  const videoId = normalizeYouTubeVideoId(media.video_id ?? media.videoId);
  const positionSeconds = normalizePositionSeconds(media.position_seconds ?? media.positionSeconds ?? 0);
  const origin = normalizePreferredYouTubeOrigin(
    options.preferredOrigin || media.web_origin || DEFAULT_YOUTUBE_ORIGIN,
  );
  if (!videoId || positionSeconds == null || !origin) return null;
  return {
    version: 1,
    type: "media.open",
    source: "bookmark",
    label: cleanText(bookmark.label, MAX_LABEL_CHARS),
    media: {
      provider: "youtube",
      video_id: videoId,
      position_seconds: positionSeconds,
      watch_url: buildYouTubeWatchUrl({ videoId, positionSeconds, preferredOrigin: origin }),
      web_origin: origin,
    },
  };
}

export {
  DEFAULT_YOUTUBE_ORIGIN,
  MAX_POSITION_SECONDS,
  buildYouTubeWatchUrl,
  canonicalizeYouTubeWatchUrl,
  normalizePreferredYouTubeOrigin,
  normalizeYouTubeVideoId,
  parseYouTubeWatchUrl,
  youtubeBookmarkCreateCommand,
  youtubeBookmarkOpenCommand,
};
