(function installContentUiControllerRuntime(global) {
  "use strict";

  const root = global || globalThis;

  function createContentUiControllerRuntime(options) {
    const document = options.document;
    const uiSpecRuntime = options.uiSpecRuntime;
    const storageGet = options.storageGet;
    const sendMessage = options.sendMessage;
    const getRoot = options.getRoot;
    const getSurface = options.getSurface;
    const getInput = options.getInput;
    const anchorPanel = options.anchorPanel;
    const openSurface = options.openSurface;
    const setInputText = options.setInputText;
    const primeAudio = options.primeAudio;
    const toggleVoice = options.toggleVoice;
    const describePage = options.describePage;
    const submitInstruction = options.submitInstruction;
    const cacheKey = options.cacheKey || "ageeUiSpec";

    function loadUiSpec() {
      return storageGet({ [cacheKey]: null })
        .then((stored) => {
          const cached = stored?.[cacheKey];
          applyUiSpec(cached ? cached.payload || cached : null);
        })
        .catch(() => {});
    }

    function applyUiSpec(payload) {
      renderUiSpecSurface(uiSpecRuntime.sanitize(payload));
    }

    function renderUiSpecSurface(spec) {
      const surfaceElement = getSurface();
      const hostRoot = getRoot();
      if (!surfaceElement || !hostRoot) return;
      surfaceElement.replaceChildren();
      hostRoot.classList.remove("agee-has-ui-spec");
      if (!spec) return;
      const surface = spec.surfaces[0];
      if (!surface) return;
      const shouldRender = surface.components.length > 0 || spec.isCustomized;
      if (!shouldRender) return;

      const shell = document.createElement("section");
      shell.className = "agee-ui-shell";
      shell.dataset.surface = surface.id;

      if (surface.title) {
        const title = document.createElement("div");
        title.className = "agee-ui-title";
        title.textContent = surface.title;
        shell.appendChild(title);
      }

      if (surface.components.length) {
        const components = document.createElement("div");
        components.className = "agee-ui-components";
        for (const component of surface.components) {
          const node = renderUiComponent(component);
          if (node) components.appendChild(node);
        }
        if (components.children.length) shell.appendChild(components);
      }

      if (surface.controls.length) {
        const controls = document.createElement("div");
        controls.className = "agee-ui-controls";
        for (const control of surface.controls) {
          const node = renderUiControl(control);
          if (node) controls.appendChild(node);
        }
        if (controls.children.length) shell.appendChild(controls);
      }

      if (shell.children.length <= 1 && !surface.controls.length && !surface.components.length) return;
      surfaceElement.appendChild(shell);
      hostRoot.classList.add("agee-has-ui-spec");
      anchorPanel();
    }

    function renderUiComponent(component) {
      if (component.type === "card") {
        const card = document.createElement("article");
        card.className = `agee-ui-card agee-ui-tone-${component.tone}`;
        if (component.title) {
          const title = document.createElement("div");
          title.className = "agee-ui-card-title";
          title.textContent = component.title;
          card.appendChild(title);
        }
        if (component.body) {
          const body = document.createElement("div");
          body.className = "agee-ui-card-body";
          body.textContent = component.body;
          card.appendChild(body);
        }
        return card;
      }
      if (component.type === "stat") {
        const stat = document.createElement("div");
        stat.className = `agee-ui-stat agee-ui-tone-${component.tone}`;
        const label = document.createElement("div");
        label.className = "agee-ui-stat-label";
        label.textContent = component.label;
        const value = document.createElement("div");
        value.className = "agee-ui-stat-value";
        value.textContent = component.value || "-";
        stat.append(label, value);
        if (component.delta) {
          const delta = document.createElement("div");
          delta.className = "agee-ui-stat-delta";
          delta.textContent = component.delta;
          stat.appendChild(delta);
        }
        return stat;
      }
      if (component.type === "list") {
        const wrap = document.createElement("div");
        wrap.className = "agee-ui-list";
        if (component.title) {
          const title = document.createElement("div");
          title.className = "agee-ui-list-title";
          title.textContent = component.title;
          wrap.appendChild(title);
        }
        for (const item of component.items) {
          const row = document.createElement(item.action && item.action !== "noop" ? "button" : "div");
          row.className = "agee-ui-list-row";
          if (row.tagName === "BUTTON") row.type = "button";
          const label = document.createElement("span");
          label.className = "agee-ui-list-label";
          label.textContent = item.label;
          row.appendChild(label);
          if (item.detail) {
            const detail = document.createElement("span");
            detail.className = "agee-ui-list-detail";
            detail.textContent = item.detail;
            row.appendChild(detail);
          }
          if (row.tagName === "BUTTON") {
            row.addEventListener("click", (event) => {
              event.preventDefault();
              event.stopPropagation();
              runUiAction(item.action, item.prompt || item.label, item.label);
            });
          }
          wrap.appendChild(row);
        }
        return wrap;
      }
      if (component.type === "map") return renderUiMap(component);
      return null;
    }

    function renderUiMap(component) {
      const wrap = document.createElement("div");
      wrap.className = "agee-ui-map-card";
      if (component.title) {
        const title = document.createElement("div");
        title.className = "agee-ui-map-title";
        title.textContent = component.title;
        wrap.appendChild(title);
      }
      const map = document.createElement("div");
      map.className = "agee-ui-map";
      const markers = component.markers.length ? component.markers : [component.center].filter(Boolean);
      const lats = markers.map((marker) => marker.lat);
      const lngs = markers.map((marker) => marker.lng);
      const minLat = Math.min(...lats, component.center?.lat ?? lats[0]);
      const maxLat = Math.max(...lats, component.center?.lat ?? lats[0]);
      const minLng = Math.min(...lngs, component.center?.lng ?? lngs[0]);
      const maxLng = Math.max(...lngs, component.center?.lng ?? lngs[0]);
      const latSpan = Math.max(maxLat - minLat, 0.01);
      const lngSpan = Math.max(maxLng - minLng, 0.01);
      for (const marker of markers) {
        const pin = document.createElement("span");
        pin.className = "agee-ui-map-pin";
        pin.style.left = `${10 + ((marker.lng - minLng) / lngSpan) * 80}%`;
        pin.style.top = `${90 - ((marker.lat - minLat) / latSpan) * 80}%`;
        pin.setAttribute("aria-label", marker.label || "map marker");
        if (marker.label) {
          const label = document.createElement("span");
          label.className = "agee-ui-map-pin-label";
          label.textContent = marker.label;
          pin.appendChild(label);
        }
        map.appendChild(pin);
      }
      wrap.appendChild(map);
      if (component.center?.label) {
        const meta = document.createElement("div");
        meta.className = "agee-ui-map-meta";
        meta.textContent = component.center.label;
        wrap.appendChild(meta);
      }
      return wrap;
    }

    function renderUiControl(control) {
      if (control.type === "button") {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "agee-ui-control agee-ui-button";
        button.textContent = control.label;
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          runUiAction(control.action, control.prompt || control.value || control.label, control.label);
        });
        return button;
      }
      if (control.type === "text") {
        const wrap = document.createElement("label");
        wrap.className = "agee-ui-control agee-ui-text";
        const inputElement = document.createElement("input");
        inputElement.type = "text";
        inputElement.placeholder = control.label || "Ask A.G.";
        inputElement.value = control.value || "";
        inputElement.addEventListener("keydown", (event) => {
          event.stopPropagation();
          if (event.key !== "Enter") return;
          event.preventDefault();
          const value = inputElement.value.trim();
          if (!value) return;
          runUiAction(control.action, control.prompt || value, control.label, value);
        });
        wrap.appendChild(inputElement);
        return wrap;
      }
      if (control.type === "toggle") {
        const wrap = document.createElement("label");
        wrap.className = "agee-ui-control agee-ui-toggle";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = control.checked === true;
        const text = document.createElement("span");
        text.textContent = control.label;
        checkbox.addEventListener("change", () => {
          const value = checkbox.checked ? "on" : "off";
          runUiAction(control.action, control.prompt || `${control.label}: ${value}`, control.label, value);
        });
        wrap.append(checkbox, text);
        return wrap;
      }
      if (control.type === "select") {
        const wrap = document.createElement("label");
        wrap.className = "agee-ui-control agee-ui-select";
        const label = document.createElement("span");
        label.textContent = control.label;
        const select = document.createElement("select");
        for (const optionText of control.options || []) {
          const option = document.createElement("option");
          option.value = optionText;
          option.textContent = optionText;
          select.appendChild(option);
        }
        select.addEventListener("change", () => {
          runUiAction(control.action, control.prompt || `${control.label}: ${select.value}`, control.label, select.value);
        });
        wrap.append(label, select);
        return wrap;
      }
      return null;
    }

    function runUiAction(action, prompt, label, value = "") {
      const resolved = uiSpecRuntime?.resolveAction
        ? uiSpecRuntime.resolveAction(action, prompt, label, value)
        : { action, prompt: String(prompt || "").replace(/\{value\}/g, value).trim() };
      action = resolved.action;
      const resolvedPrompt = resolved.prompt;
      if (action === "voice.toggle") {
        openSurface();
        primeAudio();
        toggleVoice();
        return;
      }
      if (action === "command.open") {
        openSurface();
        const input = getInput();
        if (input) {
          if (resolvedPrompt) setInputText(resolvedPrompt, { select: true });
          input.focus();
        }
        return;
      }
      if (action === "page.describe") {
        describePage();
        return;
      }
      if (action === "settings.open") {
        sendMessage({ cmd: "openOptions" });
        return;
      }
      if (action === "agent.run") submitInstruction(resolvedPrompt || label || value);
    }

    return Object.freeze({
      applyUiSpec,
      loadUiSpec,
      renderUiComponent,
      renderUiControl,
      renderUiMap,
      renderUiSpecSurface,
      runUiAction,
    });
  }

  root.AgeeContentUiControllerRuntime = Object.freeze({ createContentUiControllerRuntime });
})(typeof globalThis !== "undefined" ? globalThis : this);
