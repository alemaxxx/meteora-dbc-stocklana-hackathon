// Generic "copy" button (wallet/mint address) - delegated on document
// because it appears in table rows that get recreated on every refresh
// (app.js). Needs uiKit.js (toast) already loaded - see <script> order in
// index.html.
document.addEventListener("click", (ev) => {
  const btn = ev.target.closest(".copy-btn");
  if (!btn) return;
  const value = btn.dataset.copy;
  if (!value) return;
  navigator.clipboard
    .writeText(value)
    .then(() => window.toast?.("Copied to clipboard.", { type: "success", duration: 2500 }))
    .catch(() => window.toast?.("Couldn't copy - copy it manually.", { type: "error" }));
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
    el.innerHTML = `${data.solBalance.toFixed(4)} SOL <span class="mono" title="${data.address}">(${shortAddr(data.address)})</span> <button type="button" class="copy-btn" data-copy="${data.address}" title="Copy wallet address" aria-label="Copy wallet address">⧉</button>`;
  } catch (err) {
    el.textContent = "error";
    el.title = err.message;
  }
}
window.refreshWalletBalance = refreshWalletBalance;
refreshWalletBalance();
setInterval(refreshWalletBalance, 30000);
