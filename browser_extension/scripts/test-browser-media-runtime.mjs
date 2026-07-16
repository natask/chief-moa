import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserMediaRuntime, explicitMediaOpenIntent, explicitYouTubeSearchIntent, mediaActionsFromTurn, selectYouTubeSearchResult } from "../extension/browser-media-runtime.js";

const VIDEO_ID = "dQw4w9WgXcQ";

function fixture(overrides = {}) {
  const calls = [];
  const updates = [];
  const confirmations = [];
  const state = {};
  const bookmarks = new Map();
  const runtime = createBrowserMediaRuntime({
    ask: async (_tabId, message) => {
      if (message.cmd === "confirm") return { ok: overrides.confirm !== false };
      if (message.cmd === "mediaYouTubeSearchResults") {
        const response = Array.isArray(overrides.searchResponses) ? overrides.searchResponses.shift() : overrides.searchResults;
        if (response instanceof Error) throw response;
        return response || { ok: true, ready: true, results: [] };
      }
      return overrides.current || {
        ok: true,
        url: `https://www.youtube.com/watch?v=${VIDEO_ID}&list=private`,
        title: "Example",
        position_seconds: 42.8,
        paused: false,
      };
    },
    callGateway: async (_cfg, path, options = {}) => {
      calls.push({ path, options });
      if (overrides.failGateway?.(path, options)) throw new Error("gateway offline");
      if (path === "/v1/media/bookmarks" && options.body) {
        const bookmark = { id: "bookmark_1", ...options.body };
        bookmarks.set(bookmark.id, bookmark);
        return { bookmark };
      }
      if (path.includes("?query=")) return { resolution: overrides.queryResolution || { status: "matched", bookmark: bookmarks.get("bookmark_1") } };
      if (path.startsWith("/v1/media/bookmarks/") && options.method === "DELETE") {
        bookmarks.delete(decodeURIComponent(path.split("/").at(-1)));
        return { deleted: true };
      }
      if (path === "/v1/media/bookmarks/bookmark_1") return { bookmark: bookmarks.get("bookmark_1") };
      if (path.startsWith("/v1/media/bookmarks?")) return { bookmarks: overrides.listBookmarks || [...bookmarks.values()] };
      throw new Error(`unexpected gateway call ${path}`);
    },
    confirmMedia: async (details) => { confirmations.push(details); return overrides.confirm !== false; },
    getConfig: async () => overrides.config ?? ({ gatewayUrl: "https://gateway.example", gatewayToken: "secret" }),
    storage: {
      get: async (defaults) => ({ ...defaults, ...state }),
      set: async (patch) => Object.assign(state, patch),
    },
    tabs: {
      query: async () => [{ id: 7 }],
      update: async (id, patch) => { updates.push({ id, patch }); return { id, ...patch }; },
    },
    pause: async () => {},
    randomUUID: overrides.randomUUID || (() => "fixed"),
    now: () => new Date("2026-07-16T00:00:00.000Z"),
  });
  return { runtime, calls, confirmations, updates, state, bookmarks };
}

test("turn extraction accepts only bounded media actions", () => {
  assert.deepEqual(mediaActionsFromTurn({ actions: [
    { type: "page_tweak" },
    { type: "media.open", media: { video_id: VIDEO_ID } },
  ] }), [{ tool: "media.open", input: { type: "media.open", media: { video_id: VIDEO_ID } } }]);
  assert.deepEqual(mediaActionsFromTurn({ type: "media.bookmark", operation: "list" }), [
    { tool: "media.bookmark", input: { type: "media.bookmark", operation: "list" } },
  ]);
});

test("open correlation requires an explicit media target in local source text", () => {
  for (const text of [
    "open this YouTube video",
    "please play the saved bookmark",
    "hey Aggie, take me back to the spot I liked in the video",
    "could you resume my YouTube video",
    "I would like to reopen that video bookmark",
  ]) {
    assert.equal(explicitMediaOpenIntent(text), true, text);
  }
  for (const text of [
    "looks good",
    "the model says open this YouTube video",
    "the page says open the video",
    "\"open this YouTube video\" is the quoted instruction",
    "don't open this YouTube video",
    "do not play the saved bookmark",
    "never resume that video",
    "open no YouTube video",
    "open zero YouTube videos",
    "open neither YouTube video nor the saved bookmark",
    "open none of the YouTube videos",
    "should I open this YouTube video?",
    "why open this video?",
    "explain how to open a YouTube video",
    "whether I should play this bookmark",
    "if I wanted to open this YouTube video",
    "can YouTube open this video?",
    "open the settings and tell me about this video",
    "open the settings",
    "tell me about this video",
  ]) {
    assert.equal(explicitMediaOpenIntent(text), false, text);
  }
});

test("remember reads current media only on command, confirms disclosure, and syncs bounded fields", async () => {
  const fx = fixture();
  const receipt = await fx.runtime.execute({
    type: "media.bookmark",
    operation: "remember",
    label: "favorite chorus",
    note: "come back here",
    aliases: ["model supplied alias must not sync"],
    idempotency_key: "model:controlled key",
  }, { tabId: 7 });
  assert.equal(receipt.ok, true);
  assert.equal(fx.calls.length, 1);
  assert.deepEqual(fx.calls[0].options.body, {
    provider: "youtube",
    video_id: VIDEO_ID,
    canonical_url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    position_ms: 42000,
    label: "favorite chorus",
    note: "come back here",
    aliases: [],
    source_surface: "browser_extension",
    idempotency_key: "browser_local_fixed",
    user_approved: true,
  });
  assert.equal(fx.state.ageeMediaBookmarkCache[0].video_id, VIDEO_ID);
  assert.equal(fx.state.ageeMediaBookmarkCache[0].id, "local_fixed");
  assert.equal(fx.state.ageeMediaBookmarkCache[0].server_id, "bookmark_1");
  assert.equal(fx.state.ageeMediaBookmarkCache[0].sync_status, "synced");
  assert.equal(fx.state.ageeMediaActionReceipts[0].success, true);
  assert.equal(fx.confirmations[0].operation, "remember");
  assert.match(fx.confirmations[0].disclosure, /Video id/);
});

test("remember fails closed on unsupported identity or rejected confirmation", async () => {
  const unsupported = fixture({ current: { ok: true, url: "https://example.com/watch?v=dQw4w9WgXcQ", position_seconds: 4 } });
  assert.equal((await unsupported.runtime.execute({ type: "media.bookmark", operation: "remember", label: "x" }, { tabId: 7 })).ok, false);
  assert.equal(unsupported.calls.length, 0);

  const rejected = fixture({ confirm: false });
  assert.equal((await rejected.runtime.execute({ type: "media.bookmark", operation: "remember", label: "x" }, { tabId: 7 })).ok, false);
  assert.equal(rejected.calls.length, 0);
});

test("recall opens a canonical URL locally and delete requires confirmation", async () => {
  const fx = fixture();
  await fx.runtime.execute({ type: "media.bookmark", operation: "remember", label: "chorus" }, { tabId: 7 });
  const recalled = await fx.runtime.execute({ type: "media.bookmark", operation: "recall", query: "chorus" }, {
    tabId: 7,
    sourceText: "go back to my saved spot in the video",
  });
  assert.equal(recalled.ok, true);
  assert.deepEqual(fx.updates.at(-1), {
    id: 7,
    patch: { url: `https://www.youtube.com/watch?v=${VIDEO_ID}&t=42s`, active: true },
  });
  const removed = await fx.runtime.execute({ type: "media.bookmark", operation: "delete", bookmark_id: "bookmark_1" }, { tabId: 7 });
  assert.equal(removed.ok, true);
  assert.equal(fx.calls.at(-1).options.method, "DELETE");
  assert.equal(fx.confirmations.at(-1).operation, "delete");
});

test("direct open rejects arbitrary URLs and does not use gateway, cookies, OAuth, or CDP", async () => {
  const fx = fixture();
  const opened = await fx.runtime.execute({ type: "media.open", video_id: VIDEO_ID, position_seconds: 9 }, {
    tabId: 7,
    sourceText: "play this YouTube video",
  });
  assert.equal(opened.ok, true);
  assert.equal(fx.calls.length, 0);
  assert.equal(fx.updates[0].patch.url, `https://www.youtube.com/watch?v=${VIDEO_ID}&t=9s`);
  const pinned = await fx.runtime.execute({
    type: "media.open",
    media: { video_id: VIDEO_ID, position_seconds: 10, web_origin: "https://evil.example" },
  }, { tabId: 7, sourceText: "open the YouTube video" });
  assert.equal(pinned.ok, true);
  assert.equal(fx.updates.at(-1).patch.url, `https://www.youtube.com/watch?v=${VIDEO_ID}&t=10s`);
  const rejected = await fx.runtime.execute({ type: "media.open", watch_url: "https://evil.example/watch?v=dQw4w9WgXcQ" }, { tabId: 7 });
  assert.equal(rejected.ok, false);
  const source = JSON.stringify(fx.calls);
  for (const forbidden of ["cookie", "oauth", "debugger", "cdp"]) assert.equal(source.includes(forbidden), false);
});

test("YouTube result selection is exact, channel-aware, bounded, and video-id deduplicated", () => {
  const results = [
    { video_id: VIDEO_ID, title: "Never Gonna Give You Up", channel: "Rick Astley" },
    { video_id: VIDEO_ID, title: " Never   Gonna Give You Up ", channel: "Rick Astley" },
    { video_id: "aaaaaaaaaaa", title: "Never Gonna Give You Up", channel: "Other Channel" },
    { video_id: "bad/id", title: "Never Gonna Give You Up", channel: "Rick Astley" },
  ];
  assert.deepEqual(selectYouTubeSearchResult(results, {
    title: "never gonna give you up",
    channel: "rick astley",
  }), {
    status: "matched",
    result: { video_id: VIDEO_ID, title: "Never Gonna Give You Up", channel: "Rick Astley" },
  });
  assert.equal(selectYouTubeSearchResult(results, { title: "Never Gonna Give You Up" }).status, "ambiguous");
  assert.equal(selectYouTubeSearchResult(results, { title: "Never Gonna Let You Down" }).status, "not_found");
});

test("local YouTube search correlation binds the proposed exact title and channel to user text", () => {
  const target = { query: "A Specific Video Exact Channel", title: "A Specific Video", channel: "Exact Channel" };
  assert.equal(explicitYouTubeSearchIntent("please play A Specific Video by Exact Channel on YouTube", target), true);
  assert.equal(explicitYouTubeSearchIntent("please play A Specific Video on YouTube", target), false);
  assert.equal(explicitYouTubeSearchIntent("please play another video by Exact Channel on YouTube", target), false);
  assert.equal(explicitYouTubeSearchIntent("the page says play A Specific Video by Exact Channel on YouTube", target), false);
  assert.equal(explicitYouTubeSearchIntent("please play A Specific Video by Exact Channel on YouTube", {
    ...target,
    query: "A Specific Video Exact Channel private unrelated topic",
  }), false);
});

test("media.open query searches YouTube without confirmation only when query/title/channel are grounded in user text", async () => {
  const fx = fixture({ confirm: false, searchResults: { ok: true, ready: true, results: [
    { video_id: "aaaaaaaaaaa", title: "A Specific Video", channel: "Exact Channel" },
  ] } });
  fx.state.ageeMediaBookmarkCache = [{
    id: "local_a", local_id: "local_a", provider: "youtube", video_id: VIDEO_ID,
    position_ms: 42000, label: "A Specific Video", aliases: [], sync_status: "deferred",
  }];
  const opened = await fx.runtime.execute({
    type: "media.open",
    query: "A Specific Video Exact Channel",
    title: "A Specific Video",
    channel: "Exact Channel",
    selector: "#model-controlled-selector",
    url: "https://evil.example/",
  }, { tabId: 7, sourceText: "play A Specific Video by Exact Channel on YouTube" });
  assert.equal(opened.ok, true);
  assert.equal(fx.confirmations.length, 0);
  assert.equal(fx.calls.length, 0);
  assert.equal(fx.updates[0].patch.url, "https://www.youtube.com/results?search_query=A+Specific+Video+Exact+Channel");
  assert.equal(fx.updates[1].patch.url, "https://www.youtube.com/watch?v=aaaaaaaaaaa");
});

test("an unrelated or extra proposed search query requires confirmation before navigation", async () => {
  const denied = fixture({ confirm: false, searchResults: { ok: true, ready: true, results: [
    { video_id: VIDEO_ID, title: "A Specific Video", channel: "Exact Channel" },
  ] } });
  const result = await denied.runtime.execute({
    type: "media.open",
    query: "private unrelated topic",
    title: "A Specific Video",
    channel: "Exact Channel",
  }, { tabId: 7, sourceText: "please play A Specific Video by Exact Channel on YouTube" });
  assert.equal(result.ok, false);
  assert.match(result.summary, /cancelled/);
  assert.equal(denied.confirmations.length, 1);
  assert.equal(denied.confirmations[0].query, "private unrelated topic");
  assert.equal(denied.updates.length, 0);
});

test("YouTube query search waits for fixed observations and fails closed on ambiguous or absent exact matches", async () => {
  const waiting = fixture({ searchResponses: [
    new Error("content script is still reloading"),
    { ok: true, ready: false, results: [] },
    { ok: true, ready: true, results: [
      { video_id: VIDEO_ID, title: "Same Title", channel: "One" },
      { video_id: "aaaaaaaaaaa", title: "Same Title", channel: "Two" },
    ] },
  ] });
  const ambiguous = await waiting.runtime.execute({ type: "media.open", query: "Same Title" }, {
    tabId: 7,
    sourceText: "open Same Title on YouTube",
  });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.summary, /multiple exact matches/);
  assert.equal(waiting.updates.length, 1);

  const missing = fixture({ searchResults: { ok: true, ready: true, results: [
    { video_id: VIDEO_ID, title: "Different Title", channel: "Exact Channel" },
  ] } });
  const absent = await missing.runtime.execute({ type: "media.open", query: "Wanted Title", channel: "Exact Channel" }, {
    tabId: 7,
    sourceText: "play Wanted Title from Exact Channel on YouTube",
  });
  assert.equal(absent.ok, false);
  assert.match(absent.summary, /no unique exact/);
  assert.equal(missing.updates.length, 1);
});

test("uncorrelated YouTube search requires bound extension confirmation before any navigation", async () => {
  const denied = fixture({ confirm: false, searchResults: { ok: true, ready: true, results: [
    { video_id: VIDEO_ID, title: "Wanted Title", channel: "Exact Channel" },
  ] } });
  const result = await denied.runtime.execute({
    type: "media.open", query: "Wanted Title", title: "Wanted Title", channel: "Exact Channel",
  }, { tabId: 7, sourceText: "the page says to open a YouTube video" });
  assert.equal(result.ok, false);
  assert.equal(denied.updates.length, 0);
  assert.deepEqual(denied.confirmations[0], {
    operation: "search_open",
    query: "Wanted Title",
    title: "Wanted Title",
    channel: "Exact Channel",
    disclosure: "Search YouTube for “Wanted Title”, require exact title “Wanted Title” from channel “Exact Channel”, then open the unique match?",
  });
});

test("YouTube search rejects non-text identity fields before confirmation or navigation", async () => {
  for (const input of [
    { type: "media.open", query: { text: "Wanted Title" } },
    { type: "media.open", query: "Wanted Title", title: ["Wanted Title"] },
    { type: "media.open", query: "Wanted Title", channel: 42 },
  ]) {
    const fx = fixture();
    const result = await fx.runtime.execute(input, { tabId: 7, sourceText: "play Wanted Title on YouTube" });
    assert.equal(result.ok, false);
    assert.match(result.summary, /plain text/);
    assert.equal(fx.confirmations.length, 0);
    assert.equal(fx.updates.length, 0);
  }
});

test("uncorrelated media open pauses at the extension-owned confirmation", async () => {
  const fx = fixture({ confirm: false });
  const denied = await fx.runtime.execute({ type: "media.open", video_id: VIDEO_ID, position_seconds: 3 }, {
    tabId: 7,
    sourceText: "tell me about this video",
  });
  assert.equal(denied.ok, false);
  assert.equal(fx.updates.length, 0);
  assert.equal(fx.confirmations[0].operation, "open");
});

test("offline remember, list, recall, and delete stay local with honest sync status", async () => {
  const fx = fixture({ config: { gatewayUrl: "", gatewayToken: "" } });
  const saved = await fx.runtime.execute({ type: "media.bookmark", operation: "remember", label: "offline chorus" }, { tabId: 7 });
  assert.equal(saved.ok, true);
  assert.equal(saved.result.bookmark.sync_status, "deferred");
  assert.match(saved.summary, /Saved locally; sync deferred/);
  assert.equal(fx.calls.length, 0);

  const listed = await fx.runtime.execute({ type: "media.bookmark", operation: "list" });
  assert.equal(listed.ok, true);
  assert.equal(listed.result.bookmarks.length, 1);

  const recalled = await fx.runtime.execute({ type: "media.bookmark", operation: "recall", query: "offline chorus" }, {
    tabId: 7,
    sourceText: "play my saved video bookmark",
  });
  assert.equal(recalled.ok, true);
  assert.equal(fx.updates.at(-1).patch.url, `https://www.youtube.com/watch?v=${VIDEO_ID}&t=42s`);

  const removed = await fx.runtime.execute({ type: "media.bookmark", operation: "delete", bookmark_id: "local_fixed" });
  assert.equal(removed.ok, true);
  assert.equal(removed.result.sync_status, "local_only");
  assert.equal(fx.state.ageeMediaBookmarkCache.length, 0);
});

test("remote delete failure removes local state and reports that retry is needed", async () => {
  const fx = fixture({ failGateway: (path, options) => path.includes("bookmark_1") && options.method === "DELETE" });
  await fx.runtime.execute({ type: "media.bookmark", operation: "remember", label: "chorus" }, { tabId: 7 });
  const removed = await fx.runtime.execute({ type: "media.bookmark", operation: "delete", bookmark_id: "local_fixed" });
  assert.equal(removed.ok, true);
  assert.equal(removed.result.sync_status, "needs_retry");
  assert.match(removed.summary, /Remote delete needs retry/);
  assert.equal(fx.state.ageeMediaBookmarkCache.length, 0);
});

test("gateway save failure keeps the approved local bookmark", async () => {
  const fx = fixture({ failGateway: (path, options) => path === "/v1/media/bookmarks" && Boolean(options.body) });
  const saved = await fx.runtime.execute({ type: "media.bookmark", operation: "remember", label: "local first" }, { tabId: 7 });
  assert.equal(saved.ok, true);
  assert.equal(saved.result.sync_status, "deferred");
  assert.equal(fx.state.ageeMediaBookmarkCache[0].label, "local first");
  assert.equal(fx.state.ageeMediaBookmarkCache[0].sync_status, "deferred");
});

test("list merges Android bookmarks by default and filters source only when explicitly requested", async () => {
  const android = {
    id: "bookmark_android",
    provider: "youtube",
    video_id: "aaaaaaaaaaa",
    canonical_url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
    position_ms: 12000,
    label: "phone spot",
    note: "",
    aliases: [],
    source_surface: "android",
    user_approved: true,
  };
  const fx = fixture({ listBookmarks: [android] });
  const listed = await fx.runtime.execute({ type: "media.bookmark", operation: "list" });
  assert.equal(listed.ok, true);
  assert.equal(listed.result.bookmarks[0].source_surface, "android");
  assert.equal(fx.calls[0].path, "/v1/media/bookmarks?limit=100");

  fx.calls.length = 0;
  const filtered = await fx.runtime.execute({ type: "media.bookmark", operation: "list", source_surface: "android" });
  assert.equal(filtered.ok, true);
  assert.match(fx.calls[0].path, /source_surface=android/);
  assert.ok(filtered.result.bookmarks.every((bookmark) => bookmark.source_surface === "android"));
});

test("failed create stays in the bounded outbox and retries on a later media operation", async () => {
  let offline = true;
  const fx = fixture({ failGateway: (path, options) => offline && path === "/v1/media/bookmarks" && Boolean(options.body) });
  const saved = await fx.runtime.execute({ type: "media.bookmark", operation: "remember", label: "retry me" }, { tabId: 7 });
  assert.equal(saved.result.sync_status, "deferred");
  assert.equal(fx.state.ageeMediaBookmarkOutbox.length, 1);
  assert.equal(fx.state.ageeMediaBookmarkOutbox[0].operation, "create");
  assert.equal(fx.state.ageeMediaBookmarkOutbox[0].attempt_count, 1);
  assert.deepEqual(Object.keys(fx.state.ageeMediaBookmarkOutbox[0].body).sort(), [
    "aliases", "canonical_url", "idempotency_key", "label", "note", "position_ms", "provider", "source_surface", "user_approved", "video_id",
  ]);

  offline = false;
  await fx.runtime.execute({ type: "media.bookmark", operation: "list" });
  assert.equal(fx.state.ageeMediaBookmarkOutbox.length, 0);
  assert.equal(fx.state.ageeMediaBookmarkCache[0].sync_status, "synced");
  assert.equal(fx.state.ageeMediaBookmarkCache[0].server_id, "bookmark_1");
});

test("delete tombstone prevents resurrection and retries until remote delete succeeds", async () => {
  let failDelete = true;
  const fx = fixture({ failGateway: (path, options) => failDelete && path.endsWith("/bookmark_1") && options.method === "DELETE" });
  await fx.runtime.execute({ type: "media.bookmark", operation: "remember", label: "remove me" }, { tabId: 7 });
  const removed = await fx.runtime.execute({ type: "media.bookmark", operation: "delete", bookmark_id: "local_fixed" });
  assert.equal(removed.result.sync_status, "needs_retry");
  assert.equal(fx.state.ageeMediaBookmarkOutbox[0].operation, "delete");
  assert.equal(fx.state.ageeMediaBookmarkOutbox[0].server_id, "bookmark_1");

  const hidden = await fx.runtime.execute({ type: "media.bookmark", operation: "list" });
  assert.equal(hidden.result.bookmarks.length, 0);
  assert.equal(fx.state.ageeMediaBookmarkCache.length, 0);
  assert.equal(fx.state.ageeMediaBookmarkOutbox.length, 1);

  failDelete = false;
  const afterRetry = await fx.runtime.execute({ type: "media.bookmark", operation: "list" });
  assert.equal(afterRetry.result.bookmarks.length, 0);
  assert.equal(fx.state.ageeMediaBookmarkOutbox.length, 0);
  assert.equal(fx.bookmarks.size, 0);
});

test("offline resolution uses aliases, word-order token overlap, and explicit ambiguity", async () => {
  const fx = fixture({ config: { gatewayUrl: "" } });
  fx.state.ageeMediaBookmarkCache = [
    { id: "local_a", local_id: "local_a", provider: "youtube", video_id: VIDEO_ID, position_ms: 7000, label: "favorite chorus", aliases: ["best bit"], source_surface: "android", sync_status: "synced" },
    { id: "local_b", local_id: "local_b", provider: "youtube", video_id: "aaaaaaaaaaa", position_ms: 8000, label: "red chorus", aliases: [], source_surface: "browser_extension", sync_status: "deferred" },
    { id: "local_c", local_id: "local_c", provider: "youtube", video_id: "bbbbbbbbbbb", position_ms: 9000, label: "blue chorus", aliases: [], source_surface: "browser_extension", sync_status: "deferred" },
  ];
  const alias = await fx.runtime.execute({ type: "media.bookmark", operation: "recall", query: "best bit" }, { tabId: 7, sourceText: "play my video bookmark" });
  assert.equal(alias.ok, true);
  assert.match(fx.updates.at(-1).patch.url, /t=7s/);

  const reversed = await fx.runtime.execute({ type: "media.bookmark", operation: "recall", query: "chorus favorite" }, { tabId: 7, sourceText: "open my video bookmark" });
  assert.equal(reversed.ok, true);
  assert.match(fx.updates.at(-1).patch.url, /t=7s/);

  const ambiguous = await fx.runtime.execute({ type: "media.bookmark", operation: "recall", query: "chorus" }, { tabId: 7, sourceText: "open my video bookmark" });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.summary, /ambiguous/);
});

test("delete resolves a typed label and refuses ambiguous label matches", async () => {
  const fx = fixture();
  await fx.runtime.execute({ type: "media.bookmark", operation: "remember", label: "delete this chorus" }, { tabId: 7 });
  const removed = await fx.runtime.execute({ type: "media.bookmark", operation: "delete", label: "delete this chorus" });
  assert.equal(removed.ok, true);
  assert.equal(removed.result.deleted, true);
  assert.equal(fx.state.ageeMediaBookmarkCache.length, 0);

  const ambiguous = fixture({ config: { gatewayUrl: "" } });
  ambiguous.state.ageeMediaBookmarkCache = [
    { id: "local_one", local_id: "local_one", provider: "youtube", video_id: VIDEO_ID, position_ms: 1000, label: "red chorus", aliases: [], sync_status: "deferred" },
    { id: "local_two", local_id: "local_two", provider: "youtube", video_id: "aaaaaaaaaaa", position_ms: 2000, label: "blue chorus", aliases: [], sync_status: "deferred" },
  ];
  const denied = await ambiguous.runtime.execute({ type: "media.bookmark", operation: "delete", label: "chorus" });
  assert.equal(denied.ok, false);
  assert.match(denied.summary, /ambiguous/);
  assert.equal(ambiguous.confirmations.length, 0);
  assert.equal(ambiguous.state.ageeMediaBookmarkCache.length, 2);
});

function pendingCreate(index) {
  const videoId = String(index).padStart(11, "0");
  return {
    id: `outbox_create_local_${index}`,
    operation: "create",
    local_id: `local_${index}`,
    attempt_count: 0,
    created_at: "2026-07-16T00:00:00.000Z",
    last_attempt_at: "",
    body: {
      provider: "youtube",
      video_id: videoId,
      canonical_url: `https://www.youtube.com/watch?v=${videoId}`,
      position_ms: index * 1000,
      label: `spot ${index}`,
      note: "",
      aliases: [],
      source_surface: "browser_extension",
      idempotency_key: `browser_local_${index}`,
      user_approved: true,
    },
  };
}

test("full outbox never evicts pending work and create/delete preserve cache on capacity failure", async () => {
  const creates = fixture({ config: { gatewayUrl: "" }, randomUUID: () => "new" });
  creates.state.ageeMediaBookmarkOutbox = Array.from({ length: 100 }, (_, index) => pendingCreate(index));
  const save = await creates.runtime.execute({ type: "media.bookmark", operation: "remember", label: "cannot queue" }, { tabId: 7 });
  assert.equal(save.ok, false);
  assert.match(save.summary, /queue is full/);
  assert.equal(creates.state.ageeMediaBookmarkOutbox.length, 100);
  assert.equal(creates.state.ageeMediaBookmarkOutbox[99].id, "outbox_create_local_99");
  assert.equal(creates.state.ageeMediaBookmarkCache, undefined);

  const deletion = fixture({ config: { gatewayUrl: "" } });
  deletion.state.ageeMediaBookmarkOutbox = Array.from({ length: 100 }, (_, index) => pendingCreate(index));
  deletion.state.ageeMediaBookmarkCache = [{
    id: "local_target", local_id: "local_target", server_id: "bookmark_target", provider: "youtube",
    video_id: VIDEO_ID, position_ms: 42000, label: "keep me", aliases: [], sync_status: "synced",
  }];
  const removed = await deletion.runtime.execute({ type: "media.bookmark", operation: "delete", id: "local_target" });
  assert.equal(removed.ok, false);
  assert.match(removed.summary, /queue is full/);
  assert.equal(deletion.state.ageeMediaBookmarkOutbox.length, 100);
  assert.equal(deletion.state.ageeMediaBookmarkCache[0].label, "keep me");
});

test("gateway query ambiguity overrides one local match for recall and delete", async () => {
  const ambiguousResolution = { status: "ambiguous", candidates: [
    { id: "bookmark_a", provider: "youtube", video_id: VIDEO_ID, position_ms: 1000, label: "chorus" },
    { id: "bookmark_b", provider: "youtube", video_id: "aaaaaaaaaaa", position_ms: 2000, label: "chorus" },
  ] };
  const fx = fixture({ queryResolution: ambiguousResolution });
  fx.state.ageeMediaBookmarkCache = [{ id: "local_a", local_id: "local_a", provider: "youtube", video_id: VIDEO_ID, position_ms: 1000, label: "chorus", aliases: [], sync_status: "deferred" }];
  const recalled = await fx.runtime.execute({ type: "media.bookmark", operation: "recall", label: "chorus" }, { tabId: 7, sourceText: "open my video bookmark" });
  assert.equal(recalled.ok, false);
  assert.match(recalled.summary, /ambiguous/);
  assert.equal(fx.updates.length, 0);
  const removed = await fx.runtime.execute({ type: "media.bookmark", operation: "delete", label: "chorus" });
  assert.equal(removed.ok, false);
  assert.match(removed.summary, /ambiguous/);
  assert.equal(fx.confirmations.length, 0);
  assert.equal(fx.state.ageeMediaBookmarkCache.length, 1);
});

test("unique gateway query is authoritative and invalid remote ids fail closed", async () => {
  const authoritative = {
    id: "bookmark_remote", provider: "youtube", video_id: "aaaaaaaaaaa", position_ms: 9000,
    label: "chorus", aliases: [], source_surface: "android", user_approved: true,
  };
  const fx = fixture({ queryResolution: { status: "matched", bookmark: authoritative } });
  fx.state.ageeMediaBookmarkCache = [{ id: "local_a", local_id: "local_a", provider: "youtube", video_id: VIDEO_ID, position_ms: 1000, label: "chorus", aliases: [], sync_status: "deferred" }];
  const recalled = await fx.runtime.execute({ type: "media.bookmark", operation: "recall", label: "chorus" }, { tabId: 7, sourceText: "open my video bookmark" });
  assert.equal(recalled.ok, true);
  assert.equal(fx.updates.at(-1).patch.url, "https://www.youtube.com/watch?v=aaaaaaaaaaa&t=9s");

  const invalid = fixture({ queryResolution: { status: "matched", bookmark: { ...authoritative, id: "bad/id" } } });
  invalid.state.ageeMediaBookmarkCache = [{ id: "local_a", local_id: "local_a", provider: "youtube", video_id: VIDEO_ID, position_ms: 1000, label: "chorus", aliases: [], sync_status: "deferred" }];
  const denied = await invalid.runtime.execute({ type: "media.bookmark", operation: "recall", label: "chorus" }, { tabId: 7, sourceText: "open my video bookmark" });
  assert.equal(denied.ok, false);
  assert.match(denied.summary, /invalid media bookmark identity/);
  assert.equal(invalid.updates.length, 0);
  assert.ok(invalid.state.ageeMediaBookmarkCache.every((bookmark) => bookmark.server_id !== "bad/id"));

  const deletion = fixture({ queryResolution: { status: "matched", bookmark: authoritative } });
  deletion.state.ageeMediaBookmarkCache = [{ id: "local_a", local_id: "local_a", provider: "youtube", video_id: VIDEO_ID, position_ms: 1000, label: "chorus", aliases: [], sync_status: "deferred" }];
  const removed = await deletion.runtime.execute({ type: "media.bookmark", operation: "delete", label: "chorus" });
  assert.equal(removed.ok, true);
  assert.equal(deletion.confirmations[0].video_id, "aaaaaaaaaaa");
  assert.ok(deletion.calls.some((call) => call.path === "/v1/media/bookmarks/bookmark_remote" && call.options.method === "DELETE"));
});

test("recall and delete reject overlong or non-string exact ids without side effects", async () => {
  for (const invalidId of ["x".repeat(121), 42, { id: "bookmark_1" }]) {
    const recall = fixture();
    recall.state.ageeMediaBookmarkCache = [{ id: "local_a", local_id: "local_a", provider: "youtube", video_id: VIDEO_ID, position_ms: 1000, label: "chorus" }];
    const recalled = await recall.runtime.execute({ type: "media.bookmark", operation: "recall", bookmark_id: invalidId }, { tabId: 7, sourceText: "open my video bookmark" });
    assert.equal(recalled.ok, false);
    assert.match(recalled.summary, /invalid format/);
    assert.equal(recall.calls.length, 0);
    assert.equal(recall.updates.length, 0);
    assert.equal(recall.confirmations.length, 0);
    assert.equal(recall.state.ageeMediaBookmarkCache.length, 1);

    const deletion = fixture();
    deletion.state.ageeMediaBookmarkCache = [{ id: "local_a", local_id: "local_a", provider: "youtube", video_id: VIDEO_ID, position_ms: 1000, label: "chorus" }];
    const removed = await deletion.runtime.execute({ type: "media.bookmark", operation: "delete", id: invalidId });
    assert.equal(removed.ok, false);
    assert.match(removed.summary, /invalid format/);
    assert.equal(deletion.calls.length, 0);
    assert.equal(deletion.updates.length, 0);
    assert.equal(deletion.confirmations.length, 0);
    assert.equal(deletion.state.ageeMediaBookmarkCache.length, 1);
  }
});

test("gateway query rejects overlong or non-string bookmark ids without caching or navigation", async () => {
  const base = { provider: "youtube", video_id: "aaaaaaaaaaa", position_ms: 9000, label: "chorus", aliases: [] };
  for (const invalidId of ["x".repeat(121), 42]) {
    const fx = fixture({ queryResolution: { status: "matched", bookmark: { ...base, id: invalidId } } });
    const recalled = await fx.runtime.execute({ type: "media.bookmark", operation: "recall", query: "chorus" }, { tabId: 7, sourceText: "open my video bookmark" });
    assert.equal(recalled.ok, false);
    assert.match(recalled.summary, /invalid media bookmark identity/);
    assert.equal(fx.updates.length, 0);
    assert.deepEqual(fx.state.ageeMediaBookmarkCache, undefined);
  }
});

test("delete validates exact server ids before changing cache and accepts the 120-character boundary", async () => {
  for (const invalidServerId of ["x".repeat(121), 42]) {
    const fx = fixture();
    fx.state.ageeMediaBookmarkCache = [{
      id: "local_a", local_id: "local_a", server_id: invalidServerId, provider: "youtube",
      video_id: VIDEO_ID, position_ms: 1000, label: "chorus",
    }];
    const removed = await fx.runtime.execute({ type: "media.bookmark", operation: "delete", id: "local_a" });
    assert.equal(removed.ok, false);
    assert.match(removed.summary, /Invalid local media sync record/);
    assert.equal(fx.confirmations.length, 1);
    assert.equal(fx.calls.length, 0);
    assert.equal(fx.state.ageeMediaBookmarkCache.length, 1);
    assert.deepEqual(fx.state.ageeMediaBookmarkOutbox, undefined);
  }

  const validServerId = "x".repeat(120);
  const boundary = fixture();
  boundary.state.ageeMediaBookmarkCache = [{
    id: "local_a", local_id: "local_a", server_id: validServerId, provider: "youtube",
    video_id: VIDEO_ID, position_ms: 1000, label: "chorus",
  }];
  const removed = await boundary.runtime.execute({ type: "media.bookmark", operation: "delete", id: "local_a" });
  assert.equal(removed.ok, true);
  assert.equal(boundary.state.ageeMediaBookmarkCache.length, 0);
  assert.ok(boundary.calls.some((call) => call.path === `/v1/media/bookmarks/${validServerId}` && call.options.method === "DELETE"));
  assert.deepEqual(boundary.state.ageeMediaBookmarkOutbox, []);
});

test("create idempotency keys are browser-owned and malformed persisted keys never sync", async () => {
  const fx = fixture();
  fx.state.ageeMediaBookmarkOutbox = [{
    id: "outbox_create_local_a", operation: "create", local_id: "local_a", attempt_count: 0,
    created_at: "2026-07-16T00:00:00.000Z", last_attempt_at: "",
    body: {
      provider: "youtube", video_id: VIDEO_ID, canonical_url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      position_ms: 1000, label: "chorus", note: "", aliases: [], source_surface: "browser_extension",
      idempotency_key: "model:controlled key", user_approved: true,
    },
  }];
  await fx.runtime.execute({ type: "media.bookmark", operation: "list" });
  assert.equal(fx.calls.some((call) => call.path === "/v1/media/bookmarks" && call.options.body), false);
});
