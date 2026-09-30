// Shared top-nav "Connect Wallet" button (2026-09-30, part of the
// multi-page site: Home / Launch / Explore / Docs each have their own
// copy of the nav markup, but this one script drives the wallet button
// on all of them - so a page like Explore can read the connected wallet
// (for a future "My tokens" filter) without reimplementing the whole
// connect flow, and Launch's app.js reads it instead of owning its own
// copy. Needs uiKit.js (toast/walletPickerDialog), main.js (shortAddr)
// and walletConnect.js (window.WalletConnect) loaded first - see each
// page's <script> order.
(function () {
  const btn = document.getElementById("wallet-connect-btn");
  if (!btn) return;

  const state = { address: null, handle: null };
  const listeners = [];

  function setConnected(address, handle) {
    state.address = address;
    state.handle = handle;
    listeners.forEach((cb) => cb(state));
  }

  async function connectWallet() {
    const wallets = window.WalletConnect?.listWallets() ?? [];
    if (!wallets.length) {
      window.toast?.("No Solana wallet detected - install Phantom, Solflare, Backpack or another Wallet-Standard wallet and reload.", { type: "error", duration: 8000 });
      return;
    }
    const wallet = wallets.length === 1 ? wallets[0] : await window.walletPickerDialog(wallets);
    if (!wallet) return;
    try {
      const { address, account } = await window.WalletConnect.connect(wallet);
      setConnected(address, { wallet, account });
      btn.textContent = `${wallet.name}: ${window.shortAddr(address)}`;
      btn.classList.add("is-connected");
    } catch (err) {
      window.toast?.(`Wallet connection failed: ${err.message}`, { type: "error" });
    }
  }

  btn.addEventListener("click", () => {
    if (!state.address) connectWallet();
  });

  // Read via window.CurveForgeWallet.address / .handle - .handle is the
  // {wallet, account} pair signTransaction needs later (see
  // walletConnect.js), kept private here so every page doesn't need to
  // re-derive it.
  window.CurveForgeWallet = {
    get address() {
      return state.address;
    },
    get handle() {
      return state.handle;
    },
    onChange(cb) {
      listeners.push(cb);
    },
  };
})();
