#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const AUDIO_DIR = path.resolve(process.argv[2] || "");
const MODEL = process.argv[3] || "gemini-3.5-flash";
const PROMPT_MODE = process.argv[4] || "strict";
const LOCATION = process.env.VERTEX_LOCATION || "global";
const PROJECT = process.env.VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || gcloudProject();

if (!AUDIO_DIR || !fs.statSync(AUDIO_DIR).isDirectory()) {
  throw new Error("usage: eval-gemini-audio-understanding.mjs AUDIO_DIR [MODEL]");
}
if (!PROJECT) throw new Error("VERTEX_PROJECT or GOOGLE_CLOUD_PROJECT is required");

const token = await googleToken();
const endpoint = `https://${LOCATION === "global" ? "aiplatform.googleapis.com" : `${LOCATION}-aiplatform.googleapis.com`}/v1beta1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
const files = fs.readdirSync(AUDIO_DIR).filter((name) => name.endsWith(".pcm")).sort();
const results = [];

for (const file of files) {
  const pcm = fs.readFileSync(path.join(AUDIO_DIR, file));
  const started = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-goog-user-project": PROJECT,
      },
      body: JSON.stringify(requestBody(wavFromPcm16(pcm, 16000))),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0, 1000)}`);
    const text = (body?.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("").trim();
    results.push({
      id: path.basename(file, ".pcm"),
      audio_bytes: pcm.length,
      audio_sha256: sha256(pcm),
      status: "completed",
      duration_ms: Date.now() - started,
      output: parseJson(text),
      finish_reason: body?.candidates?.[0]?.finishReason || "",
      usage: body?.usageMetadata || {},
    });
  } catch (error) {
    results.push({
      id: path.basename(file, ".pcm"),
      audio_bytes: pcm.length,
      audio_sha256: sha256(pcm),
      status: "error",
      duration_ms: Date.now() - started,
      error: String(error?.message || error).replace(/[\r\n]+/g, " ").slice(0, 1200),
    });
  }
}

console.log(JSON.stringify({
  ok: results.every((result) => result.status === "completed"),
  evaluated_at: new Date().toISOString(),
  provider: "vertex",
  model: MODEL,
  prompt_mode: PROMPT_MODE,
  location: LOCATION,
  input_format: { encoding: "pcm16", sample_rate: 16000, channels: 1, transport: "audio/wav inlineData" },
  results,
}, null, 2));

function requestBody(wav) {
  return {
    contents: [{ role: "user", parts: [
      { text: transcriptionPrompt(PROMPT_MODE) },
      { inlineData: { mimeType: "audio/wav", data: wav.toString("base64") } },
    ] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 4096,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          transcript: { type: "STRING" },
          languages: { type: "ARRAY", items: { type: "STRING" } },
          segments: { type: "ARRAY", items: {
            type: "OBJECT",
            properties: {
              language: { type: "STRING" },
              script: { type: "STRING" },
              text: { type: "STRING" },
              uncertain: { type: "BOOLEAN" },
            },
            required: ["language", "script", "text", "uncertain"],
          } },
          notes: { type: "STRING" },
        },
        required: ["transcript", "languages", "segments", "notes"],
      },
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
}

function transcriptionPrompt(mode) {
  const common = [
    "Transcribe this audio verbatim. Do not translate it.",
    "Split the transcript whenever the spoken language changes.",
    "Return only the requested JSON. Mark uncertain spans instead of guessing.",
  ];
  if (mode === "minimal") return common.join(" ");
  if (mode === "bilingual") return [
    ...common,
    "The speaker may switch between Amharic and English within one utterance.",
  ].join(" ");
  if (mode !== "strict") throw new Error("prompt mode must be strict, bilingual, or minimal");
  return [
    ...common,
    "The speaker may switch between Amharic and English within one utterance.",
    "Write Amharic speech in Ethiopic (Ge'ez) script and English speech in Latin script.",
    "Do not substitute Hindi, Kannada, or another language when uncertain.",
  ].join(" ");
}

function wavFromPcm16(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function gcloudProject() {
  try {
    return execFileSync("gcloud", ["config", "get-value", "project"], {
      encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { return ""; }
}

async function googleToken() {
  const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || "";
  if (credentialPath && fs.existsSync(credentialPath)) {
    const credential = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
    if (credential.type === "service_account") {
      const now = Math.floor(Date.now() / 1000);
      const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
        iss: credential.client_email,
        scope: "https://www.googleapis.com/auth/cloud-platform",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      })}`;
      const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(credential.private_key).toString("base64url");
      return exchangeToken({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      });
    }
    return exchangeToken({
      grant_type: "refresh_token",
      client_id: credential.client_id,
      client_secret: credential.client_secret,
      refresh_token: credential.refresh_token,
    });
  }
  return execFileSync("gcloud", ["auth", "application-default", "print-access-token"], {
    encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

async function exchangeToken(parameters) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(parameters).toString(),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new Error(`Google token exchange failed: HTTP ${response.status}`);
  }
  return body.access_token;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return { raw: text }; }
}
