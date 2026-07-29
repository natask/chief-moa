# Hackathon Project Page Draft

> Historical snapshot from 2026-06-20. This draft contains provider, storage,
> shortcut, and deployment claims that no longer describe the current product.
> Use [CORE_PRODUCT_INTENT.md](../../CORE_PRODUCT_INTENT.md) for product direction
> and [ARCHITECTURE.md](../../ARCHITECTURE.md) for the live system boundary.

## Project Story

### Inspiration

I wanted to build an assistant that actually does work, not just chat. Every voice assistant today is a conversation wrapper — you ask, it answers, then you're back to manual work. I wanted something that could take a real task, break it down, and execute it while keeping me in control.

The phone is the perfect control surface: it's always with you, has voice, touch, and screen context. But it shouldn't hold the keys or run the heavy automation. That belongs on a gateway machine. The phone proposes, the gateway executes, and the user approves.

### What I Learned

Trust boundaries matter more than features. If the phone holds raw API keys, it's a security hole. If the server can directly tap buttons on your screen, it's a security hole. The only safe model is: server proposes, phone approves, phone executes.

Async is the only way voice works. You speak, you want an immediate response, not a spinning wheel while an agent thinks for 30 seconds. The overlay shows run status immediately; the full app shows history and deep inspection.

Architecture survives when you write it down. OpenSpec, ARCHITECTURE.md, and AGENTS.md let any agent resume work without losing the product shape. Chat memory is not a durable substrate.

### How I Built It

**Android overlay**: A floating orb that you hold to speak. Release sends the turn. The overlay shows the transcript and short answers. It stays small — no scrollback, no settings, no history. That belongs in the full app.

**Gateway**: A Node.js server that routes voice turns, stores sessions/events, and launches agent runs. It uses Gemini Live for bundled STT+LLM+TTS, but can swap providers. It never sends raw API keys to the phone.

**Browser extension**: A thin Chrome client that mirrors the Android overlay pattern. Cmd/Ctrl+K to wake voice, Cmd/Ctrl+, for text. It sends turns to the gateway and receives answers or action proposals.

**Agent harness**: The gateway launches local CLI harnesses (Codex, Claude, Gemini) for build/fix/test work. Agent runs are observable from the phone — you see run ID, status, and completion without blocking the UI.

**Action runtime**: Phone-local actions (screen reading, taps, navigation) go through an approval broker. The gateway can propose actions, but the Android app checks capability manifests, risk, and current screen state before executing.

### Challenges Faced

**Trust boundary**: It's tempting to put routing logic on the phone for speed. But that leaks credentials. I had to enforce the boundary strictly: phone owns UI and permissions, gateway owns models and storage.

**Voice interruption**: When you start a new turn while the assistant is still responding, what happens? I decided to create new sessions/branches instead of merging. It's more complex but preserves history and makes interruption robust.

**Android recognition quality**: Android SpeechRecognizer is good but not perfect. I built the interaction to be robust with final-result preference and partial fallback, with a path to streaming STT later.

**OTA updates**: How do you push phone updates without remote control? The gateway serves signed APK artifacts, but Android downloads, verifies SHA-256, and opens the platform package installer for user approval. The phone remains the authority.

**Async observability**: Voice-started agent work must return immediately. The phone polls or subscribes for lifecycle updates. This required careful run state design and cancellation support.

## Built With

- **Android**: Native overlay, accessibility service, voice capture, local TTS, action broker
- **TypeScript/Node.js**: Gateway server, voice routing, agent harness orchestration
- **Chrome Extension**: Manifest V3 thin client with voice/text capture
- **Claude, Codex, Gemini**: Agent harnesses for code work and reasoning
- **Devin**: Agent orchestration and development workflow
- **Postgres**: Planned durable store for sessions, runs, approvals, receipts
- **WebSocket**: Real-time voice turn transport and lifecycle updates
- **LiteLLM**: Model provider aggregation and routing

## Try It Out

- **GitHub repo**: https://github.com/natstack/chief-moa
- **Demo**: Local gateway setup with Android APK or Chrome extension
