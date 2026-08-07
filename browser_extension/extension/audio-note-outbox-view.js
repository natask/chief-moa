import { audioNotePlaybackBlob, formatBytes, formatDuration } from "./audio-note-library.js";

function localTimestamp(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "time unavailable" : date.toLocaleString();
}

function renderAudioNoteOutbox(record, options) {
  const { outbox, getConfig, onChanged } = options;
  const card = document.createElement("article");
  card.className = "voice-note-card";
  card.dataset.outboxId = record.id;

  const title = document.createElement("div");
  title.className = "voice-note-title";
  title.textContent = "Pending voice note";

  const meta = document.createElement("div");
  meta.className = "voice-note-meta";
  meta.textContent = [
    localTimestamp(record.created_at),
    formatDuration(record.duration_ms),
    formatBytes(record.byte_length),
    "saved on this browser",
  ].join(" · ");

  const state = document.createElement("div");
  state.className = "voice-note-state";
  state.dataset.state = record.last_error ? "error" : "ready";
  state.textContent = record.remote_note
    ? "Uploaded · local cleanup pending"
    : record.last_error
      ? "Saved locally · upload failed"
      : "Saved locally · upload pending";

  const operation = document.createElement("div");
  operation.className = "voice-note-operation";
  operation.setAttribute("role", "status");
  operation.textContent = record.last_error || "The original PCM bytes are retained until upload succeeds or you delete them.";
  if (record.last_error) operation.dataset.state = "error";

  const actions = document.createElement("div");
  actions.className = "voice-note-actions";

  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = record.remote_note ? "Finish cleanup" : "Retry upload";
  retry.addEventListener("click", async () => {
    retry.disabled = true;
    operation.dataset.state = "ready";
    operation.textContent = record.remote_note ? "Removing the uploaded local recovery copy…" : "Uploading the retained original recording…";
    try {
      await outbox.upload(record.id, await getConfig());
      operation.textContent = "Upload complete. The gateway copy now owns this voice note.";
      await onChanged();
    } catch (error) {
      operation.dataset.state = "error";
      operation.textContent = `Retry failed; the original remains saved locally: ${String(error?.message || error)}`;
      retry.disabled = false;
    }
  });

  const play = document.createElement("button");
  play.type = "button";
  play.textContent = "Play local";
  play.addEventListener("click", async () => {
    play.disabled = true;
    try {
      const source = await outbox.readBlob(record.id);
      const playable = await audioNotePlaybackBlob({ content_type: source.type }, source);
      const url = URL.createObjectURL(playable);
      const player = document.createElement("audio");
      player.controls = true;
      player.autoplay = true;
      player.src = url;
      player.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
      const previous = card.querySelector("audio");
      if (previous) previous.replaceWith(player);
      else card.appendChild(player);
      operation.textContent = "Playing the locally retained original.";
      play.textContent = "Replay local";
    } catch (error) {
      operation.dataset.state = "error";
      operation.textContent = `Could not play the local copy: ${String(error?.message || error)}`;
    } finally {
      play.disabled = false;
    }
  });

  const download = document.createElement("button");
  download.type = "button";
  download.textContent = "Download local";
  download.addEventListener("click", async () => {
    download.disabled = true;
    try {
      const url = URL.createObjectURL(await outbox.readBlob(record.id));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `pending-voice-note-${record.id.slice(-12)}.pcm`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      operation.textContent = "Local recovery download started.";
    } catch (error) {
      operation.dataset.state = "error";
      operation.textContent = `Could not download the local copy: ${String(error?.message || error)}`;
    } finally {
      download.disabled = false;
    }
  });

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "delete";
  remove.textContent = "Delete local";
  remove.addEventListener("click", async () => {
    if (!confirm("Delete this locally retained recording? This cannot be undone.")) return;
    remove.disabled = true;
    try {
      await outbox.discard(record.id);
      await onChanged();
    } catch (error) {
      operation.dataset.state = "error";
      operation.textContent = `Could not delete the local copy: ${String(error?.message || error)}`;
      remove.disabled = false;
    }
  });

  actions.append(retry, play, download, remove);
  card.append(title, meta, state, operation, actions);
  return card;
}

export { renderAudioNoteOutbox };
