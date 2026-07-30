function topDocumentIdentity(frameTree) {
  const frame = frameTree?.frameTree?.frame || frameTree?.frame || null;
  if (!frame) return null;
  const frameId = String(frame.id || "");
  const loaderId = String(frame.loaderId || "");
  const url = String(frame.url || "");
  return frameId && loaderId ? { frameId, loaderId, url } : null;
}

function sameDocument(left, right) {
  return Boolean(left && right
    && left.frameId === right.frameId
    && left.loaderId === right.loaderId
    && left.url === right.url);
}

async function captureBoundTabJpeg(tabId, adapter = {}) {
  if (!Number.isInteger(tabId) || tabId < 0) return null;
  if (typeof adapter.attach !== "function"
    || typeof adapter.send !== "function"
    || typeof adapter.detach !== "function") return null;
  const target = Object.freeze({ tabId });
  let attached = false;
  try {
    await adapter.attach(target);
    attached = true;
    await adapter.send(target, "Page.enable");
    const before = topDocumentIdentity(await adapter.send(target, "Page.getFrameTree"));
    const shot = await adapter.send(target, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 45,
      fromSurface: true,
    });
    const after = topDocumentIdentity(await adapter.send(target, "Page.getFrameTree"));
    if (!sameDocument(before, after)) return null;
    const data = String(shot?.data || "");
    return data || null;
  } catch {
    return null;
  } finally {
    if (attached) await adapter.detach(target).catch(() => {});
  }
}

export { captureBoundTabJpeg, sameDocument, topDocumentIdentity };
