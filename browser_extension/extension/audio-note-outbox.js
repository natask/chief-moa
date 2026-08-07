const CONTENT_TYPE = "audio/L16; rate=16000; channels=1";
const DB_NAME = "agee-audio-note-outbox";
const STORE_NAME = "audio_notes";
const MAX_ITEM_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

function resultOf(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Local recording storage failed."));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Local recording storage failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Local recording storage was cancelled."));
  });
}

function copyBuffer(value) {
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  return new Uint8Array(value || []).buffer;
}

function metadata(record) {
  if (!record) return null;
  const { body: _body, ...rest } = record;
  return rest;
}

function createIndexedDbAudioNoteOutboxStorage(indexedDb = globalThis.indexedDB) {
  let databasePromise;
  function database() {
    if (!indexedDb) return Promise.reject(new Error("This browser cannot preserve recordings locally."));
    if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
      const request = indexedDb.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open local recording storage."));
      request.onblocked = () => reject(new Error("Local recording storage is blocked by another extension page."));
    });
    return databasePromise;
  }
  async function use(mode, operation) {
    const db = await database();
    const transaction = db.transaction(STORE_NAME, mode);
    const done = mode === "readwrite" ? transactionDone(transaction) : null;
    try {
      const value = await operation(transaction.objectStore(STORE_NAME));
      if (done) await done;
      return value;
    } catch (error) {
      if (done) await done.catch(() => {});
      throw error;
    }
  }
  return {
    async put(record) { await use("readwrite", (store) => resultOf(store.put(record))); },
    get(id) { return use("readonly", (store) => resultOf(store.get(id))); },
    async remove(id) { await use("readwrite", (store) => resultOf(store.delete(id))); },
    list() { return use("readonly", async (store) => (await resultOf(store.getAll())).map(metadata)); },
    async totalBytes() {
      return (await this.list()).reduce((sum, record) => sum + (Number(record.byte_length) || 0), 0);
    },
  };
}

function createMemoryAudioNoteOutboxStorage() {
  const records = new Map();
  return {
    async put(record) { records.set(record.id, { ...record, body: copyBuffer(record.body) }); },
    async get(id) {
      const record = records.get(id);
      return record ? { ...record, body: copyBuffer(record.body) } : undefined;
    },
    async remove(id) { records.delete(id); },
    async list() { return [...records.values()].map(metadata); },
    async totalBytes() { return [...records.values()].reduce((sum, record) => sum + record.byte_length, 0); },
  };
}

function errorText(error) {
  return String(error?.message || error || "Upload failed.").replace(/\s+/g, " ").trim().slice(0, 500);
}

function createAudioNoteOutbox(options = {}) {
  const storage = options.storage || createIndexedDbAudioNoteOutboxStorage();
  const fetchImpl = options.fetchImpl || globalThis.fetch?.bind(globalThis);
  const now = options.now || (() => new Date());
  const randomId = options.randomId || (() => crypto.randomUUID());
  const maxItemBytes = Number(options.maxItemBytes || MAX_ITEM_BYTES);
  const maxTotalBytes = Number(options.maxTotalBytes || MAX_TOTAL_BYTES);

  async function retain(input = {}) {
    const body = copyBuffer(input.bytes);
    if (!body.byteLength) throw new Error("No audio was captured.");
    if (body.byteLength > maxItemBytes) throw new Error("This recording is too large for local recovery storage.");
    if ((await storage.totalBytes()) + body.byteLength > maxTotalBytes) {
      throw new Error("Local recording storage is full. Retry or delete a pending voice note before recording another.");
    }
    const token = String(randomId()).replace(/[^a-z0-9_-]/gi, "").slice(0, 100);
    const record = {
      id: `audio-outbox:${token}`,
      created_at: now().toISOString(),
      content_type: CONTENT_TYPE,
      surface: String(input.surface || "agee-extension").slice(0, 80),
      session_id: String(input.sessionId || "").slice(0, 120),
      duration_ms: Math.max(0, Math.round(Number(input.durationMs) || 0)),
      byte_length: body.byteLength,
      body,
      attempts: 0,
      last_attempt_at: null,
      last_error: "",
      remote_note: null,
      uploaded_at: null,
    };
    await storage.put(record);
    return metadata(record);
  }

  async function list() {
    return (await storage.list()).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  async function discard(id) {
    await storage.remove(String(id || ""));
  }

  async function readBlob(id) {
    const record = await storage.get(String(id || ""));
    if (!record) throw new Error("The locally retained recording no longer exists.");
    return new Blob([record.body], { type: record.content_type });
  }

  async function upload(id, config = {}) {
    const record = await storage.get(String(id || ""));
    if (!record) throw new Error("The locally retained recording no longer exists.");
    if (record.remote_note) {
      await storage.remove(record.id);
      return { note: record.remote_note, recovered: true };
    }
    try {
      if (!fetchImpl) throw new Error("This browser cannot upload recordings.");
      if (!config.gatewayUrl) throw new Error("No gateway URL set. Open AG Options and set the Agent gateway URL.");
      const headers = {
        "content-type": record.content_type,
        "x-moa-surface": record.surface,
        "x-moa-session-id": record.session_id,
        "x-moa-duration-ms": String(record.duration_ms),
      };
      if (config.gatewayToken) headers.authorization = `Bearer ${config.gatewayToken}`;
      const response = await fetchImpl(`${String(config.gatewayUrl).replace(/\/+$/, "")}/v1/audio-notes`, {
        method: "POST", headers, body: record.body,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Gateway returned ${response.status}${text.trim() ? `: ${text.slice(0, 300)}` : ""}`);
      let payload = null;
      if (text.trim()) {
        try { payload = JSON.parse(text); } catch { payload = null; }
      }
      record.remote_note = payload?.note || payload || { stored: true };
      record.uploaded_at = now().toISOString();
      record.last_attempt_at = record.uploaded_at;
      record.last_error = "";
      record.attempts += 1;
      await storage.put(record);
      await storage.remove(record.id);
      return payload;
    } catch (error) {
      record.attempts += 1;
      record.last_attempt_at = now().toISOString();
      record.last_error = errorText(error);
      await storage.put(record);
      throw new Error(record.last_error);
    }
  }

  return { discard, list, readBlob, retain, upload };
}

export {
  CONTENT_TYPE,
  MAX_ITEM_BYTES,
  MAX_TOTAL_BYTES,
  createAudioNoteOutbox,
  createIndexedDbAudioNoteOutboxStorage,
  createMemoryAudioNoteOutboxStorage,
};
