# audio-note-capture Specification

## Purpose
TBD - created by archiving change record-mode-audio-notes. Update Purpose after archive.
## Requirements
### Requirement: Record mode stores audio without model processing

The browser and Android clients SHALL capture an explicit record-mode session
and upload its audio to gateway-owned durable storage without invoking STT, an
LLM, TTS, or agent routing.

#### Scenario: user records a note

- GIVEN the user starts and finishes record mode
- WHEN the client uploads the completed audio
- THEN the gateway stores authenticated bytes and queryable metadata
- AND no voice-session provider or model turn is created.

