"use strict";

function createMediaNoteHandlers(deps) {
  const { authorized, sendJson, audioNoteHandlers, videoNoteHandlers } = deps;

  async function routeMediaNotes(request, response, url) {
    const path = url.pathname;
    const audioCollection = path === "/v1/audio-notes" && ["GET", "POST"].includes(request.method);
    const audioItem = ["GET", "DELETE"].includes(request.method) && path.startsWith("/v1/audio-notes/");
    const videoCollection = path === "/v1/video-notes" && ["GET", "POST"].includes(request.method);
    const videoItem = ["GET", "DELETE"].includes(request.method) && path.startsWith("/v1/video-notes/");
    if (!(audioCollection || audioItem || videoCollection || videoItem)) return false;
    if (!authorized(request)) {
      sendJson(response, 401, { error: "missing or invalid gateway token" });
      return true;
    }

    if (path.startsWith("/v1/audio-notes")) await routeAudio(request, response, url);
    else await routeVideo(request, response, url);
    return true;
  }

  async function routeAudio(request, response, url) {
    if (request.method === "POST") await audioNoteHandlers.create(request, response);
    else if (request.method === "DELETE") await audioNoteHandlers.remove(response, url);
    else if (url.pathname === "/v1/audio-notes") audioNoteHandlers.list(response, url);
    else if (url.pathname.endsWith("/audio")) await audioNoteHandlers.sendAudio(response, url);
    else audioNoteHandlers.get(response, url);
  }

  async function routeVideo(request, response, url) {
    if (request.method === "POST") await videoNoteHandlers.create(request, response);
    else if (request.method === "DELETE") await videoNoteHandlers.remove(response, url);
    else if (url.pathname === "/v1/video-notes") videoNoteHandlers.list(response, url);
    else if (url.pathname.endsWith("/video")) await videoNoteHandlers.sendVideo(response, url);
    else videoNoteHandlers.get(response, url);
  }

  return { routeMediaNotes, routeAudio, routeVideo };
}

module.exports = { createMediaNoteHandlers };
