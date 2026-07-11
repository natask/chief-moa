(function installUiSpecRuntime(global) {
  "use strict";

  const ACTIONS = new Set(["voice.toggle", "command.open", "agent.run", "page.describe", "settings.open", "noop"]);
  const CONTROL_TYPES = new Set(["button", "text", "toggle", "select"]);
  const COMPONENT_TYPES = new Set(["card", "list", "map", "stat"]);

  function token(value) {
    return String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60);
  }
  function text(value, max = 160) {
    return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  }
  function action(value) {
    const candidate = String(value || "").trim();
    return ACTIONS.has(candidate) ? candidate : "noop";
  }
  function coordinate(value) {
    if (!value || typeof value !== "object") return null;
    const lat = Number(value.lat ?? value.latitude);
    const lng = Number(value.lng ?? value.lon ?? value.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng, label: text(value.label || value.name, 100) };
  }
  function control(value) {
    if (!value || typeof value !== "object") return null;
    const type = CONTROL_TYPES.has(value.type) ? value.type : "";
    const id = token(value.id);
    if (!type || !id) return null;
    const out = { type, id, label: text(value.label || id, 80), action: action(value.action), prompt: text(value.prompt, 500), value: text(value.value, 500), checked: value.checked === true };
    if (type === "select" && Array.isArray(value.options)) out.options = value.options.map((item) => text(item, 80)).filter(Boolean).slice(0, 50);
    return out;
  }
  function listItem(value) {
    if (!value || typeof value !== "object") return null;
    const label = text(value.label || value.title, 120);
    return label ? { label, detail: text(value.detail || value.body || value.text, 300), action: action(value.action), prompt: text(value.prompt, 500) } : null;
  }
  function marker(value) {
    const point = coordinate(value);
    return point ? { ...point, detail: text(value.detail || value.body, 220) } : null;
  }
  function component(value) {
    if (!value || typeof value !== "object") return null;
    const type = COMPONENT_TYPES.has(value.type) ? value.type : "";
    const id = token(value.id);
    if (!type || !id) return null;
    const base = { type, id, title: text(value.title, 100), tone: ["neutral", "good", "warn", "danger", "info"].includes(value.tone) ? value.tone : "neutral" };
    if (type === "card") return { ...base, body: text(value.body || value.text, 1200) };
    if (type === "stat") return { ...base, label: text(value.label || value.title || id, 80), value: text(value.value, 120), delta: text(value.delta, 120) };
    if (type === "list") {
      const items = Array.isArray(value.items) ? value.items.map(listItem).filter(Boolean).slice(0, 30) : [];
      return items.length ? { ...base, items } : null;
    }
    const markers = Array.isArray(value.markers) ? value.markers.map(marker).filter(Boolean).slice(0, 24) : [];
    const center = coordinate(value.center) || markers[0] || null;
    if (!center && !markers.length) return null;
    const zoom = Number(value.zoom);
    return { ...base, center, zoom: Number.isFinite(zoom) ? Math.max(1, Math.min(Math.round(zoom), 20)) : 12, markers };
  }
  function surface(value) {
    if (!value || typeof value !== "object") return null;
    const id = token(value.id);
    if (!id) return null;
    return { id, title: text(value.title || id, 80), components: Array.isArray(value.components) ? value.components.slice(0, 40).map(component).filter(Boolean) : [], controls: Array.isArray(value.controls) ? value.controls.slice(0, 40).map(control).filter(Boolean) : [] };
  }
  function sanitize(payload) {
    const source = payload?.payload && typeof payload.payload === "object" ? payload.payload : payload;
    const spec = source?.spec && typeof source.spec === "object" ? source.spec : source;
    if (!spec || typeof spec !== "object" || spec.version !== 1 || !Array.isArray(spec.surfaces)) return null;
    const surfaces = spec.surfaces.slice(0, 8).map(surface).filter(Boolean);
    let remaining = 80;
    for (const item of surfaces) {
      item.components = item.components.slice(0, remaining);
      remaining -= item.components.length;
      item.controls = item.controls.slice(0, remaining);
      remaining -= item.controls.length;
    }
    const normalized = surfaces.length ? { version: 1, isCustomized: source?.is_customized === true || source?.isCustomized === true, surfaces } : null;
    return normalized && JSON.stringify(normalized).length <= 131072 ? normalized : null;
  }
  function resolveAction(value, prompt, label, input = "") {
    const kind = action(value);
    const resolvedPrompt = text(String(prompt || "").replace(/\{value\}/g, text(input, 500)), 500);
    return { action: kind, prompt: resolvedPrompt || text(label || input, 500) };
  }

  global.AgeeUiSpecRuntime = Object.freeze({ sanitize, resolveAction });
})(globalThis);
