(() => {
  function create({ launcher, stopButton, storageGet, storageSet, win = globalThis }) {
    let explicitlyRevealed = false;

    function reveal() {
      explicitlyRevealed = true;
      launcher.hidden = false;
      storageSet({ ageeLauncherHidden: false }).catch(() => {});
    }

    function restoreVisibility(isOpen) {
      storageGet({ ageeLauncherHidden: false }).then(({ ageeLauncherHidden }) => {
        if (!isOpen() && !explicitlyRevealed) launcher.hidden = ageeLauncherHidden === true;
      }).catch(() => {});
    }

    function positionStop() {
      if (!stopButton.classList.contains("visible")) {
        const draft = launcher.parentElement?.querySelector("#agee-draft-controls:not([hidden])");
        if (!draft) launcher.parentElement?.classList.remove("agee-control-layout-impossible");
        return;
      }
      const mark = launcher.getBoundingClientRect();
      const control = stopButton.getBoundingClientRect();
      const draft = launcher.parentElement?.querySelector("#agee-draft-controls:not([hidden])");
      const draftRect = draft?.getBoundingClientRect();
      const layout = win.AgeeRibbonLayout.companionControlPlacement({
        launcherRect: mark,
        viewportWidth: win.innerWidth,
        viewportHeight: win.innerHeight,
        controls: [
          ...(draftRect?.width ? [{ id: "draft", width: draftRect.width, height: draftRect.height }] : []),
          { id: "stop", width: control.width, height: control.height },
        ],
      });
      launcher.parentElement?.classList.toggle("agee-control-layout-impossible", layout.impossible === true);
      for (const placement of layout.placements) {
        const target = placement.id === "draft" ? draft : stopButton;
        if (!target) continue;
        target.style.left = `${placement.left}px`;
        target.style.top = `${placement.top}px`;
      }
    }

    function syncStop(active) {
      stopButton.classList.toggle("visible", active === true);
      positionStop();
      launcher.parentElement?.dispatchEvent(new win.CustomEvent("agee:position-companion-controls"));
    }

    launcher.parentElement?.addEventListener("agee:position-companion-controls", positionStop);

    return Object.freeze({ positionStop, restoreVisibility, reveal, syncStop });
  }

  globalThis.AgeeBrowserSurfaceControls = Object.freeze({ create });
})();
