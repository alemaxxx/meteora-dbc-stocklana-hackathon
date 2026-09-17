// Kit de UI compartilhado (toast + modal de confirmação) - carregado ANTES
// de hype.js/volumeBotPanel.js/main.js (ver index.html), expõe window.toast
// e window.confirmDialog como globais simples, mesmo padrão dos outros
// scripts da tela (sem módulos, sem build step).
//
// Motivo de existir (15/09/2026): o resto do app já dava feedback inline
// (.modal__error/.modal__success, pills, botões que mudam de texto) - só o
// fluxo do Meteora DBC (BETA) usava window.alert/window.confirm nativos,
// que destoam MUITO visualmente do resto (janela do navegador, sem
// nenhum estilo). Generalizado aqui pra também cobrir os dois
// window.confirm de "valor grande, tem certeza?" que já existiam desde
// antes (achado ao vivo em 12/09/2026) - mesmo texto/comportamento, só a
// aparência muda.
(function () {
  const ICONS = {
    success: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5"/><path d="M6 10.5l2.5 2.5L14 7.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    error: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5"/><path d="M7 7l6 6M13 7l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    warning: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 2.5l8.5 14.7H1.5L10 2.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M10 8v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="10" cy="14.6" r="0.9" fill="currentColor"/></svg>',
    info: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5"/><path d="M10 9v4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="10" cy="6.3" r="1" fill="currentColor"/></svg>',
  };

  // Scripts ficam no fim do <body> (ver index.html) - o body já existe
  // nesse ponto, mesmo padrão de injeção direta que o fees-modal de
  // hype.js já usa (document.body.insertAdjacentHTML), sem precisar
  // esperar DOMContentLoaded.
  document.body.insertAdjacentHTML("beforeend", '<div class="toast-stack" role="status" aria-live="polite"></div>');
  const stack = document.querySelector(".toast-stack");

  /**
   * Mostra uma notificação temporária, canto inferior direito. `type`:
   * "success" | "error" | "warning" | "info" (padrão). `duration` em ms,
   * 0 = não some sozinha (só no clique do X).
   */
  function toast(message, { type = "info", duration = 5000 } = {}) {
    const el = document.createElement("div");
    el.className = `toast toast--${type}`;
    el.innerHTML = `
      <span class="toast__icon">${ICONS[type] ?? ICONS.info}</span>
      <span class="toast__msg"></span>
      <button type="button" class="toast__close" aria-label="Fechar">×</button>
    `;
    el.querySelector(".toast__msg").textContent = message; // textContent de propósito - message pode conter endereço/erro cru, nunca HTML
    stack.appendChild(el);
    requestAnimationFrame(() => el.classList.add("is-visible"));

    let timer = null;
    const remove = () => {
      el.classList.remove("is-visible");
      setTimeout(() => el.remove(), 200);
    };
    el.querySelector(".toast__close").addEventListener("click", remove);
    if (duration > 0) timer = setTimeout(remove, duration);
    // Pausa a auto-remoção enquanto o mouse tá em cima - notificação de erro
    // longa não deve sumir bem na hora que o usuário for ler.
    el.addEventListener("mouseenter", () => timer && clearTimeout(timer));
    el.addEventListener("mouseleave", () => {
      if (duration > 0) timer = setTimeout(remove, 1500);
    });
    return { close: remove };
  }

  /**
   * Modal de confirmação assíncrono - substitui window.confirm() com a
   * mesma estética de .modal-overlay/.modal já usada no resto do app.
   * Resolve `true` (confirmou) ou `false` (cancelou/Esc/clicou fora).
   */
  function confirmDialog(message, { title = "Confirmar ação", confirmText = "Confirmar", cancelText = "Cancelar", danger = false } = {}) {
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

  window.toast = toast;
  window.confirmDialog = confirmDialog;
})();
