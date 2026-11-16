/**
 * The menus are native modal dialogs, and `.hidden` is still the switch.
 *
 * Every screen — the menu, the briefing, the armoury, pause and game over —
 * is a `<dialog class="overlay">`. Shown, it is opened with `showModal()`,
 * which is what a div could not do: focus goes into it and stays there, the
 * HUD and the canvas behind it are inert to the keyboard and to a screen
 * reader, and it sits in the top layer over everything without a z-index.
 *
 * The game has always shown and hidden a screen by its `hidden` class, and so
 * do the checks, so that stays the one source of truth. `showScreen` sets it
 * and opens or closes the dialog at once (a resume must close pause before it
 * asks for the mouse); a class change made anywhere else is caught by an
 * observer and followed a microtask later.
 *
 * Esc on a modal dialog would close it by itself, out from under the game's
 * state. Its `cancel` is refused, and the keydown still reaches the game's own
 * handlers, which decide (resume, close the armoury). Where the browser closes
 * it anyway — a second Esc without a gesture is allowed to — it is opened
 * again while the game still says it is showing.
 *
 * The frame-rate readout is a manual popover, and is put back on top each
 * time a screen opens, so "Show frame rate" in the pause menu still shows it.
 */

const sync = (d) => {
  const want = !d.classList.contains('hidden');
  if (want && !d.open) {
    try { d.showModal(); } catch { d.setAttribute('open', ''); }
    // Opening focuses the first button, which scrolls a tall screen down to
    // it on a short window; a screen is read from its top.
    d.scrollTop = 0;
    raisePopovers();
  } else if (!want && d.open) {
    d.close();
  }
};

/** Re-show every open manual popover, so it is the newest in the top layer. */
export function raisePopovers() {
  for (const p of document.querySelectorAll('[popover]')) {
    try {
      if (p.matches(':popover-open')) { p.hidePopover(); p.showPopover(); }
    } catch { /* no popover support: it is an ordinary element */ }
  }
}

/** Wire every screen up; open whichever are already showing. */
export function bindScreens() {
  for (const d of document.querySelectorAll('dialog.overlay')) {
    new MutationObserver(() => sync(d)).observe(d, { attributes: true, attributeFilter: ['class'] });
    d.addEventListener('cancel', (e) => e.preventDefault());
    d.addEventListener('close', () => { if (!d.classList.contains('hidden')) queueMicrotask(() => sync(d)); });
    sync(d);
  }
}

/** Show or hide a screen by id, now. */
export function showScreen(id, on) {
  const d = document.getElementById(id);
  if (!d) return;
  d.classList.toggle('hidden', !on);
  sync(d);
}
