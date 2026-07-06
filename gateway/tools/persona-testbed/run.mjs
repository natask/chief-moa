#!/usr/bin/env node
// Persona testbed CLI: send the SAME system-instruction stack + persona +
// probe questions to swappable middle models (the LLM leg of the cascaded
// voice pipeline). STT and TTS stay out of scope — text in, text out.
// Does NOT touch the live gateway. For the browser UI, run server.mjs.
//
// Usage:
//   node run.mjs                                   # default persona + probe suite, all configured models
//   node run.mjs --ask "Who created you?"          # single question
//   node run.mjs --persona personas/master-created.txt
//   node run.mjs --persona "You are a pirate."     # inline persona text also works
//   node run.mjs --models gemini,openai,grok,claude
//   node run.mjs --no-stack                        # persona only, skip the gateway stack
//
// Model overrides: --model-gemini, --model-openai, --model-grok, --model-claude

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROVIDERS, DEFAULT_PROBES, buildSystemInstruction, askProvider } from "./providers.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);

function parseArgs(argv) {
  const args = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-stack") { args.noStack = true; continue; }
    if (a.startsWith("--")) { args[a.slice(2)] = argv[++i]; continue; }
    args.positional.push(a);
  }
  return args;
}
const args = parseArgs(process.argv.slice(2));

function loadPersona(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  const asPath = path.isAbsolute(v) ? v : path.join(here, v);
  if (fs.existsSync(asPath)) return fs.readFileSync(asPath, "utf8").trim();
  if (fs.existsSync(v)) return fs.readFileSync(v, "utf8").trim();
  return v; // inline persona text
}

const persona = loadPersona(args.persona);
const systemInstruction = buildSystemInstruction(persona, { noStack: args.noStack });
const probes = args.ask ? [args.ask] : DEFAULT_PROBES;
const requested = (args.models ? args.models.split(",") : Object.keys(PROVIDERS)).map((m) => m.trim()).filter(Boolean);

const lines = [];
const say = (s) => { console.log(s); lines.push(s); };

say(`# Persona testbed run — ${new Date().toISOString()}`);
say(`stack: ${args.noStack ? "persona only (no gateway stack)" : "gateway stack + persona"}`);
say(`\n## System instruction persona layer\n\n${persona || "(default persona: personas/master-created.txt)"}\n`);

for (const name of requested) {
  const provider = PROVIDERS[name];
  if (!provider) { say(`\n## ${name}\n\nunknown provider (valid: ${Object.keys(PROVIDERS).join(", ")})`); continue; }
  if (!provider.configured()) { say(`\n## ${name}\n\nskipped — set ${provider.keyHint} to enable`); continue; }
  say(`\n## ${name}`);
  for (const question of probes) {
    try {
      const { model, text } = await askProvider(name, {
        question,
        systemInstruction,
        model: args[`model-${name}`] || "",
      });
      say(`\n**Q (${model}):** ${question}\n\n> ${text.replace(/\n/g, "\n> ")}`);
    } catch (error) {
      say(`\n**Q:** ${question}\n\n> ERROR: ${error.message}`);
    }
  }
}

// Save the transcript next to the script; fall back to the OS tmpdir when the
// script dir is not writable (e.g. a read-only bind mount in a container).
const resultsName = `results-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
for (const dir of [here, os.tmpdir()]) {
  try {
    const outFile = path.join(dir, resultsName);
    fs.writeFileSync(outFile, lines.join("\n") + "\n");
    console.log(`\nwrote ${outFile}`);
    break;
  } catch {
    // try the next location; the transcript was already printed to stdout
  }
}
