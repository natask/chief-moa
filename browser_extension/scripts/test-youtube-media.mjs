import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_YOUTUBE_ORIGIN,
  MAX_POSITION_SECONDS,
  buildYouTubeWatchUrl,
  canonicalizeYouTubeWatchUrl,
  normalizePreferredYouTubeOrigin,
  normalizeYouTubeVideoId,
  parseYouTubeWatchUrl,
  youtubeBookmarkCreateCommand,
  youtubeBookmarkOpenCommand,
} from "../extension/youtube-media.js";

const VIDEO_ID = "dQw4w9WgXcQ";

test("video ids and preferred HTTPS origins fail closed", () => {
  assert.equal(normalizeYouTubeVideoId(VIDEO_ID), VIDEO_ID);
  for (const invalid of ["", "short", `${VIDEO_ID}?t=2`, "dQw4w9WgXc!"]) {
    assert.equal(normalizeYouTubeVideoId(invalid), null);
  }
  assert.equal(normalizePreferredYouTubeOrigin(), DEFAULT_YOUTUBE_ORIGIN);
  assert.equal(normalizePreferredYouTubeOrigin("https://tube.example/"), "https://tube.example");
  for (const invalid of [
    "http://tube.example",
    "https://user:pass@tube.example",
    "https://tube.example/subpath",
    "https://tube.example/?account=secret",
  ]) assert.equal(normalizePreferredYouTubeOrigin(invalid), null);
});

test("watch URL parsing keeps only stable identity and a bounded timestamp", () => {
  assert.deepEqual(
    parseYouTubeWatchUrl(`https://music.youtube.com/watch?v=${VIDEO_ID}&list=private&t=1h2m3s#comments`),
    {
      video_id: VIDEO_ID,
      position_seconds: 3723,
      watch_url: `https://music.youtube.com/watch?v=${VIDEO_ID}&t=3723s`,
      web_origin: "https://music.youtube.com",
    },
  );
  assert.equal(
    canonicalizeYouTubeWatchUrl(`https://www.youtube.com/watch?start=90&v=${VIDEO_ID}&si=tracking`),
    `https://www.youtube.com/watch?v=${VIDEO_ID}&t=90s`,
  );
  for (const invalid of [
    `http://www.youtube.com/watch?v=${VIDEO_ID}`,
    `https://evil.example/watch?v=${VIDEO_ID}`,
    `https://www.youtube.com/results?v=${VIDEO_ID}`,
    `https://www.youtube.com/watch?v=${VIDEO_ID}&v=aaaaaaaaaaa`,
    `https://www.youtube.com/watch?v=${VIDEO_ID}&t=1m&start=60`,
    `https://www.youtube.com/watch?v=${VIDEO_ID}&t=${MAX_POSITION_SECONDS + 1}`,
  ]) assert.equal(parseYouTubeWatchUrl(invalid), null, invalid);
});

test("short links and Shorts canonicalize to one bounded watch URL", () => {
  assert.deepEqual(parseYouTubeWatchUrl(`https://youtu.be/${VIDEO_ID}?t=1m5s&si=tracking`), {
    video_id: VIDEO_ID,
    position_seconds: 65,
    watch_url: `https://www.youtube.com/watch?v=${VIDEO_ID}&t=65s`,
    web_origin: "https://www.youtube.com",
  });
  assert.deepEqual(parseYouTubeWatchUrl(`https://www.youtube.com/shorts/${VIDEO_ID}?t=9s&feature=share`), {
    video_id: VIDEO_ID,
    position_seconds: 9,
    watch_url: `https://www.youtube.com/watch?v=${VIDEO_ID}&t=9s`,
    web_origin: "https://www.youtube.com",
  });
  for (const invalid of [
    `https://youtu.be/${VIDEO_ID}/extra`,
    `https://www.youtube.com/shorts/${VIDEO_ID}/extra`,
    `https://evil.example/shorts/${VIDEO_ID}`,
    `http://youtu.be/${VIDEO_ID}`,
  ]) assert.equal(parseYouTubeWatchUrl(invalid), null, invalid);
});

test("a configured web instance is explicit and canonical", () => {
  const preferredOrigin = "https://tube.example";
  assert.equal(
    buildYouTubeWatchUrl({ videoId: VIDEO_ID, positionSeconds: 42.9, preferredOrigin }),
    `https://tube.example/watch?v=${VIDEO_ID}&t=42s`,
  );
  assert.deepEqual(
    parseYouTubeWatchUrl(`https://tube.example/watch?v=${VIDEO_ID}&t=42s`, { preferredOrigin }),
    {
      video_id: VIDEO_ID,
      position_seconds: 42,
      watch_url: `https://tube.example/watch?v=${VIDEO_ID}&t=42s`,
      web_origin: preferredOrigin,
    },
  );
  assert.equal(parseYouTubeWatchUrl(`https://other.example/watch?v=${VIDEO_ID}`, { preferredOrigin }), null);
});

test("bookmark commands are inert, bounded records with reproducible open URLs", () => {
  const create = youtubeBookmarkCreateCommand({
    label: "  favorite   chorus  ",
    note: ` Back here ${"x".repeat(400)}`,
    watchUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}&t=75s&list=private`,
  });
  assert.equal(create.type, "media.bookmark");
  assert.equal(create.operation, "create");
  assert.equal(create.label, "favorite chorus");
  assert.equal(create.note.length, 280);
  assert.deepEqual(create.media, {
    provider: "youtube",
    video_id: VIDEO_ID,
    position_seconds: 75,
    watch_url: `https://www.youtube.com/watch?v=${VIDEO_ID}&t=75s`,
    web_origin: "https://www.youtube.com",
  });

  assert.deepEqual(youtubeBookmarkOpenCommand(create), {
    version: 1,
    type: "media.open",
    source: "bookmark",
    label: "favorite chorus",
    media: create.media,
  });
  assert.equal(youtubeBookmarkCreateCommand({ videoId: VIDEO_ID, label: "" }), null);
  assert.equal(youtubeBookmarkCreateCommand({
    videoId: VIDEO_ID,
    label: "do not fall back",
    watchUrl: `https://evil.example/watch?v=${VIDEO_ID}`,
  }), null);
  assert.equal(youtubeBookmarkOpenCommand({ media: { video_id: "bad" } }), null);
  assert.equal(youtubeBookmarkOpenCommand({
    media: { provider: "other", video_id: VIDEO_ID, position_seconds: 1 },
  }), null);
});
