(function () {
  const els = {
    image: document.getElementById("launch-image"),
    imageUploadBtn: document.getElementById("launch-image-upload-btn"),
    imageFileInput: document.getElementById("launch-image-file"),
    name: document.getElementById("launch-name"),
    symbol: document.getElementById("launch-symbol"),
    presetChips: document.getElementById("preset-chips"),
    presetHint: document.getElementById("preset-hint"),
    firstBuy: document.getElementById("launch-firstbuy"),
    firstBuyLabel: document.getElementById("launch-firstbuy-label"),
    error: document.getElementById("launch-error"),
    success: document.getElementById("launch-success"),
    confirmBtn: document.getElementById("launch-confirm-btn"),
    launchedRows: document.getElementById("launched-rows"),
    launchedEmpty: document.getElementById("launched-empty"),
    walletConnectBtn: document.getElementById("wallet-connect-btn"),
  };

  let allPresets = [];
  let selectedPresetId = null;
  let selectedPythSymbol = null;
  let imageDataUrl = null;
  let connectedWallet = null; // base58 address of the browser wallet paying for launches
  let connectedWalletHandle = null; // { wallet, account } pair from walletConnect.js, needed to sign later
  const LARGE_SOL_THRESHOLD = 0.5; // same "fat finger" guard from the original Lançar Token Bot

  // ---- wallet connect (any Wallet Standard wallet - Phantom, Solflare,
  // Backpack, ...; see public/walletConnect.js) - launching pays from and
  // is owned by THIS wallet, never the platform one (see
  // DBC-MIGRATION-PLAN.md section 5.7 for why this exists: the app used
  // to have no auth at all, so anyone with the URL could spend the
  // platform wallet's real SOL just by clicking Launch). ----
  async function connectWallet() {
    const wallets = window.WalletConnect?.listWallets() ?? [];
    if (!wallets.length) {
      toast("No Solana wallet detected - install Phantom, Solflare, Backpack or another Wallet-Standard wallet and reload.", { type: "error", duration: 8000 });
      return;
    }
    const wallet = wallets.length === 1 ? wallets[0] : await walletPickerDialog(wallets);
    if (!wallet) return;
    try {
      const { address, account } = await window.WalletConnect.connect(wallet);
      connectedWallet = address;
      connectedWalletHandle = { wallet, account };
      els.walletConnectBtn.textContent = `${wallet.name}: ${shortAddr(address)}`;
      els.walletConnectBtn.classList.add("is-connected");
    } catch (err) {
      toast(`Wallet connection failed: ${err.message}`, { type: "error" });
    }
  }
  els.walletConnectBtn.addEventListener("click", () => {
    if (!connectedWallet) connectWallet();
  });

  // Escapes text before it goes into an innerHTML template - found live
  // (2026-09-20, pre-launch security review): renderRow() below used to
  // interpolate token.name/token.symbol straight from the PUBLIC launch
  // form with no escaping, so anyone could launch a token named e.g.
  // `<img src=x onerror=...>` and have it execute in every visitor's
  // browser who loads the launched-tokens table - a stored XSS, and a
  // serious one on a wallet-connected page (injected JS could try to
  // trick a connected wallet into approving something).
  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function meteoraLink(poolAddress) {
    return `https://app.meteora.ag/dammv2/${poolAddress}`;
  }
  // A DBC pool (pre-migration) isn't a DAMM v2 pool yet - meteoraLink() only
  // applies after migration. Before that, link to the generic explorer.
  function solscanLink(address) {
    return `https://solscan.io/account/${address}`;
  }
  function formatShortTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  // ---- image (upload or Ctrl+V) ----
  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  els.imageUploadBtn.addEventListener("click", () => els.imageFileInput.click());
  els.imageFileInput.addEventListener("change", async () => {
    const file = els.imageFileInput.files?.[0];
    if (!file) return;
    imageDataUrl = await readFileAsDataUrl(file);
    els.image.src = imageDataUrl;
  });
  document.addEventListener("paste", async (ev) => {
    const item = [...(ev.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    imageDataUrl = await readFileAsDataUrl(file);
    els.image.src = imageDataUrl;
  });

  // ---- curve presets (fixed SOL presets + Pyth-anchored ones) ----
  async function loadPresets() {
    try {
      const res = await fetch("/api/dbc-presets");
      const data = await res.json();
      allPresets = data.presets ?? [];
      let chipsHtml = allPresets
        .map((p) => `<button type="button" class="token-chip" data-preset="${p.id}">${p.label.split(" - ")[0]}</button>`)
        .join("");

      // Pyth-anchored chips are a SEPARATE, static list (no live Pyth call
      // here) so they always render even if Pyth itself is unreachable or
      // this project's trial key has expired - only picking one triggers
      // a live fetch (see selectPythSymbol below), which fails gracefully
      // on its own.
      try {
        const pythRes = await fetch("/api/pyth-presets");
        const pythData = await pythRes.json();
        chipsHtml += (pythData.symbols ?? [])
          .map((s) => `<button type="button" class="token-chip token-chip--pyth" data-pyth="${s.symbol}">🔴 Live: ${s.label}</button>`)
          .join("");
      } catch (err) {
        console.error("Failed to load Pyth-anchored presets:", err);
      }

      els.presetChips.innerHTML = chipsHtml;
      if (allPresets.length > 0) selectPreset(allPresets[0].id);
    } catch (err) {
      console.error("Failed to load presets:", err);
    }
  }

  function markSelectedChip(matcher) {
    els.presetChips.querySelectorAll(".token-chip").forEach((c) => {
      c.classList.toggle("is-selected", matcher(c));
    });
  }

  function selectPreset(id) {
    selectedPresetId = id;
    selectedPythSymbol = null;
    markSelectedChip((c) => c.dataset.preset === id);
    const preset = allPresets.find((p) => p.id === id);
    els.presetHint.textContent = preset?.label ?? "";
    // Presets quoted in a real xStock (see dbcConfig.js's "stock-quoted-*"
    // presets, 2026-09-22) trade against that stock directly, not SOL -
    // the initial-buy field's label needs to reflect that or "0.05" would
    // look like SOL when it's actually 0.05 of a real tokenized share.
    els.firstBuyLabel.textContent = `${preset?.quoteSymbol ?? "SOL"} for initial buy (optional)`;
  }

  async function selectPythSymbol(symbol) {
    selectedPresetId = null;
    selectedPythSymbol = symbol;
    markSelectedChip((c) => c.dataset.pyth === symbol);
    els.firstBuyLabel.textContent = "SOL for initial buy (optional)";
    els.presetHint.textContent = `Fetching ${symbol}'s live price from Pyth…`;
    try {
      const res = await fetch(`/api/pyth-presets/${encodeURIComponent(symbol)}/preview`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      // selection may have moved on to something else while this was in flight
      if (selectedPythSymbol !== symbol) return;
      els.presetHint.textContent =
        `${symbol} @ $${data.stockUsd.toFixed(2)} (SOL @ $${data.solUsd.toFixed(2)}) - ` +
        `curve migrates at ${data.migrationMarketCap.toFixed(4)} SOL, anchored to this live price.`;
    } catch (err) {
      if (selectedPythSymbol !== symbol) return;
      els.presetHint.textContent = `Couldn't fetch ${symbol}'s live Pyth price (${err.message}). Pick a different preset.`;
    }
  }

  els.presetChips.addEventListener("click", (ev) => {
    const chip = ev.target.closest(".token-chip");
    if (!chip) return;
    if (chip.dataset.pyth) selectPythSymbol(chip.dataset.pyth);
    else selectPreset(chip.dataset.preset);
  });

  // ---- launch ----
  els.confirmBtn.addEventListener("click", async () => {
    els.error.hidden = true;
    els.success.hidden = true;

    const name = els.name.value.trim();
    const symbol = els.symbol.value.trim().toUpperCase();

    if (!name || !symbol) {
      els.error.textContent = "Fill in name and symbol.";
      els.error.hidden = false;
      return;
    }
    if (!imageDataUrl) {
      els.error.textContent = "Choose an image for the token (upload or Ctrl+V).";
      els.error.hidden = false;
      return;
    }
    if (!selectedPresetId && !selectedPythSymbol) {
      els.error.textContent = "No curve preset available - check /api/dbc-presets.";
      els.error.hidden = false;
      return;
    }
    if (!connectedWallet) {
      els.error.textContent = "Connect a wallet first - it pays for and owns the new token.";
      els.error.hidden = false;
      return;
    }

    let firstBuySolUi;
    const rawFirstBuy = els.firstBuy.value.trim();
    if (rawFirstBuy) {
      if (Number(rawFirstBuy) <= 0) {
        els.error.textContent = "If you set an initial buy, it needs to be greater than zero (or leave it empty).";
        els.error.hidden = false;
        return;
      }
      const preset = allPresets.find((p) => p.id === selectedPresetId);
      const quoteSymbol = preset?.quoteSymbol ?? "SOL";
      if (quoteSymbol === "SOL" && Number(rawFirstBuy) > LARGE_SOL_THRESHOLD) {
        const ok = await confirmDialog(
          `You entered ${rawFirstBuy} SOL for the initial buy - that's well above what's normal for this field. Are you sure this isn't a mistake?`,
          { title: "Unusual value", confirmText: "Confirm anyway", danger: true }
        );
        if (!ok) return;
      }
      firstBuySolUi = Number(rawFirstBuy);
    }

    const confirmed = await confirmDialog(
      `This sends a real on-chain transaction (mint + Meteora DBC curve), paid for by your connected wallet (${shortAddr(connectedWallet)}). Double-check name, symbol and values.`,
      { title: "Launch token?", confirmText: "Launch", danger: true }
    );
    if (!confirmed) return;

    els.confirmBtn.disabled = true;
    els.confirmBtn.textContent = "Preparing…";

    try {
      // Phase 1: server builds the transaction (paid for by connectedWallet)
      // and partially signs it with the new mint's own required keypair -
      // no SOL moves yet.
      const prepRes = await fetch("/api/launch/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          symbol,
          imageDataUrl,
          presetId: selectedPresetId,
          pythSymbol: selectedPythSymbol,
          firstBuySolUi,
          creatorPublicKey: connectedWallet,
        }),
      });
      const prepData = await prepRes.json();
      if (!prepRes.ok) throw new Error(prepData.error ?? `HTTP ${prepRes.status}`);

      // Phase 2: the connected wallet completes the signature - this is
      // the step the user actually approves in their wallet's popup. The
      // transaction already carries the mint's own signature (added by
      // the server) - serializing with requireAllSignatures: false keeps
      // it intact for the wallet to add its own alongside.
      els.confirmBtn.textContent = "Approve in your wallet…";
      const txBytes = Uint8Array.from(atob(prepData.transactionBase64), (c) => c.charCodeAt(0));
      const tx = solanaWeb3.Transaction.from(txBytes);
      const unsignedBytes = tx.serialize({ requireAllSignatures: false });
      const signedBytes = await window.WalletConnect.signTransaction(connectedWalletHandle.wallet, connectedWalletHandle.account, unsignedBytes);
      let binary = "";
      for (const b of signedBytes) binary += String.fromCharCode(b);
      const signedTransactionBase64 = btoa(binary);

      els.confirmBtn.textContent = "Confirming on-chain…";
      const subRes = await fetch("/api/launch/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: prepData.id, signedTransactionBase64 }),
      });
      const data = await subRes.json();
      if (!subRes.ok) throw new Error(data.error ?? `HTTP ${subRes.status}`);

      els.success.innerHTML = `Token launched! Mint: <span class="mono">${data.mint}</span> · Pool: <a href="${solscanLink(data.poolAddress)}" target="_blank" rel="noopener" class="sf-meteora-link">DBC curve ↗</a>`;
      els.success.hidden = false;
      refreshLaunchedTokens();
    } catch (err) {
      els.error.textContent = err.message;
      els.error.hidden = false;
    } finally {
      els.confirmBtn.disabled = false;
      els.confirmBtn.textContent = "Launch Token";
    }
  });

  // ---- launched tokens table ----
  function renderRow(token) {
    const tr = document.createElement("tr");
    const statusHtml =
      token.status === "success"
        ? `<span class="pill pill--success">created</span>`
        : token.status === "error"
          ? `<span class="pill pill--error" title="${escapeHtml(token.error)}">error</span>`
          : `<span class="pill pill--pending">pending</span>`;

    let poolCell = "—";
    if (token.poolAddress) {
      if (token.dbcMigrated) {
        poolCell = `<a class="sf-meteora-link" href="${meteoraLink(token.poolAddress)}" target="_blank" rel="noopener" title="${token.poolAddress}">open on Meteora ↗</a>
          <span class="fee-rate__base">migrated to DAMM v2</span>
          <div class="dbc-actions">
            <button type="button" class="sf-action-btn dbc-claim-btn" data-id="${token.id}">Claim fees</button>
          </div>`;
      } else {
        poolCell = `<a class="sf-meteora-link" href="${solscanLink(token.poolAddress)}" target="_blank" rel="noopener" title="${token.poolAddress}">DBC curve ↗</a>
          <div class="dbc-actions">
            <button type="button" class="sf-action-btn dbc-progress-btn" data-id="${token.id}">View progress</button>
            <button type="button" class="sf-action-btn dbc-migrate-btn" data-id="${token.id}">Migrate to DAMM v2</button>
            <button type="button" class="sf-action-btn dbc-claim-btn" data-id="${token.id}">Claim fees</button>
          </div>`;
      }
    }

    const preset = allPresets.find((p) => p.id === token.presetId);
    const presetLabel = token.pythSymbol
      ? `🔴 Live: ${token.pythSymbol} (Pyth-anchored)`
      : (preset ? preset.label.split(" - ")[0] : token.presetId ?? "—");
    tr.innerHTML = `
      <td>
        <span class="pool-name">${escapeHtml(token.name ?? "?")}${token.symbol ? ` (${escapeHtml(token.symbol)})` : ""}</span>
        <span class="pool-addr">${token.mint ? shortAddr(token.mint) : "—"}${token.mint ? `<button type="button" class="copy-btn" data-copy="${token.mint}" title="Copy mint">⧉</button>` : ""}</span>
      </td>
      <td class="mono">${presetLabel}</td>
      <td class="mono">${formatShortTime(token.createdAt)}</td>
      <td>${statusHtml}</td>
      <td>${poolCell}</td>
    `;
    return tr;
  }

  async function refreshLaunchedTokens() {
    try {
      const res = await fetch("/api/launched-tokens");
      const data = await res.json();
      const tokens = data.tokens ?? [];
      els.launchedRows.innerHTML = "";
      els.launchedEmpty.hidden = tokens.length > 0;
      for (const t of tokens) els.launchedRows.appendChild(renderRow(t));
    } catch (err) {
      console.error("Failed to list launched tokens:", err);
    }
  }

  // ---- DBC actions (progress/migrate/claim) - always click-triggered ----
  document.addEventListener("click", async (ev) => {
    const progressBtn = ev.target.closest(".dbc-progress-btn");
    if (progressBtn) {
      const original = progressBtn.textContent;
      progressBtn.disabled = true;
      progressBtn.textContent = "Checking…";
      try {
        const res = await fetch(`/api/launched-tokens/${encodeURIComponent(progressBtn.dataset.id)}/progress`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        toast(`Curve progress: ${(data.progress * 100).toFixed(1)}% of the migration threshold.`, { type: "info" });
      } catch (err) {
        toast(`Failed to check progress: ${err.message}`, { type: "error", duration: 8000 });
      } finally {
        progressBtn.disabled = false;
        progressBtn.textContent = original;
      }
      return;
    }

    const migrateBtn = ev.target.closest(".dbc-migrate-btn");
    if (migrateBtn) {
      const confirmed = await confirmDialog(
        "Only works (and only spends SOL) if the curve has already reached the preset's threshold - otherwise it does nothing.",
        { title: "Migrate to a real DAMM v2 pool?", confirmText: "Migrate", danger: true }
      );
      if (!confirmed) return;
      const original = migrateBtn.textContent;
      migrateBtn.disabled = true;
      migrateBtn.textContent = "Migrating…";
      try {
        const res = await fetch(`/api/launched-tokens/${encodeURIComponent(migrateBtn.dataset.id)}/migrate`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        if (data.migrated) {
          toast(`Migrated! DAMM v2 pool: ${data.newPoolAddress ?? "(address not computed, check the transaction)"}`, { type: "success", duration: 10000 });
          refreshLaunchedTokens();
        } else if (data.alreadyMigrated) {
          toast("This pool had already been migrated.", { type: "info" });
          refreshLaunchedTokens();
        } else {
          toast(`Hasn't reached the migration threshold yet (progress: ${((data.progress ?? 0) * 100).toFixed(1)}%).`, { type: "warning" });
        }
      } catch (err) {
        toast(`Failed to migrate: ${err.message}`, { type: "error", duration: 8000 });
      } finally {
        migrateBtn.disabled = false;
        migrateBtn.textContent = original;
      }
      return;
    }

    const claimBtn = ev.target.closest(".dbc-claim-btn");
    if (claimBtn) {
      // Two independent claims - partner (always the platform wallet,
      // server-signed) and creator (whoever actually launched this token,
      // must sign themselves - see the bug note on
      // prepareClaimCreatorFeeTransaction in src/dbcMigration.js: the DBC
      // program requires the creator's own signature, so this can only
      // ever work for the wallet connected right now). Reported
      // separately since one can succeed while the other fails (e.g. the
      // wrong wallet is connected, or one side has nothing to claim).
      const id = claimBtn.dataset.id;
      const original = claimBtn.textContent;
      claimBtn.disabled = true;
      claimBtn.textContent = "Claiming…";
      const results = [];
      try {
        const partnerRes = await fetch(`/api/launched-tokens/${encodeURIComponent(id)}/claim-partner-fee`, { method: "POST" });
        const partnerData = await partnerRes.json();
        results.push(partnerRes.ok ? "partner fee claimed" : `partner fee failed: ${partnerData.error ?? partnerRes.status}`);
      } catch (err) {
        results.push(`partner fee failed: ${err.message}`);
      }

      if (!connectedWallet) {
        results.push("creator fee skipped: connect the wallet that launched this token first.");
      } else {
        try {
          const prepRes = await fetch(`/api/launched-tokens/${encodeURIComponent(id)}/claim-creator-fee/prepare`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ creatorPublicKey: connectedWallet }),
          });
          const prepData = await prepRes.json();
          if (!prepRes.ok) throw new Error(prepData.error ?? `HTTP ${prepRes.status}`);

          const txBytes = Uint8Array.from(atob(prepData.transactionBase64), (c) => c.charCodeAt(0));
          const tx = solanaWeb3.Transaction.from(txBytes);
          const unsignedBytes = tx.serialize({ requireAllSignatures: false });
          const signedBytes = await window.WalletConnect.signTransaction(connectedWalletHandle.wallet, connectedWalletHandle.account, unsignedBytes);
          let binary = "";
          for (const b of signedBytes) binary += String.fromCharCode(b);
          const signedTransactionBase64 = btoa(binary);

          const subRes = await fetch(`/api/launched-tokens/${encodeURIComponent(id)}/claim-creator-fee/submit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ signedTransactionBase64, blockhash: prepData.blockhash, lastValidBlockHeight: prepData.lastValidBlockHeight }),
          });
          const subData = await subRes.json();
          if (!subRes.ok) throw new Error(subData.error ?? `HTTP ${subRes.status}`);
          results.push("creator fee claimed");
        } catch (err) {
          results.push(`creator fee failed: ${err.message}`);
        }
      }

      toast(results.join(" · "), { type: results.every((r) => r.includes("claimed")) ? "success" : "warning", duration: 10000 });
      claimBtn.disabled = false;
      claimBtn.textContent = original;
    }
  });

  loadPresets();
  refreshLaunchedTokens();
})();
