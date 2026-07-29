// Ribbon runtime: the companion between two single-line streams.
// Contract: reference/design/overlay-2026-07/spec.md
//
// The DOM-bound half of the ribbon design — element wiring, the opacity/press
// state machine, the drag-as-one-unit grouping, expand/collapse, the copy rail
// and the hold menu. The text model lives in ribbon-window.js and the geometry
// in ribbon-layout.js; both are pure and unit-tested. This file holds only what
// genuinely needs a document.
//
// A ribbon is ONE line inside a fixed viewport with no surface behind it. It
// never wraps, never grows, and never reflows the page. That bound is the whole
// point: the user asked twice (2026-07-16, 2026-07-23) for overlay text to stop
// covering the persistent line.
//
// The runtime owns no conversation state. It renders the worker-owned active
// turn, so the visible turn follows the user across tabs and navigations.
(function initAgeeRibbons(global) {
  "use strict";

  const TextModel = global.AgeeRibbonWindow;
  const Layout = global.AgeeRibbonLayout;

  const HOLD_MS = 340;
  const MULTITAP_MS = 260;
  const TAP_SLOP = 6;
  const LATCH_MS = 6000;
  const LINGER_YOU = 4500;
  const LINGER_REPLY = 9000;
  const LINGER_ERROR = 14000;
  const PROXIMITY = 72;
  const THEME_SAMPLE_DEBOUNCE_MS = 250;

  const COPY_GLYPH = '<svg class="agee-ribbon-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
  const CHECK_GLYPH = '<svg class="agee-ribbon-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5.2 5.2L20 7"/></svg>';
  const CHEVRON_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9.5l6 6 6-6"/></svg>';

  function ribbonMarkup(id, kind, label) {
    return `
      <div class="agee-ribbon" id="${id}" data-agee-ribbon="${kind}" role="button" tabindex="0" aria-label="${label}">
        <span class="agee-ribbon-dot" aria-hidden="true"></span>
        <div class="agee-ribbon-viewport"><div class="agee-ribbon-line" aria-live="polite"><span class="agee-ribbon-text"></span><i class="agee-ribbon-caret" aria-hidden="true"></i></div></div>
        <button class="agee-ribbon-copy" type="button" tabindex="-1" aria-label="Copy ${kind === "you" ? "what you said" : "the reply"}">${COPY_GLYPH}${CHECK_GLYPH}</button>
        <button class="agee-ribbon-copy agee-ribbon-chevron" type="button" tabindex="-1" aria-label="Choose which version to copy" aria-haspopup="menu">${CHEVRON_GLYPH}</button>
        <span class="agee-ribbon-caption" aria-hidden="true">Copied</span>
      </div>`;
  }

  // The overlay's ribbon markup, injected into #agee-root by content.js.
  function template() {
    return [
      ribbonMarkup("agee-ribbon-you", "you", "What you said. Tap to expand and copy, hold for options, double tap for history."),
      ribbonMarkup("agee-ribbon-reply", "reply", "Ag&apos;s reply. Tap to expand and copy, hold for options, double tap for history."),
      '<div id="agee-ribbon-menu" role="menu" aria-label="Ribbon options"></div>',
      '<div id="agee-copy-menu" role="menu" aria-label="Choose which version to copy"></div>',
    ].join("\n");
  }

  function create(deps) {
    const {
      root,
      launcher,
      placeLauncher,
      copyText,
      openHistory,
      doc = global.document,
      win = global,
    } = deps || {};
    if (!root || !launcher) return null;

    let unitState = "dormant";
    let latched = false;
    let latchTimer = null;
    let pointerNear = false;
    let menuOwner = null;
    let presentationCue = "";
    let themeTimer = null;

    const menuEl = root.querySelector("#agee-ribbon-menu");
    const copyMenuEl = root.querySelector("#agee-copy-menu");

    function build(id, lingerMs) {
      const el = root.querySelector(`#${id}`);
      if (!el) return null;
      const ribbon = {
        el,
        lingerMs,
        lineEl: el.querySelector(".agee-ribbon-line"),
        textEl: el.querySelector(".agee-ribbon-text"),
        viewportEl: el.querySelector(".agee-ribbon-viewport"),
        copyEl: el.querySelector(".agee-ribbon-copy:not(.agee-ribbon-chevron)"),
        chevronEl: el.querySelector(".agee-ribbon-chevron"),
        buffer: "",
        truncated: false,
        expanded: false,
        variants: TextModel.emptyVariants(),
        skillName: "",
        chosenVariant: "",
        lingerTimer: null,
        copyTimer: null,
        renderPending: false,
      };
      ribbon.copyEl?.addEventListener("pointerdown", (event) => event.stopPropagation());
      ribbon.copyEl?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        copy(ribbon);
      });
      ribbon.chevronEl?.addEventListener("pointerdown", (event) => event.stopPropagation());
      ribbon.chevronEl?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openCopyMenu(ribbon);
      });
      return ribbon;
    }

    const you = build("agee-ribbon-you", LINGER_YOU);
    const reply = build("agee-ribbon-reply", LINGER_REPLY);
    if (!you || !reply) return null;
    const both = [you, reply];

    const isLive = (ribbon) => !!ribbon?.el?.classList.contains("agee-ribbon-live");

    // ---- Rendering --------------------------------------------------------
    // One write per animation frame, so a token-per-event stream cannot thrash
    // layout. Only transform animates while streaming; never width or height.
    function render(ribbon) {
      if (!ribbon || ribbon.renderPending) return;
      ribbon.renderPending = true;
      const paint = () => {
        ribbon.renderPending = false;
        ribbon.variants.literal = ribbon.buffer;
        if (ribbon.expanded) {
          // Expanded shows the whole buffer, wrapped inside the height cap.
          // The sliding window is a collapsed-state rule only.
          ribbon.textEl.textContent = ribbon.buffer;
          ribbon.lineEl.style.transform = "translateX(0px)";
          ribbon.el.classList.remove("agee-ribbon-clipped");
          return;
        }
        ribbon.textEl.textContent = TextModel.windowFor(ribbon.buffer);
        const overflow = TextModel.overflowFor(ribbon.viewportEl.clientWidth, ribbon.lineEl.scrollWidth);
        ribbon.lineEl.style.transform = `translateX(${overflow}px)`;
        ribbon.el.classList.toggle("agee-ribbon-clipped", overflow < 0);
      };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(paint);
      else paint();
    }

    function open(ribbon) {
      if (!ribbon) return;
      clearTimeout(ribbon.lingerTimer);
      ribbon.lingerTimer = null;
      ribbon.el.classList.add("agee-ribbon-live");
      position();
      syncState();
    }

    function clear(ribbon) {
      if (!ribbon) return;
      collapse(ribbon);
      ribbon.variants = TextModel.emptyVariants();
      ribbon.skillName = "";
      ribbon.chosenVariant = "";
      ribbon.buffer = "";
      ribbon.truncated = false;
      ribbon.textEl.textContent = "";
      ribbon.lineEl.style.transform = "translateX(0px)";
      ribbon.el.classList.remove(
        "agee-ribbon-clipped", "agee-ribbon-warn", "agee-ribbon-mute",
        "agee-ribbon-copied", "agee-ribbon-streaming"
      );
    }

    function retire(ribbon) {
      if (!ribbon) return;
      clearTimeout(ribbon.lingerTimer);
      ribbon.lingerTimer = null;
      ribbon.el.classList.remove("agee-ribbon-live", "agee-ribbon-streaming");
      clear(ribbon);
      syncState();
    }

    function push(ribbon, delta) {
      if (!ribbon || !delta) return;
      open(ribbon);
      const next = TextModel.appendDelta(ribbon.buffer, delta);
      ribbon.buffer = next.buffer;
      ribbon.truncated = ribbon.truncated || next.truncated;
      render(ribbon);
    }

    function setText(ribbon, text, { tone = "" } = {}) {
      if (!ribbon) return;
      const value = String(text || "");
      if (!value) return retire(ribbon);
      open(ribbon);
      const bounded = TextModel.boundBuffer(value);
      ribbon.buffer = bounded.buffer;
      ribbon.truncated = bounded.truncated;
      ribbon.el.classList.toggle("agee-ribbon-warn", tone === "warn");
      ribbon.el.classList.toggle("agee-ribbon-mute", tone === "mute");
      render(ribbon);
    }

    const setStreaming = (ribbon, on) => ribbon?.el?.classList.toggle("agee-ribbon-streaming", !!on);

    function startLinger(ribbon, ms) {
      if (!ribbon || !isLive(ribbon)) return;
      clearTimeout(ribbon.lingerTimer);
      ribbon.lingerTimer = setTimeout(() => {
        // Engaged, latched, or menu-open ribbons never retire under the user.
        if (unitState === "engaged" || unitState === "dragging" || menuOwner === ribbon) {
          startLinger(ribbon, 1200);
          return;
        }
        retire(ribbon);
      }, Number.isFinite(ms) ? ms : ribbon.lingerMs);
    }

    function holdOpen() {
      for (const ribbon of both) {
        clearTimeout(ribbon.lingerTimer);
        ribbon.lingerTimer = null;
      }
    }

    // ---- Expand -----------------------------------------------------------
    // The bounded bar opens to the full text. It grows away from the companion
    // (see ribbon-layout), so the companion, the other ribbon, and the page all
    // stay exactly where they were.
    function expand(ribbon) {
      if (!ribbon || !isLive(ribbon) || ribbon.expanded) return;
      for (const other of both) if (other !== ribbon) collapse(other);
      ribbon.expanded = true;
      ribbon.el.classList.add("agee-ribbon-expanded");
      holdOpen();
      render(ribbon);
    }

    function collapse(ribbon) {
      if (!ribbon?.expanded) return;
      ribbon.expanded = false;
      ribbon.el.classList.remove("agee-ribbon-expanded");
      closeCopyMenu();
      render(ribbon);
    }

    const toggleExpanded = (ribbon) => (ribbon?.expanded ? collapse(ribbon) : expand(ribbon));

    async function copy(ribbon, key) {
      if (!ribbon) return false;
      const variant = key || TextModel.defaultVariant(ribbon);
      // Choosing a variant is sticky for this turn only. A durable preference
      // is profile state and the agent owns that, not the overlay.
      if (key) ribbon.chosenVariant = key;
      const text = TextModel.variantText(ribbon, variant);
      if (!text) return false;
      const copied = await copyText(text);
      if (!copied) return false;
      ribbon.el.classList.add("agee-ribbon-copied");
      clearTimeout(ribbon.copyTimer);
      ribbon.copyTimer = setTimeout(() => ribbon.el.classList.remove("agee-ribbon-copied"), 1400);
      engage(true);
      return true;
    }

    // ---- Unit state -------------------------------------------------------
    function setUnitState(next) {
      unitState = next;
      root.dataset.ageeUnit = next;
    }

    function syncState() {
      if (unitState === "dragging") return;
      if (latched) return setUnitState("engaged");
      if (isLive(you) || isLive(reply)) return setUnitState("ambient");
      setUnitState(pointerNear ? "near" : "dormant");
    }

    function engage(latch) {
      clearTimeout(latchTimer);
      setUnitState("engaged");
      holdOpen();
      if (!latch) return;
      latched = true;
      // Latch expiry is a full release: it collapses an expanded ribbon and
      // closes any open menu, so the overlay is never left occluding the page
      // after the user has stopped touching it.
      latchTimer = setTimeout(() => unlatch(), LATCH_MS);
    }

    function release() {
      if (latched) return;
      syncState();
      startLinger(you, you.lingerMs);
      startLinger(reply, reply.lingerMs);
    }

    function unlatch() {
      latched = false;
      clearTimeout(latchTimer);
      closeMenu();
      closeCopyMenu();
      collapse(you);
      collapse(reply);
      release();
    }

    // ---- Placement --------------------------------------------------------
    function position() {
      const rect = launcher.getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      const width = you.el.offsetWidth || Math.min(340, Math.max(232, win.innerWidth * 0.44));
      const place = Layout.ribbonPlacement({
        launcherRect: rect,
        viewportWidth: win.innerWidth,
        viewportHeight: win.innerHeight,
        ribbonWidth: width,
      });
      you.el.style.left = `${place.left}px`;
      reply.el.style.left = `${place.left}px`;
      if (place.youAnchor === "top") {
        you.el.style.top = `${place.youTop}px`;
        you.el.style.bottom = "auto";
      } else {
        you.el.style.top = "auto";
        you.el.style.bottom = `${place.youBottom}px`;
      }
      if (place.replyAnchor === "bottom") {
        reply.el.style.top = "auto";
        reply.el.style.bottom = `${place.replyBottom}px`;
      } else {
        reply.el.style.top = `${place.replyTop}px`;
        reply.el.style.bottom = "auto";
      }
      root.classList.toggle("agee-ribbons-flipped", place.flip);
      root.classList.toggle("agee-ribbons-stacked-above", place.stackAbove);
    }

    // The ambient glyphs sit directly on page content, so sample what is
    // actually behind the unit. Debounced, and never during a stream, so this
    // can never cost a frame of the sliding window.
    function scheduleThemeSample() {
      clearTimeout(themeTimer);
      themeTimer = setTimeout(sampleTheme, THEME_SAMPLE_DEBOUNCE_MS);
    }

    function sampleTheme() {
      let luminance = null;
      try {
        const rect = launcher.getBoundingClientRect();
        const x = Math.max(0, Math.min(win.innerWidth - 1, rect.left + rect.width / 2));
        const y = Math.max(0, Math.min(win.innerHeight - 1, rect.top + rect.height / 2));
        const under = doc.elementsFromPoint(x, y).find((el) => !root.contains(el));
        for (let el = under; el; el = el.parentElement) {
          const parsed = Layout.relativeLuminance(getComputedStyle(el).backgroundColor);
          if (parsed !== null) {
            luminance = parsed;
            break;
          }
        }
        if (luminance === null) {
          const body = Layout.relativeLuminance(
            getComputedStyle(doc.body || doc.documentElement).backgroundColor
          );
          luminance = body === null
            ? (win.matchMedia?.("(prefers-color-scheme: light)")?.matches ? 1 : 0)
            : body;
        }
      } catch {
        return;
      }
      root.dataset.ageeRibbonTheme = Layout.themeForLuminance(luminance);
    }

    // ---- Gestures ---------------------------------------------------------
    // Every element is a drag handle and the anchor is always the companion, so
    // the companion and both ribbons move as one object. The companion's own
    // gesture map is untouched.
    function attachGestures(ribbon) {
      let activeId = null;
      let downX = 0;
      let downY = 0;
      let startLeft = 0;
      let startTop = 0;
      let dragging = false;
      let held = false;
      let holdTimer = null;
      let tapCount = 0;
      let tapTimer = null;

      ribbon.el.addEventListener("pointerdown", (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        if (!isLive(ribbon)) return;
        event.preventDefault();
        event.stopPropagation();
        activeId = event.pointerId;
        try { ribbon.el.setPointerCapture(event.pointerId); } catch {}
        const rect = launcher.getBoundingClientRect();
        downX = event.clientX;
        downY = event.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        dragging = false;
        held = false;
        engage(false);
        holdTimer = setTimeout(() => {
          if (dragging) return;
          held = true;
          ribbon.el.classList.add("agee-ribbon-held");
          openMenu(ribbon);
        }, HOLD_MS);
      });

      ribbon.el.addEventListener("pointermove", (event) => {
        if (event.pointerId !== activeId) return;
        const dx = event.clientX - downX;
        const dy = event.clientY - downY;
        if (!dragging && Math.hypot(dx, dy) > TAP_SLOP) {
          dragging = true;
          clearTimeout(holdTimer);
          closeMenu();
          collapse(ribbon);
          held = false;
          ribbon.el.classList.remove("agee-ribbon-held");
          setUnitState("dragging");
        }
        if (!dragging) return;
        // Dragging a ribbon moves the companion; position() then re-lays both
        // ribbons from the new anchor, so the unit travels as one.
        placeLauncher(startLeft + dx, startTop + dy, false);
      });

      const finish = (event) => {
        if (event.pointerId !== activeId) return;
        activeId = null;
        clearTimeout(holdTimer);
        try { ribbon.el.releasePointerCapture(event.pointerId); } catch {}
        if (dragging) {
          dragging = false;
          const rect = launcher.getBoundingClientRect();
          placeLauncher(rect.left, rect.top, true);
          latched = false;
          syncState();
          scheduleThemeSample();
          return;
        }
        if (held) {
          held = false;
          ribbon.el.classList.remove("agee-ribbon-held");
          return; // the menu stays open until an outside press or a row click
        }
        tapCount += 1;
        clearTimeout(tapTimer);
        tapTimer = setTimeout(() => {
          const taps = tapCount;
          tapCount = 0;
          if (taps === 1) {
            // One gesture, one obvious result: the bounded bar opens to the
            // full text AND the copy rail appears with it, so the copy
            // affordance sits where the text you would copy is visible.
            // Solidify is not a destination of its own — touching a ribbon
            // already solidifies it.
            engage(true);
            toggleExpanded(ribbon);
            if (!ribbon.expanded) unlatch();
            return;
          }
          // Double tap hands off to the history surface. The overlay never
          // becomes a scrollback.
          ribbon.el.classList.remove("agee-ribbon-flash");
          void ribbon.el.offsetWidth;
          ribbon.el.classList.add("agee-ribbon-flash");
          setTimeout(() => ribbon.el.classList.remove("agee-ribbon-flash"), 220);
          unlatch();
          openHistory();
        }, MULTITAP_MS);
      };
      ribbon.el.addEventListener("pointerup", finish);
      ribbon.el.addEventListener("pointercancel", finish);

      ribbon.el.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          engage(true);
          toggleExpanded(ribbon);
          if (!ribbon.expanded) unlatch();
        } else if (event.key === " ") {
          event.preventDefault();
          engage(true);
          openMenu(ribbon);
        } else if (event.key === "Escape") {
          event.preventDefault();
          unlatch();
        }
      });
    }

    // ---- Menus ------------------------------------------------------------
    // At most four rows, no submenus, and nothing that takes a model action,
    // launches a run, or changes a setting. Settings stay agent-opened only.
    function menuRows(ribbon) {
      const rows = [{ label: "Copy", run: () => copy(ribbon) }];
      if (ribbon === you) {
        rows.push({
          label: "Copy as note",
          run: () => copyText(`${new Date().toLocaleString()} — ${ribbon.buffer}`),
        });
      }
      rows.push({ label: "Open history", run: () => { unlatch(); openHistory(); } });
      rows.push({ label: "Dismiss", run: () => { retire(you); retire(reply); } });
      return rows;
    }

    function placeMenu(el, anchorRect, align) {
      const place = Layout.popupPlacement({
        anchorRect,
        viewportWidth: win.innerWidth,
        viewportHeight: win.innerHeight,
        width: el.offsetWidth || (align === "right" ? 214 : 176),
        height: el.offsetHeight || 150,
        align,
      });
      el.style.left = `${place.left}px`;
      el.style.top = `${place.top}px`;
    }

    function openMenu(ribbon) {
      if (!menuEl) return;
      menuEl.textContent = "";
      for (const row of menuRows(ribbon)) {
        const button = doc.createElement("button");
        button.type = "button";
        button.setAttribute("role", "menuitem");
        button.textContent = row.label;
        button.addEventListener("pointerdown", (event) => event.stopPropagation());
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          Promise.resolve(row.run()).catch(() => {});
          closeMenu();
        });
        menuEl.appendChild(button);
      }
      menuOwner = ribbon;
      menuEl.classList.add("agee-ribbon-menu-open");
      placeMenu(menuEl, ribbon.el.getBoundingClientRect(), "left");
      engage(true);
    }

    function closeMenu() {
      menuOwner?.el?.classList.remove("agee-ribbon-held");
      menuOwner = null;
      menuEl?.classList.remove("agee-ribbon-menu-open");
    }

    // The copy rail is a three-way choice with a default, not one button.
    // Unavailable variants render as disabled rows with a reason, so the
    // capability is discoverable before the data exists.
    function openCopyMenu(ribbon) {
      if (!copyMenuEl) return;
      copyMenuEl.textContent = "";
      for (const row of TextModel.variantRows(ribbon)) {
        const button = doc.createElement("button");
        button.type = "button";
        button.setAttribute("role", "menuitem");
        const head = doc.createElement("span");
        head.className = "agee-copy-row-head";
        const tick = doc.createElement("i");
        tick.className = "agee-copy-tick";
        head.appendChild(tick);
        head.appendChild(doc.createTextNode(row.label));
        const why = doc.createElement("span");
        why.className = "agee-copy-why";
        why.textContent = row.note;
        button.appendChild(head);
        button.appendChild(why);
        if (!row.available) button.disabled = true;
        if (row.isDefault) button.classList.add("agee-copy-default");
        button.addEventListener("pointerdown", (event) => event.stopPropagation());
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          copy(ribbon, row.key).catch(() => {});
          closeCopyMenu();
        });
        copyMenuEl.appendChild(button);
      }
      copyMenuEl.classList.add("agee-ribbon-menu-open");
      placeMenu(copyMenuEl, (ribbon.chevronEl || ribbon.el).getBoundingClientRect(), "right");
      engage(true);
    }

    function closeCopyMenu() {
      copyMenuEl?.classList.remove("agee-ribbon-menu-open");
    }

    // ---- Wiring -----------------------------------------------------------
    for (const ribbon of both) attachGestures(ribbon);

    // Proximity pre-light is browser-only (Android has no hover). It runs on
    // every page mousemove, so it must never force layout: sample the pointer
    // and do the single rect read at most once per animation frame.
    let proximityPending = false;
    let proximityX = 0;
    let proximityY = 0;
    win.addEventListener("pointermove", (event) => {
      if (event.pointerType !== "mouse" || proximityPending) return;
      proximityX = event.clientX;
      proximityY = event.clientY;
      proximityPending = true;
      requestAnimationFrame(() => {
        proximityPending = false;
        const near = Layout.isWithinProximity(
          launcher.getBoundingClientRect(), proximityX, proximityY, PROXIMITY
        );
        if (near === pointerNear) return;
        pointerNear = near;
        syncState();
      });
    }, { passive: true });

    doc.addEventListener("pointerdown", (event) => {
      if (root.contains(event.target)) return;
      unlatch();
    }, true);

    win.addEventListener("resize", () => {
      position();
      scheduleThemeSample();
    });

    setUnitState("dormant");
    position();
    scheduleThemeSample();

    // ---- Public surface ---------------------------------------------------
    return {
      position,
      scheduleThemeSample,

      // The upper ribbon is the live transcription stream. An empty transcript
      // only stops the caret: the ribbon retires on its own linger timer so the
      // user can still read and copy what they said after the turn ends.
      setUser(text, { interim = false } = {}) {
        const value = String(text || "");
        if (value) {
          setText(you, value);
          setStreaming(you, !!interim);
        } else {
          setStreaming(you, false);
        }
      },

      // The lower ribbon is the assistant response stream.
      setReply(text, { tone = "", streaming = false } = {}) {
        const value = String(text || "").trim();
        if (!value) return;
        setText(reply, value, { tone });
        setStreaming(reply, streaming);
      },

      pushUser: (delta) => push(you, delta),
      pushReply: (delta) => push(reply, delta),
      setReplyStreaming: (on) => setStreaming(reply, on),

      // Freeze both ribbons and start their linger timers. A reply the device
      // never spoke has to be read, so it stays up materially longer.
      endTurn({ spoken = true, error = false } = {}) {
        setStreaming(you, false);
        setStreaming(reply, false);
        startLinger(you, LINGER_YOU);
        startLinger(reply, error || spoken === false ? LINGER_ERROR : LINGER_REPLY);
      },

      // The ribbons render the worker-owned active turn, so switching tabs or
      // navigating carries the visible turn with the user. Local streaming
      // still drives the owning tab directly for immediacy.
      applyPresentation(presentation, isOwner) {
        if (!presentation) return;
        const cueId = String(presentation.cue_id || "");
        if (cueId && cueId !== presentationCue) {
          // A different turn owns the unit now: drop the previous turn's text
          // rather than letting two turns share one pair of ribbons.
          presentationCue = cueId;
          if (!isOwner) {
            retire(you);
            retire(reply);
          }
        }
        const status = String(presentation.status || "");
        // Derived revisions, when the gateway has produced them. Absent fields
        // leave that variant unavailable and the rail falls back down the rank.
        for (const [ribbon, patch] of [[you, presentation.user_variants], [reply, presentation.response_variants]]) {
          const merged = TextModel.mergeVariants(ribbon.variants, patch);
          ribbon.variants = merged.variants;
          if (merged.skillName !== null) ribbon.skillName = merged.skillName;
        }
        if (TextModel.shouldAdoptPresentationText(you.buffer, presentation.user_text, isOwner)) {
          setText(you, presentation.user_text);
        }
        if (TextModel.shouldAdoptPresentationText(reply.buffer, presentation.response_text, isOwner)) {
          setText(reply, presentation.response_text, { tone: status === "error" ? "warn" : "" });
        }
        setStreaming(you, status === "listening");
        setStreaming(reply, status === "responding" || status === "running");
        if (status === "done" || status === "error") {
          this.endTurn({ error: status === "error" });
        }
        syncState();
      },
    };
  }

  global.AgeeRibbons = Object.freeze({ create, template, HOLD_MS, MULTITAP_MS, LATCH_MS });
})(globalThis);
