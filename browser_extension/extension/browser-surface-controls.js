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
      if (!stopButton.classList.contains("visible")) return;
      const mark = launcher.getBoundingClientRect();
      const control = stopButton.getBoundingClientRect();
      const gap = 8;
      let left = mark.right + gap;
      if (left + control.width > win.innerWidth - 8) left = mark.left - control.width - gap;
      stopButton.style.left = `${Math.max(8, Math.round(left))}px`;
      stopButton.style.top = `${Math.max(8, Math.min(win.innerHeight - control.height - 8, Math.round(mark.top + (mark.height - control.height) / 2)))}px`;
    }

    function syncStop(active) {
      stopButton.classList.toggle("visible", active === true);
      positionStop();
    }

    return Object.freeze({ positionStop, restoreVisibility, reveal, syncStop });
  }

  globalThis.AgeeBrowserSurfaceControls = Object.freeze({ create });
})();
