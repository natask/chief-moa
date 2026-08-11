// Ribbon runtime: the companion between two chat bubbles.
// Contract: reference/design/overlay-2026-07-28/spec.md sections 5, 5.1, 5.2
//
// The DOM-bound half of the ribbon design — element wiring, the opacity/press
// state machine, the drag-as-one-unit grouping, expand/collapse, the copy rail
// and the hold menu. The text model lives in ribbon-window.js and the geometry
// in ribbon-layout.js; both are pure and unit-tested. This file holds only what
// genuinely needs a document.
//
// A bubble wraps inside a bounded viewport and pins to its tail. Streaming is
// always one fixed line. A deliberate tap opens exactly three visible lines
// with vertical scrolling. Text never changes the window geometry or reflows
// the page.
//
// The runtime owns no conversation state. It renders the worker-owned active
// turn, so the visible turn follows the user across tabs and navigations.
(function initAgeeRibbons(global) {
  "use strict";

  const TextModel = global.AgeeRibbonWindow;
  const Layout = global.AgeeRibbonLayout;
  const Report = global.AgeeRibbonGeometryReport;

  const HOLD_MS = 340;
  const MULTITAP_MS = 260;
  const TAP_SLOP = 6;
  const LATCH_MS = 6000;
  const LINGER_YOU = 4500;
  const LINGER_REPLY = 9000;
  const LINGER_ERROR = 14000;
  const PROXIMITY = 72;
  // Reading pace for the reply line, in rendered glyphs per second, and the
  // tick it is applied on. Counted in grapheme clusters, not code units, so a
  // syllabic script (Amharic carries far more meaning per glyph than Latin)
  // arrives at a readable rate rather than flashing past — and so a reveal can
  // never cut a cluster in half.
  const REVEAL_CPS = 26;
  const REVEAL_TICK_MS = 40;
  // However far behind the reveal falls, it is caught up within this window.
  const REVEAL_CATCHUP_MS = 2500;
  const THEME_SAMPLE_DEBOUNCE_MS = 250;
  // How far from the bottom of an expanded bubble still counts as "reading the
  // tail". One line, so a stream re-pins for someone who has not scrolled away.
  const TAIL_SLACK = 24;
  // Mirrors the CSS clamp for --agee-ribbon-w (spec section 5). position()
  // writes the width, so it cannot read it back without feeding its own output
  // in and shrinking the box a little further on every pass.
  const BUBBLE_MIN_W = 260;
  const BUBBLE_MAX_W = 380;
  const BUBBLE_VW = 0.4;

  const COPY_GLYPH = '<svg class="agee-ribbon-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
  const CHECK_GLYPH = '<svg class="agee-ribbon-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5.2 5.2L20 7"/></svg>';
  const CHEVRON_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9.5l6 6 6-6"/></svg>';
  const SEND_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V6"/><path d="M6 12l6-6 6 6"/></svg>';
  // The wave is a separate path so muting hides one element rather than
  // swapping the whole glyph, which would flash the button on every toggle.
  const VOICE_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 9v6h4l5 4V5L9 9H5z"/><path class="agee-ribbon-voice-wave" d="M17 9a4 4 0 0 1 0 6"/><path class="agee-ribbon-voice-slash" d="M17 9l5 6M22 9l-5 6"/></svg>';

  // The send button rides the same rail the copy button sits in, and only on
  // the you-ribbon: while composing it takes copy's place, so the box you type
  // in is the box you already know, with a send where copy was.
  //
  // Mute rides that rail on the reply side only, because it acts on the reply.
  // It used to be #agee-quiet-controls, a fixed pill parked beside the mascot:
  // always on, turn-agnostic, not part of the draggable unit, and — the reason
  // it had to go — painted from overlay.css with a hard-coded dark plate, so on
  // a light page it stayed dark next to two bubbles that had correctly flipped.
  // Inside the bubble it inherits the palette and cannot disagree with it.
  function ribbonMarkup(id, kind, label) {
    const send = kind === "you"
      ? `<button class="agee-ribbon-send" type="button" tabindex="-1" aria-label="Send">${SEND_GLYPH}</button>`
      : "";
    const voice = kind === "reply"
      // No data-agee-tip: #agee-tip is a fixed overlay.css surface with its own
      // hard-coded dark plate, and hanging one off a rail button would put a
      // dark tooltip on a light page right back next to the companion — the
      // exact defect the pill was deleted for. The rail's other buttons carry
      // aria-label only, and this matches them.
      ? `<button class="agee-ribbon-voice" type="button" tabindex="-1" aria-pressed="true" aria-label="Turn voice replies off">${VOICE_GLYPH}</button>`
      : "";
    return `
      <div class="agee-ribbon" id="${id}" data-agee-ribbon="${kind}" role="button" tabindex="0" aria-label="${label}">
        <div class="agee-ribbon-viewport"><div class="agee-ribbon-line" aria-live="polite"><span class="agee-ribbon-text"></span><i class="agee-ribbon-caret" aria-hidden="true"></i></div></div>
        <button class="agee-ribbon-copy" type="button" tabindex="-1" aria-label="Copy ${kind === "you" ? "what you said" : "the reply"}">${COPY_GLYPH}${CHECK_GLYPH}</button>
        <button class="agee-ribbon-copy agee-ribbon-chevron" type="button" tabindex="-1" aria-label="Choose which version to copy" aria-haspopup="menu">${CHEVRON_GLYPH}</button>
        ${voice}
        ${send}
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
      // Text mode submits through the host: the runtime owns presentation, not
      // conversation. Copy on a live capture asks the host to finalize it.
      onSubmitText = () => {},
      // Told whenever the typing box gains or loses an unsent line, so the host
      // can keep a dev reload from landing on top of it.
      onComposeStateChange = () => {},
      finalizeUserTranscriptForCopy = () => false,
      // Mute moved off the floating pill and into the reply rail. The
      // preference, its storage key and setVoiceRepliesEnabled are unchanged —
      // only where you press it moved, so this is a location change and not a
      // behaviour change.
      onVoiceRepliesChange = () => {},
      preferredCopyVariant = "",
      onPreferredCopyVariantChange = () => {},
      generateWritingVariant = async () => null,
      // Handed the whole bounded ring whenever it grows, so the host can
      // persist it: the band is intermittent and the page it appeared on is
      // usually gone by the time anyone goes looking.
      onGeometryBreach = () => {},
      doc = global.document,
      win = global,
    } = deps || {};
    if (!root || !launcher) return null;

    let activePageObservationId = "";
    let unitState = "dormant";
    let latched = false;
    let latchTimer = null;
    let pointerNear = false;
    let menuOwner = null;
    let composing = false;
    let pendingUserCopy = false;
    let presentationCue = "";
    let themeTimer = null;
    let voiceRepliesOn = true;
    // True between capture opening and capture closing. Only the opening edge
    // clears the you-bubble; see setUserPending.
    let userCaptureOpen = false;
    let geometryBreaches = [];
    let geometryAuditPending = false;
    let currentPreferredCopyVariant = ["skill", "edited", "literal"].includes(preferredCopyVariant) ? preferredCopyVariant : "";

    function setPageObservation(rawPhase, rawId) {
      const phase = String(rawPhase || "");
      const id = String(rawId || "");
      if (phase === "reading" || phase === "seeing") {
        activePageObservationId = id;
        root.classList.toggle("agee-page-observing-reading", phase === "reading");
        root.classList.toggle("agee-page-observing-seeing", phase === "seeing");
      } else if (!id || id === activePageObservationId) {
        activePageObservationId = "";
        root.classList.remove("agee-page-observing-reading", "agee-page-observing-seeing");
      }
    }

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
        // The one node every stream appends into. Held here so a delta is an
        // appendData rather than a fresh node per frame.
        textNode: null,
        viewportEl: el.querySelector(".agee-ribbon-viewport"),
        copyEl: el.querySelector(".agee-ribbon-copy:not(.agee-ribbon-chevron)"),
        chevronEl: el.querySelector(".agee-ribbon-chevron"),
        sendEl: el.querySelector(".agee-ribbon-send"),
        voiceEl: el.querySelector(".agee-ribbon-voice"),
        buffer: "",
        // What the ribbon has been given, which is not always what it has shown
        // yet: `buffer` is the revealed prefix and `target` is the whole reply.
        // Copy, the variants and the expanded view all read `target` — pacing is
        // a reading aid, never a claim that Ag said less than it did.
        target: "",
        targetGraphemes: [],
        revealIndex: 0,
        revealTimer: null,
        truncated: false,
        expanded: false,
        variants: TextModel.emptyVariants(),
        skillName: "",
        chosenVariant: currentPreferredCopyVariant,
        lingerTimer: null,
        lingerAfterReveal: 0,
        copyTimer: null,
        renderPending: false,
      };
      ribbon.copyEl?.addEventListener("pointerdown", (event) => event.stopPropagation());
      ribbon.copyEl?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        copy(ribbon);
      });
      // preventDefault keeps the caret in the editable line: a press that stole
      // focus would drop the selection before the click that sends lands.
      ribbon.sendEl?.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      ribbon.sendEl?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        submitComposed();
      });
      ribbon.voiceEl?.addEventListener("pointerdown", (event) => event.stopPropagation());
      ribbon.voiceEl?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setVoiceReplies(!voiceRepliesOn, { notify: true });
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

    // Mute. `notify` is false when the host is telling the rail what the stored
    // preference already is, and true when the user pressed the button — so
    // restoring the preference on load cannot write it back and cannot announce.
    function setVoiceReplies(on, { notify = false } = {}) {
      voiceRepliesOn = on !== false;
      const label = voiceRepliesOn ? "Turn voice replies off" : "Turn voice replies on";
      reply.el.classList.toggle("agee-ribbon-voice-muted", !voiceRepliesOn);
      if (reply.voiceEl) {
        reply.voiceEl.setAttribute("aria-pressed", String(voiceRepliesOn));
        reply.voiceEl.setAttribute("aria-label", label);
      }
      // The button carries its own answer — the slash appears and aria-pressed
      // flips — so there is no transient caption to read. The old pill needed
      // one because it had no state of its own to show.
      if (notify) {
        try { onVoiceRepliesChange(voiceRepliesOn); } catch {}
      }
    }

    // ---- Scrollback -------------------------------------------------------
    // Hovering the unit and scrolling walks back through finished turns, in
    // place. The overlay still holds no conversation — this is a bounded ring
    // of what these two boxes have already shown, so the gesture costs nothing
    // and cannot become a chat log. Scrolling past the newest returns to live.
    const HISTORY_MAX = 20;
    const history = [];
    let historyIndex = -1;
    let liveFrame = null;

    const snapshot = (ribbon) => ({
      target: ribbon.target || ribbon.buffer,
      variants: { ...ribbon.variants },
      skillName: ribbon.skillName,
    });

    function restoreRibbon(ribbon, snap) {
      if (!snap?.target) return retire(ribbon);
      setText(ribbon, snap.target);
      ribbon.variants = { ...snap.variants };
      ribbon.skillName = snap.skillName;
    }

    // Called when a turn finishes, so the ring holds completed exchanges only.
    function recordTurn() {
      const frame = { you: snapshot(you), reply: snapshot(reply) };
      if (!frame.you.target && !frame.reply.target) return;
      history.push(frame);
      if (history.length > HISTORY_MAX) history.shift();
      historyIndex = -1;
      liveFrame = null;
    }

    // Any new text pulls the unit back to the live turn: a reply must never
    // land silently while the user is reading something older.
    function returnToLive() {
      if (historyIndex < 0) return;
      historyIndex = -1;
      liveFrame = null;
      root.classList.remove("agee-ribbons-history");
    }

    // dir +1 walks older, -1 walks newer. -1 is the live turn.
    function stepHistory(dir) {
      if (!history.length) return false;
      if (historyIndex < 0) liveFrame = { you: snapshot(you), reply: snapshot(reply) };
      const next = Math.max(-1, Math.min(historyIndex + dir, history.length - 1));
      if (next === historyIndex) return false;
      historyIndex = next;
      const frame = historyIndex < 0 ? liveFrame : history[history.length - 1 - historyIndex];
      restoreRibbon(you, frame.you);
      restoreRibbon(reply, frame.reply);
      root.classList.toggle("agee-ribbons-history", historyIndex >= 0);
      // Browsing counts as using the unit, so it stays up while reading.
      engage(true);
      return true;
    }

    for (const ribbon of [you, reply]) {
      ribbon.el.addEventListener("wheel", (event) => {
        // Only claim the wheel when there is somewhere to go; otherwise the
        // page must scroll normally under the pointer.
        if (!history.length) return;
        if (!stepHistory(event.deltaY < 0 ? 1 : -1)) return;
        event.preventDefault();
      }, { passive: false });
    }

    // ---- Rendering --------------------------------------------------------
    // One write per animation frame, so a token-per-event stream cannot thrash
    // layout. The bubble's width is written by position() and never by a
    // stream, and the stylesheet fixes both collapsed and expanded heights.

    // A stream is almost always an append, so append: appendData mutates the
    // existing text node in place and the browser reflows the new run, not the
    // whole paragraph. Assigning textContent would tear the node down and
    // rebuild it every frame. Never innerHTML — this is model output.
    function writeText(ribbon, next) {
      let node = ribbon.textNode;
      // Compose replaces the contenteditable's children, and a paste or a
      // select-all-delete can leave the node detached. Re-adopt rather than
      // writing into something that is no longer on screen.
      if (!node || node.parentNode !== ribbon.textEl) {
        ribbon.textEl.textContent = "";
        node = doc.createTextNode("");
        ribbon.textEl.appendChild(node);
        ribbon.textNode = node;
      }
      const current = node.data;
      if (next === current) return;
      if (current && next.startsWith(current)) node.appendData(next.slice(current.length));
      else node.data = next;
    }

    // Pin to the tail: the newest text is the text you are looking at, and the
    // oldest leaves off the top under the fade. Collapsed always pins. Expanded
    // pins only while the reader is already at the bottom, so a stream cannot
    // yank the view away from something they scrolled back to read.
    function pinToTail(ribbon) {
      const viewport = ribbon.viewportEl;
      const overflowing = viewport.scrollHeight > viewport.clientHeight + 1;
      ribbon.el.classList.toggle("agee-ribbon-clipped", overflowing && !ribbon.expanded);
      if (!ribbon.expanded) {
        viewport.scrollTop = viewport.scrollHeight;
        return;
      }
      const fromTail = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      if (fromTail <= TAIL_SLACK) viewport.scrollTop = viewport.scrollHeight;
    }

    function render(ribbon) {
      if (!ribbon || ribbon.renderPending) return;
      ribbon.renderPending = true;
      const paint = () => {
        ribbon.renderPending = false;
        ribbon.variants.literal = ribbon.target || ribbon.buffer;
        // The caret lives in this node while composing; rewriting it would move
        // the caret to the start on every keystroke. Still pin, so a typed line
        // that has passed the single collapsed row keeps the caret in view.
        if (composing && ribbon === you) return pinToTail(ribbon);
        // Expanded shows everything Ag has said. Opening a bubble is the "show
        // me all of it now" gesture, so it reads the target, not the paced
        // prefix — pacing is a collapsed-state reading aid.
        writeText(ribbon, ribbon.expanded ? (ribbon.target || ribbon.buffer) : ribbon.buffer);
        pinToTail(ribbon);
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
      stopReveal(ribbon);
      ribbon.lingerAfterReveal = 0;
      ribbon.variants = TextModel.emptyVariants();
      ribbon.skillName = "";
      ribbon.chosenVariant = currentPreferredCopyVariant;
      ribbon.buffer = "";
      ribbon.target = "";
      ribbon.targetGraphemes = [];
      ribbon.revealIndex = 0;
      ribbon.truncated = false;
      ribbon.textEl.textContent = "";
      ribbon.textNode = null;
      ribbon.viewportEl.scrollTop = 0;
      ribbon.el.classList.remove(
        "agee-ribbon-clipped", "agee-ribbon-warn", "agee-ribbon-mute",
        "agee-ribbon-copied", "agee-ribbon-streaming"
      );
    }

    function retire(ribbon) {
      if (!ribbon) return;
      clearTimeout(ribbon.lingerTimer);
      ribbon.lingerTimer = null;
      ribbon.pending = false;
      ribbon.el.classList.remove("agee-ribbon-live", "agee-ribbon-streaming", "agee-ribbon-pending");
      clear(ribbon);
      syncState();
    }

    function push(ribbon, delta, { paced = false } = {}) {
      if (!ribbon || !delta) return;
      open(ribbon);
      const next = TextModel.appendDelta(ribbon.target, delta);
      ribbon.target = next.buffer;
      ribbon.truncated = ribbon.truncated || next.truncated;
      if (!paced) {
        ribbon.buffer = ribbon.target;
        render(ribbon);
        return;
      }
      scheduleReveal(ribbon);
    }

    function setText(ribbon, text, { tone = "", paced = false } = {}) {
      if (!ribbon) return;
      const value = String(text || "");
      if (!value) return retire(ribbon);
      open(ribbon);
      const bounded = TextModel.boundBuffer(value);
      ribbon.target = bounded.buffer;
      ribbon.truncated = bounded.truncated;
      ribbon.el.classList.toggle("agee-ribbon-warn", tone === "warn");
      ribbon.el.classList.toggle("agee-ribbon-mute", tone === "mute");
      // Unpaced text lands whole: the user's own transcript, where partials
      // rewrite themselves and pacing would fight the correction.
      ribbon.targetGraphemes = TextModel.graphemes(ribbon.target);
      if (!paced || !ribbon.target.startsWith(ribbon.buffer)) {
        stopReveal(ribbon);
        ribbon.buffer = ribbon.target;
        ribbon.revealIndex = ribbon.targetGraphemes.length;
        render(ribbon);
        return;
      }
      ribbon.revealIndex = Math.min(ribbon.revealIndex, ribbon.targetGraphemes.length);
      scheduleReveal(ribbon);
      render(ribbon);
    }

    // ---- Paced reveal -----------------------------------------------------
    // A reply that arrives whole — a text-only turn, a provider that does not
    // stream, a burst of buffered deltas — used to appear as one block of text
    // that is already gone by the time you look at it. Reveal it at reading
    // pace instead, so the line always moves and can be followed. This is
    // presentation only: `target` is the whole reply from the moment it lands,
    // so copy, expand and the variants are never short-changed.
    //
    // The rate scales with the backlog. Ordinary streaming reads at REVEAL_CPS;
    // a long reply that landed at once catches up fast rather than trickling
    // out for a minute, and is always fully shown within REVEAL_CATCHUP_MS.
    function revealStep(ribbon) {
      const remaining = ribbon.targetGraphemes.length - ribbon.revealIndex;
      if (remaining <= 0) {
        stopReveal(ribbon);
        // Catching up is what ends the turn's visible work: an endTurn that
        // arrived mid-reveal parked its linger here so the last words are not
        // wiped a frame after they appear.
        if (ribbon.lingerAfterReveal) {
          const ms = ribbon.lingerAfterReveal;
          ribbon.lingerAfterReveal = 0;
          setStreaming(ribbon, false);
          startLinger(ribbon, ms);
        }
        return;
      }
      const catchUpCps = remaining / (REVEAL_CATCHUP_MS / 1000);
      const cps = Math.max(REVEAL_CPS, catchUpCps);
      const step = Math.max(1, Math.round((cps * REVEAL_TICK_MS) / 1000));
      ribbon.revealIndex = Math.min(ribbon.targetGraphemes.length, ribbon.revealIndex + step);
      ribbon.buffer = ribbon.targetGraphemes.slice(0, ribbon.revealIndex).join("");
      render(ribbon);
      ribbon.revealTimer = setTimeout(() => revealStep(ribbon), REVEAL_TICK_MS);
    }

    function scheduleReveal(ribbon) {
      if (ribbon.revealTimer) return;
      ribbon.revealTimer = setTimeout(() => revealStep(ribbon), REVEAL_TICK_MS);
    }

    function stopReveal(ribbon) {
      if (!ribbon) return;
      clearTimeout(ribbon.revealTimer);
      ribbon.revealTimer = null;
    }

    // Touching a ribbon means "show me all of it now". Any pending reveal is
    // finished immediately rather than made to race the user's attention.
    function revealAll(ribbon) {
      if (!ribbon) return;
      stopReveal(ribbon);
      if (ribbon.buffer !== ribbon.target) {
        ribbon.buffer = ribbon.target;
        ribbon.revealIndex = ribbon.targetGraphemes.length;
        render(ribbon);
      }
      if (ribbon.lingerAfterReveal) {
        const ms = ribbon.lingerAfterReveal;
        ribbon.lingerAfterReveal = 0;
        setStreaming(ribbon, false);
        startLinger(ribbon, ms);
      }
    }

    const setStreaming = (ribbon, on) => ribbon?.el?.classList.toggle("agee-ribbon-streaming", !!on);

    // Pending: the ribbon is open and visibly waiting, with no text yet. This is
    // what makes the unit appear the moment the microphone opens instead of at
    // the first partial transcript — the gap between "I started talking" and
    // "the first word came back" is where the overlay used to look dead.
    // A pending ribbon paints its dots, not its (empty) glyph run, so it must
    // stay live through setText's empty-string retire path.
    function setPending(ribbon, on) {
      if (!ribbon) return;
      ribbon.pending = !!on;
      ribbon.el.classList.toggle("agee-ribbon-pending", !!on);
      if (on) open(ribbon);
      else if (!ribbon.buffer) retire(ribbon);
    }

    // Where the companion is ALLOWED to sit: only where both streams still have
    // their minimum room. The rule lives in ribbon-layout.js next to the tokens
    // the boxes are laid out from, so the two can never disagree — a companion
    // dropped in a corner used to leave its box 29px wide with the send button
    // hanging off the end. Applied on every placement, drag and resize alike.
    function clampLauncherInto(x, y, rect) {
      return Layout.clampLauncher(x, y, Layout.launcherBounds({
        viewportWidth: win.innerWidth,
        viewportHeight: win.innerHeight,
        launcherWidth: rect?.width || 0,
        launcherHeight: rect?.height || 0,
        // The SAME gap position() lays the bubbles out with. The rim is drawn
        // outside the launcher's box, where getBoundingClientRect cannot see
        // it, so the gap has to carry it — and if only one of these two calls
        // carries it, the drag boundary and the space budget disagree by
        // exactly that outset, which is the thing this file's own comment says
        // must never happen. The companion could then be dropped where its
        // bubble no longer fits, and the bubble ran off the top of the screen.
        gap: Layout.GAP + rimOutset(),
      }));
    }

    // ---- Compose ----------------------------------------------------------
    // Text mode is the same bubble, editable. Clicking the companion puts the
    // caret in the you-line and typing wraps and tail-pins exactly as the
    // transcript does, so there is one buffer and one place to look for what
    // you are about to say — never a second surface stacked over the page.
    //
    // While composing, render() must not write into the text node: the caret
    // lives there and rewriting it would move the caret to the start on every
    // keystroke. Only the tail pin runs.
    function beginCompose({ text = "" } = {}) {
      if (composing) {
        if (text) setComposedText(text);
        return;
      }
      composing = true;
      stopReveal(you);
      setPending(you, false);
      open(you);
      you.el.classList.add("agee-ribbon-composing");
      you.textEl.setAttribute("contenteditable", "plaintext-only");
      you.textEl.setAttribute("role", "textbox");
      you.textEl.setAttribute("aria-label", "Type to Ag");
      holdOpen();
      engage(true);
      if (text) setComposedText(text);
      markComposeEmpty();
      focusCompose();
    }

    // An empty compose line has nothing to read, so the box shows what it is
    // for and dims the send. The prompt is painted by the viewport, never by
    // the editable node — text inside it would sit before the caret.
    function markComposeEmpty() {
      const hasText = !!composedText();
      you.el.classList.toggle("agee-ribbon-empty", !hasText);
      try { onComposeStateChange({ composing, hasText }); } catch {}
    }

    // Prefill, used by the agent-authored quick actions that used to drop a
    // prompt into the panel's field. Same buffer, same bubble, caret at the end.
    function setComposedText(text) {
      you.target = String(text || "");
      you.buffer = you.target;
      you.textEl.textContent = you.target;
      you.textNode = null;
      pinToTail(you);
      markComposeEmpty();
    }

    function focusCompose() {
      try {
        you.textEl.focus({ preventScroll: true });
        const range = doc.createRange();
        range.selectNodeContents(you.textEl);
        range.collapse(false);
        const selection = win.getSelection?.();
        selection?.removeAllRanges();
        selection?.addRange(range);
      } catch {}
    }

    function endCompose({ clearText = false } = {}) {
      if (!composing) return;
      composing = false;
      you.el.classList.remove("agee-ribbon-composing", "agee-ribbon-empty");
      you.textEl.removeAttribute("contenteditable");
      you.textEl.removeAttribute("role");
      you.textEl.removeAttribute("aria-label");
      try { you.textEl.blur(); } catch {}
      try { onComposeStateChange({ composing: false, hasText: false }); } catch {}
      if (clearText) retire(you);
      else render(you);
    }

    function composedText() {
      return String(you.textEl.textContent || "").trim();
    }

    function submitComposed() {
      const text = composedText();
      if (!text) {
        endCompose({ clearText: true });
        return;
      }
      you.target = text;
      you.buffer = text;
      endCompose();
      onSubmitText(text);
    }

    you.textEl.addEventListener("input", () => {
      if (!composing) return;
      you.target = String(you.textEl.textContent || "");
      you.buffer = you.target;
      // Keep the newest line in view, exactly as the stream does, without
      // touching the node the caret sits in.
      pinToTail(you);
      markComposeEmpty();
    });

    you.textEl.addEventListener("keydown", (event) => {
      if (!composing) return;
      event.stopPropagation();
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submitComposed();
      } else if (event.key === "Escape") {
        event.preventDefault();
        endCompose({ clearText: true });
        unlatch();
      }
    });

    // A press inside the editable line is a caret placement, not a ribbon
    // gesture: it must not start a drag or open the hold menu.
    you.textEl.addEventListener("pointerdown", (event) => {
      if (composing) event.stopPropagation();
    });

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
      // Opening the box is the "all of it, now" gesture.
      revealAll(ribbon);
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
      // Copy on a live capture is also a disposition: it finalizes what has
      // been said so far and does NOT send it to reasoning. The host completes
      // copyUserTranscript() only after the transcription-only session returns
      // its terminal text, so the clipboard never gets a half-formed hypothesis.
      if (ribbon === you && !key && finalizeUserTranscriptForCopy()) {
        pendingUserCopy = true;
        revealAll(you);
        engage(true);
        return true;
      }
      const variant = key || TextModel.defaultVariant(ribbon);
      if (key) {
        ribbon.chosenVariant = key;
        try { onPreferredCopyVariantChange(key); } catch {}
      }
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
      // after the user has stopped touching it. Text mode is exempt — a caret
      // in the buffer means the user is mid-sentence, and a timer must never
      // take the line out from under them.
      latchTimer = setTimeout(() => {
        if (composing) return engage(true);
        unlatch();
      }, LATCH_MS);
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
      // Clicking away, or Escape, ends text mode: the buffer is an engaged
      // state, so releasing the unit releases the caret with it.
      endCompose();
      closeMenu();
      closeCopyMenu();
      collapse(you);
      collapse(reply);
      release();
    }

    // ---- Placement --------------------------------------------------------
    // The companion's state rim (.agee-ring, overlay.css) is drawn OUTSIDE the
    // launcher's box at inset -0.18em, and getBoundingClientRect() does not see
    // it — so the layout's 8px gap is measured from a box the rim already
    // overhangs. At the default 22px mascot the rim eats 4px of that gap; at
    // the 72px scroll-to-resize maximum it is 13px and the listening rim paints
    // underneath the bubble. Widen the gap by exactly the outset so the spec's
    // clear space survives every mascot size. Falls back to the default rather
    // than to zero: a missing font-size must not put the rim back under the box.
    const RIM_OUTSET_EM = 0.18;
    const RIM_FONT_FALLBACK_PX = 22;
    function rimOutset() {
      let fontPx = 0;
      try { fontPx = parseFloat(win.getComputedStyle(launcher).fontSize); } catch {}
      if (!Number.isFinite(fontPx) || fontPx <= 0) fontPx = RIM_FONT_FALLBACK_PX;
      return Math.round(fontPx * RIM_OUTSET_EM);
    }

    function position() {
      const rect = launcher.getBoundingClientRect();
      if (!rect.width && !rect.height) {
        // The companion has no box, so there is nothing to lay the streams out
        // from and none of the geometry below is written. Whatever the boxes
        // are showing right now, nothing is bounding them — record it.
        auditGeometry({ positioned: false, cap: 0, rect });
        return;
      }
      // Derived, never measured. position() writes these widths, so reading the
      // element back would feed its own output in and collapse the box a little
      // further on every pass. Mirrors the CSS clamp for --agee-ribbon-w.
      const width = Math.min(BUBBLE_MAX_W, Math.max(BUBBLE_MIN_W, win.innerWidth * BUBBLE_VW));
      const place = Layout.ribbonPlacement({
        launcherRect: rect,
        viewportWidth: win.innerWidth,
        viewportHeight: win.innerHeight,
        ribbonWidth: width,
        gap: Layout.GAP + rimOutset(),
      });
      you.el.style.left = `${place.youLeft}px`;
      reply.el.style.left = `${place.replyLeft}px`;
      // The sides never swap, so each box's width is what absorbs a companion
      // near an edge. Writing width here overrides the CSS clamp deliberately:
      // the available space on that side of the seam is the real constraint.
      you.el.style.width = `${place.youWidth}px`;
      reply.el.style.width = `${place.replyWidth}px`;
      // Anchor each line to the edge that sits on the companion, so the words
      // hug it rather than sitting at the far end of the box.
      you.el.dataset.ageeSeam = place.youSeam;
      reply.el.dataset.ageeSeam = place.replySeam;
      // Height is capped by the space on that side, never by moving the box:
      // an expanded turn grows away from the companion until it runs out of
      // room, and then scrolls inside itself.
      you.el.style.maxHeight = `${place.youMaxHeight}px`;
      reply.el.style.maxHeight = `${place.replyMaxHeight}px`;
      you.el.style.top = "auto";
      you.el.style.bottom = `${place.youBottom}px`;
      reply.el.style.top = `${place.replyTop}px`;
      reply.el.style.bottom = "auto";
      root.classList.toggle("agee-ribbons-cramped", place.youCramped || place.replyCramped);
      auditGeometry({ positioned: true, cap: width, rect });
    }

    // ---- Geometry self-report ---------------------------------------------
    // The overlay intermittently paints a dark band the width of the page. It
    // happens on the user's pages, not a fixture, and a screenshot cannot say
    // which of three things went wrong — so the overlay measures its own paint
    // against what the layout promised and writes down every breach. The
    // measurement is deferred to the next frame because the widths written
    // just above have not been laid out yet when position() returns.
    function auditGeometry({ positioned, cap, rect }) {
      if (!Report || geometryAuditPending) return;
      geometryAuditPending = true;
      const run = () => {
        geometryAuditPending = false;
        for (const ribbon of [you, reply]) {
          // A box nobody can see has no geometry worth judging.
          if (!ribbon.el.classList.contains("agee-ribbon-live")) continue;
          const breach = Report.inspect({
            id: ribbon.el.id,
            positioned,
            boxWidth: ribbon.el.getBoundingClientRect().width,
            runWidth: ribbon.lineEl?.scrollWidth,
            maxWidth: cap,
            viewportWidth: win.innerWidth,
            launcherWidth: rect?.width,
            launcherHeight: rect?.height,
            theme: root.dataset.ageeRibbonTheme || "",
            text: (ribbon.target || ribbon.buffer || "").length,
          });
          if (!breach) continue;
          geometryBreaches = Report.append(geometryBreaches, breach, { at: Date.now() });
          // On the element, so it is readable from the page console without
          // any extension context — that is where the user is when they see it.
          root.dataset.ageeGeometry = Report.format(breach);
          root.dataset.ageeGeometryCount = String(geometryBreaches.length);
          try { onGeometryBreach(geometryBreaches); } catch {}
        }
      };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
      else run();
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
        const canGenerate = ribbon === you && row.key === "skill" && !row.available;
        if (!row.available && !canGenerate) button.disabled = true;
        if (canGenerate) {
          button.classList.add("agee-copy-generate");
          why.textContent = "Generate with plain style";
        }
        if (row.isDefault) button.classList.add("agee-copy-default");
        button.addEventListener("pointerdown", (event) => event.stopPropagation());
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (canGenerate) {
            button.disabled = true;
            why.textContent = "Generating...";
            const literal = TextModel.variantText(ribbon, "literal");
            Promise.resolve(generateWritingVariant(literal)).then((result) => {
              const text = String(result?.text || "").trim();
              if (!text) return;
              ribbon.variants.skill = text;
              ribbon.skillName = String(result?.skill_name || "plain style");
              return copy(ribbon, "skill");
            }).catch(() => {}).finally(closeCopyMenu);
            return;
          }
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
      setPageObservation,

      // The upper ribbon is the live transcription stream. An empty transcript
      // only stops the caret: the ribbon retires on its own linger timer so the
      // user can still read and copy what they said after the turn ends.
      setUser(text, { interim = false } = {}) {
        const value = String(text || "");
        if (value) {
          returnToLive();
          // A real turn taking the line ends text mode: one buffer, one owner.
          // Otherwise the caret would sit in a node the transcript is trying to
          // rewrite, and the line would freeze on whatever was typed.
          endCompose();
          // First real text ends the pending state: the dots are replaced by
          // the words, in the same ribbon, with no reflow.
          setPending(you, false);
          setText(you, value);
          setStreaming(you, !!interim);
        } else {
          setStreaming(you, false);
        }
      },

      // Open the you-ribbon before any transcript exists. Called when capture
      // opens so the unit reacts to the microphone, not to the transcriber.
      setUserPending(on) {
        if (on) {
          endCompose();
          // A new capture opens an EMPTY line. The previous turn's words sit in
          // this bubble on their linger timer by design, and putting the caret
          // behind them would read as the new sentence appending to the old
          // one — the staggered repeat the transcript path was just fixed to
          // stop, reintroduced visually. Guarded by an explicit capture flag,
          // not by the pending class: the first partial clears pending, so a
          // repeated "listening" mid-capture would otherwise wipe words that
          // have already been transcribed.
          if (!userCaptureOpen) {
            userCaptureOpen = true;
            clear(you);
          }
        } else {
          userCaptureOpen = false;
        }
        setPending(you, on);
      },

      clampLauncherInto,

      // Sync the rail to the stored preference. Never notifies back: the host
      // is the one telling us, so echoing it would rewrite storage on load.
      setVoiceReplies: (on) => setVoiceReplies(on),
      setPreferredCopyVariant(variant) {
        if (variant !== "" && !["skill", "edited", "literal"].includes(variant)) return;
        currentPreferredCopyVariant = variant;
        for (const ribbon of both) ribbon.chosenVariant = variant;
      },

      // Text mode: the you-line becomes the buffer you type into.
      beginCompose,
      endCompose,
      isComposing: () => composing,

      // Complete a copy that was deferred while the capture finalized.
      copyUserTranscript() {
        if (!pendingUserCopy) return Promise.resolve(false);
        pendingUserCopy = false;
        return copy(you, TextModel.defaultVariant(you));
      },
      cancelPendingUserCopy() {
        pendingUserCopy = false;
      },
      // Same for the reply side: the gap between committing a turn and the
      // first reply delta is where "is it thinking?" lives.
      setReplyPending: (on) => setPending(reply, on),

      // The lower ribbon is the assistant response stream, revealed at reading
      // pace. A provider that streams and one that answers in a single block
      // therefore look the same on screen: a line that fills in.
      setReply(text, { tone = "", streaming = false } = {}) {
        const value = String(text || "").trim();
        if (!value) return;
        returnToLive();
        setPending(reply, false);
        setText(reply, value, { tone, paced: true });
        setStreaming(reply, streaming || reply.buffer !== reply.target);
      },

      pushUser: (delta) => push(you, delta),
      pushReply: (delta) => push(reply, delta, { paced: true }),
      setReplyStreaming: (on) => setStreaming(reply, on),

      copyLatest() {
        if (you.target) return copy(you);
        if (reply.target) return copy(reply);
        return Promise.resolve(false);
      },

      // Freeze both ribbons and start their linger timers. A reply the device
      // never spoke has to be read, so it stays up materially longer. A reply
      // still revealing keeps its caret and parks the linger until the last
      // word is on screen — the turn is over for the gateway, not for the eye.
      endTurn({ spoken = true, error = false } = {}) {
        recordTurn();
        setStreaming(you, false);
        startLinger(you, LINGER_YOU);
        const replyLinger = error || spoken === false ? LINGER_ERROR : LINGER_REPLY;
        if (reply.revealTimer) {
          reply.lingerAfterReveal = replyLinger;
          return;
        }
        setStreaming(reply, false);
        startLinger(reply, replyLinger);
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
        if (TextModel.shouldAdoptPresentationText(you.target, presentation.user_text, isOwner)) {
          endCompose();
          setText(you, presentation.user_text);
        }
        if (TextModel.shouldAdoptPresentationText(reply.target, presentation.response_text, isOwner)) {
          setText(reply, presentation.response_text, { tone: status === "error" ? "warn" : "", paced: true });
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
