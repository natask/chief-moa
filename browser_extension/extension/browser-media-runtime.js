import {
  buildYouTubeWatchUrl,
  MAX_POSITION_SECONDS,
  parseYouTubeWatchUrl,
  youtubeBookmarkCreateCommand,
  youtubeBookmarkOpenCommand,
} from "./youtube-media.js";

const RECEIPTS_KEY = "ageeMediaActionReceipts";
const BOOKMARK_CACHE_KEY = "ageeMediaBookmarkCache";
const BOOKMARK_OUTBOX_KEY = "ageeMediaBookmarkOutbox";
const MAX_LOCAL_RECORDS = 100;

function browserLocalToolManifest() {
  return [
    { tool: "browser.tab.list", risk: "read_only", approval: "none" },
    { tool: "browser.tab.open", risk: "navigation", approval: "implicit_user_command" },
    { tool: "browser.tab.activate", risk: "navigation", approval: "implicit_user_command" },
    { tool: "browser.tab.close", risk: "destructive_browser_local", approval: "implicit_user_command" },
    { tool: "browser.tab.reload", risk: "navigation", approval: "implicit_user_command" },
    { tool: "browser.cdp.execute", risk: "browser_local_debugger", approval: "implicit_user_command" },
    { tool: "browser.task.claim", risk: "browser_local", approval: "none" },
    { tool: "page.snapshot", risk: "read_only", approval: "none" },
    { tool: "media.open", risk: "navigation", approval: "implicit_user_command" },
    { tool: "media.bookmark", risk: "local_state", approval: "explicit_local_confirmation" },
  ];
}

function boundedText(value, max) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function mediaActionEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const tool = boundedText(value.tool || value.type, 80);
  if (!new Set(["media.open", "media.bookmark"]).has(tool)) return null;
  const input = value.input && typeof value.input === "object" && !Array.isArray(value.input)
    ? value.input
    : value;
  return { tool, input };
}

function mediaActionsFromTurn(data) {
  const result = data?.result && typeof data.result === "object" ? data.result : {};
  const values = [data, data?.action, ...(Array.isArray(data?.actions) ? data.actions : []),
    ...(Array.isArray(data?.proposals) ? data.proposals : []),
    ...(Array.isArray(data?.action_proposals) ? data.action_proposals : []),
    result.action, ...(Array.isArray(result.actions) ? result.actions : []),
    ...(Array.isArray(result.proposals) ? result.proposals : []),
    ...(Array.isArray(result.action_proposals) ? result.action_proposals : [])];
  return values.map(mediaActionEnvelope).filter(Boolean);
}

async function executeFirstMediaActionFromTurn(data, options = {}) {
  if (options.allowed === false) return null;
  const extract = typeof options.extract === "function" ? options.extract : mediaActionsFromTurn;
  const execute = typeof options.execute === "function" ? options.execute : null;
  const action = extract(data)[0];
  if (!action || !execute || (typeof options.shouldExecute === "function" && !options.shouldExecute(action))) return null;
  return { action, receipt: await execute(action) };
}

function explicitMediaOpenIntent(value) {
  const text = boundedText(value, 500).toLowerCase();
  if (!text) return false;
  if (/\b(?:not|never|don't|do not|no|zero|neither|nor|none|should i|why|explain|whether|what if|page says|page said|text says|quoted?)\b/.test(text)) return false;
  if (/^["'“‘]|\bif\s+i\b/.test(text)) return false;
  const prefix = "(?:hey(?: aggie)?[, ]+)?(?:please\\s+)?";
  const verb = "(?:open|play|watch|resume|reopen|go back to|return(?: me)? to|take me back to|bring me back to)";
  const action = text.match(new RegExp(`^(?:${prefix}${verb}\\b|${prefix}(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?${verb}\\b|${prefix}i\\s+(?:want|would like)\\s+(?:you\\s+)?to\\s+${verb}\\b)`));
  if (!action) return false;
  const tail = text.slice(action[0].length);
  const target = tail.match(/\b(?:youtube|video|bookmark|saved spot|spot i (?:saved|liked)|where i (?:was|left off))\b/);
  if (!target || target.index > 100) return false;
  return !/[,.!?;&]|\b(?:and|but|then|says?|said)\b/.test(tail.slice(0, target.index));
}

function explicitYouTubeSearchIntent(value, target) {
  if (!explicitMediaOpenIntent(value)) return false;
  const source = normalizeSearchText(value, 500);
  const query = normalizeSearchText(target?.query, 200);
  const title = normalizeSearchText(target?.title, 160);
  const channel = normalizeSearchText(target?.channel, 120);
  const sourceTokens = new Set(source.split(" ").filter(Boolean));
  const queryTokens = query.split(" ").filter(Boolean);
  return Boolean(queryTokens.length && queryTokens.every((token) => sourceTokens.has(token))
    && title && source.includes(title) && (!channel || source.includes(channel)));
}

function normalizeSearchText(value, max) {
  return boundedText(value, max).normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function createBrowserMediaRuntime(deps) {
  const {
    ask, callGateway, confirmMedia, getConfig, storage, tabs,
    pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    randomUUID = () => crypto.randomUUID(), now = () => new Date(),
  } = deps;
  let outboxFlushInFlight = null;
  let outboxMutation = Promise.resolve();
  const approvedSearchNavigation = Symbol("approvedSearchNavigation");

  async function execute(value, options = {}) {
    const action = mediaActionEnvelope(value);
    if (!action) return receipt("unsupported", false, "That is not a supported browser media action.");
    try {
      await flushMediaOutbox();
      const result = action.tool === "media.open"
        ? await open(action.input, options)
        : await bookmark(action.input, options);
      return await persistReceipt(receipt(action.tool, true, result.summary, result.result));
    } catch (error) {
      return await persistReceipt(receipt(action.tool, false, String(error?.message || error)));
    }
  }

  async function bookmark(input, options) {
    const operation = boundedText(input.operation || input.action || "remember", 20).toLowerCase();
    if (["remember", "create", "save"].includes(operation)) return remember(input, options);
    if (["open", "recall", "resolve"].includes(operation)) return recall(input, options);
    if (operation === "list") return list(input);
    if (["delete", "remove"].includes(operation)) return remove(input, options);
    throw new Error("Unsupported media bookmark operation.");
  }

  async function remember(input, options) {
    const tabId = await targetTabId(options.tabId);
    const current = await ask(tabId, { cmd: "mediaCurrentState" });
    if (!current?.ok) throw new Error(current?.error || "This page does not expose one supported YouTube video.");
    const parsed = parseYouTubeWatchUrl(current.url);
    if (!parsed) throw new Error("The current page does not have one valid YouTube video id.");
    const positionSeconds = Number.isFinite(current.position_seconds)
      ? Math.max(0, Math.floor(current.position_seconds))
      : parsed.position_seconds;
    const command = youtubeBookmarkCreateCommand({
      label: input.label || input.name,
      note: input.note,
      videoId: parsed.video_id,
      positionSeconds,
      preferredOrigin: parsed.web_origin,
    });
    if (!command) throw new Error("A bookmark needs a label, a valid video id, and a bounded playback position.");
    const disclosure = [
      `Save “${command.label}” at ${command.media.position_seconds}s?`,
      `Video id: ${command.media.video_id}`,
      command.note ? `Note leaving this browser: ${command.note}` : "No note will leave this browser.",
    ].join("\n");
    if (!(await confirmMedia({
      operation: "remember",
      video_id: command.media.video_id,
      position_seconds: command.media.position_seconds,
      label: command.label,
      note: command.note,
      disclosure,
    }))) throw new Error("Bookmark save cancelled.");
    const localId = `local_${randomUUID()}`;
    const timestamp = now().toISOString();
    const localBookmark = {
      id: localId,
      local_id: localId,
      provider: "youtube",
      video_id: command.media.video_id,
      canonical_url: `https://www.youtube.com/watch?v=${command.media.video_id}`,
      position_ms: command.media.position_seconds * 1000,
      label: command.label,
      note: command.note,
      aliases: [],
      source_surface: "browser_extension",
      user_approved: true,
      sync_status: "deferred",
      created_at: timestamp,
      updated_at: timestamp,
    };
    await queueOutbox({
      id: `outbox_create_${localId}`,
      operation: "create",
      local_id: localId,
      body: {
        provider: "youtube",
        video_id: localBookmark.video_id,
        canonical_url: localBookmark.canonical_url,
        position_ms: localBookmark.position_ms,
        label: localBookmark.label,
        note: localBookmark.note,
        aliases: [],
        source_surface: "browser_extension",
        idempotency_key: `browser_${localId}`,
        user_approved: true,
      },
      attempt_count: 0,
      created_at: timestamp,
      last_attempt_at: "",
    });
    await cacheBookmark(localBookmark);
    await flushMediaOutbox();
    const bookmark = resolveLocalBookmark(await readCachedBookmarks(), { id: localId }).bookmark || localBookmark;
    const sync = bookmark.sync_status === "synced" ? " Saved and synced." : " Saved locally; sync deferred.";
    return { summary: `Saved “${bookmark.label}” at ${Math.floor(bookmark.position_ms / 1000)}s.${sync}`, result: { bookmark, sync_status: bookmark.sync_status } };
  }

  async function open(input, options) {
    const suppliedMedia = input.media && typeof input.media === "object" ? input.media : input;
    const suppliedUrl = suppliedMedia.watch_url || suppliedMedia.watchUrl || input.watch_url || input.watchUrl;
    const parsedUrl = suppliedUrl ? parseYouTubeWatchUrl(suppliedUrl) : null;
    const direct = youtubeBookmarkOpenCommand({
      label: input.label,
      video_id: suppliedMedia.video_id || suppliedMedia.videoId || parsedUrl?.video_id,
      position_seconds: suppliedMedia.position_seconds ?? suppliedMedia.positionSeconds
        ?? (Number.isFinite(suppliedMedia.position_ms) ? Math.floor(suppliedMedia.position_ms / 1000) : parsedUrl?.position_seconds ?? 0),
    });
    if (!direct) {
      if (input.bookmark_id || input.bookmarkId || input.source === "bookmark") return recall(input, options);
      if (input.query || input.title || input.video_title || input.videoTitle) return searchAndOpen(input, options);
      throw new Error("Media open requires a valid YouTube video id and bounded position.");
    }
    const tabId = await targetTabId(options.tabId);
    if (!explicitMediaOpenIntent(options.sourceText) && options.searchApproval !== approvedSearchNavigation) {
      const allowed = await confirmMedia({
        operation: "open",
        video_id: direct.media.video_id,
        position_seconds: direct.media.position_seconds,
        label: direct.label,
        disclosure: `Open YouTube video ${direct.media.video_id} at ${direct.media.position_seconds}s in the active tab?`,
      });
      if (!allowed) throw new Error("Media open cancelled.");
    }
    await tabs.update(tabId, { url: direct.media.watch_url, active: true });
    return { summary: `Opened YouTube video ${direct.media.video_id} at ${direct.media.position_seconds}s.`, result: { tab_id: tabId, media: direct.media } };
  }

  async function searchAndOpen(input, options) {
    const rawQuery = input.query ?? input.title ?? input.video_title ?? input.videoTitle;
    const rawTitle = input.title ?? input.video_title ?? input.videoTitle ?? input.query;
    const rawChannel = input.channel ?? input.channel_name ?? input.channelName ?? "";
    if (typeof rawQuery !== "string" || typeof rawTitle !== "string" || typeof rawChannel !== "string") {
      throw new Error("YouTube search fields must be plain text.");
    }
    const query = boundedText(rawQuery, 200);
    const title = boundedText(rawTitle, 160);
    const channel = boundedText(rawChannel, 120);
    if (!query || !title) throw new Error("YouTube search needs a bounded query and exact target title.");
    const tabId = await targetTabId(options.tabId);
    if (!explicitYouTubeSearchIntent(options.sourceText, { query, title, channel })) {
      const allowed = await confirmMedia({
        operation: "search_open",
        query,
        title,
        channel,
        disclosure: `Search YouTube for “${query}”, require exact title “${title}”${channel ? ` from channel “${channel}”` : ""}, then open the unique match?`,
      });
      if (!allowed) throw new Error("YouTube search cancelled.");
    }
    const searchUrl = new URL("/results", "https://www.youtube.com/");
    searchUrl.searchParams.set("search_query", query);
    await tabs.update(tabId, { url: searchUrl.href, active: true });
    let observation = null;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      try {
        observation = await ask(tabId, { cmd: "mediaYouTubeSearchResults" });
        if (observation?.ok && observation.ready !== false) break;
      } catch {}
      if (attempt < 31) await pause(250);
    }
    if (!observation?.ok) throw new Error("YouTube search results were not available through the fixed browser policy.");
    const selected = selectYouTubeSearchResult(observation.results, { title, channel });
    if (selected.status === "ambiguous") throw new Error("YouTube search found multiple exact matches; include an exact channel name.");
    if (selected.status !== "matched") throw new Error("YouTube search found no unique exact title/channel match.");
    return open({
      media: { video_id: selected.result.video_id, position_seconds: 0 },
      label: selected.result.title,
    }, { ...options, tabId, searchApproval: approvedSearchNavigation });
  }

  async function recall(input, options) {
    const rawId = input.bookmark_id ?? input.id ?? "";
    if (rawId !== "" && !validRemoteId(rawId)) throw new Error("Bookmark id has an invalid format.");
    const id = rawId;
    const query = boundedText(input.query || input.label || input.name, 160);
    if (!id && !query) throw new Error("Bookmark recall needs an id or label.");
    const localResolution = resolveLocalBookmark(await readCachedBookmarks(), { id, query });
    let bookmark = localResolution.status === "matched" ? localResolution.bookmark : null;
    let remoteResolution = null;
    let remoteInvalid = false;
    const cfg = await optionalGateway();
    if (cfg) try {
      const data = id
        ? await callGateway(cfg, `/v1/media/bookmarks/${encodeURIComponent(id)}`, { method: "GET" })
        : await callGateway(cfg, `/v1/media/bookmarks?query=${encodeURIComponent(query)}`, { method: "GET" });
      remoteResolution = data?.resolution || null;
      const remote = data?.bookmark || (data?.resolution?.status === "matched" ? data.resolution.bookmark : null);
      if (remote) {
        const merged = await mergeRemoteBookmark(remote);
        remoteInvalid = !merged;
        const same = bookmark && (bookmark.server_id === remote.id || (
          bookmark.video_id === remote.video_id && bookmark.position_ms === remote.position_ms && bookmark.label === remote.label
        ));
        if (query || !bookmark || same) bookmark = merged || bookmark;
      }
    } catch {}
    if (query && remoteResolution?.status === "ambiguous") throw new Error("That bookmark name is ambiguous; use a more specific label.");
    if (query && remoteInvalid) throw new Error("The gateway returned an invalid media bookmark identity.");
    if (!bookmark) {
      if (localResolution.status === "ambiguous" || remoteResolution?.status === "ambiguous") throw new Error("That bookmark name is ambiguous; use a more specific label.");
      throw new Error("No matching media bookmark was found.");
    }
    const command = youtubeBookmarkOpenCommand({
      label: bookmark.label,
      video_id: bookmark.video_id,
      position_seconds: Math.floor(bookmark.position_ms / 1000),
    });
    if (!command) throw new Error("The stored bookmark does not contain a valid YouTube identity.");
    return open(command, options);
  }

  async function list(input) {
    const videoId = boundedText(input.video_id || input.videoId, 11);
    const requestedSurface = boundedText(input.source_surface || input.sourceSurface, 40).toLowerCase();
    const sourceSurface = /^[a-z][a-z0-9_-]*$/.test(requestedSurface) ? requestedSurface : "";
    let bookmarks = await readCachedBookmarks();
    const cfg = await optionalGateway();
    if (cfg) try {
      const path = `/v1/media/bookmarks?limit=100${videoId ? `&video_id=${encodeURIComponent(videoId)}` : ""}${sourceSurface ? `&source_surface=${encodeURIComponent(sourceSurface)}` : ""}`;
      const data = await callGateway(cfg, path, { method: "GET" });
      for (const remote of Array.isArray(data?.bookmarks) ? data.bookmarks : []) await mergeRemoteBookmark(remote);
      bookmarks = await readCachedBookmarks();
    } catch {}
    if (videoId) bookmarks = bookmarks.filter((bookmark) => bookmark.video_id === videoId);
    if (sourceSurface) bookmarks = bookmarks.filter((bookmark) => bookmark.source_surface === sourceSurface);
    return { summary: bookmarks.length ? `Found ${bookmarks.length} browser media bookmark${bookmarks.length === 1 ? "" : "s"}.` : "No browser media bookmarks found.", result: { bookmarks } };
  }

  async function remove(input, options) {
    const rawId = input.bookmark_id ?? input.id ?? "";
    if (rawId !== "" && !validRemoteId(rawId)) throw new Error("Bookmark id has an invalid format.");
    const id = rawId;
    const query = boundedText(input.query || input.label || input.name, 160);
    if (!id && !query) throw new Error("Bookmark delete needs an id or label.");
    const cfg = await optionalGateway();
    const localResolution = resolveLocalBookmark(await readCachedBookmarks(), { id, query });
    if (localResolution.status === "ambiguous") throw new Error("That bookmark name is ambiguous; use a more specific label.");
    let bookmark = localResolution.bookmark || null;
    let remoteAmbiguous = false;
    let remoteInvalid = false;
    if (cfg && (query || !bookmark)) try {
      const data = id
        ? await callGateway(cfg, `/v1/media/bookmarks/${encodeURIComponent(id)}`, { method: "GET" })
        : await callGateway(cfg, `/v1/media/bookmarks?query=${encodeURIComponent(query)}`, { method: "GET" });
      remoteAmbiguous = data?.resolution?.status === "ambiguous";
      const remote = data?.bookmark || (data?.resolution?.status === "matched" ? data.resolution.bookmark : null);
      if (remote) {
        const merged = await mergeRemoteBookmark(remote);
        remoteInvalid = !merged;
        bookmark = merged || bookmark;
      }
    } catch {}
    if (remoteAmbiguous) throw new Error("That bookmark name is ambiguous; use a more specific label.");
    if (query && remoteInvalid) throw new Error("The gateway returned an invalid media bookmark identity.");
    if (!bookmark) throw new Error("Media bookmark not found.");
    if (!(await confirmMedia({
      operation: "delete",
      video_id: bookmark.video_id,
      position_seconds: Math.floor(bookmark.position_ms / 1000),
      label: bookmark.label,
      bookmark_id: bookmark.id,
      disclosure: `Delete saved spot “${bookmark.label}” for video ${bookmark.video_id}?`,
    }))) {
      throw new Error("Bookmark delete cancelled.");
    }
    const remoteId = bookmark.server_id || (id && !id.startsWith("local_") ? id : "");
    if (remoteId) await queueOutbox({
      id: `outbox_delete_${remoteId}`,
      operation: "delete",
      local_id: bookmark.local_id || bookmark.id,
      server_id: remoteId,
      video_id: bookmark.video_id,
      label: bookmark.label,
      attempt_count: 0,
      created_at: now().toISOString(),
      last_attempt_at: "",
    });
    await removeOutbox((record) => record.operation === "create" && record.local_id === bookmark.local_id);
    await removeCachedBookmark(bookmark);
    if (cfg) await flushMediaOutbox();
    const retryPending = remoteId && (await readOutbox()).some((record) => record.operation === "delete" && record.server_id === remoteId);
    const syncStatus = retryPending ? "needs_retry" : remoteId ? "synced" : "local_only";
    const suffix = syncStatus === "needs_retry" ? " Remote delete needs retry." : "";
    return { summary: `Deleted “${bookmark.label}” locally.${suffix}`, result: { deleted: true, bookmark_id: bookmark.id, sync_status: syncStatus } };
  }

  async function optionalGateway() {
    try {
      const cfg = await getConfig();
      return cfg?.gatewayUrl ? cfg : null;
    } catch {
      return null;
    }
  }

  async function flushMediaOutbox() {
    if (outboxFlushInFlight) return outboxFlushInFlight;
    outboxFlushInFlight = flushMediaOutboxOnce();
    try { return await outboxFlushInFlight; }
    finally { outboxFlushInFlight = null; }
  }

  async function flushMediaOutboxOnce() {
    const records = await readOutbox();
    if (!records.length) return;
    const cfg = await optionalGateway();
    if (!cfg) return;
    for (const record of records) {
      const attempted = { ...record, attempt_count: Math.min(1000, record.attempt_count + 1), last_attempt_at: now().toISOString() };
      await queueOutbox(attempted);
      try {
        if (record.operation === "create") {
          const local = resolveLocalBookmark(await readCachedBookmarks(), { id: record.local_id }).bookmark;
          if (!local) { await removeOutbox((item) => item.id === record.id); continue; }
          const data = await callGateway(cfg, "/v1/media/bookmarks", { body: record.body });
          if (!validRemoteId(data?.bookmark?.id)) continue;
          await cacheBookmark({ ...local, ...data.bookmark, id: local.id, local_id: local.local_id, server_id: data.bookmark.id, sync_status: "synced" });
        } else {
          await callGateway(cfg, `/v1/media/bookmarks/${encodeURIComponent(record.server_id)}`, { method: "DELETE" });
        }
        await removeOutbox((item) => item.id === record.id);
      } catch {}
    }
  }

  async function targetTabId(supplied) {
    const id = Number(supplied);
    if (Number.isFinite(id)) return id;
    const [active] = await tabs.query({ active: true, lastFocusedWindow: true });
    if (!active?.id) throw new Error("No active browser tab is available.");
    return active.id;
  }

  function receipt(tool, ok, summary, result = null) {
    return { ok, tool, summary: boundedText(summary, 500), result, local_receipt: { tool, success: ok, receipt_id: `media_${randomUUID()}`, created_at: now().toISOString() } };
  }

  async function persistReceipt(value) {
    const stored = await storage.get({ [RECEIPTS_KEY]: [] });
    const existing = Array.isArray(stored[RECEIPTS_KEY]) ? stored[RECEIPTS_KEY] : [];
    await storage.set({ [RECEIPTS_KEY]: [...existing.slice(-(MAX_LOCAL_RECORDS - 1)), value.local_receipt] });
    return value;
  }

  function canonicalOutboxRecord(input) {
    const operation = input?.operation === "create" ? "create" : input?.operation === "delete" ? "delete" : "";
    const id = input?.id;
    const localId = input?.local_id;
    if (!operation || !validOutboxId(id) || !validRemoteId(localId)) return null;
    const common = {
      id,
      operation,
      local_id: localId,
      attempt_count: Number.isInteger(input.attempt_count) ? Math.max(0, Math.min(1000, input.attempt_count)) : 0,
      created_at: boundedText(input.created_at, 40),
      last_attempt_at: boundedText(input.last_attempt_at, 40),
    };
    if (operation === "delete") {
      const serverId = input.server_id;
      const videoId = boundedText(input.video_id, 11);
      if (!validRemoteId(serverId) || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
      return { ...common, server_id: serverId, video_id: videoId, label: boundedText(input.label, 120) };
    }
    const body = input.body && typeof input.body === "object" ? input.body : {};
    const videoId = boundedText(body.video_id, 11);
    const position = body.position_ms;
    const label = boundedText(body.label, 120);
    const idempotencyKey = body.idempotency_key;
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || !Number.isSafeInteger(position) || position < 0 || position > MAX_POSITION_SECONDS * 1000 || !label || !validIdempotencyKey(idempotencyKey)) return null;
    return { ...common, body: {
      provider: "youtube",
      video_id: videoId,
      canonical_url: `https://www.youtube.com/watch?v=${videoId}`,
      position_ms: position,
      label,
      note: boundedText(body.note, 1000),
      aliases: [],
      source_surface: "browser_extension",
      idempotency_key: idempotencyKey,
      user_approved: true,
    } };
  }

  async function readOutbox() {
    await outboxMutation;
    return readOutboxStored();
  }

  async function readOutboxStored() {
    const stored = await storage.get({ [BOOKMARK_OUTBOX_KEY]: [] });
    return (Array.isArray(stored[BOOKMARK_OUTBOX_KEY]) ? stored[BOOKMARK_OUTBOX_KEY] : [])
      .map(canonicalOutboxRecord).filter(Boolean).slice(0, MAX_LOCAL_RECORDS);
  }

  async function queueOutbox(input) {
    const record = canonicalOutboxRecord(input);
    if (!record) throw new Error("Invalid local media sync record.");
    const write = outboxMutation.then(async () => {
      const existing = await readOutboxStored();
      const replacing = existing.some((item) => item.id === record.id);
      if (!replacing && existing.length >= MAX_LOCAL_RECORDS) throw new Error("Local media sync queue is full; nothing was changed.");
      await storage.set({ [BOOKMARK_OUTBOX_KEY]: [record, ...existing.filter((item) => item.id !== record.id)] });
    });
    outboxMutation = write.catch(() => {});
    return write;
  }

  async function removeOutbox(predicate) {
    const write = outboxMutation.then(async () => {
      const existing = await readOutboxStored();
      await storage.set({ [BOOKMARK_OUTBOX_KEY]: existing.filter((item) => !predicate(item)) });
    });
    outboxMutation = write.catch(() => {});
    return write;
  }

  async function cacheBookmark(bookmark) {
    const stored = await storage.get({ [BOOKMARK_CACHE_KEY]: [] });
    const existing = Array.isArray(stored[BOOKMARK_CACHE_KEY]) ? stored[BOOKMARK_CACHE_KEY] : [];
    const matches = (item) => item?.id === bookmark.id
      || (bookmark.local_id && item?.local_id === bookmark.local_id)
      || (bookmark.server_id && (item?.server_id === bookmark.server_id || item?.id === bookmark.server_id));
    await storage.set({ [BOOKMARK_CACHE_KEY]: [bookmark, ...existing.filter((item) => !matches(item))].slice(0, MAX_LOCAL_RECORDS) });
  }

  async function readCachedBookmarks() {
    const stored = await storage.get({ [BOOKMARK_CACHE_KEY]: [] });
    return (Array.isArray(stored[BOOKMARK_CACHE_KEY]) ? stored[BOOKMARK_CACHE_KEY] : []).filter((bookmark) => (
      bookmark && bookmark.provider === "youtube"
      && /^[A-Za-z0-9_-]{11}$/.test(String(bookmark.video_id || ""))
      && Number.isSafeInteger(bookmark.position_ms) && bookmark.position_ms >= 0
    )).slice(0, MAX_LOCAL_RECORDS);
  }

  function resolveLocalBookmark(bookmarks, { id = "", query = "" } = {}) {
    if (id) {
      const bookmark = bookmarks.find((item) => [item.id, item.local_id, item.server_id].includes(id));
      return bookmark ? { status: "matched", match_type: "id", bookmark } : { status: "not_found", candidates: [] };
    }
    const normalized = normalizeAlias(query);
    if (!normalized) return { status: "not_found", candidates: [] };
    const ranked = bookmarks.map((bookmark) => rankLocalBookmark(bookmark, normalized)).filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || String(b.bookmark.updated_at || "").localeCompare(String(a.bookmark.updated_at || "")) || a.bookmark.id.localeCompare(b.bookmark.id));
    if (!ranked.length) return { status: "not_found", candidates: [] };
    const top = ranked.filter((item) => item.score === ranked[0].score);
    if (top.length > 1) return { status: "ambiguous", match_type: top[0].match_type, candidates: top.map((item) => item.bookmark) };
    return { status: "matched", match_type: top[0].match_type, bookmark: top[0].bookmark };
  }

  function rankLocalBookmark(bookmark, query) {
    const aliases = [bookmark.label, ...(Array.isArray(bookmark.aliases) ? bookmark.aliases.slice(0, 12) : [])].map(normalizeAlias).filter(Boolean);
    if (aliases.includes(query)) return { bookmark, score: 3000, match_type: "exact_alias" };
    if (aliases.some((alias) => alias.includes(query) || query.includes(alias))) return { bookmark, score: 2000, match_type: "phrase" };
    const queryTokens = new Set(query.split(" ").filter(Boolean));
    let score = 0;
    for (const alias of aliases) {
      const aliasTokens = new Set(alias.split(" ").filter(Boolean));
      const shared = [...queryTokens].filter((token) => aliasTokens.has(token)).length;
      score = Math.max(score, shared ? Math.round((shared / Math.max(queryTokens.size, aliasTokens.size)) * 1000) : 0);
    }
    return { bookmark, score, match_type: "token_overlap" };
  }

  function normalizeAlias(value) {
    return boundedText(value, 160).normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  }

  async function mergeRemoteBookmark(remote) {
    if (!remote || !validRemoteId(remote.id) || (remote.provider && remote.provider !== "youtube") || !/^[A-Za-z0-9_-]{11}$/.test(String(remote.video_id || ""))) return null;
    if ((await readOutbox()).some((record) => record.operation === "delete" && record.server_id === remote.id)) return null;
    const cached = await readCachedBookmarks();
    const local = cached.find((bookmark) => bookmark.server_id === remote.id || (
      bookmark.video_id === remote.video_id && bookmark.position_ms === remote.position_ms && bookmark.label === remote.label
    ));
    const localId = local?.local_id || local?.id || `local_${randomUUID()}`;
    const merged = { ...local, ...remote, id: localId, local_id: localId, server_id: remote.id, provider: "youtube", sync_status: "synced" };
    await cacheBookmark(merged);
    return merged;
  }

  async function removeCachedBookmark(bookmark) {
    const stored = await storage.get({ [BOOKMARK_CACHE_KEY]: [] });
    const existing = Array.isArray(stored[BOOKMARK_CACHE_KEY]) ? stored[BOOKMARK_CACHE_KEY] : [];
    const ids = new Set([bookmark.id, bookmark.local_id, bookmark.server_id].filter(Boolean));
    await storage.set({ [BOOKMARK_CACHE_KEY]: existing.filter((item) => ![item?.id, item?.local_id, item?.server_id].some((id) => ids.has(id))) });
  }

  function validRemoteId(value) {
    return typeof value === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(value);
  }

  function validOutboxId(value) {
    return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
  }

  function validIdempotencyKey(value) {
    return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
  }

  return Object.freeze({ execute, mediaActionsFromTurn });
}

function selectYouTubeSearchResult(results, target) {
  const wantedTitle = normalizeSearchText(target?.title, 160), wantedChannel = normalizeSearchText(target?.channel, 120);
  if (!wantedTitle) return { status: "not_found", candidates: [] };
  const unique = new Map();
  for (const raw of Array.isArray(results) ? results.slice(0, 24) : []) {
    const videoId = boundedText(raw?.video_id, 11), title = boundedText(raw?.title, 160), channel = boundedText(raw?.channel, 120);
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || normalizeSearchText(title, 160) !== wantedTitle) continue;
    if (wantedChannel && normalizeSearchText(channel, 120) !== wantedChannel) continue;
    if (!unique.has(videoId)) unique.set(videoId, { video_id: videoId, title, channel });
  }
  const candidates = [...unique.values()];
  return candidates.length === 1 ? { status: "matched", result: candidates[0] }
    : { status: candidates.length ? "ambiguous" : "not_found", candidates };
}

export { browserLocalToolManifest, createBrowserMediaRuntime, executeFirstMediaActionFromTurn, explicitMediaOpenIntent, explicitYouTubeSearchIntent, mediaActionEnvelope, mediaActionsFromTurn, selectYouTubeSearchResult };
