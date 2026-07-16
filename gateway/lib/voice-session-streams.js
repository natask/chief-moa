"use strict";

function abortSttStream(turn) {
  if (!turn || !turn.sttStream) return;
  const stream = turn.sttStream;
  turn.sttStream = null;
  try {
    stream.abort?.();
  } catch {
    // best effort: a streaming fault must not take the session down
  }
}

async function closeAudioStream(turn) {
  if (!turn.audioStream) return;
  const stream = turn.audioStream;
  turn.audioStream = null;
  await new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

async function commitLiveSession(turn) {
  turn.liveSession.commit();
  return turn.liveSession.done;
}

async function commitLiveTextSession(turn, text) {
  turn.liveSession.sendText(text);
  return turn.liveSession.done;
}

module.exports = {
  abortSttStream,
  closeAudioStream,
  commitLiveSession,
  commitLiveTextSession,
};
