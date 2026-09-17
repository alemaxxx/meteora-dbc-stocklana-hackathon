// Botão "copiar" genérico (endereço de wallet/mint) - delegado no document
// porque aparece em linhas de tabela recriadas a cada refresh (app.js).
// Precisa de uiKit.js (toast) já carregado antes - ver ordem dos <script>
// no index.html.
document.addEventListener("click", (ev) => {
  const btn = ev.target.closest(".copy-btn");
  if (!btn) return;
  const value = btn.dataset.copy;
  if (!value) return;
  navigator.clipboard
    .writeText(value)
    .then(() => window.toast?.("Copiado para a área de transferência.", { type: "success", duration: 2500 }))
    .catch(() => window.toast?.("Não consegui copiar - copie manualmente.", { type: "error" }));
});

function shortAddr(addr, size = 4) {
  if (!addr) return "—";
  return `${addr.slice(0, size)}…${addr.slice(-size)}`;
}
window.shortAddr = shortAddr;

async function refreshWalletBalance() {
  const el = document.getElementById("wallet-balance-value");
  if (!el) return;
  try {
    const res = await fetch("/api/wallet/balance");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    el.innerHTML = `${data.solBalance.toFixed(4)} SOL <span class="mono" title="${data.address}">(${shortAddr(data.address)})</span> <button type="button" class="copy-btn" data-copy="${data.address}" title="Copiar endereço da wallet" aria-label="Copiar endereço da wallet">⧉</button>`;
  } catch (err) {
    el.textContent = "erro";
    el.title = err.message;
  }
}
window.refreshWalletBalance = refreshWalletBalance;
refreshWalletBalance();
setInterval(refreshWalletBalance, 30000);
