"use strict";

const assert = require("node:assert");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createVoiceDraftStore } = require("../lib/voice-drafts");

test("append is allowed only while capturing and send_ready remains discardable", () => {
  withTempDir("append-state", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const draft = createDraft(store, { session_id: "session-1", branch_id: "branch-1" });

    store.appendSegment(draft.id, {
      segment_id: "seg-1",
      bytes: pcm(1, 2),
      duration_ms: 10,
      expected_revision: draft.revision,
    });
    store.transition(draft.id, {
      action: "pause",
      idempotency_key: "pause-1",
      expected_revision: store.get(draft.id).revision,
    });
    assert.throws(
      () => store.appendSegment(draft.id, {
        segment_id: "seg-2",
        bytes: pcm(3, 4),
        duration_ms: 10,
        expected_revision: store.get(draft.id).revision,
      }),
      /append only while capturing/,
    );

    store.transition(draft.id, {
      action: "send_ready",
      idempotency_key: "ready-1",
      expected_revision: store.get(draft.id).revision,
    });
    const receipt = store.discard(draft.id, {
      idempotency_key: "discard-1",
      expected_revision: store.get(draft.id).revision,
    });
    assert.equal(receipt.state_after, "discarded");
    assert.equal(store.get(draft.id).state, "discarded");
  });
});

test("every mutation requires expected_revision and exact idempotent retries bypass stale revision checks", () => {
  withTempDir("revision", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const draft = createDraft(store, {
      session_id: "session-r",
      branch_id: "branch-r",
      source: "android",
      release_id: "release-r",
      release_version: "1.0.0",
    });
    assert.throws(
      () => store.appendSegment(draft.id, { segment_id: "seg-1", bytes: pcm(1, 2), duration_ms: 10 }),
      /expected_revision is required/,
    );

    const segment = store.appendSegment(draft.id, {
      segment_id: "seg-1",
      bytes: pcm(1, 2),
      duration_ms: 10,
      expected_revision: draft.revision,
    });
    const duplicate = store.appendSegment(draft.id, {
      segment_id: "seg-1",
      bytes: pcm(1, 2),
      duration_ms: 10,
      expected_revision: draft.revision,
    });
    assert.equal(duplicate.segment_id, segment.segment_id);

    const ready = transitionToSendReady(store, draft.id);
    const claimRevision = ready.revision;
    const claim = store.claimForTurn(draft.id, {
      session_id: "session-r",
      branch_id: "branch-r",
      turn_id: "turn-r",
      expected_revision: claimRevision,
    });
    const replayedClaim = store.claimForTurn(draft.id, {
      session_id: "session-r",
      branch_id: "branch-r",
      turn_id: "turn-r",
      expected_revision: claimRevision,
    });
    assert.equal(replayedClaim.turn_id, claim.turn_id);
    assert.throws(
      () => store.claimForTurn(draft.id, {
        session_id: "session-r",
        branch_id: "branch-r",
        turn_id: "turn-r",
        expected_revision: store.get(draft.id).revision,
      }),
      /already claimed/,
    );

    const sentRevision = store.get(draft.id).revision;
    const sent = store.markSent(draft.id, {
      receipt_id: "sent-r",
      session_id: "session-r",
      branch_id: "branch-r",
      turn_id: "turn-r",
      source: "android",
      sent_at: "2026-07-11T00:00:00.000Z",
      expected_revision: sentRevision,
    });
    const replayedSent = store.markSent(draft.id, {
      receipt_id: "sent-r",
      session_id: "session-r",
      branch_id: "branch-r",
      turn_id: "turn-r",
      source: "android",
      sent_at: "2026-07-11T00:00:00.000Z",
      expected_revision: sentRevision,
    });
    assert.deepEqual(replayedSent, sent);
    assert.throws(
      () => store.markSent(draft.id, {
        receipt_id: "sent-r",
        session_id: "session-r",
        branch_id: "branch-r",
        turn_id: "turn-r",
        source: "browser",
        sent_at: "2026-07-11T00:00:00.000Z",
        expected_revision: sentRevision,
      }),
      /already marked sent|does not match voice draft creation authority/,
    );
    for (const changed of [
      { actor: { kind: "user", id: "other" } },
      { release_id: "release-other" },
      { sent_at: "2026-07-12T00:00:00.000Z" },
      { expected_revision: store.get(draft.id).revision },
    ]) {
      assert.throws(
        () => store.markSent(draft.id, {
          receipt_id: "sent-r",
          session_id: "session-r",
          branch_id: "branch-r",
          turn_id: "turn-r",
          source: "android",
          sent_at: "2026-07-11T00:00:00.000Z",
          expected_revision: sentRevision,
          ...changed,
        }),
        /already marked sent|does not match voice draft creation authority/,
      );
    }
  });
});

test("discard with a stale revision leaves content intact", () => {
  withTempDir("stale-discard", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const draft = createDraft(store, { session_id: "session-d", branch_id: "branch-d" });
    store.appendSegment(draft.id, {
      segment_id: "seg-1",
      bytes: pcm(1, 2),
      duration_ms: 10,
      expected_revision: draft.revision,
    });
    const current = store.get(draft.id);
    store.transition(draft.id, {
      action: "pause",
      idempotency_key: "pause-d",
      expected_revision: current.revision,
    });
    assert.throws(
      () => store.discard(draft.id, {
        idempotency_key: "discard-d",
        expected_revision: current.revision,
      }),
      /revision conflict/,
    );
    const after = store.get(draft.id);
    assert.equal(after.state, "paused");
    assert.equal(after.audio.total_bytes, 4);
  });
});

test("idempotency keys bind the complete canonical action request", () => {
  withTempDir("exact-idempotency", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const draft = createDraft(store, { session_id: "session-exact", branch_id: "branch-exact" });
    const command = {
      action: "pause",
      idempotency_key: "pause-exact",
      actor: { kind: "user", id: "alice" },
      expected_revision: draft.revision,
    };
    const receipt = store.transition(draft.id, command);
    assert.deepEqual(store.transition(draft.id, command), receipt);
    assert.throws(
      () => store.transition(draft.id, {
        ...command,
        actor: { kind: "user", id: "mallory" },
      }),
      /retried with a different request/,
    );
    assert.throws(
      () => store.transition(draft.id, {
        ...command,
        expected_revision: store.get(draft.id).revision,
      }),
      /retried with a different request/,
    );
  });
});

test("segment byte caps and explicit zero declarations are enforced", () => {
  withTempDir("segment-byte-cap", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir, maxSegmentBytes: 2 });
    const draft = createDraft(store, { session_id: "session-cap-bytes", branch_id: "branch-cap-bytes" });
    assert.throws(
      () => store.appendSegment(draft.id, {
        segment_id: "too-large",
        bytes: pcm(1, 2),
        duration_ms: 10,
        expected_revision: draft.revision,
      }),
      /segment byte cap exceeded/,
    );
    assert.throws(
      () => store.appendSegment(draft.id, {
        segment_id: "declared-zero",
        bytes: pcm(1),
        byte_count: 0,
        duration_ms: 10,
        expected_revision: draft.revision,
      }),
      /byte count does not match/,
    );
  });
});

test("durable action hashes prevent key reuse after transition history eviction", () => {
  withTempDir("idempotency-history", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const draft = createDraft(store, { session_id: "session-i", branch_id: "branch-i" });
    store.appendSegment(draft.id, {
      segment_id: "seg-1",
      bytes: pcm(1, 2),
      duration_ms: 10,
      expected_revision: draft.revision,
    });

    for (let index = 0; index < 70; index += 1) {
      const state = store.get(draft.id).state;
      const action = state === "capturing" ? "pause" : "resume";
      store.transition(draft.id, {
        action,
        idempotency_key: `k-${index}`,
        expected_revision: store.get(draft.id).revision,
      });
    }

    assert.throws(
      () => store.transition(draft.id, {
        action: "pause",
        idempotency_key: "k-0",
        expected_revision: store.get(draft.id).revision,
      }),
      /no longer replayable/,
    );
  });
});

test("fails visibly when durable idempotency capacity is exhausted", () => {
  withTempDir("idempotency-capacity", (tempDir) => {
    const store = createVoiceDraftStore({
      dataDir: tempDir,
      maxActionKeyHashes: 2,
    });
    const draft = createDraft(store, { session_id: "session-cap", branch_id: "branch-cap" });
    store.appendSegment(draft.id, {
      segment_id: "seg-1",
      bytes: pcm(1, 2),
      duration_ms: 10,
      expected_revision: draft.revision,
    });
    store.transition(draft.id, {
      action: "pause",
      idempotency_key: "p1",
      expected_revision: store.get(draft.id).revision,
    });
    store.transition(draft.id, {
      action: "resume",
      idempotency_key: "p2",
      expected_revision: store.get(draft.id).revision,
    });
    assert.throws(
      () => store.transition(draft.id, {
        action: "pause",
        idempotency_key: "p3",
        expected_revision: store.get(draft.id).revision,
      }),
      /idempotency capacity exceeded/,
    );
  });
});

test("a failed parked resume does not strand the process-wide capture lease", () => {
  withTempDir("resume-lease-rollback", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir, maxActionKeyHashes: 1 });
    const draft = createDraft(store, { session_id: "session-lease", branch_id: "branch-lease" });
    store.transition(draft.id, {
      action: "park",
      idempotency_key: "park-lease",
      expected_revision: draft.revision,
    });
    assert.throws(
      () => store.transition(draft.id, {
        action: "resume",
        idempotency_key: "resume-over-capacity",
        expected_revision: store.get(draft.id).revision,
      }),
      /idempotency capacity exceeded/,
    );
    assert.equal(store.get(draft.id).state, "parked");
    assert.equal(store.status().active_capture_draft_id, "");
  });
});

test("resume rolls back its lease when persistence fails after acquisition", () => {
  withTempDir("resume-lease-write-failure", (tempDir) => {
    let failOnce = true;
    const store = createVoiceDraftStore({
      dataDir: tempDir,
      testHooks: {
        afterResumeLeaseAcquiredBeforeMeta() {
          if (!failOnce) return;
          failOnce = false;
          throw new Error("simulated resume metadata failure");
        },
      },
    });
    const draft = createDraft(store, { session_id: "session-write", branch_id: "branch-write" });
    store.transition(draft.id, {
      action: "park",
      idempotency_key: "park-write",
      expected_revision: draft.revision,
    });
    const resumeRevision = store.get(draft.id).revision;
    const resume = {
      action: "resume",
      idempotency_key: "resume-write",
      expected_revision: resumeRevision,
    };
    assert.throws(() => store.transition(draft.id, resume), /simulated resume metadata failure/);
    assert.equal(store.get(draft.id).state, "parked");
    assert.equal(store.status().active_capture_draft_id, "");
    assert.equal(store.transition(draft.id, resume).state_after, "capturing");
  });
});

test("two store instances do not both capture and a second instance does not auto-park the first", () => {
  withTempDir("dual-store", (tempDir) => {
    const storeA = createVoiceDraftStore({ dataDir: tempDir });
    const first = createDraft(storeA, { session_id: "session-a", branch_id: "branch-a" });
    const storeB = createVoiceDraftStore({ dataDir: tempDir });

    assert.equal(storeB.get(first.id).state, "capturing");
    assert.equal(storeB.status().active_capture_draft_id, first.id);
    assert.throws(
      () => createDraft(storeB, { session_id: "session-b", branch_id: "branch-b" }),
      /active capture lease/,
    );
    assert.throws(
      () => storeB.transition(first.id, {
        action: "resume",
        idempotency_key: "resume-b",
        expected_revision: storeB.get(first.id).revision,
      }),
      /illegal voice draft transition/,
    );
  });
});

test("a live capture lease excludes a second process and becomes recoverable after owner exit", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-voice-drafts-process-lease-"));
  const modulePath = path.resolve(__dirname, "../lib/voice-drafts.js");
  const childSource = `
    const { createVoiceDraftStore } = require(process.argv[2]);
    const store = createVoiceDraftStore({ dataDir: process.argv[1] });
    const draft = store.create({ idempotency_key: "create-child", session_id: "session-child", branch_id: "branch-child" });
    process.send({ draftId: draft.id });
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["-e", childSource, tempDir, modulePath], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  try {
    const { draftId } = await new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`lease child exited early with ${code}`)));
    });
    const contender = createVoiceDraftStore({ dataDir: tempDir });
    assert.equal(contender.get(draftId).state, "capturing");
    assert.throws(
      () => createDraft(contender, { session_id: "session-parent", branch_id: "branch-parent" }),
      /active capture lease/,
    );

    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    const recovered = createVoiceDraftStore({ dataDir: tempDir });
    assert.equal(recovered.get(draftId).state, "parked");
    assert.equal(recovered.status().active_capture_draft_id, "");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("stale partial locks recover and lock release never deletes a successor owner", () => {
  withTempDir("lock-recovery", (tempDir) => {
    const draftsDir = path.join(tempDir, "voice-drafts");
    fs.mkdirSync(draftsDir, { recursive: true });
    const lockPath = path.join(draftsDir, "store.lock");
    fs.writeFileSync(lockPath, "");
    assert.throws(
      () => createVoiceDraftStore({ dataDir: tempDir, lockStaleMs: 60_000 }),
      /recent incomplete lock/,
    );
    const staleAt = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, staleAt, staleAt);
    const recovered = createVoiceDraftStore({ dataDir: tempDir, lockStaleMs: 1 });
    assert.equal(recovered.status().count, 0);
    assert.equal(fs.existsSync(lockPath), false);

    const capturePath = path.join(draftsDir, "capture.lock");
    fs.writeFileSync(capturePath, "");
    fs.utimesSync(capturePath, staleAt, staleAt);
    createVoiceDraftStore({ dataDir: tempDir, lockStaleMs: 1 });
    assert.equal(fs.existsSync(capturePath), false);

    let replaceOnce = true;
    createVoiceDraftStore({
      dataDir: tempDir,
      testHooks: {
        beforeLockRelease({ label, owner }) {
          if (!replaceOnce || label !== "voice-draft-store") return;
          replaceOnce = false;
          fs.unlinkSync(lockPath);
          fs.writeFileSync(lockPath, `${JSON.stringify({ ...owner, owner_id: "owner_successor" })}\n`);
        },
      },
    });
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).owner_id, "owner_successor");
    fs.unlinkSync(lockPath);
  });
});

test("boot auto-parks only genuinely orphaned leases", () => {
  withTempDir("boot-park", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const draft = createDraft(store, { session_id: "session-boot", branch_id: "branch-boot" });
    store.appendSegment(draft.id, {
      segment_id: "seg-1",
      bytes: pcm(1, 2),
      duration_ms: 10,
      expected_revision: draft.revision,
    });
    fs.rmSync(path.join(tempDir, "voice-drafts", "capture.lock"), { force: true });

    const restarted = createVoiceDraftStore({ dataDir: tempDir });
    const recovered = restarted.get(draft.id);
    assert.equal(recovered.state, "parked");
    assert.equal(recovered.recovery_receipt.reason, "boot_recovery_auto_park");
  });
});

test("append journal recovery commits a fully persisted append and cleanup-pending recovery finishes privacy deletion", () => {
  withTempDir("journal-recovery", (tempDir) => {
    let store = createVoiceDraftStore({
      dataDir: tempDir,
      testHooks: {
        afterAppendPersistedBeforeMeta() {
          throw new Error("stop-after-append");
        },
      },
    });
    const draft = createDraft(store, { session_id: "session-j", branch_id: "branch-j" });
    assert.throws(
      () => store.appendSegment(draft.id, {
        segment_id: "seg-1",
        bytes: pcm(1, 2),
        duration_ms: 10,
        expected_revision: draft.revision,
      }),
      /stop-after-append/,
    );

    store = createVoiceDraftStore({ dataDir: tempDir });
    const recovered = store.get(draft.id);
    assert.equal(recovered.audio.total_bytes, 4);
    assert.equal(recovered.segments.length, 1);

    const ready = transitionToSendReady(store, draft.id);
    store.claimForTurn(draft.id, {
      session_id: "session-j",
      branch_id: "branch-j",
      turn_id: "turn-j",
      expected_revision: ready.revision,
    });

    store = createVoiceDraftStore({
      dataDir: tempDir,
      testHooks: {
        afterCleanupMarkerWrite() {
          throw new Error("stop-after-cleanup-marker");
        },
      },
    });
    assert.throws(
      () => store.markSent(draft.id, {
        receipt_id: "sent-j",
        session_id: "session-j",
        branch_id: "branch-j",
        turn_id: "turn-j",
        expected_revision: store.get(draft.id).revision,
      }),
      /stop-after-cleanup-marker/,
    );

    store = createVoiceDraftStore({ dataDir: tempDir });
    const finalDraft = store.get(draft.id);
    assert.equal(finalDraft.state, "sent");
    assert.equal(finalDraft.cleanup_pending, null);
    assert.equal(finalDraft.audio.total_bytes, 0);
    assert.equal(fs.existsSync(path.join(tempDir, "voice-drafts", draft.id, "audio.pcm")), false);
  });
});

test("the same store reconciles a persisted append before any later mutation", () => {
  withTempDir("same-process-journal", (tempDir) => {
    let failOnce = true;
    const store = createVoiceDraftStore({
      dataDir: tempDir,
      testHooks: {
        afterAppendPersistedBeforeMeta() {
          if (!failOnce) return;
          failOnce = false;
          throw new Error("stop-after-pcm-fsync");
        },
      },
    });
    const draft = createDraft(store, { session_id: "session-same", branch_id: "branch-same" });
    const command = {
      segment_id: "seg-same",
      bytes: pcm(1, 2),
      duration_ms: 10,
      expected_revision: draft.revision,
    };
    assert.throws(() => store.appendSegment(draft.id, command), /stop-after-pcm-fsync/);

    const recoveredSegment = store.appendSegment(draft.id, command);
    assert.equal(recoveredSegment.segment_id, "seg-same");
    assert.deepEqual(store.readAudio(draft.id).readBuffer(), pcm(1, 2));
    assert.equal(
      fs.existsSync(path.join(tempDir, "voice-drafts", draft.id, "append-journal.json")),
      false,
    );
  });
});

test("cleanup remains retryable after unlink failure and removes crash temp transcripts", () => {
  withTempDir("cleanup-fail-closed", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const draft = createDraft(store, { session_id: "session-clean", branch_id: "branch-clean" });
    store.appendSegment(draft.id, {
      segment_id: "seg-clean",
      bytes: pcm(1, 2),
      duration_ms: 10,
      partial_transcript: "erase these sensitive words",
      expected_revision: draft.revision,
    });
    const draftDir = path.join(tempDir, "voice-drafts", draft.id);
    const audioPath = path.join(draftDir, "audio.pcm");
    const journalTemp = path.join(draftDir, `append-journal.json.${process.pid}.deadbeef.tmp`);
    const metaTemp = path.join(draftDir, `meta.json.${process.pid}.cafebabe.tmp`);
    fs.writeFileSync(journalTemp, "erase these sensitive words");
    fs.writeFileSync(metaTemp, "erase these sensitive words");
    createVoiceDraftStore({ dataDir: tempDir });
    assert.equal(fs.existsSync(journalTemp), false);
    assert.equal(fs.existsSync(metaTemp), false);

    const expectedRevision = store.get(draft.id).revision;
    const originalUnlink = fs.unlinkSync;
    fs.unlinkSync = (filePath) => {
      if (filePath === audioPath) {
        const error = new Error("simulated unlink EIO");
        error.code = "EIO";
        throw error;
      }
      return originalUnlink(filePath);
    };
    try {
      assert.throws(
        () => store.discard(draft.id, {
          idempotency_key: "discard-clean",
          expected_revision: expectedRevision,
        }),
        /could not be removed/,
      );
    } finally {
      fs.unlinkSync = originalUnlink;
    }
    assert.equal(fs.existsSync(audioPath), true);
    assert.ok(store.get(draft.id).cleanup_pending);
    assert.equal(store.status().total_bytes, pcm(1, 2).length);

    const receipt = store.discard(draft.id, {
      idempotency_key: "discard-clean",
      expected_revision: expectedRevision,
    });
    assert.equal(receipt.state_after, "discarded");
    assert.equal(store.get(draft.id).cleanup_pending, null);
    assert.equal(fs.existsSync(audioPath), false);
    assert.equal(store.status().total_bytes, 0);
    assert.equal(fs.existsSync(journalTemp), false);
    assert.equal(fs.existsSync(metaTemp), false);
  });
});

test("readAudio uses the canonical bounded PCM file and does not accumulate exports", () => {
  withTempDir("canonical-pcm", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const draft = createDraft(store, { session_id: "session-p", branch_id: "branch-p" });
    store.appendSegment(draft.id, {
      segment_id: "seg-1",
      bytes: pcm(1, 2),
      duration_ms: 10,
      expected_revision: draft.revision,
    });
    const ready = transitionToSendReady(store, draft.id);
    const audioA = store.readAudio(draft.id);
    const audioB = store.readAudio(draft.id);
    assert.equal(audioA.path, audioB.path);
    assert.equal(path.basename(audioA.path), "audio.pcm");
    assert.equal(ready.state, "send_ready");
    assert.equal(fs.existsSync(path.join(path.dirname(audioA.path), "exports")), false);
  });
});

test("claims and sent receipts must match durable creation authority", () => {
  withTempDir("authority", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    assert.throws(
      () => createDraft(store, { session_id: "session!auth", branch_id: "branch-auth" }),
      /invalid characters/,
    );
    assert.throws(
      () => createDraft(store, { session_id: "s".repeat(121), branch_id: "branch-auth" }),
      /exceeds 120 characters/,
    );
    assert.throws(
      () => createDraft(store, {
        session_id: "session-one",
        sessionId: "session-two",
        branch_id: "branch-auth",
      }),
      /aliases disagree/,
    );
    const draft = createDraft(store, { session_id: "session-auth", branch_id: "branch-auth" });
    store.appendSegment(draft.id, {
      segment_id: "seg-1",
      bytes: pcm(1, 2),
      duration_ms: 10,
      expected_revision: draft.revision,
    });
    transitionToSendReady(store, draft.id);

    assert.throws(
      () => store.claimForTurn(draft.id, {
        session_id: "session!auth",
        branch_id: "branch-auth",
        turn_id: "turn-1",
        expected_revision: store.get(draft.id).revision,
      }),
      /invalid characters/,
    );

    assert.throws(
      () => store.claimForTurn(draft.id, {
        session_id: "session-other",
        branch_id: "branch-auth",
        turn_id: "turn-1",
        expected_revision: store.get(draft.id).revision,
      }),
      /session_id does not match/,
    );
    assert.throws(
      () => store.markSent(draft.id, {
        receipt_id: "sent-missing-claim",
        session_id: "session-auth",
        branch_id: "branch-auth",
        turn_id: "turn-1",
        expected_revision: store.get(draft.id).revision,
      }),
      /must be claimed before markSent/,
    );

    store.claimForTurn(draft.id, {
      session_id: "session-auth",
      branch_id: "branch-auth",
      turn_id: "turn-1",
      expected_revision: store.get(draft.id).revision,
    });
    assert.throws(
      () => store.markSent(draft.id, {
        receipt_id: "sent-bad-turn",
        session_id: "session-auth",
        branch_id: "branch-auth",
        turn_id: "turn-2",
        expected_revision: store.get(draft.id).revision,
      }),
      /must match the claimed turn/,
    );
  });
});

test("rejects odd bytes, noncanonical content type, digest mismatch, byte-count mismatch, and unsafe persisted paths", () => {
  withTempDir("pcm-validation", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const draft = createDraft(store, { session_id: "session-v", branch_id: "branch-v" });

    assert.throws(
      () => store.appendSegment(draft.id, {
        segment_id: "odd",
        bytes: Buffer.from([1]),
        duration_ms: 10,
        expected_revision: draft.revision,
      }),
      /byte length must be even/,
    );
    assert.throws(
      () => store.appendSegment(draft.id, {
        segment_id: "type",
        bytes: pcm(1, 2),
        duration_ms: 10,
        content_type: "audio/wav",
        expected_revision: draft.revision,
      }),
      /canonical PCM16 mono 16kHz/,
    );
    assert.throws(
      () => store.appendSegment(draft.id, {
        segment_id: "digest",
        bytes: pcm(1, 2),
        duration_ms: 10,
        sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        expected_revision: draft.revision,
      }),
      /digest does not match/,
    );
    assert.throws(
      () => store.appendSegment(draft.id, {
        segment_id: "bytes",
        bytes: pcm(1, 2),
        duration_ms: 10,
        byte_count: 99,
        expected_revision: draft.revision,
      }),
      /byte count does not match/,
    );

    store.appendSegment(draft.id, {
      segment_id: "good",
      bytes: pcm(1, 2),
      duration_ms: 10,
      expected_revision: draft.revision,
    });
    const metaPath = path.join(tempDir, "voice-drafts", draft.id, "meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const outsidePath = path.join(tempDir, "outside.pcm");
    fs.writeFileSync(outsidePath, "must-remain");
    meta.cleanup_pending = { files: ["../outside.pcm"] };
    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    assert.throws(
      () => createVoiceDraftStore({ dataDir: tempDir }),
      /cleanup marker is invalid|cleanup files are invalid|resolved outside the draft directory|cleanup_pending is missing required fields/,
    );
    assert.equal(fs.readFileSync(outsidePath, "utf8"), "must-remain");

    meta.cleanup_pending = null;
    meta.audio.path = "../escape.pcm";
    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

    assert.throws(
      () => createVoiceDraftStore({ dataDir: tempDir }),
      /unsafe persisted path/,
    );
  });
});

test("audio and metadata boundaries reject symlinks and non-regular files", () => {
  withTempDir("path-boundaries", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const draft = createDraft(store, { session_id: "session-path", branch_id: "branch-path" });
    const draftDir = path.join(tempDir, "voice-drafts", draft.id);
    const audioPath = path.join(draftDir, "audio.pcm");
    const outsidePath = path.join(tempDir, "outside.pcm");
    fs.writeFileSync(outsidePath, Buffer.alloc(0));
    fs.symlinkSync(outsidePath, audioPath);
    assert.throws(
      () => store.appendSegment(draft.id, {
        segment_id: "symlink",
        bytes: pcm(1),
        duration_ms: 10,
        expected_revision: draft.revision,
      }),
      /non-symlink regular file/,
    );
    assert.equal(fs.statSync(outsidePath).size, 0);
    fs.unlinkSync(audioPath);

    fs.mkdirSync(audioPath);
    assert.throws(
      () => store.appendSegment(draft.id, {
        segment_id: "directory",
        bytes: pcm(1),
        duration_ms: 10,
        expected_revision: draft.revision,
      }),
      /regular file/,
    );
    fs.rmSync(audioPath, { recursive: true });
  });
});

test("boot fails visibly on physical PCM truncation", () => {
  withTempDir("truncation", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const draft = createDraft(store, { session_id: "session-t", branch_id: "branch-t" });
    store.appendSegment(draft.id, {
      segment_id: "seg-1",
      bytes: pcm(1, 2, 3, 4),
      duration_ms: 10,
      expected_revision: draft.revision,
    });
    const audioPath = path.join(tempDir, "voice-drafts", draft.id, "audio.pcm");
    const fd = fs.openSync(audioPath, "r+");
    try {
      fs.ftruncateSync(fd, 6);
    } finally {
      fs.closeSync(fd);
    }
    assert.throws(
      () => createVoiceDraftStore({ dataDir: tempDir }),
      /PCM size mismatch|digest mismatch/,
    );
  });
});

test("create is durably idempotent across active capture, park, restart, and lost responses", () => {
  withTempDir("create-idempotency", (tempDir) => {
    let store = createVoiceDraftStore({ dataDir: tempDir });
    const command = {
      idempotency_key: "create-durable",
      session_id: "session-create",
      branch_id: "branch-create",
      source: "android",
      surface: "overlay",
      release_id: "release-create",
      release_version: "1.2.3",
      partial_transcript: "unsent words",
    };
    assert.throws(
      () => store.create({ session_id: "missing-key", branch_id: "missing-key" }),
      /idempotency_key is required/,
    );

    const first = store.create(command);
    const immediateRetry = store.create(command);
    assert.equal(immediateRetry.id, first.id);
    assert.equal(store.status().count, 1);
    assert.equal(store.status().active_capture_draft_id, first.id);

    store = createVoiceDraftStore({ dataDir: tempDir });
    const activeRestartRetry = store.create(command);
    assert.equal(activeRestartRetry.id, first.id);
    assert.equal(activeRestartRetry.state, "capturing");
    assert.equal(store.status().active_capture_draft_id, first.id);

    store.transition(first.id, {
      action: "park",
      idempotency_key: "park-create",
      expected_revision: store.get(first.id).revision,
    });
    const parkedRetry = store.create(command);
    assert.equal(parkedRetry.id, first.id);
    assert.equal(parkedRetry.state, "parked");
    assert.equal(store.status().count, 1);

    store = createVoiceDraftStore({ dataDir: tempDir });
    const restartedRetry = store.create(command);
    assert.equal(restartedRetry.id, first.id);
    assert.equal(restartedRetry.state, "parked");
    assert.equal(store.status().count, 1);
    assert.throws(
      () => store.create({ ...command, branch_id: "branch-create-other" }),
      /retried with a different request/,
    );
    assert.throws(
      () => store.create({ ...command, release_id: "left", releaseId: "right" }),
      /aliases disagree/,
    );
  });
});

test("authority identifiers never collide and sent receipts bind creation release authority", () => {
  withTempDir("strict-authority", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const draft = store.create({
      idempotency_key: "create-authority",
      session_id: "session-authority",
      branch_id: "branch-authority",
      source: "android",
      surface: "overlay",
      release_id: "release-authority",
      release_version: "1.2.3",
    });
    for (const actor of [
      { kind: "user", id: `${"a".repeat(120)}X` },
      { kind: "user", id: "alice!" },
      { kind: "user!", id: "alice" },
    ]) {
      assert.throws(
        () => store.transition(draft.id, {
          action: "pause",
          actor,
          idempotency_key: "bad-actor",
          expected_revision: draft.revision,
        }),
        /actor\.(?:id|kind).*(?:exceeds|invalid characters)/,
      );
    }
    assert.equal(store.get(draft.id).revision, draft.revision);

    store.appendSegment(draft.id, {
      segment_id: "authority-segment",
      bytes: pcm(1, 2),
      duration_ms: 10,
      expected_revision: draft.revision,
    });
    transitionToSendReady(store, draft.id);
    store.claimForTurn(draft.id, {
      session_id: "session-authority",
      branch_id: "branch-authority",
      turn_id: "turn-authority",
      expected_revision: store.get(draft.id).revision,
    });
    const sentRevision = store.get(draft.id).revision;
    const baseSent = {
      receipt_id: "sent-authority",
      session_id: "session-authority",
      branch_id: "branch-authority",
      turn_id: "turn-authority",
      source: "android",
      surface: "overlay",
      release_id: "release-authority",
      release_version: "1.2.3",
      sent_at: "2026-07-11T12:00:00.000Z",
      expected_revision: sentRevision,
    };
    assert.throws(
      () => store.markSent(draft.id, {
        ...baseSent,
        releaseId: "release-conflict",
      }),
      /release_id aliases disagree/,
    );
    assert.throws(
      () => store.markSent(draft.id, { ...baseSent, release_version: "9.9.9" }),
      /release_version does not match voice draft creation authority/,
    );
    const receipt = store.markSent(draft.id, {
      ...baseSent,
      releaseId: "release-authority",
      releaseVersion: "1.2.3",
    });
    assert.equal(receipt.draft_id, draft.id);
    assert.equal(receipt.release_id, "release-authority");
    assert.equal(receipt.release_version, "1.2.3");
    assert.deepEqual(
      store.markSent(draft.id, {
        ...baseSent,
        releaseId: "release-authority",
        releaseVersion: "1.2.3",
      }),
      receipt,
    );
    assert.throws(
      () => store.markSent(draft.id, { ...baseSent, release_version: "0.0.1" }),
      /release_version does not match voice draft creation authority/,
    );
  });
});

test("an expired current-PID lock with a different boot identity is reclaimed", () => {
  withTempDir("pid-reuse", (tempDir) => {
    const draftsDir = path.join(tempDir, "voice-drafts");
    fs.mkdirSync(draftsDir, { recursive: true });
    const lockPath = path.join(draftsDir, "store.lock");
    fs.writeFileSync(lockPath, `${JSON.stringify({
      type: "voice_draft_operation_lock",
      owner_id: "owner_previous_boot",
      label: "voice-draft-store",
      pid: process.pid,
      process_boot_id: "previous-boot-id",
      acquired_at: "2026-07-11T00:00:00.000Z",
    })}\n`, { mode: 0o600 });
    const staleAt = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, staleAt, staleAt);

    const store = createVoiceDraftStore({ dataDir: tempDir, lockStaleMs: 1 });
    assert.equal(store.status().count, 0);
    assert.equal(fs.existsSync(lockPath), false);
  });
});

test("an explicit zero segment limit never falls back to the permissive default", () => {
  withTempDir("zero-segment-limit", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir, maxSegmentBytes: 0 });
    const draft = createDraft(store, { session_id: "session-zero", branch_id: "branch-zero" });
    assert.equal(store.status().limits.maxSegmentBytes, 0);
    assert.throws(
      () => store.appendSegment(draft.id, {
        segment_id: "zero-limit-segment",
        bytes: pcm(1),
        byte_count: 2,
        duration_ms: 1,
        expected_revision: draft.revision,
      }),
      /segment byte cap exceeded/,
    );
  });
});

test("discard remains durable and replay-safe after nonterminal idempotency capacity is full", () => {
  withTempDir("discard-at-capacity", (tempDir) => {
    let store = createVoiceDraftStore({ dataDir: tempDir, maxActionKeyHashes: 2 });
    const draft = createDraft(store, { session_id: "session-erase", branch_id: "branch-erase" });
    store.appendSegment(draft.id, {
      segment_id: "erase-segment",
      bytes: pcm(1, 2),
      duration_ms: 10,
      partial_transcript: "erase me",
      expected_revision: draft.revision,
    });
    store.transition(draft.id, {
      action: "pause",
      idempotency_key: "erase-pause",
      expected_revision: store.get(draft.id).revision,
    });
    store.transition(draft.id, {
      action: "resume",
      idempotency_key: "erase-resume",
      expected_revision: store.get(draft.id).revision,
    });
    const discardCommand = {
      idempotency_key: "erase-discard",
      expected_revision: store.get(draft.id).revision,
    };
    const receipt = store.discard(draft.id, discardCommand);
    assert.equal(receipt.state_after, "discarded");
    assert.equal(store.get(draft.id).partial_transcript, "");
    assert.equal(store.get(draft.id).used_action_key_hashes.length, 3);
    assert.equal(fs.existsSync(path.join(tempDir, "voice-drafts", draft.id, "audio.pcm")), false);
    assert.equal(
      fs.readFileSync(path.join(tempDir, "voice-drafts", draft.id, "meta.json"), "utf8").includes("erase me"),
      false,
    );

    store = createVoiceDraftStore({ dataDir: tempDir, maxActionKeyHashes: 2 });
    assert.deepEqual(store.discard(draft.id, discardCommand), receipt);
    assert.throws(
      () => store.discard(draft.id, {
        ...discardCommand,
        actor: { kind: "user", id: "different-actor" },
      }),
      /retried with a different request/,
    );
  });
});

test("failed first metadata persistence and empty crash remnants never consume draft quota", () => {
  withTempDir("failed-create-cleanup", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir, maxDrafts: 1 });
    const command = {
      idempotency_key: "create-after-failure",
      session_id: "session-after-failure",
      branch_id: "branch-after-failure",
    };
    const originalRename = fs.renameSync;
    let failMetadataRename = true;
    fs.renameSync = (from, to) => {
      if (failMetadataRename && path.basename(to) === "meta.json") {
        failMetadataRename = false;
        const error = new Error("simulated initial metadata rename failure");
        error.code = "EIO";
        throw error;
      }
      return originalRename(from, to);
    };
    try {
      assert.throws(() => store.create(command), /simulated initial metadata rename failure/);
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(store.status().count, 0);
    assert.equal(store.status().active_capture_draft_id, "");

    const emptyOrphan = path.join(tempDir, "voice-drafts", "draft_empty_orphan");
    fs.mkdirSync(emptyOrphan, { mode: 0o700 });
    const restarted = createVoiceDraftStore({ dataDir: tempDir, maxDrafts: 1 });
    assert.equal(fs.existsSync(emptyOrphan), false);
    const created = restarted.create(command);
    assert.equal(restarted.status().count, 1);
    assert.equal(restarted.get(created.id).id, created.id);
    assert.equal(fs.statSync(path.dirname(path.join(tempDir, "voice-drafts", created.id))).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(tempDir, "voice-drafts", created.id)).mode & 0o777, 0o700);
  });
});

test("persisted state, schema, revisions, segment authority, and aggregates fail closed without rewrite", () => {
  const corruptions = [
    ["state", (meta) => { meta.state = "not-a-real-state"; }, /persisted state/],
    ["revision", (meta) => { meta.revision = "not-a-revision"; }, /positive integer/],
    ["store-revision", (meta) => { meta.store_revision = "voice_draft_store.future"; }, /incompatible/],
    ["machine-revision", (meta) => { meta.state_machine_revision = "voice_draft_state.future"; }, /incompatible/],
    ["segment-id", (meta) => { meta.segments[0].segment_id = "bad segment"; }, /segment_id.*invalid characters/],
    ["segment-number", (meta) => { meta.segments[0].bytes = "4"; }, /segment\.bytes.*positive integer/],
    ["aggregate", (meta) => { meta.audio.total_bytes += 2; }, /audio totals do not match/],
  ];
  for (const [name, corrupt, expected] of corruptions) {
    withTempDir(`stored-corruption-${name}`, (tempDir) => {
      const store = createVoiceDraftStore({ dataDir: tempDir });
      const draft = createDraft(store, {
        session_id: `session-${name}`,
        branch_id: `branch-${name}`,
      });
      store.appendSegment(draft.id, {
        segment_id: `segment-${name}`,
        bytes: pcm(1, 2),
        duration_ms: 10,
        expected_revision: draft.revision,
      });
      const metaPath = path.join(tempDir, "voice-drafts", draft.id, "meta.json");
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      corrupt(meta);
      const corruptedBytes = `${JSON.stringify(meta, null, 2)}\n`;
      fs.writeFileSync(metaPath, corruptedBytes);
      assert.throws(() => createVoiceDraftStore({ dataDir: tempDir }), expected);
      assert.equal(fs.readFileSync(metaPath, "utf8"), corruptedBytes);
    });
  }
});

test("draft-directory symlinks fail closed across reads, lazy audio, mutations, recovery, and cleanup", () => {
  withTempDir("directory-symlink", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const draft = createDraft(store, { session_id: "session-link", branch_id: "branch-link" });
    store.appendSegment(draft.id, {
      segment_id: "segment-link",
      bytes: pcm(1, 2),
      duration_ms: 10,
      expected_revision: draft.revision,
    });
    store.transition(draft.id, {
      action: "park",
      idempotency_key: "park-link",
      expected_revision: store.get(draft.id).revision,
    });
    const parked = store.get(draft.id);
    const lazyAudio = store.readAudio(draft.id);
    const draftDir = path.join(tempDir, "voice-drafts", draft.id);
    const outsideDir = path.join(tempDir, "outside-draft");
    fs.renameSync(draftDir, outsideDir);
    fs.symlinkSync(outsideDir, draftDir, "dir");
    const outsideBefore = snapshotTree(outsideDir);
    const rejected = /symlink|non-symlink directory|resolves outside/;

    for (const operation of [
      () => store.get(draft.id),
      () => store.list(),
      () => store.segments(draft.id),
      () => store.readAudio(draft.id),
      () => lazyAudio.readBuffer(),
      () => store.appendSegment(draft.id, {
        segment_id: "segment-link-2",
        bytes: pcm(3, 4),
        duration_ms: 10,
        expected_revision: parked.revision,
      }),
      () => store.transition(draft.id, {
        action: "resume",
        idempotency_key: "resume-link",
        expected_revision: parked.revision,
      }),
      () => store.claimForTurn(draft.id, {
        session_id: "session-link",
        branch_id: "branch-link",
        turn_id: "turn-link",
        expected_revision: parked.revision,
      }),
      () => store.markSent(draft.id, {
        receipt_id: "sent-link",
        session_id: "session-link",
        branch_id: "branch-link",
        turn_id: "turn-link",
        expected_revision: parked.revision,
      }),
      () => store.discard(draft.id, {
        idempotency_key: "discard-link",
        expected_revision: parked.revision,
      }),
      () => createVoiceDraftStore({ dataDir: tempDir }),
    ]) {
      assert.throws(operation, rejected);
      assert.deepEqual(snapshotTree(outsideDir), outsideBefore);
    }
    fs.unlinkSync(draftDir);
    fs.cpSync(outsideDir, draftDir, { recursive: true });
    assert.throws(() => lazyAudio.readBuffer(), /directory boundary changed/);
    assert.throws(() => lazyAudio.createReadStream(), /directory boundary changed/);
    assert.deepEqual(snapshotTree(outsideDir), outsideBefore);
  });
});

test("stored draft identity, create authority, and terminal receipt invariants fail without rewrite", () => {
  withTempDir("stored-container-id", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const draft = createDraft(store, { session_id: "session-id", branch_id: "branch-id" });
    const metaPath = draftMetaPath(tempDir, draft.id);
    const meta = readJson(metaPath);
    meta.id = "draft_other_identity";
    meta.capture_lease.draft_id = meta.id;
    const corrupted = writeJson(metaPath, meta);
    assert.throws(() => store.get(draft.id), /disagrees with directory/);
    assert.throws(() => createVoiceDraftStore({ dataDir: tempDir }), /disagrees with directory/);
    assert.equal(fs.readFileSync(metaPath, "utf8"), corrupted);
  });

  withTempDir("stored-create-authority", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const command = {
      idempotency_key: "create-required-authority",
      session_id: "session-create-authority",
      branch_id: "branch-create-authority",
    };
    const draft = store.create(command);
    store.transition(draft.id, {
      action: "park",
      idempotency_key: "park-create-authority",
      expected_revision: draft.revision,
    });
    const metaPath = draftMetaPath(tempDir, draft.id);
    const meta = readJson(metaPath);
    delete meta.create_request;
    const corrupted = writeJson(metaPath, meta);
    const directoriesBefore = fs.readdirSync(path.join(tempDir, "voice-drafts")).sort();
    assert.throws(() => store.create(command), /requires canonical create request authority/);
    assert.deepEqual(fs.readdirSync(path.join(tempDir, "voice-drafts")).sort(), directoriesBefore);
    assert.equal(fs.readFileSync(metaPath, "utf8"), corrupted);
  });

  withTempDir("stored-forged-terminal", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const draft = createDraft(store, { session_id: "session-forged", branch_id: "branch-forged" });
    store.appendSegment(draft.id, {
      segment_id: "segment-forged",
      bytes: pcm(5, 6),
      duration_ms: 10,
      expected_revision: draft.revision,
    });
    store.transition(draft.id, {
      action: "park",
      idempotency_key: "park-forged",
      expected_revision: store.get(draft.id).revision,
    });
    const metaPath = draftMetaPath(tempDir, draft.id);
    const audioPath = path.join(tempDir, "voice-drafts", draft.id, "audio.pcm");
    const meta = readJson(metaPath);
    meta.state = "sent";
    const corrupted = writeJson(metaPath, meta);
    const audioBefore = fs.readFileSync(audioPath);
    assert.throws(() => store.get(draft.id), /sent voice draft is missing|matching tombstone|terminal voice draft/);
    assert.throws(
      () => createVoiceDraftStore({ dataDir: tempDir }),
      /sent voice draft is missing|matching tombstone|terminal voice draft/,
    );
    assert.equal(fs.readFileSync(metaPath, "utf8"), corrupted);
    assert.deepEqual(fs.readFileSync(audioPath), audioBefore);
  });

  withTempDir("stored-terminal-authority", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const draft = createDraft(store, { session_id: "session-tomb", branch_id: "branch-tomb" });
    store.discard(draft.id, {
      idempotency_key: "discard-tomb",
      expected_revision: draft.revision,
    });
    const metaPath = draftMetaPath(tempDir, draft.id);
    const meta = readJson(metaPath);
    meta.tombstone.receipt_id = "different-discard-authority";
    const corrupted = writeJson(metaPath, meta);
    assert.throws(() => createVoiceDraftStore({ dataDir: tempDir }), /discard tombstone authority disagrees/);
    assert.equal(fs.readFileSync(metaPath, "utf8"), corrupted);
  });

  withTempDir("stored-terminal-physical-content", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const draft = createDraft(store, { session_id: "session-raw", branch_id: "branch-raw" });
    store.discard(draft.id, {
      idempotency_key: "discard-raw",
      expected_revision: draft.revision,
    });
    const audioPath = path.join(tempDir, "voice-drafts", draft.id, "audio.pcm");
    const rawAudio = pcm(11, 12);
    fs.writeFileSync(audioPath, rawAudio);
    assert.throws(
      () => store.get(draft.id),
      /untracked audio|cleanup left audio\.pcm|physical schema contains unexpected files/,
    );
    assert.throws(
      () => createVoiceDraftStore({ dataDir: tempDir }),
      /untracked audio|cleanup left audio\.pcm|physical schema contains unexpected files/,
    );
    assert.deepEqual(fs.readFileSync(audioPath), rawAudio);
  });
});

test("persisted metadata bytes, text, collections, and audio totals obey active configured limits", () => {
  const lowerLimitCases = [
    ["transcript", { maxPartialTranscriptChars: 10 }, /partial_transcript exceeds/],
    ["segments", { maxSegmentsPerDraft: 1 }, /segment count exceeds|audio totals exceed configured limits/],
    ["segment-bytes", { maxSegmentBytes: 2 }, /segment exceeds configured limits/],
    ["segment-duration", { maxSegmentDurationMs: 5 }, /segment exceeds configured limits/],
    ["draft-bytes", { maxDraftBytes: 4 }, /audio totals exceed configured limits/],
    ["draft-duration", { maxDraftDurationMs: 15 }, /audio totals exceed configured limits/],
    ["history", { maxTransitionHistory: 1 }, /transition history exceeds/],
    ["hashes", { maxActionKeyHashes: 1 }, /action-key hashes exceed/],
    ["store-total", { maxTotalBytes: 4 }, /total byte limit/],
  ];
  for (const [name, limits, expected] of lowerLimitCases) {
    withTempDir(`persisted-limit-${name}`, (tempDir) => {
      const fixture = createPersistedLimitFixture(tempDir, name);
      const before = fs.readFileSync(fixture.metaPath, "utf8");
      assert.throws(() => createVoiceDraftStore({ dataDir: tempDir, ...limits }), expected);
      assert.equal(fs.readFileSync(fixture.metaPath, "utf8"), before);
    });
  }

  withTempDir("persisted-limit-metadata-bytes", (tempDir) => {
    const fixture = createPersistedLimitFixture(tempDir, "metadata-bytes");
    const original = fs.readFileSync(fixture.metaPath, "utf8");
    const padded = `${original}${" ".repeat(2048)}`;
    fs.writeFileSync(fixture.metaPath, padded);
    assert.throws(
      () => createVoiceDraftStore({ dataDir: tempDir, maxMetadataBytes: Buffer.byteLength(original) + 32 }),
      /exceeds .* bytes/,
    );
    assert.equal(fs.readFileSync(fixture.metaPath, "utf8"), padded);
  });

  withTempDir("persisted-limit-crafted-collections", (tempDir) => {
    const fixture = createPersistedLimitFixture(tempDir, "crafted-collections");
    const meta = readJson(fixture.metaPath);
    meta.partial_transcript = "x".repeat(100_000);
    meta.used_action_key_hashes = Array.from(
      { length: 1000 },
      (_, index) => index.toString(16).padStart(64, "0"),
    );
    const corrupted = writeJson(fixture.metaPath, meta);
    assert.throws(
      () => createVoiceDraftStore({
        dataDir: tempDir,
        maxMetadataBytes: 512 * 1024,
        maxPartialTranscriptChars: 10,
        maxActionKeyHashes: 2,
      }),
      /partial_transcript exceeds|action-key hashes exceed/,
    );
    assert.equal(fs.readFileSync(fixture.metaPath, "utf8"), corrupted);
  });
});

test("bounded full replay retention compacts to durable expired outcomes without pruning live content", () => {
  withTempDir("terminal-turnover", (tempDir) => {
    const options = { dataDir: tempDir, maxDrafts: 1, maxTerminalDrafts: 1 };
    let store = createVoiceDraftStore(options);
    const firstCommand = {
      idempotency_key: "create-turnover-discard",
      session_id: "session-turnover-discard",
      branch_id: "branch-turnover-discard",
    };
    const first = store.create(firstCommand);
    const firstDiscardRevision = first.revision;
    const discarded = store.discard(first.id, {
      idempotency_key: "discard-turnover",
      expected_revision: firstDiscardRevision,
    });
    assert.deepEqual(store.create(firstCommand), store.get(first.id));
    assert.deepEqual(store.discard(first.id, {
      idempotency_key: "discard-turnover",
      expected_revision: firstDiscardRevision,
    }), discarded);

    const secondCommand = {
      idempotency_key: "create-turnover-sent",
      session_id: "session-turnover-sent",
      branch_id: "branch-turnover-sent",
      source: "android",
    };
    const second = store.create(secondCommand);
    store.appendSegment(second.id, {
      segment_id: "segment-turnover-sent",
      bytes: pcm(7, 8),
      duration_ms: 10,
      expected_revision: second.revision,
    });
    transitionToSendReady(store, second.id);
    store.claimForTurn(second.id, {
      session_id: secondCommand.session_id,
      branch_id: secondCommand.branch_id,
      turn_id: "turn-turnover-sent",
      expected_revision: store.get(second.id).revision,
    });
    const sentRevision = store.get(second.id).revision;
    const sentCommand = {
      receipt_id: "sent-turnover",
      session_id: secondCommand.session_id,
      branch_id: secondCommand.branch_id,
      turn_id: "turn-turnover-sent",
      source: "android",
      sent_at: "2026-07-11T01:02:03.000Z",
      expected_revision: sentRevision,
    };
    const sent = store.markSent(second.id, sentCommand);
    assert.equal(fs.existsSync(path.join(tempDir, "voice-drafts", first.id)), false);
    assert.equal(
      fs.existsSync(path.join(tempDir, "voice-drafts", "expired-replay-index.json")),
      true,
    );
    const expiredFirst = store.get(first.id);
    assert.equal(expiredFirst.kind, "voice_draft_expired_replay");
    assert.equal(expiredFirst.state, "expired");
    assert.equal(expiredFirst.terminal_state, "discarded");
    assert.throws(
      () => store.create(firstCommand),
      (error) => error.statusCode === 410
        && error.code === "voice_draft_replay_expired"
        && error.outcome.draft_id === first.id,
    );
    assert.throws(
      () => store.discard(first.id, {
        idempotency_key: "discard-turnover",
        expected_revision: firstDiscardRevision,
      }),
      (error) => error.statusCode === 410
        && error.code === "voice_draft_replay_expired"
        && error.outcome.draft_id === first.id,
    );
    assert.throws(
      () => store.discard("draft_missing_valid_id", {
        idempotency_key: "discard-missing",
        expected_revision: 1,
      }),
      (error) => error.statusCode === 404 && /not found/.test(error.message),
    );
    assert.equal(fs.existsSync(path.join(tempDir, "voice-drafts", second.id, "audio.pcm")), false);
    assert.equal(store.create(secondCommand).id, second.id);
    assert.deepEqual(store.markSent(second.id, sentCommand), sent);
    assert.throws(
      () => store.create({ ...secondCommand, branch_id: "different-branch" }),
      /retried with a different request/,
    );

    store = createVoiceDraftStore(options);
    assert.throws(
      () => store.create(firstCommand),
      (error) => error.statusCode === 410
        && error.code === "voice_draft_replay_expired"
        && error.outcome.draft_id === first.id,
    );
    assert.equal(store.get(first.id).kind, "voice_draft_expired_replay");
    assert.equal(store.create(secondCommand).id, second.id);
    assert.deepEqual(store.markSent(second.id, sentCommand), sent);
    const third = store.create({
      idempotency_key: "create-turnover-live",
      session_id: "session-turnover-live",
      branch_id: "branch-turnover-live",
    });
    store.appendSegment(third.id, {
      segment_id: "segment-turnover-live",
      bytes: pcm(9, 10),
      duration_ms: 10,
      expected_revision: third.revision,
    });
    const liveBefore = snapshotTree(path.join(tempDir, "voice-drafts", third.id));
    assert.throws(
      () => store.create({
        idempotency_key: "create-turnover-over-cap",
        session_id: "session-turnover-over-cap",
        branch_id: "branch-turnover-over-cap",
      }),
      /active capacity exceeded/,
    );
    assert.deepEqual(snapshotTree(path.join(tempDir, "voice-drafts", third.id)), liveBefore);
    assert.equal(store.status().capacity_count, 1);
    assert.equal(store.status().terminal_replay_count, 1);
    assert.equal(store.status().expired_replay_count, 1);
    assert.equal(store.status().terminal_retention.exact_replay_scope, "retained_records");
    assert.equal(
      store.status().terminal_retention.compacted_scope,
      "durable_expired_domain_outcome",
    );
  });
});

test("expired replay markers are exact, content-free, and reject unknown fields", () => {
  withTempDir("expired-marker-schema", (tempDir) => {
    const options = { dataDir: tempDir, maxDrafts: 1, maxTerminalDrafts: 1 };
    const store = createVoiceDraftStore(options);
    const first = store.create({
      idempotency_key: "create-expired-private",
      session_id: "session-expired-private",
      branch_id: "branch-expired-private",
      partial_transcript: "private marker transcript",
    });
    store.appendSegment(first.id, {
      segment_id: "segment-expired-private",
      bytes: pcm(1, 2),
      duration_ms: 10,
      partial_transcript: "private marker transcript",
      expected_revision: first.revision,
    });
    store.discard(first.id, {
      idempotency_key: "discard-expired-private",
      expected_revision: store.get(first.id).revision,
    });
    const second = store.create({
      idempotency_key: "create-expired-trigger",
      session_id: "session-expired-trigger",
      branch_id: "branch-expired-trigger",
    });
    store.discard(second.id, {
      idempotency_key: "discard-expired-trigger",
      expected_revision: second.revision,
    });
    const firstDir = path.join(tempDir, "voice-drafts", first.id);
    const metaPath = path.join(tempDir, "voice-drafts", "expired-replay-index.json");
    const encoded = fs.readFileSync(metaPath, "utf8");
    assert.equal(encoded.includes("private marker transcript"), false);
    assert.equal(fs.existsSync(path.join(firstDir, "audio.pcm")), false);
    assert.equal(fs.existsSync(firstDir), false);
    const index = JSON.parse(encoded);
    const meta = index.records_by_draft[first.id];
    assert.equal(meta.kind, "voice_draft_expired_replay");
    meta.unknown_transcript = "must remain corrupt evidence";
    const corrupted = writeJson(metaPath, index);
    const indexTempPath = path.join(
      tempDir,
      "voice-drafts",
      `expired-replay-index.json.${process.pid}.deadbeef.tmp`,
    );
    fs.writeFileSync(indexTempPath, "preserve replay-index crash evidence");
    assert.throws(() => createVoiceDraftStore(options), /expired_replay contains .*unknown fields/);
    assert.equal(fs.readFileSync(metaPath, "utf8"), corrupted);
    assert.equal(fs.readFileSync(indexTempPath, "utf8"), "preserve replay-index crash evidence");
  });
});

test("mutation integers require number-typed safe integers and fail before state or content changes", () => {
  withTempDir("strict-mutation-integers", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const root = path.join(tempDir, "voice-drafts");
    const beforeInvalidCreate = snapshotTree(root);
    assert.throws(
      () => store.create({ idempotency_key: 1, session_id: "session-number", branch_id: "branch-number" }),
      /idempotency_key is required/,
    );
    assert.deepEqual(snapshotTree(root), beforeInvalidCreate);

    const draft = createDraft(store, { session_id: "session-number", branch_id: "branch-number" });
    const invalidIntegers = [
      "1",
      1.4,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
    for (const [index, value] of invalidIntegers.entries()) {
      assertOperationLeavesTreeUnchanged(root, () => store.transition(draft.id, {
        action: "pause",
        idempotency_key: `pause-invalid-${index}`,
        expected_revision: value,
      }), /number-typed positive safe integer/);
      assertOperationLeavesTreeUnchanged(root, () => store.appendSegment(draft.id, {
        segment_id: `segment-invalid-revision-${index}`,
        bytes: pcm(1, 2),
        duration_ms: 10,
        expected_revision: value,
      }), /number-typed positive safe integer/);
      assertOperationLeavesTreeUnchanged(root, () => store.appendSegment(draft.id, {
        segment_id: `segment-invalid-duration-${index}`,
        bytes: pcm(1, 2),
        duration_ms: value,
        expected_revision: draft.revision,
      }), /number-typed safe integer/);
      assertOperationLeavesTreeUnchanged(root, () => store.appendSegment(draft.id, {
        segment_id: `segment-invalid-bytes-${index}`,
        bytes: pcm(1, 2),
        byte_count: value,
        duration_ms: 10,
        expected_revision: draft.revision,
      }), /number-typed non-negative safe integer/);
    }

    store.appendSegment(draft.id, {
      segment_id: "segment-number-valid",
      bytes: pcm(3, 4),
      duration_ms: 10,
      expected_revision: draft.revision,
    });
    transitionToSendReady(store, draft.id);
    const readyRevision = store.get(draft.id).revision;
    for (const [index, value] of invalidIntegers.entries()) {
      assertOperationLeavesTreeUnchanged(root, () => store.claimForTurn(draft.id, {
        session_id: "session-number",
        branch_id: "branch-number",
        turn_id: `turn-invalid-${index}`,
        expected_revision: value,
      }), /number-typed positive safe integer/);
    }
    store.claimForTurn(draft.id, {
      session_id: "session-number",
      branch_id: "branch-number",
      turn_id: "turn-number-valid",
      expected_revision: readyRevision,
    });
    for (const value of invalidIntegers) {
      assertOperationLeavesTreeUnchanged(root, () => store.markSent(draft.id, {
        receipt_id: "sent-number-invalid",
        session_id: "session-number",
        branch_id: "branch-number",
        turn_id: "turn-number-valid",
        expected_revision: value,
      }), /number-typed positive safe integer/);
    }
  });
});

test("exact v2 schemas reject unknown draft, authority, segment, and history fields without cleanup", () => {
  const corruptions = [
    ["draft", (meta) => { meta.unknown_transcript_backup = "must remain evidence"; }],
    ["create-request", (meta) => { meta.create_request.unknown_audio = "AQI="; }],
    ["capture-lease", (meta) => { meta.capture_lease.unknown_owner = "mallory"; }],
    ["audio", (meta) => { meta.audio.unknown_path = "outside.pcm"; }],
    ["segment", (meta) => { meta.segments[0].unknown_transcript = "secret"; }],
    ["append-request", (meta) => { meta.segments[0].append_request.unknown_bytes = 4; }],
    ["history-entry", (meta) => { meta.transition_history[0].unknown_receipt = {}; }],
    ["history-request", (meta) => { meta.transition_history[0].request.unknown_actor = "mallory"; }],
    ["history-request-actor", (meta) => { meta.transition_history[0].request.actor.unknown = "mallory"; }],
    ["history-receipt", (meta) => { meta.transition_history[0].receipt.unknown_state = "sent"; }],
  ];
  for (const [name, corrupt] of corruptions) {
    withTempDir(`exact-schema-${name}`, (tempDir) => {
      const store = createVoiceDraftStore({ dataDir: tempDir });
      const draft = createDraft(store, {
        session_id: `session-exact-${name}`,
        branch_id: `branch-exact-${name}`,
        partial_transcript: "known private transcript",
      });
      store.appendSegment(draft.id, {
        segment_id: `segment-exact-${name}`,
        bytes: pcm(1, 2),
        duration_ms: 10,
        expected_revision: draft.revision,
      });
      store.transition(draft.id, {
        action: "pause",
        idempotency_key: `pause-exact-${name}`,
        expected_revision: store.get(draft.id).revision,
      });
      const metaPath = draftMetaPath(tempDir, draft.id);
      const audioPath = path.join(tempDir, "voice-drafts", draft.id, "audio.pcm");
      const meta = readJson(metaPath);
      corrupt(meta);
      const corrupted = writeJson(metaPath, meta);
      const audioBefore = fs.readFileSync(audioPath);
      assert.throws(
        () => store.discard(draft.id, {
          idempotency_key: `discard-exact-${name}`,
          expected_revision: meta.revision,
        }),
        /unknown fields/,
      );
      assert.throws(() => createVoiceDraftStore({ dataDir: tempDir }), /unknown fields/);
      assert.equal(fs.readFileSync(metaPath, "utf8"), corrupted);
      assert.deepEqual(fs.readFileSync(audioPath), audioBefore);
    });
  }
});

test("park, recovery, discard, and cleanup receipts use exact persisted schemas", () => {
  const cases = [
    ["parked", (tempDir) => {
      const store = createVoiceDraftStore({ dataDir: tempDir });
      const draft = createDraft(store, { session_id: "session-park-schema", branch_id: "branch-park-schema" });
      store.transition(draft.id, {
        action: "park",
        idempotency_key: "park-schema",
        expected_revision: draft.revision,
      });
      const metaPath = draftMetaPath(tempDir, draft.id);
      const meta = readJson(metaPath);
      meta.parked_receipt.unknown = "secret";
      return { metaPath, corrupted: writeJson(metaPath, meta) };
    }],
    ["recovery", (tempDir) => {
      let store = createVoiceDraftStore({ dataDir: tempDir });
      const draft = createDraft(store, {
        session_id: "session-recovery-schema",
        branch_id: "branch-recovery-schema",
      });
      fs.rmSync(path.join(tempDir, "voice-drafts", "capture.lock"), { force: true });
      store = createVoiceDraftStore({ dataDir: tempDir });
      assert.equal(store.get(draft.id).state, "parked");
      const metaPath = draftMetaPath(tempDir, draft.id);
      const meta = readJson(metaPath);
      meta.recovery_receipt.unknown = "secret";
      return { metaPath, corrupted: writeJson(metaPath, meta) };
    }],
    ["discard", (tempDir) => {
      const store = createVoiceDraftStore({ dataDir: tempDir });
      const draft = createDraft(store, { session_id: "session-discard-schema", branch_id: "branch-discard-schema" });
      store.discard(draft.id, {
        idempotency_key: "discard-schema",
        expected_revision: draft.revision,
      });
      const metaPath = draftMetaPath(tempDir, draft.id);
      const meta = readJson(metaPath);
      meta.discard_receipt.unknown = "secret";
      return { metaPath, corrupted: writeJson(metaPath, meta) };
    }],
    ["cleanup", (tempDir) => {
      const store = createVoiceDraftStore({
        dataDir: tempDir,
        testHooks: {
          afterCleanupMarkerWrite() {
            throw new Error("stop-before-cleanup");
          },
        },
      });
      const draft = createDraft(store, { session_id: "session-cleanup-schema", branch_id: "branch-cleanup-schema" });
      store.appendSegment(draft.id, {
        segment_id: "segment-cleanup-schema",
        bytes: pcm(1, 2),
        duration_ms: 10,
        expected_revision: draft.revision,
      });
      assert.throws(() => store.discard(draft.id, {
        idempotency_key: "discard-cleanup-schema",
        expected_revision: store.get(draft.id).revision,
      }), /stop-before-cleanup/);
      const metaPath = draftMetaPath(tempDir, draft.id);
      const meta = readJson(metaPath);
      meta.cleanup_pending.unknown = "secret";
      return { metaPath, corrupted: writeJson(metaPath, meta) };
    }],
  ];
  for (const [name, build] of cases) {
    withTempDir(`receipt-schema-${name}`, (tempDir) => {
      const fixture = build(tempDir);
      assert.throws(() => createVoiceDraftStore({ dataDir: tempDir }), /unknown fields/);
      assert.equal(fs.readFileSync(fixture.metaPath, "utf8"), fixture.corrupted);
    });
  }
});

test("schema corruption preserves recognized crash-temp evidence instead of cleaning around it", () => {
  withTempDir("corrupt-with-temp", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const draft = createDraft(store, { session_id: "session-corrupt-temp", branch_id: "branch-corrupt-temp" });
    store.transition(draft.id, {
      action: "pause",
      idempotency_key: "pause-corrupt-temp",
      expected_revision: draft.revision,
    });
    const metaPath = draftMetaPath(tempDir, draft.id);
    const meta = readJson(metaPath);
    meta.unknown_transcript = "corrupt evidence";
    const corrupted = writeJson(metaPath, meta);
    const tempPath = path.join(
      tempDir,
      "voice-drafts",
      draft.id,
      `meta.json.${process.pid}.deadbeef.tmp`,
    );
    fs.writeFileSync(tempPath, "crash temp evidence");
    assert.throws(() => store.discard(draft.id, {
      idempotency_key: "discard-corrupt-temp",
      expected_revision: meta.revision,
    }), /unknown fields/);
    assert.equal(fs.readFileSync(metaPath, "utf8"), corrupted);
    assert.equal(fs.readFileSync(tempPath, "utf8"), "crash temp evidence");
    assert.throws(() => createVoiceDraftStore({ dataDir: tempDir }), /unknown fields/);
    assert.equal(fs.readFileSync(metaPath, "utf8"), corrupted);
    assert.equal(fs.readFileSync(tempPath, "utf8"), "crash temp evidence");
  });
});

test("append journal root, boundary, segment, and request schemas are exact", () => {
  const corruptions = [
    ["root", (journal) => { journal.unknown = "secret"; }],
    ["pre", (journal) => { journal.pre.unknown = "secret"; }],
    ["post", (journal) => { journal.post.unknown = "secret"; }],
    ["segment", (journal) => { journal.segment.unknown = "secret"; }],
    ["request", (journal) => { journal.segment.append_request.unknown = "secret"; }],
  ];
  for (const [name, corrupt] of corruptions) {
    withTempDir(`journal-schema-${name}`, (tempDir) => {
      const store = createVoiceDraftStore({
        dataDir: tempDir,
        testHooks: {
          afterAppendJournalWrite() {
            throw new Error("stop-after-journal-schema");
          },
        },
      });
      const draft = createDraft(store, {
        session_id: `session-journal-${name}`,
        branch_id: `branch-journal-${name}`,
      });
      assert.throws(() => store.appendSegment(draft.id, {
        segment_id: `segment-journal-${name}`,
        bytes: pcm(1, 2),
        duration_ms: 10,
        expected_revision: draft.revision,
      }), /stop-after-journal-schema/);
      const journalPath = path.join(tempDir, "voice-drafts", draft.id, "append-journal.json");
      const journal = readJson(journalPath);
      corrupt(journal);
      const corrupted = writeJson(journalPath, journal);
      const metadataBefore = fs.readFileSync(draftMetaPath(tempDir, draft.id), "utf8");
      assert.throws(() => createVoiceDraftStore({ dataDir: tempDir }), /unknown fields/);
      assert.equal(fs.readFileSync(journalPath, "utf8"), corrupted);
      assert.equal(fs.readFileSync(draftMetaPath(tempDir, draft.id), "utf8"), metadataBefore);
    });
  }
});

test("duplicate create replay authority fails before any other record's temp evidence is removed", () => {
  withTempDir("duplicate-create-authority", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const firstCommand = {
      idempotency_key: "create-duplicate-authority-a",
      session_id: "session-duplicate-authority-a",
      branch_id: "branch-duplicate-authority-a",
    };
    const first = store.create(firstCommand);
    store.transition(first.id, {
      action: "park",
      idempotency_key: "park-duplicate-authority-a",
      expected_revision: first.revision,
    });
    const second = store.create({
      idempotency_key: "create-duplicate-authority-b",
      session_id: "session-duplicate-authority-b",
      branch_id: "branch-duplicate-authority-b",
    });
    store.transition(second.id, {
      action: "park",
      idempotency_key: "park-duplicate-authority-b",
      expected_revision: second.revision,
    });
    const secondMetaPath = draftMetaPath(tempDir, second.id);
    const secondMeta = readJson(secondMetaPath);
    secondMeta.create_request.idempotency_key = "create-duplicate-authority-a";
    const corrupted = writeJson(secondMetaPath, secondMeta);
    assert.throws(
      () => store.create(firstCommand),
      /create idempotency authority .* is duplicated|create authority root disagrees/,
    );
    assert.equal(fs.readFileSync(secondMetaPath, "utf8"), corrupted);
    const firstTemp = path.join(
      tempDir,
      "voice-drafts",
      first.id,
      `meta.json.${process.pid}.deadbeef.tmp`,
    );
    fs.writeFileSync(firstTemp, "preserve first temp");
    assert.throws(
      () => createVoiceDraftStore({ dataDir: tempDir }),
      /create idempotency authority .* is duplicated|create authority root disagrees/,
    );
    assert.equal(fs.readFileSync(secondMetaPath, "utf8"), corrupted);
    assert.equal(fs.readFileSync(firstTemp, "utf8"), "preserve first temp");
  });
});

test("unexpected files, symlinks, and directories fail before and after terminal cleanup", () => {
  for (const stage of ["before", "after"]) {
    for (const kind of ["file", "symlink", "directory"]) {
      withTempDir(`physical-${stage}-${kind}`, (tempDir) => {
        const store = createVoiceDraftStore({ dataDir: tempDir });
        const draft = createDraft(store, {
          session_id: `session-physical-${stage}-${kind}`,
          branch_id: `branch-physical-${stage}-${kind}`,
          partial_transcript: "private physical evidence",
        });
        store.appendSegment(draft.id, {
          segment_id: `segment-physical-${stage}-${kind}`,
          bytes: pcm(3, 4),
          duration_ms: 10,
          expected_revision: draft.revision,
        });
        store.transition(draft.id, {
          action: "pause",
          idempotency_key: `pause-physical-${stage}-${kind}`,
          expected_revision: store.get(draft.id).revision,
        });
        if (stage === "after") {
          store.discard(draft.id, {
            idempotency_key: `discard-physical-${stage}-${kind}`,
            expected_revision: store.get(draft.id).revision,
          });
        }
        const expectedRevision = stage === "before" ? store.get(draft.id).revision : 0;
        const draftDir = path.join(tempDir, "voice-drafts", draft.id);
        const artifact = installUnexpectedArtifact(draftDir, kind, tempDir);
        const artifactBefore = snapshotTree(artifact.path);
        const metaPath = draftMetaPath(tempDir, draft.id);
        const metadataBefore = fs.readFileSync(metaPath, "utf8");
        const audioPath = path.join(draftDir, "audio.pcm");
        const audioBefore = fs.existsSync(audioPath) ? fs.readFileSync(audioPath) : null;
        if (stage === "before") {
          assert.throws(
            () => store.discard(draft.id, {
              idempotency_key: `discard-blocked-${kind}`,
              expected_revision: expectedRevision,
            }),
            /unexpected files|forbidden/,
          );
        } else {
          assert.throws(() => store.get(draft.id), /unexpected files|forbidden/);
        }
        assert.throws(() => createVoiceDraftStore({ dataDir: tempDir }), /unexpected files|forbidden/);
        assert.equal(fs.readFileSync(metaPath, "utf8"), metadataBefore);
        assert.deepEqual(snapshotTree(artifact.path), artifactBefore);
        if (artifact.outsidePath) {
          assert.equal(fs.readFileSync(artifact.outsidePath, "utf8"), "outside evidence");
        }
        if (audioBefore) assert.deepEqual(fs.readFileSync(audioPath), audioBefore);
      });
    }
  }
});

test("terminal lock scaffolding must be an exact bounded operation-lock record", () => {
  for (const [name, contents, expected] of [
    ["hidden-content", "private transcript", /lock scaffolding is invalid/],
    ["unknown-field", `${JSON.stringify({
      type: "voice_draft_operation_lock",
      owner_id: "owner_forged",
      label: "placeholder",
      pid: process.pid,
      process_boot_id: "forged-boot",
      acquired_at: "2026-07-11T00:00:00.000Z",
      unknown_transcript: "private transcript",
    })}\n`, /lock scaffolding is invalid/],
    ["oversized", "x".repeat(16 * 1024 + 1), /operation lock exceeds/],
  ]) {
    withTempDir(`terminal-lock-${name}`, (tempDir) => {
      const store = createVoiceDraftStore({ dataDir: tempDir });
      const draft = createDraft(store, {
        session_id: `session-terminal-lock-${name}`,
        branch_id: `branch-terminal-lock-${name}`,
      });
      store.discard(draft.id, {
        idempotency_key: `discard-terminal-lock-${name}`,
        expected_revision: draft.revision,
      });
      const lockPath = path.join(tempDir, "voice-drafts", draft.id, "meta.lock");
      let encoded = contents;
      if (name === "unknown-field") {
        const parsed = JSON.parse(contents);
        parsed.label = draft.id;
        encoded = `${JSON.stringify(parsed)}\n`;
      }
      fs.writeFileSync(lockPath, encoded);
      assert.throws(() => store.get(draft.id), expected);
      assert.equal(fs.readFileSync(lockPath, "utf8"), encoded);
      assert.throws(
        () => createVoiceDraftStore({ dataDir: tempDir, lockStaleMs: 60_000 }),
        /recent incomplete lock|operation lock exceeds/,
      );
      assert.equal(fs.readFileSync(lockPath, "utf8"), encoded);
    });
  }
});

test("an unexpected artifact created after the cleanup marker preserves all evidence", () => {
  withTempDir("physical-during-cleanup", (tempDir) => {
    let lateArtifact = "";
    const store = createVoiceDraftStore({
      dataDir: tempDir,
      testHooks: {
        afterCleanupMarkerWrite({ draftId }) {
          lateArtifact = path.join(tempDir, "voice-drafts", draftId, "late-transcript.backup");
          fs.writeFileSync(lateArtifact, "late private evidence");
        },
      },
    });
    const draft = createDraft(store, { session_id: "session-late", branch_id: "branch-late" });
    store.appendSegment(draft.id, {
      segment_id: "segment-late",
      bytes: pcm(1, 2),
      duration_ms: 10,
      partial_transcript: "late transcript",
      expected_revision: draft.revision,
    });
    const audioPath = path.join(tempDir, "voice-drafts", draft.id, "audio.pcm");
    const audioBefore = fs.readFileSync(audioPath);
    assert.throws(() => store.discard(draft.id, {
      idempotency_key: "discard-late",
      expected_revision: store.get(draft.id).revision,
    }), /unexpected files/);
    const metaPath = draftMetaPath(tempDir, draft.id);
    const metadataAfterMarker = fs.readFileSync(metaPath, "utf8");
    assert.ok(readJson(metaPath).cleanup_pending);
    assert.deepEqual(fs.readFileSync(audioPath), audioBefore);
    assert.equal(fs.readFileSync(lateArtifact, "utf8"), "late private evidence");
    assert.throws(() => createVoiceDraftStore({ dataDir: tempDir }), /unexpected files/);
    assert.equal(fs.readFileSync(metaPath, "utf8"), metadataAfterMarker);
    assert.deepEqual(fs.readFileSync(audioPath), audioBefore);
    assert.equal(fs.readFileSync(lateArtifact, "utf8"), "late private evidence");
  });
});

test("metadata corruption injected after the cleanup marker is not overwritten", () => {
  withTempDir("metadata-during-cleanup", (tempDir) => {
    let corruptedMetadata = "";
    const store = createVoiceDraftStore({
      dataDir: tempDir,
      testHooks: {
        afterCleanupMarkerWrite({ draftId }) {
          const metaPath = draftMetaPath(tempDir, draftId);
          const meta = readJson(metaPath);
          meta.unknown_transcript_after_marker = "preserve this evidence";
          corruptedMetadata = writeJson(metaPath, meta);
        },
      },
    });
    const draft = createDraft(store, { session_id: "session-meta-race", branch_id: "branch-meta-race" });
    store.appendSegment(draft.id, {
      segment_id: "segment-meta-race",
      bytes: pcm(1, 2),
      duration_ms: 10,
      expected_revision: draft.revision,
    });
    const audioPath = path.join(tempDir, "voice-drafts", draft.id, "audio.pcm");
    const audioBefore = fs.readFileSync(audioPath);
    assert.throws(() => store.discard(draft.id, {
      idempotency_key: "discard-meta-race",
      expected_revision: store.get(draft.id).revision,
    }), /unknown fields/);
    const metaPath = draftMetaPath(tempDir, draft.id);
    assert.equal(fs.readFileSync(metaPath, "utf8"), corruptedMetadata);
    assert.deepEqual(fs.readFileSync(audioPath), audioBefore);
    assert.throws(() => createVoiceDraftStore({ dataDir: tempDir }), /unknown fields/);
    assert.equal(fs.readFileSync(metaPath, "utf8"), corruptedMetadata);
    assert.deepEqual(fs.readFileSync(audioPath), audioBefore);
  });
});

test("audio handles use immutable verified snapshots across digest, inode, directory, and cleanup races", async () => {
  await withTempDirAsync("audio-snapshot-digest", async (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const draft = createDraft(store, { session_id: "session-snapshot", branch_id: "branch-snapshot" });
    const original = pcm(1, 2);
    store.appendSegment(draft.id, {
      segment_id: "segment-snapshot",
      bytes: original,
      duration_ms: 10,
      expected_revision: draft.revision,
    });
    store.transition(draft.id, {
      action: "park",
      idempotency_key: "park-snapshot",
      expected_revision: store.get(draft.id).revision,
    });
    const handle = store.readAudio(draft.id);
    fs.writeFileSync(handle.path, pcm(9, 8));
    assert.throws(() => handle.readBuffer(), /digest changed/);
    assert.throws(() => handle.createReadStream(), /digest changed/);
  });

  await withTempDirAsync("audio-snapshot-inode", async (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const draft = createDraft(store, { session_id: "session-inode", branch_id: "branch-inode" });
    const original = pcm(3, 4);
    store.appendSegment(draft.id, {
      segment_id: "segment-inode",
      bytes: original,
      duration_ms: 10,
      expected_revision: draft.revision,
    });
    store.transition(draft.id, {
      action: "park",
      idempotency_key: "park-inode",
      expected_revision: store.get(draft.id).revision,
    });
    const handle = store.readAudio(draft.id);
    const oldPath = path.join(tempDir, "old-inode.pcm");
    fs.renameSync(handle.path, oldPath);
    fs.writeFileSync(handle.path, original);
    assert.throws(() => handle.readBuffer(), /inode changed/);
    assert.throws(() => handle.createReadStream(), /inode changed/);
  });

  for (const mode of ["buffer", "stream"]) {
    await withTempDirAsync(`audio-snapshot-cleanup-${mode}`, async (tempDir) => {
      let store;
      let draft;
      let cleanupOnce = true;
      store = createVoiceDraftStore({
        dataDir: tempDir,
        testHooks: {
          afterAudioSnapshotReadBeforeVerify() {
            if (!cleanupOnce) return;
            cleanupOnce = false;
            store.discard(draft.id, {
              idempotency_key: `discard-snapshot-${mode}`,
              expected_revision: store.get(draft.id).revision,
            });
          },
        },
      });
      draft = createDraft(store, {
        session_id: `session-cleanup-${mode}`,
        branch_id: `branch-cleanup-${mode}`,
      });
      store.appendSegment(draft.id, {
        segment_id: `segment-cleanup-${mode}`,
        bytes: pcm(5, 6),
        duration_ms: 10,
        expected_revision: draft.revision,
      });
      store.transition(draft.id, {
        action: "park",
        idempotency_key: `park-cleanup-${mode}`,
        expected_revision: store.get(draft.id).revision,
      });
      const handle = store.readAudio(draft.id);
      assert.throws(
        () => (mode === "buffer" ? handle.readBuffer() : handle.createReadStream()),
        /unavailable|path changed|directory boundary changed/,
      );
      assert.equal(store.get(draft.id).state, "discarded");
    });
  }

  await withTempDirAsync("audio-snapshot-lifetime", async (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const draft = createDraft(store, { session_id: "session-lifetime", branch_id: "branch-lifetime" });
    const original = pcm(7, 8);
    store.appendSegment(draft.id, {
      segment_id: "segment-lifetime",
      bytes: original,
      duration_ms: 10,
      expected_revision: draft.revision,
    });
    store.transition(draft.id, {
      action: "park",
      idempotency_key: "park-lifetime",
      expected_revision: store.get(draft.id).revision,
    });
    const stream = store.readAudio(draft.id).createReadStream();
    store.discard(draft.id, {
      idempotency_key: "discard-lifetime",
      expected_revision: store.get(draft.id).revision,
    });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), original);
  });
});

test("persisted sent replay authority is exact, unique, and revision-bound", () => {
  const corruptions = [
    ["claim-extra", (meta) => { meta.claim.unknown = "secret"; }, /unknown fields/],
    ["claim-request-extra", (meta) => { meta.claim_request.unknown = "secret"; }, /unknown fields/],
    ["sent-receipt-extra", (meta) => { meta.sent_receipt.unknown = "secret"; }, /unknown fields/],
    ["sent-request-extra", (meta) => { meta.sent_request.unknown = "secret"; }, /unknown fields/],
    ["ready-receipt-extra", (meta) => { meta.send_ready_receipt.unknown = "secret"; }, /unknown fields/],
    ["ready-audio-extra", (meta) => { meta.send_ready_receipt.audio.unknown = "secret"; }, /unknown fields/],
    ["tombstone-extra", (meta) => { meta.tombstone.unknown = "secret"; }, /unknown fields/],
    ["duplicate-history", (meta) => {
      meta.transition_history.push(JSON.parse(JSON.stringify(meta.transition_history.at(-1))));
    }, /duplicate idempotency hashes/],
    ["forged-reordered-history", (meta) => {
      const forged = JSON.parse(JSON.stringify(meta.transition_history.at(-1)));
      forged.request.actor.id = "mallory";
      forged.receipt.actor.id = "mallory";
      meta.transition_history.unshift(forged);
    }, /duplicate idempotency hashes|state chain is contradictory|revisions are not strictly increasing/],
    ["sent-request-revision", (meta) => {
      meta.sent_request.expected_revision += 100;
    }, /request authority disagrees|revision authority is contradictory/],
    ["history-request-revision", (meta) => {
      meta.transition_history.at(-1).request.expected_revision += 100;
    }, /request authority disagrees|revision authority is contradictory|revision exceeds the draft revision/],
    ["history-nonmonotonic-revision", (meta) => {
      meta.transition_history[1].request.expected_revision = meta.transition_history[0].request.expected_revision;
    }, /revisions are not strictly increasing/],
    ["claim-request-revision", (meta) => {
      meta.claim_request.expected_revision += 100;
    }, /revision authority is contradictory/],
    ["draft-revision", (meta) => { meta.revision += 100; }, /revision authority is contradictory/],
    ["claim-turn", (meta) => {
      meta.claim.turn_id = "turn-forged";
      meta.claim_request.turn_id = "turn-forged";
    }, /claim disagrees with turn_id/],
    ["sent-turn", (meta) => {
      meta.sent_receipt.turn_id = "turn-forged";
      meta.sent_request.turn_id = "turn-forged";
    }, /claim disagrees with turn_id|request authority disagrees/],
  ];
  for (const [name, corrupt, expected] of corruptions) {
    withTempDir(`sent-authority-${name}`, (tempDir) => {
      const fixture = createSentFixture(tempDir, name);
      const meta = readJson(fixture.metaPath);
      corrupt(meta);
      const corrupted = writeJson(fixture.metaPath, meta);
      assert.throws(() => createVoiceDraftStore({ dataDir: tempDir }), expected);
      assert.equal(fs.readFileSync(fixture.metaPath, "utf8"), corrupted);
    });
  }
});

test("markSent rejects non-string and noncanonical sent_at values before mutation", () => {
  withTempDir("strict-sent-at", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const draft = createDraft(store, { session_id: "session-time", branch_id: "branch-time" });
    store.appendSegment(draft.id, {
      segment_id: "segment-time",
      bytes: pcm(1, 2),
      duration_ms: 10,
      expected_revision: draft.revision,
    });
    transitionToSendReady(store, draft.id);
    store.claimForTurn(draft.id, {
      session_id: "session-time",
      branch_id: "branch-time",
      turn_id: "turn-time",
      expected_revision: store.get(draft.id).revision,
    });
    const root = path.join(tempDir, "voice-drafts");
    for (const [index, sentAt] of [
      123,
      {},
      [],
      true,
      false,
      null,
      "",
      "not-a-time",
      "2026-07-11",
      "2026-07-11T00:00:00Z",
    ].entries()) {
      assertOperationLeavesTreeUnchanged(root, () => store.markSent(draft.id, {
        receipt_id: `sent-invalid-time-${index}`,
        session_id: "session-time",
        branch_id: "branch-time",
        turn_id: "turn-time",
        sent_at: sentAt,
        expected_revision: store.get(draft.id).revision,
      }), /canonical string timestamp/);
    }
    const receipt = store.markSent(draft.id, {
      receipt_id: "sent-valid-time",
      session_id: "session-time",
      branch_id: "branch-time",
      turn_id: "turn-time",
      sent_at: "2026-07-11T00:00:00.000Z",
      expected_revision: store.get(draft.id).revision,
    });
    assert.equal(receipt.sent_at, "2026-07-11T00:00:00.000Z");
  });
});

test("compacted sent and discarded authority rejects single and jointly coherent tampering", () => {
  const sentCorruptions = [
    ["request-revision", (record) => { record.terminal_request.expected_revision += 100; }],
    ["turn-pair", (record) => {
      record.terminal_request.turn_id = "turn-forged";
      record.terminal_receipt.turn_id = "turn-forged";
    }],
    ["joint-turn-authority", (record) => {
      record.terminal_request.turn_id = "turn-forged-joint";
      record.terminal_receipt.turn_id = "turn-forged-joint";
      record.terminal_history.request.turn_id = "turn-forged-joint";
      record.claim.turn_id = "turn-forged-joint";
      record.claim_request.turn_id = "turn-forged-joint";
    }],
    ["final-anchor", (record) => { record.final_mutation_anchor.draft_revision += 1; }],
  ];
  for (const [name, corrupt] of sentCorruptions) {
    withTempDir(`expired-sent-tamper-${name}`, (tempDir) => {
      const fixture = createCompactedSentFixture(tempDir, name);
      const index = readJson(fixture.indexPath);
      corrupt(index.records_by_draft[fixture.draft.id]);
      const corrupted = writeJson(fixture.indexPath, index);
      assert.throws(
        () => fixture.store.get(fixture.draft.id),
        /expired|decision|authority|claim|mutation|revision|digest/,
      );
      assert.equal(fs.readFileSync(fixture.indexPath, "utf8"), corrupted);
      assert.throws(
        () => createVoiceDraftStore(fixture.options),
        /expired|decision|authority|claim|mutation|revision|digest/,
      );
      assert.equal(fs.readFileSync(fixture.indexPath, "utf8"), corrupted);
    });
  }

  const discardCorruptions = [
    ["request-revision", (record) => { record.terminal_request.expected_revision += 100; }],
    ["joint-revision", (record) => {
      record.terminal_request.expected_revision += 100;
      record.terminal_history.request.expected_revision += 100;
      record.final_revision += 100;
      record.final_mutation_anchor.previous_revision += 100;
      record.final_mutation_anchor.draft_revision += 100;
    }],
    ["joint-actor", (record) => {
      record.terminal_request.actor.id = "forged-actor";
      record.terminal_receipt.actor.id = "forged-actor";
      record.terminal_history.request.actor.id = "forged-actor";
      record.terminal_history.receipt.actor.id = "forged-actor";
    }],
  ];
  for (const [name, corrupt] of discardCorruptions) {
    withTempDir(`expired-discard-tamper-${name}`, (tempDir) => {
      const fixture = createCompactedDiscardFixture(tempDir, name);
      const index = readJson(fixture.indexPath);
      corrupt(index.records_by_draft[fixture.draft.id]);
      const corrupted = writeJson(fixture.indexPath, index);
      assert.throws(
        () => fixture.store.get(fixture.draft.id),
        /expired|decision|authority|mutation|revision|digest/,
      );
      assert.equal(fs.readFileSync(fixture.indexPath, "utf8"), corrupted);
      assert.throws(
        () => createVoiceDraftStore(fixture.options),
        /expired|decision|authority|mutation|revision|digest/,
      );
      assert.equal(fs.readFileSync(fixture.indexPath, "utf8"), corrupted);
    });
  }
});

test("nonterminal mutation anchors close state, revision, claim, segment, recovery, and truncated-history chains", () => {
  for (const [name, corrupt] of [
    ["paused-revision", (meta) => { meta.revision += 100; }],
    ["paused-state", (meta) => { meta.state = "capturing"; }],
  ]) {
    withTempDir(`anchor-${name}`, (tempDir) => {
      const store = createVoiceDraftStore({ dataDir: tempDir });
      const draft = createDraft(store, { session_id: `session-${name}`, branch_id: `branch-${name}` });
      store.transition(draft.id, {
        action: "pause",
        idempotency_key: `pause-${name}`,
        expected_revision: draft.revision,
      });
      const metaPath = draftMetaPath(tempDir, draft.id);
      const meta = readJson(metaPath);
      corrupt(meta);
      const corrupted = writeJson(metaPath, meta);
      assert.throws(() => createVoiceDraftStore({ dataDir: tempDir }), /mutation anchor|latest transition/);
      assert.equal(fs.readFileSync(metaPath, "utf8"), corrupted);
    });
  }

  withTempDir("anchor-segment-revision", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const draft = createDraft(store, { session_id: "session-segment-anchor", branch_id: "branch-segment-anchor" });
    store.appendSegment(draft.id, {
      segment_id: "segment-anchor",
      bytes: pcm(1, 2),
      duration_ms: 10,
      expected_revision: draft.revision,
    });
    const metaPath = draftMetaPath(tempDir, draft.id);
    const meta = readJson(metaPath);
    meta.segments[0].append_request.expected_revision += 1;
    const corrupted = writeJson(metaPath, meta);
    assert.throws(() => createVoiceDraftStore({ dataDir: tempDir }), /segment revision|mutation predecessors|mutation anchor/);
    assert.equal(fs.readFileSync(metaPath, "utf8"), corrupted);
  });

  withTempDir("anchor-claim-revision", (tempDir) => {
    const store = createVoiceDraftStore({ dataDir: tempDir });
    const draft = createDraft(store, { session_id: "session-claim-anchor", branch_id: "branch-claim-anchor" });
    store.appendSegment(draft.id, {
      segment_id: "segment-claim-anchor",
      bytes: pcm(1, 2),
      duration_ms: 10,
      expected_revision: draft.revision,
    });
    transitionToSendReady(store, draft.id);
    store.claimForTurn(draft.id, {
      session_id: "session-claim-anchor",
      branch_id: "branch-claim-anchor",
      turn_id: "turn-claim-anchor",
      expected_revision: store.get(draft.id).revision,
    });
    const metaPath = draftMetaPath(tempDir, draft.id);
    const meta = readJson(metaPath);
    meta.claim_request.expected_revision = 1;
    const corrupted = writeJson(metaPath, meta);
    assert.throws(() => createVoiceDraftStore({ dataDir: tempDir }), /claim revision|claim mutation anchor/);
    assert.equal(fs.readFileSync(metaPath, "utf8"), corrupted);
  });

  withTempDir("anchor-recovery-revision", (tempDir) => {
    let store = createVoiceDraftStore({ dataDir: tempDir });
    const draft = createDraft(store, { session_id: "session-recovery-anchor", branch_id: "branch-recovery-anchor" });
    fs.rmSync(path.join(tempDir, "voice-drafts", "capture.lock"));
    store = createVoiceDraftStore({ dataDir: tempDir });
    assert.equal(store.get(draft.id).state, "parked");
    const metaPath = draftMetaPath(tempDir, draft.id);
    const meta = readJson(metaPath);
    meta.recovery_receipt.expected_revision += 1;
    const corrupted = writeJson(metaPath, meta);
    assert.throws(
      () => createVoiceDraftStore({ dataDir: tempDir }),
      /recovery receipt|recovery history|mutation anchor|terminal park/,
    );
    assert.equal(fs.readFileSync(metaPath, "utf8"), corrupted);
  });

  withTempDir("anchor-truncated-history", (tempDir) => {
    const options = { dataDir: tempDir, maxTransitionHistory: 2 };
    const store = createVoiceDraftStore(options);
    const draft = createDraft(store, { session_id: "session-truncated", branch_id: "branch-truncated" });
    for (let index = 0; index < 6; index += 1) {
      const current = store.get(draft.id);
      store.transition(draft.id, {
        action: current.state === "capturing" ? "pause" : "resume",
        idempotency_key: `truncated-${index}`,
        expected_revision: current.revision,
      });
    }
    const metaPath = draftMetaPath(tempDir, draft.id);
    const meta = readJson(metaPath);
    meta.transition_history.pop();
    const corrupted = writeJson(metaPath, meta);
    assert.throws(() => createVoiceDraftStore(options), /latest transition|transition mutation anchor/);
    assert.equal(fs.readFileSync(metaPath, "utf8"), corrupted);
  });
});

test("orphan recovery has a dedicated decision slot at exact user idempotency capacity", () => {
  withTempDir("recovery-dedicated-capacity", (tempDir) => {
    const options = { dataDir: tempDir, maxActionKeyHashes: 2, maxTransitionHistory: 8 };
    let store = createVoiceDraftStore(options);
    const draft = createDraft(store, { session_id: "session-recovery-cap", branch_id: "branch-recovery-cap" });
    store.transition(draft.id, {
      action: "pause",
      idempotency_key: "user-cap-1",
      expected_revision: draft.revision,
    });
    store.transition(draft.id, {
      action: "resume",
      idempotency_key: "user-cap-2",
      expected_revision: store.get(draft.id).revision,
    });
    fs.rmSync(path.join(tempDir, "voice-drafts", "capture.lock"));
    store = createVoiceDraftStore(options);
    const recovered = store.get(draft.id);
    assert.equal(recovered.state, "parked");
    assert.equal(recovered.used_action_key_hashes.length, 2);
    assert.match(recovered.recovery_receipt.idempotency_key, /^recovery-park:/);
    const recoveryReceipt = JSON.parse(JSON.stringify(recovered.recovery_receipt));
    const revision = recovered.revision;
    store = createVoiceDraftStore(options);
    assert.deepEqual(store.get(draft.id).recovery_receipt, recoveryReceipt);
    assert.equal(store.get(draft.id).revision, revision);
    assert.throws(() => store.transition(draft.id, {
      action: "resume",
      idempotency_key: "user-cap-3",
      expected_revision: revision,
    }), /idempotency capacity exceeded/);
    assert.throws(() => store.transition(draft.id, {
      action: "resume",
      idempotency_key: recovered.recovery_receipt.idempotency_key,
      expected_revision: revision,
    }), /reserved for system recovery/);
  });
});

test("owner-file parent durability failures clean exact store and capture owners", () => {
  for (const [name, failDirectorySyncNumber] of [["store", 1], ["capture", 2]]) {
    withTempDir(`owner-fsync-${name}`, (tempDir) => {
      const store = createVoiceDraftStore({ dataDir: tempDir });
      const originalFsync = fs.fsyncSync;
      let directorySyncs = 0;
      fs.fsyncSync = (fd) => {
        if (fs.fstatSync(fd).isDirectory() && ++directorySyncs === failDirectorySyncNumber) {
          throw new Error(`injected ${name} owner directory fsync failure`);
        }
        return originalFsync(fd);
      };
      try {
        assert.throws(() => store.create({
          idempotency_key: `create-owner-fsync-${name}`,
          session_id: `session-owner-fsync-${name}`,
          branch_id: `branch-owner-fsync-${name}`,
        }), /directory could not be synchronized/);
      } finally {
        fs.fsyncSync = originalFsync;
      }
      const draftsDir = path.join(tempDir, "voice-drafts");
      assert.equal(fs.existsSync(path.join(draftsDir, "store.lock")), false);
      assert.equal(fs.existsSync(path.join(draftsDir, "capture.lock")), false);
      const retry = store.create({
        idempotency_key: `create-owner-fsync-retry-${name}`,
        session_id: `session-owner-fsync-retry-${name}`,
        branch_id: `branch-owner-fsync-retry-${name}`,
      });
      store.transition(retry.id, {
        action: "park",
        idempotency_key: `park-owner-fsync-retry-${name}`,
        expected_revision: retry.revision,
      });
      const restarted = createVoiceDraftStore({ dataDir: tempDir });
      assert.equal(restarted.get(retry.id).state, "parked");
    });
  }
});

test("bounded keyed replay index applies exact count and metadata-byte backpressure", () => {
  withTempDir("replay-index-count-cap", (tempDir) => {
    const options = {
      dataDir: tempDir,
      maxDrafts: 1,
      maxTerminalDrafts: 1,
      maxExpiredReplayRecords: 2,
    };
    let store = createVoiceDraftStore(options);
    const commands = [];
    for (let index = 0; index < 3; index += 1) {
      const command = {
        idempotency_key: `create-index-count-${index}`,
        session_id: `session-index-count-${index}`,
        branch_id: `branch-index-count-${index}`,
      };
      commands.push(command);
      const draft = store.create(command);
      store.discard(draft.id, {
        idempotency_key: `discard-index-count-${index}`,
        expected_revision: draft.revision,
      });
    }
    const draftsDir = path.join(tempDir, "voice-drafts");
    const status = store.status();
    assert.equal(status.count, 3);
    assert.equal(status.full_record_count, 1);
    assert.equal(status.expired_replay_count, 2);
    assert.equal(status.replay_index.record_count, 2);
    assert.equal(
      status.replay_index.metadata_bytes,
      fs.statSync(path.join(draftsDir, "expired-replay-index.json")).size,
    );
    assert.equal(
      fs.readdirSync(draftsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length,
      1,
    );
    const treeBeforeBackpressure = snapshotTree(draftsDir);
    assert.throws(() => store.create({
      idempotency_key: "create-index-count-over-cap",
      session_id: "session-index-count-over-cap",
      branch_id: "branch-index-count-over-cap",
    }), /replay authority capacity exceeded/);
    assert.deepEqual(snapshotTree(draftsDir), treeBeforeBackpressure);
    assert.throws(
      () => store.create(commands[0]),
      (error) => error.statusCode === 410 && error.code === "voice_draft_replay_expired",
    );
    store = createVoiceDraftStore(options);
    assert.equal(store.status().expired_replay_count, 2);
    assert.throws(
      () => store.create(commands[0]),
      (error) => error.statusCode === 410 && error.code === "voice_draft_replay_expired",
    );
  });

  withTempDir("replay-index-byte-cap", (tempDir) => {
    const options = {
      dataDir: tempDir,
      maxDrafts: 1,
      maxTerminalDrafts: 1,
      maxExpiredReplayRecords: 20,
      maxReplayIndexBytes: 75_000,
      maxActionKeyHashes: 2,
    };
    const store = createVoiceDraftStore(options);
    let admitted = 0;
    let backpressure = null;
    for (let index = 0; index < 20; index += 1) {
      try {
        const draft = store.create({
          idempotency_key: `create-index-bytes-${index}`,
          session_id: `session-index-bytes-${index}`,
          branch_id: `branch-index-bytes-${index}`,
        });
        store.discard(draft.id, {
          idempotency_key: `discard-index-bytes-${index}`,
          expected_revision: draft.revision,
        });
        admitted += 1;
      } catch (error) {
        backpressure = error;
        break;
      }
    }
    assert.ok(admitted >= 2 && admitted < 20);
    assert.equal(backpressure?.statusCode, 507);
    assert.match(backpressure?.message || "", /replay metadata byte capacity exceeded/);
    const status = store.status();
    assert.ok(status.replay_index.metadata_bytes <= options.maxReplayIndexBytes);
    assert.ok(status.replay_index.admission_reserved_bytes <= options.maxReplayIndexBytes);
    assert.equal(status.expired_replay_count, admitted - 1);
    assert.equal(
      fs.readdirSync(path.join(tempDir, "voice-drafts"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).length,
      1,
    );
  });
});

test("replay-index-first compaction recovers an interrupted full-record removal", () => {
  withTempDir("replay-index-compaction-crash", (tempDir) => {
    let stopOnce = true;
    const options = {
      dataDir: tempDir,
      maxDrafts: 1,
      maxTerminalDrafts: 1,
      testHooks: {
        afterReplayIndexWriteBeforeDraftRemoval() {
          if (!stopOnce) return;
          stopOnce = false;
          throw new Error("stop-after-replay-index-write");
        },
      },
    };
    const store = createVoiceDraftStore(options);
    const firstCommand = {
      idempotency_key: "create-index-crash-first",
      session_id: "session-index-crash-first",
      branch_id: "branch-index-crash-first",
    };
    const first = store.create(firstCommand);
    store.discard(first.id, {
      idempotency_key: "discard-index-crash-first",
      expected_revision: first.revision,
    });
    const second = store.create({
      idempotency_key: "create-index-crash-second",
      session_id: "session-index-crash-second",
      branch_id: "branch-index-crash-second",
    });
    assert.throws(() => store.discard(second.id, {
      idempotency_key: "discard-index-crash-second",
      expected_revision: second.revision,
    }), /stop-after-replay-index-write/);
    assert.equal(fs.existsSync(draftMetaPath(tempDir, first.id)), true);
    assert.equal(store.get(first.id).kind, "voice_draft_expired_replay");
    assert.throws(
      () => store.create(firstCommand),
      (error) => error.statusCode === 410 && error.code === "voice_draft_replay_expired",
    );
    const restarted = createVoiceDraftStore({
      dataDir: tempDir,
      maxDrafts: 1,
      maxTerminalDrafts: 1,
    });
    assert.equal(fs.existsSync(path.join(tempDir, "voice-drafts", first.id)), false);
    assert.equal(restarted.get(first.id).kind, "voice_draft_expired_replay");
    assert.equal(restarted.get(second.id).state, "discarded");
  });
});

test("global mutation authority rejects cross-family predecessor reordering", () => {
  withTempDir("global-mutation-order", (tempDir) => {
    const options = { dataDir: tempDir };
    const store = createVoiceDraftStore(options);
    const draft = createDraft(store, {
      session_id: "session-global-order",
      branch_id: "branch-global-order",
    });
    store.appendSegment(draft.id, {
      segment_id: "segment-global-order",
      bytes: pcm(1, 2),
      duration_ms: 10,
      expected_revision: draft.revision,
    });
    store.transition(draft.id, {
      action: "pause",
      idempotency_key: "pause-global-order",
      expected_revision: store.get(draft.id).revision,
    });
    store.transition(draft.id, {
      action: "resume",
      idempotency_key: "resume-global-order",
      expected_revision: store.get(draft.id).revision,
    });
    const metaPath = draftMetaPath(tempDir, draft.id);
    const meta = readJson(metaPath);
    meta.segments[0].append_request.expected_revision = 2;
    meta.transition_history[0].request.expected_revision = 1;
    const corrupted = writeJson(metaPath, meta);
    assert.throws(
      () => store.get(draft.id),
      /global mutation chain|authority chain|segment authority|latest authority/,
    );
    assert.throws(
      () => createVoiceDraftStore(options),
      /global mutation chain|authority chain|segment authority|latest authority/,
    );
    assert.equal(fs.readFileSync(metaPath, "utf8"), corrupted);
  });
});

test("create roots and evicted user action hashes remain immutable after later mutations", () => {
  withTempDir("immutable-create-root", (tempDir) => {
    const options = { dataDir: tempDir };
    const command = {
      idempotency_key: "create-root-original",
      session_id: "session-root-original",
      branch_id: "branch-root-original",
    };
    const store = createVoiceDraftStore(options);
    const draft = store.create(command);
    store.transition(draft.id, {
      action: "park",
      idempotency_key: "park-root-original",
      expected_revision: draft.revision,
    });
    const metaPath = draftMetaPath(tempDir, draft.id);
    const meta = readJson(metaPath);
    meta.create_request.idempotency_key = "create-root-forged";
    const corrupted = writeJson(metaPath, meta);
    assert.throws(() => store.create(command), /create authority root|latest authority chain evidence/);
    assert.throws(() => createVoiceDraftStore(options), /create authority root|latest authority chain evidence/);
    assert.equal(fs.readFileSync(metaPath, "utf8"), corrupted);
    assert.equal(fs.readdirSync(path.join(tempDir, "voice-drafts"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).length, 1);
  });

  for (const [name, mutate] of [
    ["remove", (hashes) => hashes.slice(1)],
    ["replace", (hashes) => ["f".repeat(64), ...hashes.slice(1)]],
  ]) {
    withTempDir(`immutable-action-hash-${name}`, (tempDir) => {
      const options = { dataDir: tempDir, maxTransitionHistory: 1, maxActionKeyHashes: 4 };
      const store = createVoiceDraftStore(options);
      const draft = createDraft(store, {
        session_id: `session-action-hash-${name}`,
        branch_id: `branch-action-hash-${name}`,
      });
      store.transition(draft.id, {
        action: "pause",
        idempotency_key: `evicted-action-${name}`,
        expected_revision: draft.revision,
      });
      store.transition(draft.id, {
        action: "resume",
        idempotency_key: `retained-action-${name}`,
        expected_revision: store.get(draft.id).revision,
      });
      const metaPath = draftMetaPath(tempDir, draft.id);
      const meta = readJson(metaPath);
      meta.used_action_key_hashes = mutate(meta.used_action_key_hashes);
      const corrupted = writeJson(metaPath, meta);
      assert.throws(
        () => createVoiceDraftStore(options),
        /action-key authority|latest authority chain evidence/,
      );
      assert.equal(fs.readFileSync(metaPath, "utf8"), corrupted);
    });
  }
});

test("transcript, segment, and discarded content evidence stays bound to mutation authority", () => {
  for (const mode of ["create", "append"]) {
    withTempDir(`bound-transcript-${mode}`, (tempDir) => {
      const options = { dataDir: tempDir };
      const store = createVoiceDraftStore(options);
      const draft = store.create({
        idempotency_key: `create-bound-transcript-${mode}`,
        session_id: `session-bound-transcript-${mode}`,
        branch_id: `branch-bound-transcript-${mode}`,
        partial_transcript: "canonical transcript",
      });
      if (mode === "append") {
        store.appendSegment(draft.id, {
          segment_id: "segment-bound-transcript",
          bytes: pcm(1, 2),
          duration_ms: 10,
          partial_transcript: "latest canonical transcript",
          expected_revision: draft.revision,
        });
        store.transition(draft.id, {
          action: "pause",
          idempotency_key: "pause-bound-transcript",
          expected_revision: store.get(draft.id).revision,
        });
      }
      const metaPath = draftMetaPath(tempDir, draft.id);
      const meta = readJson(metaPath);
      meta.partial_transcript = "forged private content";
      meta.partial_transcript_updated_at = "2030-01-01T00:00:00.000Z";
      const corrupted = writeJson(metaPath, meta);
      assert.throws(() => createVoiceDraftStore(options), /latest authority chain evidence/);
      assert.equal(fs.readFileSync(metaPath, "utf8"), corrupted);
    });
  }

  withTempDir("bound-segment-digest", (tempDir) => {
    const options = { dataDir: tempDir };
    const store = createVoiceDraftStore(options);
    const draft = createDraft(store, {
      session_id: "session-bound-segment",
      branch_id: "branch-bound-segment",
    });
    store.appendSegment(draft.id, {
      segment_id: "segment-bound-digest",
      bytes: pcm(1, 2),
      duration_ms: 10,
      expected_revision: draft.revision,
    });
    store.transition(draft.id, {
      action: "pause",
      idempotency_key: "pause-bound-segment",
      expected_revision: store.get(draft.id).revision,
    });
    const metaPath = draftMetaPath(tempDir, draft.id);
    const meta = readJson(metaPath);
    const forged = crypto.createHash("sha256").update("not-the-pcm").digest("hex");
    meta.segments[0].sha256 = forged;
    meta.segments[0].append_request.sha256 = forged;
    const corrupted = writeJson(metaPath, meta);
    assert.throws(
      () => createVoiceDraftStore(options),
      /segment authority|latest authority chain evidence|PCM digest mismatch/,
    );
    assert.equal(fs.readFileSync(metaPath, "utf8"), corrupted);
  });

  withTempDir("bound-discard-tombstone", (tempDir) => {
    const options = { dataDir: tempDir };
    const store = createVoiceDraftStore(options);
    const draft = createDraft(store, {
      session_id: "session-bound-tombstone",
      branch_id: "branch-bound-tombstone",
    });
    store.appendSegment(draft.id, {
      segment_id: "segment-bound-tombstone",
      bytes: pcm(1, 2),
      duration_ms: 10,
      expected_revision: draft.revision,
    });
    store.discard(draft.id, {
      idempotency_key: "discard-bound-tombstone",
      expected_revision: store.get(draft.id).revision,
    });
    const metaPath = draftMetaPath(tempDir, draft.id);
    const meta = readJson(metaPath);
    meta.tombstone.audio_bytes_discarded = 0;
    meta.tombstone.duration_ms_discarded = 0;
    meta.tombstone.segment_count_discarded = 0;
    const corrupted = writeJson(metaPath, meta);
    assert.throws(
      () => createVoiceDraftStore(options),
      /tombstone disagrees|segment authority count|latest authority chain evidence/,
    );
    assert.equal(fs.readFileSync(metaPath, "utf8"), corrupted);
  });
});

test("the store root rejects and preserves unaccounted physical artifacts", () => {
  withTempDir("exact-store-root", (tempDir) => {
    const options = { dataDir: tempDir, maxTotalBytes: 2 };
    const store = createVoiceDraftStore(options);
    const draft = createDraft(store, {
      session_id: "session-exact-root",
      branch_id: "branch-exact-root",
    });
    store.transition(draft.id, {
      action: "park",
      idempotency_key: "park-exact-root",
      expected_revision: draft.revision,
    });
    const healthy = store.status();
    assert.ok(healthy.physical_storage.total_bytes >= healthy.metadata_bytes);
    const artifact = path.join(tempDir, "voice-drafts", "orphan-recording.pcm");
    const bytes = Buffer.alloc(1024 * 1024, 7);
    fs.writeFileSync(artifact, bytes);
    assert.throws(() => store.status(), /unexpected root file/);
    assert.throws(() => createVoiceDraftStore(options), /unexpected root file/);
    assert.deepEqual(fs.readFileSync(artifact), bytes);
  });

  withTempDir("exact-store-root-symlink", (tempDir) => {
    const options = { dataDir: tempDir };
    createVoiceDraftStore(options);
    const outside = path.join(tempDir, "outside-root-evidence");
    fs.writeFileSync(outside, "outside evidence");
    const link = path.join(tempDir, "voice-drafts", "forbidden-root-link");
    fs.symlinkSync(outside, link);
    assert.throws(() => createVoiceDraftStore(options), /forbidden symlink/);
    assert.equal(fs.readFileSync(outside, "utf8"), "outside evidence");
    assert.equal(fs.readlinkSync(link), outside);
  });
});

test("replay-index parsing rejects duplicate textual draft and create-hash members in either order", () => {
  for (const order of ["forged-first", "forged-last"]) {
    withTempDir(`duplicate-index-members-${order}`, (tempDir) => {
      const fixture = createCompactedDiscardFixture(tempDir, order);
      const index = readJson(fixture.indexPath);
      const [draftId, record] = Object.entries(index.records_by_draft)[0];
      const [createHash, mappedDraft] = Object.entries(index.draft_by_create_hash)[0];
      const validRecord = JSON.stringify(record);
      const forgedRecord = JSON.stringify({ forged: true });
      const validDraft = JSON.stringify(mappedDraft);
      const forgedDraft = JSON.stringify("draft_forged_duplicate");
      const records = order === "forged-first"
        ? `${JSON.stringify(draftId)}:${forgedRecord},${JSON.stringify(draftId)}:${validRecord}`
        : `${JSON.stringify(draftId)}:${validRecord},${JSON.stringify(draftId)}:${forgedRecord}`;
      const createMap = order === "forged-first"
        ? `${JSON.stringify(createHash)}:${forgedDraft},${JSON.stringify(createHash)}:${validDraft}`
        : `${JSON.stringify(createHash)}:${validDraft},${JSON.stringify(createHash)}:${forgedDraft}`;
      const ambiguous = `${JSON.stringify({
        kind: index.kind,
        store_revision: index.store_revision,
        state_machine_revision: index.state_machine_revision,
        revision: index.revision,
      }).slice(0, -1)},"records_by_draft":{${records}},"draft_by_create_hash":{${createMap}}}\n`;
      fs.writeFileSync(fixture.indexPath, ambiguous);
      assert.throws(() => fixture.store.get(draftId), /duplicate JSON object member/);
      assert.throws(() => createVoiceDraftStore(fixture.options), /duplicate JSON object member/);
      assert.equal(fs.readFileSync(fixture.indexPath, "utf8"), ambiguous);
    });
  }
});

test("post-rename parent-fsync ambiguity reconciles every metadata class and lease in process", () => {
  function faultController() {
    return {
      enabled: false,
      label: "voice draft metadata",
      occurrence: 1,
      seen: 0,
      persistent: false,
      beforeAtomicParentFsync({ label }) {
        if (!this.enabled || label !== this.label) return;
        this.seen += 1;
        if (this.seen === this.occurrence) throw new Error(`injected ${label} parent fsync ambiguity`);
      },
      beforeAtomicParentFsyncReconcile({ label }) {
        if (this.enabled && this.persistent && label === this.label) {
          throw new Error(`injected persistent ${label} parent fsync ambiguity`);
        }
      },
      arm(label = "voice draft metadata", occurrence = 1, persistent = false) {
        this.label = label;
        this.occurrence = occurrence;
        this.seen = 0;
        this.persistent = persistent;
        this.enabled = true;
      },
      disarm() {
        this.enabled = false;
      },
    };
  }

  for (const action of ["pause", "park", "send_ready", "discard"]) {
    withTempDir(`atomic-transition-${action}`, (tempDir) => {
      const hooks = faultController();
      const store = createVoiceDraftStore({ dataDir: tempDir, testHooks: hooks });
      const draft = createDraft(store, {
        session_id: `session-atomic-${action}`,
        branch_id: `branch-atomic-${action}`,
      });
      if (action === "send_ready" || action === "discard") {
        store.appendSegment(draft.id, {
          segment_id: `segment-atomic-${action}`,
          bytes: pcm(1, 2),
          duration_ms: 10,
          expected_revision: draft.revision,
        });
      }
      hooks.arm();
      const receipt = store.transition(draft.id, {
        action,
        idempotency_key: `${action}-atomic`,
        expected_revision: store.get(draft.id).revision,
      });
      hooks.disarm();
      assert.equal(receipt.state_after, action === "discard" ? "discarded" : action === "send_ready" ? "send_ready" : action === "pause" ? "paused" : "parked");
      assert.equal(
        fs.existsSync(path.join(tempDir, "voice-drafts", "capture.lock")),
        action === "pause",
      );
      createVoiceDraftStore({ dataDir: tempDir });
    });
  }

  withTempDir("atomic-resume", (tempDir) => {
    const hooks = faultController();
    const store = createVoiceDraftStore({ dataDir: tempDir, testHooks: hooks });
    const draft = createDraft(store, { session_id: "session-atomic-resume", branch_id: "branch-atomic-resume" });
    store.transition(draft.id, { action: "park", idempotency_key: "park-before-atomic-resume", expected_revision: draft.revision });
    hooks.arm();
    store.transition(draft.id, { action: "resume", idempotency_key: "resume-atomic", expected_revision: store.get(draft.id).revision });
    hooks.disarm();
    assert.equal(store.get(draft.id).state, "capturing");
    assert.equal(fs.existsSync(path.join(tempDir, "voice-drafts", "capture.lock")), true);
    store.appendSegment(draft.id, { segment_id: "segment-after-atomic-resume", bytes: pcm(1), duration_ms: 1, expected_revision: store.get(draft.id).revision });
  });

  withTempDir("atomic-claim-sent-cleanup", (tempDir) => {
    const hooks = faultController();
    const store = createVoiceDraftStore({ dataDir: tempDir, testHooks: hooks });
    const draft = createDraft(store, { session_id: "session-atomic-send", branch_id: "branch-atomic-send" });
    store.appendSegment(draft.id, { segment_id: "segment-atomic-send", bytes: pcm(1, 2), duration_ms: 10, expected_revision: draft.revision });
    transitionToSendReady(store, draft.id);
    hooks.arm();
    store.claimForTurn(draft.id, { session_id: "session-atomic-send", branch_id: "branch-atomic-send", turn_id: "turn-atomic-send", expected_revision: store.get(draft.id).revision });
    hooks.disarm();
    hooks.arm("voice draft metadata", 2);
    store.markSent(draft.id, { receipt_id: "sent-atomic", session_id: "session-atomic-send", branch_id: "branch-atomic-send", turn_id: "turn-atomic-send", expected_revision: store.get(draft.id).revision });
    hooks.disarm();
    assert.equal(store.get(draft.id).state, "sent");
    assert.equal(store.get(draft.id).cleanup_pending, null);
  });

  withTempDir("atomic-mark-sent-marker", (tempDir) => {
    const hooks = faultController();
    const store = createVoiceDraftStore({ dataDir: tempDir, testHooks: hooks });
    const draft = createDraft(store, { session_id: "session-atomic-marker", branch_id: "branch-atomic-marker" });
    store.appendSegment(draft.id, { segment_id: "segment-atomic-marker", bytes: pcm(1), duration_ms: 1, expected_revision: draft.revision });
    transitionToSendReady(store, draft.id);
    store.claimForTurn(draft.id, { session_id: "session-atomic-marker", branch_id: "branch-atomic-marker", turn_id: "turn-atomic-marker", expected_revision: store.get(draft.id).revision });
    hooks.arm("voice draft metadata", 1);
    store.markSent(draft.id, { receipt_id: "sent-atomic-marker", session_id: "session-atomic-marker", branch_id: "branch-atomic-marker", turn_id: "turn-atomic-marker", expected_revision: store.get(draft.id).revision });
    hooks.disarm();
    assert.equal(store.get(draft.id).state, "sent");
    assert.equal(store.get(draft.id).cleanup_pending, null);
  });

  withTempDir("atomic-index", (tempDir) => {
    const hooks = faultController();
    const options = { dataDir: tempDir, maxDrafts: 1, maxTerminalDrafts: 1, testHooks: hooks };
    const store = createVoiceDraftStore(options);
    const first = store.create({ idempotency_key: "create-atomic-index-a", session_id: "session-atomic-index-a", branch_id: "branch-atomic-index-a" });
    store.discard(first.id, { idempotency_key: "discard-atomic-index-a", expected_revision: first.revision });
    const second = store.create({ idempotency_key: "create-atomic-index-b", session_id: "session-atomic-index-b", branch_id: "branch-atomic-index-b" });
    hooks.arm("voice draft expired replay index");
    store.discard(second.id, { idempotency_key: "discard-atomic-index-b", expected_revision: second.revision });
    hooks.disarm();
    assert.equal(store.get(first.id).kind, "voice_draft_expired_replay");
    assert.equal(fs.existsSync(path.join(tempDir, "voice-drafts", first.id)), false);
  });

  withTempDir("atomic-persistent-cleanup", (tempDir) => {
    const hooks = faultController();
    const store = createVoiceDraftStore({ dataDir: tempDir, testHooks: hooks });
    const draft = createDraft(store, { session_id: "session-persistent-cleanup", branch_id: "branch-persistent-cleanup" });
    store.appendSegment(draft.id, { segment_id: "segment-persistent-cleanup", bytes: pcm(1), duration_ms: 1, expected_revision: draft.revision });
    const revision = store.get(draft.id).revision;
    hooks.arm("voice draft metadata", 2, true);
    assert.throws(
      () => store.discard(draft.id, { idempotency_key: "discard-persistent-cleanup", expected_revision: revision }),
      (error) => error.code === "voice_draft_publication_durability_unknown",
    );
    hooks.disarm();
    const replay = store.discard(draft.id, { idempotency_key: "discard-persistent-cleanup", expected_revision: revision });
    assert.equal(replay.state_after, "discarded");
    assert.equal(store.get(draft.id).cleanup_pending, null);
    assert.equal(fs.existsSync(path.join(tempDir, "voice-drafts", draft.id, "audio.pcm")), false);
  });

  withTempDir("atomic-persistent-index", (tempDir) => {
    const hooks = faultController();
    const options = { dataDir: tempDir, maxDrafts: 1, maxTerminalDrafts: 1, testHooks: hooks };
    const store = createVoiceDraftStore(options);
    const first = store.create({ idempotency_key: "create-persistent-index-a", session_id: "session-persistent-index-a", branch_id: "branch-persistent-index-a" });
    store.discard(first.id, { idempotency_key: "discard-persistent-index-a", expected_revision: first.revision });
    const second = store.create({ idempotency_key: "create-persistent-index-b", session_id: "session-persistent-index-b", branch_id: "branch-persistent-index-b" });
    hooks.arm("voice draft expired replay index", 1, true);
    assert.throws(
      () => store.discard(second.id, { idempotency_key: "discard-persistent-index-b", expected_revision: second.revision }),
      (error) => error.code === "voice_draft_publication_durability_unknown",
    );
    hooks.disarm();
    assert.equal(store.get(first.id).kind, "voice_draft_expired_replay");
    const third = store.create({ idempotency_key: "create-persistent-index-c", session_id: "session-persistent-index-c", branch_id: "branch-persistent-index-c" });
    assert.equal(third.state, "capturing");
    assert.equal(fs.existsSync(path.join(tempDir, "voice-drafts", first.id)), false);
  });

  for (const action of ["park", "resume"]) {
    withTempDir(`atomic-persistent-${action}`, (tempDir) => {
      const hooks = faultController();
      const store = createVoiceDraftStore({ dataDir: tempDir, testHooks: hooks });
      const draft = createDraft(store, { session_id: `session-persistent-${action}`, branch_id: `branch-persistent-${action}` });
      if (action === "resume") {
        store.transition(draft.id, { action: "park", idempotency_key: "park-before-persistent-resume", expected_revision: draft.revision });
      }
      const revision = store.get(draft.id).revision;
      hooks.arm("voice draft metadata", 1, true);
      assert.throws(
        () => store.transition(draft.id, { action, idempotency_key: `${action}-persistent`, expected_revision: revision }),
        (error) => error.code === "voice_draft_publication_durability_unknown",
      );
      hooks.disarm();
      const replay = store.transition(draft.id, { action, idempotency_key: `${action}-persistent`, expected_revision: revision });
      assert.equal(replay.state_after, action === "park" ? "parked" : "capturing");
      if (action === "park") {
        const next = store.create({ idempotency_key: "create-after-persistent-park", session_id: "session-after-persistent-park", branch_id: "branch-after-persistent-park" });
        assert.equal(next.state, "capturing");
      } else {
        store.appendSegment(draft.id, { segment_id: "segment-after-persistent-resume", bytes: pcm(1), duration_ms: 1, expected_revision: store.get(draft.id).revision });
      }
    });
  }
});

test("async mirror rejections do not fail storage mutations or leak unhandled rejections", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-voice-drafts-mirror-"));
  const rejections = [];
  const onUnhandled = (reason) => {
    rejections.push(reason);
  };
  process.once("unhandledRejection", onUnhandled);
  try {
    const store = createVoiceDraftStore({
      dataDir: tempDir,
      mirrorEvent() {
        return Promise.reject(new Error("mirror failed"));
      },
    });
    const draft = createDraft(store, { session_id: "session-m", branch_id: "branch-m" });
    store.appendSegment(draft.id, {
      segment_id: "seg-1",
      bytes: pcm(1, 2),
      duration_ms: 10,
      expected_revision: draft.revision,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rejections.length, 0);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function createPersistedLimitFixture(tempDir, name) {
  const store = createVoiceDraftStore({ dataDir: tempDir });
  const draft = createDraft(store, {
    session_id: `session-limit-${name}`,
    branch_id: `branch-limit-${name}`,
    partial_transcript: "persisted transcript over ten characters",
  });
  store.appendSegment(draft.id, {
    segment_id: `segment-limit-${name}-1`,
    bytes: pcm(1, 2),
    duration_ms: 10,
    expected_revision: draft.revision,
  });
  store.appendSegment(draft.id, {
    segment_id: `segment-limit-${name}-2`,
    bytes: pcm(3, 4),
    duration_ms: 10,
    expected_revision: store.get(draft.id).revision,
  });
  store.transition(draft.id, {
    action: "pause",
    idempotency_key: `pause-limit-${name}`,
    expected_revision: store.get(draft.id).revision,
  });
  store.transition(draft.id, {
    action: "resume",
    idempotency_key: `resume-limit-${name}`,
    expected_revision: store.get(draft.id).revision,
  });
  store.transition(draft.id, {
    action: "park",
    idempotency_key: `park-limit-${name}`,
    expected_revision: store.get(draft.id).revision,
  });
  return { draft, metaPath: draftMetaPath(tempDir, draft.id) };
}

function createSentFixture(tempDir, name) {
  const store = createVoiceDraftStore({ dataDir: tempDir });
  const draft = createDraft(store, {
    session_id: `session-sent-${name}`,
    branch_id: `branch-sent-${name}`,
    source: "android",
    surface: "overlay",
    release_id: `release-sent-${name}`,
    release_version: "1.0.0",
  });
  store.appendSegment(draft.id, {
    segment_id: `segment-sent-${name}`,
    bytes: pcm(1, 2),
    duration_ms: 10,
    expected_revision: draft.revision,
  });
  transitionToSendReady(store, draft.id);
  store.claimForTurn(draft.id, {
    session_id: `session-sent-${name}`,
    branch_id: `branch-sent-${name}`,
    turn_id: `turn-sent-${name}`,
    expected_revision: store.get(draft.id).revision,
  });
  store.markSent(draft.id, {
    receipt_id: `receipt-sent-${name}`,
    session_id: `session-sent-${name}`,
    branch_id: `branch-sent-${name}`,
    turn_id: `turn-sent-${name}`,
    source: "android",
    surface: "overlay",
    release_id: `release-sent-${name}`,
    release_version: "1.0.0",
    sent_at: "2026-07-11T00:00:00.000Z",
    expected_revision: store.get(draft.id).revision,
  });
  return { store, draft, metaPath: draftMetaPath(tempDir, draft.id) };
}

function createCompactedSentFixture(tempDir, name, extraOptions = {}) {
  const options = {
    dataDir: tempDir,
    maxDrafts: 1,
    maxTerminalDrafts: 1,
    ...extraOptions,
  };
  const store = createVoiceDraftStore(options);
  const sessionId = `session-expired-sent-${name}`;
  const branchId = `branch-expired-sent-${name}`;
  const draft = store.create({
    idempotency_key: `create-expired-sent-${name}`,
    session_id: sessionId,
    branch_id: branchId,
    source: "android",
    surface: "overlay",
    release_id: `release-expired-sent-${name}`,
    release_version: "1.0.0",
  });
  store.appendSegment(draft.id, {
    segment_id: `segment-expired-sent-${name}`,
    bytes: pcm(1, 2),
    duration_ms: 10,
    expected_revision: draft.revision,
  });
  transitionToSendReady(store, draft.id);
  store.claimForTurn(draft.id, {
    session_id: sessionId,
    branch_id: branchId,
    turn_id: `turn-expired-sent-${name}`,
    expected_revision: store.get(draft.id).revision,
  });
  store.markSent(draft.id, {
    receipt_id: `receipt-expired-sent-${name}`,
    session_id: sessionId,
    branch_id: branchId,
    turn_id: `turn-expired-sent-${name}`,
    source: "android",
    surface: "overlay",
    release_id: `release-expired-sent-${name}`,
    release_version: "1.0.0",
    sent_at: "2026-07-11T00:00:00.000Z",
    expected_revision: store.get(draft.id).revision,
  });
  const trigger = store.create({
    idempotency_key: `create-expired-sent-trigger-${name}`,
    session_id: `session-expired-sent-trigger-${name}`,
    branch_id: `branch-expired-sent-trigger-${name}`,
  });
  store.discard(trigger.id, {
    idempotency_key: `discard-expired-sent-trigger-${name}`,
    expected_revision: trigger.revision,
  });
  return {
    store,
    draft,
    options,
    indexPath: path.join(tempDir, "voice-drafts", "expired-replay-index.json"),
  };
}

function createCompactedDiscardFixture(tempDir, name, extraOptions = {}) {
  const options = {
    dataDir: tempDir,
    maxDrafts: 1,
    maxTerminalDrafts: 1,
    ...extraOptions,
  };
  const store = createVoiceDraftStore(options);
  const draft = store.create({
    idempotency_key: `create-expired-discard-${name}`,
    session_id: `session-expired-discard-${name}`,
    branch_id: `branch-expired-discard-${name}`,
  });
  store.discard(draft.id, {
    idempotency_key: `discard-expired-discard-${name}`,
    expected_revision: draft.revision,
  });
  const trigger = store.create({
    idempotency_key: `create-expired-discard-trigger-${name}`,
    session_id: `session-expired-discard-trigger-${name}`,
    branch_id: `branch-expired-discard-trigger-${name}`,
  });
  store.discard(trigger.id, {
    idempotency_key: `discard-expired-discard-trigger-${name}`,
    expected_revision: trigger.revision,
  });
  return {
    store,
    draft,
    options,
    indexPath: path.join(tempDir, "voice-drafts", "expired-replay-index.json"),
  };
}

function installUnexpectedArtifact(draftDir, kind, tempDir) {
  const artifactPath = path.join(draftDir, "transcript.backup");
  if (kind === "file") {
    fs.writeFileSync(artifactPath, "private evidence");
    return { path: artifactPath, outsidePath: "" };
  }
  if (kind === "directory") {
    fs.mkdirSync(artifactPath);
    fs.writeFileSync(path.join(artifactPath, "content"), "private evidence");
    return { path: artifactPath, outsidePath: "" };
  }
  const outsidePath = path.join(tempDir, "outside-evidence.txt");
  fs.writeFileSync(outsidePath, "outside evidence");
  fs.symlinkSync(outsidePath, artifactPath);
  return { path: artifactPath, outsidePath };
}

function draftMetaPath(tempDir, draftId) {
  return path.join(tempDir, "voice-drafts", draftId, "meta.json");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(filePath, encoded);
  return encoded;
}

function assertOperationLeavesTreeUnchanged(root, operation, expected) {
  const before = snapshotTree(root);
  assert.throws(operation, expected);
  assert.deepEqual(snapshotTree(root), before);
}

function snapshotTree(root) {
  if (!fs.existsSync(root)) return null;
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) {
    return { type: "symlink", target: fs.readlinkSync(root) };
  }
  if (stat.isDirectory()) {
    const entries = {};
    for (const name of fs.readdirSync(root).sort()) {
      entries[name] = snapshotTree(path.join(root, name));
    }
    return { type: "directory", entries };
  }
  return {
    type: stat.isFile() ? "file" : "other",
    bytes: fs.readFileSync(root).toString("base64"),
  };
}

function transitionToSendReady(store, draftId) {
  let current = store.get(draftId);
  if (current.state === "capturing") {
    store.transition(draftId, {
      action: "pause",
      idempotency_key: `pause-${current.revision}`,
      expected_revision: current.revision,
    });
    current = store.get(draftId);
  }
  if (current.state === "paused") {
    store.transition(draftId, {
      action: "send_ready",
      idempotency_key: `ready-${current.revision}`,
      expected_revision: current.revision,
    });
  }
  return store.get(draftId);
}

function createDraft(store, input) {
  const branch = String(input.branch_id || input.branchId || "draft")
    .replace(/[^A-Za-z0-9._:-]/g, "-")
    .slice(0, 100);
  return store.create({
    idempotency_key: `create-${branch}`,
    ...input,
  });
}

function pcm(...samples) {
  return Buffer.from(samples.flatMap((sample) => [sample, 0]));
}

function withTempDir(prefix, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `moa-voice-drafts-${prefix}-`));
  try {
    fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function withTempDirAsync(prefix, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `moa-voice-drafts-${prefix}-`));
  try {
    await fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
