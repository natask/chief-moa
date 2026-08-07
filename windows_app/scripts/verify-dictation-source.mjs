import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const read = (path) => readFileSync(resolve(root, path), "utf8");
const protocol = read("Aggie.Windows/DictationState.cs");
const controller = read("Aggie.Windows/DictationController.cs");
const transport = read("Aggie.Windows/GatewayVoiceDraftTransport.cs");
const microphone = read("Aggie.Windows/Pcm16MicrophoneCapture.cs");
const pointer = read("Aggie.Windows/DraftPointerStore.cs");
const view = read("Aggie.Windows/MainWindow.xaml");

assert.match(protocol, /"source"\] = "moa-windows-dictation"/);
assert.match(protocol, /"delivery_intent"\] = "literal_dictation"/);
assert.match(protocol, /"transcription_only"\] = true/);
assert.match(protocol, /"voice_draft"\]/);
assert.match(protocol, /CreateControl\("|CreateControl\(string action/);
assert.match(protocol, /Assistant output is invalid on literal dictation/);
assert.match(controller, /microphone\.Stop\(\);\s*await DrainAudioAsync\(\);\s*await SendControlAsync\("pause"/s);
assert.match(controller, /SendControlAsync\("resume"/);
assert.match(controller, /CreateCommit\(pointer\)/);
assert.match(controller, /pointerStore\.Save/);
assert.match(transport, /WebSocketMessageType\.Binary/);
assert.match(transport, /Authorization/);
assert.match(microphone, /new WaveFormat\(16_000, 16, 1\)/);
assert.match(pointer, /DictationProtocol\.SerializePointer\(pointer\)/);
assert.match(pointer, /writer\.Write\(json\)/);
assert.match(pointer, /stream\.Flush\(true\)/);
for (const id of ["ag.dictation.start", "ag.dictation.cancel", "ag.dictation.pause", "ag.dictation.resume", "ag.dictation.finish", "ag.dictation.transcript"])
  assert.match(view, new RegExp(id.replaceAll(".", "\\.")));

console.log("Windows literal-dictation source contract passed");
