// Shared UI kit (toast + confirmation modal) - loaded BEFORE main.js/app.js
// (see index.html), exposes window.toast and window.confirmDialog as
// simple globals, same pattern as the other scripts on the page (no
// modules, no build step).
//
// Why this exists (2026-09-15): the rest of the app already gave inline
// feedback (.modal__error/.modal__success, pills, buttons that change
// text) - only the Meteora DBC flow (BETA) used native
// window.alert/window.confirm, which clash A LOT visually with the rest
// (bare browser window, no styling). Generalized here to also cover the
// two "large value, are you sure?" window.confirm calls that already
// existed before (found live on 2026-09-12) - same text/behavior, only the
// look changes.
(function () {
  const ICONS = {
    success: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5"/><path d="M6 10.5l2.5 2.5L14 7.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    error: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5"/><path d="M7 7l6 6M13 7l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    warning: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 2.5l8.5 14.7H1.5L10 2.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M10 8v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="10" cy="14.6" r="0.9" fill="currentColor"/></svg>',
    info: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5"/><path d="M10 9v4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="10" cy="6.3" r="1" fill="currentColor"/></svg>',
  };

  // Scripts sit at the end of <body> (see index.html) - the body already
  // exists at this point, same direct-injection pattern already used
  // elsewhere (document.body.insertAdjacentHTML), no need to wait for
  // DOMContentLoaded.
  document.body.insertAdjacentHTML("beforeend", '<div class="toast-stack" role="status" aria-live="polite"></div>');
  const stack = document.querySelector(".toast-stack");

  /**
   * Shows a temporary notification, bottom-right corner. `type`:
   * "success" | "error" | "warning" | "info" (default). `duration` in ms,
   * 0 = doesn't auto-dismiss (only on the X click).
   */
  function toast(message, { type = "info", duration = 5000 } = {}) {
    const el = document.createElement("div");
    el.className = `toast toast--${type}`;
    el.innerHTML = `
      <span class="toast__icon">${ICONS[type] ?? ICONS.info}</span>
      <span class="toast__msg"></span>
      <button type="button" class="toast__close" aria-label="Close">×</button>
    `;
    el.querySelector(".toast__msg").textContent = message; // textContent on purpose - message may contain a raw address/error, never HTML
    stack.appendChild(el);
    requestAnimationFrame(() => el.classList.add("is-visible"));

    let timer = null;
    const remove = () => {
      el.classList.remove("is-visible");
      setTimeout(() => el.remove(), 200);
    };
    el.querySelector(".toast__close").addEventListener("click", remove);
    if (duration > 0) timer = setTimeout(remove, duration);
    // Pause auto-removal while the mouse is over it - a long error
    // notification shouldn't vanish right as the user goes to read it.
    el.addEventListener("mouseenter", () => timer && clearTimeout(timer));
    el.addEventListener("mouseleave", () => {
      if (duration > 0) timer = setTimeout(remove, 1500);
    });
    return { close: remove };
  }

  /**
   * Async confirmation modal - replaces window.confirm() with the same
   * look as the .modal-overlay/.modal already used elsewhere in the app.
   * Resolves `true` (confirmed) or `false` (cancelled/Esc/clicked outside).
   */
  function confirmDialog(message, { title = "Confirm action", confirmText = "Confirm", cancelText = "Cancel", danger = false } = {}) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay confirm-overlay";
      overlay.innerHTML = `
        <div class="modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-modal-title">
          <div class="modal__header">
            <h2 id="confirm-modal-title"></h2>
          </div>
          <div class="modal__body">
            <p class="confirm-modal__message"></p>
          </div>
          <div class="modal__footer">
            <button type="button" class="btn-secondary confirm-modal__cancel"></button>
            <button type="button" class="${danger ? "btn-danger" : "btn-primary"} confirm-modal__ok"></button>
          </div>
        </div>
      `;
      overlay.querySelector("h2").textContent = title;
      overlay.querySelector(".confirm-modal__message").textContent = message;
      overlay.querySelector(".confirm-modal__cancel").textContent = cancelText;
      overlay.querySelector(".confirm-modal__ok").textContent = confirmText;
      document.body.appendChild(overlay);

      const okBtn = overlay.querySelector(".confirm-modal__ok");
      okBtn.focus();

      function onKeydown(ev) {
        if (ev.key === "Escape") settle(false);
        if (ev.key === "Enter") settle(true);
      }
      function settle(result) {
        document.removeEventListener("keydown", onKeydown);
        overlay.remove();
        resolve(result);
      }
      overlay.querySelector(".confirm-modal__cancel").addEventListener("click", () => settle(false));
      okBtn.addEventListener("click", () => settle(true));
      overlay.addEventListener("click", (ev) => {
        if (ev.target === overlay) settle(false);
      });
      document.addEventListener("keydown", onKeydown);
    });
  }

  /**
   * Lets the user pick one of several detected wallets (Phantom, Solflare,
   * Backpack, ...) - same modal look as confirmDialog. Resolves the
   * chosen wallet object, or null if cancelled/Esc/clicked outside.
   */
  function walletPickerDialog(wallets) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay confirm-overlay";
      overlay.innerHTML = `
        <div class="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-picker-title">
          <div class="modal__header">
            <h2 id="wallet-picker-title">Choose a wallet</h2>
          </div>
          <div class="modal__body">
            <div class="wallet-picker"></div>
          </div>
          <div class="modal__footer">
            <button type="button" class="btn-secondary wallet-picker__cancel">Cancel</button>
          </div>
        </div>
      `;
      const list = overlay.querySelector(".wallet-picker");
      wallets.forEach((wallet, i) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "wallet-picker__item";
        btn.dataset.index = String(i);
        btn.innerHTML = `<img src="${wallet.icon}" alt="" /><span></span>`;
        btn.querySelector("span").textContent = wallet.name; // textContent on purpose - wallet name comes from the extension, never trust as HTML
        list.appendChild(btn);
      });
      document.body.appendChild(overlay);

      function settle(result) {
        document.removeEventListener("keydown", onKeydown);
        overlay.remove();
        resolve(result);
      }
      function onKeydown(ev) {
        if (ev.key === "Escape") settle(null);
      }
      list.addEventListener("click", (ev) => {
        const item = ev.target.closest(".wallet-picker__item");
        if (item) settle(wallets[Number(item.dataset.index)]);
      });
      overlay.querySelector(".wallet-picker__cancel").addEventListener("click", () => settle(null));
      overlay.addEventListener("click", (ev) => {
        if (ev.target === overlay) settle(null);
      });
      document.addEventListener("keydown", onKeydown);
    });
  }

  window.toast = toast;
  window.confirmDialog = confirmDialog;
  window.walletPickerDialog = walletPickerDialog;
})();
