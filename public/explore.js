// Explore page (2026-09-30) - the launched-tokens table + its
// progress/migrate/claim actions, extracted from app.js when the site
// split into Home/Launch/Explore/Docs. Reads the connected wallet from
// navBar.js's window.CurveForgeWallet instead of owning its own connect
// flow. Needs uiKit.js (toast/confirmDialog) and main.js (shortAddr) -
// see explore.html's <script> order.
(function () {
  const els = {
    launchedRows: document.getElementById("launched-rows"),
    launchedEmpty: document.getElementById("launched-empty"),
    myTokensToggle: document.getElementById("my-tokens-toggle"),
    myTokensCheckbox: document.getElementById("my-tokens-checkbox"),
  };

  let allPresets = []; // only for resolving a launched token's preset label - fetched once, read-only here
  let allTokens = []; // last fetch, filtered client-side by the "My tokens only" toggle below

  // Same escaping discipline as app.js (public form input rendered as
  // HTML - see that file's note on the 2026-09-20 stored-XSS fix).
  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function meteoraLink(poolAddress) {
    return `https://app.meteora.ag/dammv2/${poolAddress}`;
  }
  function solscanLink(address) {
    return `https://solscan.io/account/${address}`;
  }
  function formatShortTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  function renderRow(token) {
    const tr = document.createElement("tr");
    const statusHtml =
      token.status === "success"
        ? `<span class="pill pill--success">created</span>${
            token.mint
              ? `<div class="dbc-actions"><a class="sf-action-btn" href="https://gmgn.ai/sol/token/${token.mint}" target="_blank" rel="noopener">View on GMGN ↗</a></div>`
              : ""
          }`
        : token.status === "error"
          ? `<span class="pill pill--error" title="${escapeHtml(token.error)}">error</span>`
          : `<span class="pill pill--pending">pending</span>`;

    let poolCell = "—";
    if (token.poolAddress) {
      if (token.dbcMigrated) {
        poolCell = `<a class="sf-meteora-link" href="${meteoraLink(token.poolAddress)}" target="_blank" rel="noopener" title="${token.poolAddress}">open on Meteora ↗</a>
          <span class="fee-rate__base">migrated to DAMM v2</span>
          <span class="fee-rate__base damm-price" data-pool="${token.poolAddress}" data-quote-symbol="${escapeHtml(token.quoteSymbol ?? "SOL")}">loading live price…</span>
          <div class="dbc-actions">
            <button type="button" class="sf-action-btn dbc-claim-btn" data-id="${token.id}">Claim fees</button>
            <button type="button" class="sf-action-btn dbc-conviction-btn" data-pool="${token.poolAddress}" data-symbol="${escapeHtml(token.symbol ?? "")}" data-quote-symbol="${escapeHtml(token.quoteSymbol ?? "SOL")}">Open Conviction Pool</button>
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
      <td data-label="Token">
        <span class="pool-name">${escapeHtml(token.name ?? "?")}${token.symbol ? ` (${escapeHtml(token.symbol)})` : ""}</span>
        <span class="pool-addr">${token.mint ? shortAddr(token.mint) : "—"}${token.mint ? `<button type="button" class="copy-btn" data-copy="${token.mint}" title="Copy mint" aria-label="Copy mint address">⧉</button>` : ""}</span>
      </td>
      <td class="mono" data-label="Preset">${presetLabel}</td>
      <td class="mono" data-label="When">${formatShortTime(token.createdAt)}</td>
      <td data-label="Status">${statusHtml}</td>
      <td data-label="Pool">${poolCell}</td>
    `;
    return tr;
  }

  function renderTokens(tokens) {
    els.launchedRows.innerHTML = "";
    els.launchedEmpty.hidden = tokens.length > 0;
    els.launchedEmpty.textContent = els.myTokensCheckbox.checked
      ? "No tokens launched yet from this wallet."
      : "No tokens launched yet.";
    for (const t of tokens) els.launchedRows.appendChild(renderRow(t));
    loadDammPrices();
  }

  // Fills in the live DAMM v2 price for every migrated token's row, via
  // the new read-only /api/damm-pool endpoint (dammPoolInfo.js) - lazy,
  // after the rows render, same spirit as the Launch page's simulation
  // panel loading after preset selection rather than blocking the table.
  async function loadDammPrices() {
    const priceEls = [...document.querySelectorAll(".damm-price")];
    await Promise.all(
      priceEls.map(async (el) => {
        try {
          const res = await fetch(`/api/damm-pool/${encodeURIComponent(el.dataset.pool)}`);
          const data = await res.json();
          if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
          // priceBaseInQuote (not the raw priceAInB) - tokenA/tokenB don't
          // reliably correspond to base/quote (CP-AMM pools are ordered by
          // raw pubkey, not by which side was the launched token), so using
          // priceAInB directly showed an inverted price for roughly half of
          // all migrated pools. See dammPoolInfo.js for the real fix.
          const price = Number(data.priceBaseInQuote);
          el.textContent = `1 token ≈ ${price.toLocaleString("en-US", { maximumSignificantDigits: 4 })} ${el.dataset.quoteSymbol}`;
        } catch (err) {
          el.textContent = "live price unavailable";
          console.error("Failed to load DAMM v2 price:", err);
        }
      })
    );
  }

  // Small dedicated dialog for the one case that needs real numeric input
  // (base + quote amounts to seed a Conviction Pool position) - reuses the
  // same .modal-overlay/.modal shell as confirmDialog/walletPickerDialog
  // in uiKit.js for visual consistency, kept local since nothing else in
  // the app needs a two-field numeric form.
  function amountsDialog(baseSymbol, quoteSymbol) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay confirm-overlay";
      overlay.innerHTML = `
        <div class="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="conviction-amounts-title">
          <div class="modal__header"><h2 id="conviction-amounts-title">Open Conviction Pool</h2></div>
          <div class="modal__body">
            <p class="confirm-modal__message">
              This deposits real capital into a new concentrated liquidity position (±3% around
              the current price) - both amounts leave your wallet. This is not reversible without
              later removing the position yourself.
            </p>
            <div class="field">
              <label for="conviction-base-amount">${escapeHtml(baseSymbol)} amount</label>
              <input type="number" id="conviction-base-amount" min="0" step="any" placeholder="0.0" />
            </div>
            <div class="field">
              <label for="conviction-quote-amount">${escapeHtml(quoteSymbol)} amount</label>
              <input type="number" id="conviction-quote-amount" min="0" step="any" placeholder="0.0" />
            </div>
          </div>
          <div class="modal__footer">
            <button type="button" class="btn-secondary confirm-modal__cancel">Cancel</button>
            <button type="button" class="btn-primary confirm-modal__ok">Open position</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const baseInput = overlay.querySelector("#conviction-base-amount");
      const quoteInput = overlay.querySelector("#conviction-quote-amount");
      baseInput.focus();

      function settle(result) {
        overlay.remove();
        resolve(result);
      }
      overlay.querySelector(".confirm-modal__cancel").addEventListener("click", () => settle(null));
      overlay.querySelector(".confirm-modal__ok").addEventListener("click", () => {
        const baseAmountUi = Number(baseInput.value);
        const quoteAmountUi = Number(quoteInput.value);
        if (!(baseAmountUi > 0) || !(quoteAmountUi > 0)) {
          toast("Both amounts need to be greater than zero.", { type: "error" });
          return;
        }
        settle({ baseAmountUi, quoteAmountUi });
      });
      overlay.addEventListener("click", (ev) => {
        if (ev.target === overlay) settle(null);
      });
    });
  }

  function visibleTokens() {
    const wallet = window.CurveForgeWallet?.address;
    if (!els.myTokensCheckbox.checked || !wallet) return allTokens;
    return allTokens.filter((t) => t.creatorPublicKey === wallet);
  }

  async function refreshLaunchedTokens() {
    try {
      const res = await fetch("/api/launched-tokens");
      const data = await res.json();
      allTokens = data.tokens ?? [];
      renderTokens(visibleTokens());
    } catch (err) {
      console.error("Failed to list launched tokens:", err);
    }
  }

  // "My tokens only" toggle (2026-10-01) - the public list stays visible to
  // everyone (social proof / activity feed), this just narrows it down for
  // whoever has their own wallet connected. Only shown once connected.
  els.myTokensCheckbox.addEventListener("change", () => renderTokens(visibleTokens()));
  window.CurveForgeWallet?.onChange((state) => {
    els.myTokensToggle.hidden = !state.address;
    if (!state.address) els.myTokensCheckbox.checked = false;
    renderTokens(visibleTokens());
  });

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

      const connectedWallet = window.CurveForgeWallet?.address;
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

          const walletHandle = window.CurveForgeWallet.handle;
          const txBytes = Uint8Array.from(atob(prepData.transactionBase64), (c) => c.charCodeAt(0));
          const tx = solanaWeb3.Transaction.from(txBytes);
          const unsignedBytes = tx.serialize({ requireAllSignatures: false });
          const signedBytes = await window.WalletConnect.signTransaction(walletHandle.wallet, walletHandle.account, unsignedBytes);
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
      return;
    }

    // "DLMM Conviction Pool" (2026-10-01) - manually triggered only, never
    // automatic. Two real on-chain transactions, both wallet-signed by
    // the connected wallet (same prepare/sign/submit shape as everything
    // else - see WALLET-INTEGRATION.md): one creates a new DLMM pool for
    // this pair if it doesn't exist yet, the second opens a concentrated
    // (±3%) position in it - the actual "conviction" liquidity, which
    // deposits real capital from the connected wallet.
    const convictionBtn = ev.target.closest(".dbc-conviction-btn");
    if (convictionBtn) {
      const connectedWallet = window.CurveForgeWallet?.address;
      if (!connectedWallet) {
        toast("Connect your wallet first - this deposits real capital from the connected wallet.", { type: "error" });
        return;
      }

      const dammPoolAddress = convictionBtn.dataset.pool;
      const baseSymbol = convictionBtn.dataset.symbol || "token";
      const quoteSymbol = convictionBtn.dataset.quoteSymbol || "SOL";
      const original = convictionBtn.textContent;
      convictionBtn.disabled = true;

      async function signAndSubmit(transactionBase64, blockhash, lastValidBlockHeight) {
        const walletHandle = window.CurveForgeWallet.handle;
        const txBytes = Uint8Array.from(atob(transactionBase64), (c) => c.charCodeAt(0));
        const tx = solanaWeb3.Transaction.from(txBytes);
        const unsignedBytes = tx.serialize({ requireAllSignatures: false });
        const signedBytes = await window.WalletConnect.signTransaction(walletHandle.wallet, walletHandle.account, unsignedBytes);
        let binary = "";
        for (const b of signedBytes) binary += String.fromCharCode(b);
        const signedTransactionBase64 = btoa(binary);

        const subRes = await fetch("/api/conviction/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ signedTransactionBase64, blockhash, lastValidBlockHeight }),
        });
        const subData = await subRes.json();
        if (!subRes.ok) throw new Error(subData.error ?? `HTTP ${subRes.status}`);
        return subData;
      }

      try {
        convictionBtn.textContent = "Checking…";
        const statusRes = await fetch(`/api/conviction/${encodeURIComponent(dammPoolAddress)}/status?wallet=${encodeURIComponent(connectedWallet)}`);
        const status = await statusRes.json();
        if (!statusRes.ok) throw new Error(status.error ?? `HTTP ${statusRes.status}`);

        let dlmmPoolAddress = status.dlmmPoolAddress;

        if (!dlmmPoolAddress) {
          if (status.creatorHasRequiredBalance === false) {
            throw new Error(
              `Your connected wallet needs to hold some ${baseSymbol} to open a Conviction Pool - Meteora's own program requires this as proof against spam pool creation.`
            );
          }
          const confirmed = await confirmDialog(
            `No DLMM pool exists yet for this token - this first creates one (a separate, small transaction), priced at the current market rate.`,
            { title: "Create a new DLMM pool?", confirmText: "Create pool" }
          );
          if (!confirmed) {
            convictionBtn.disabled = false;
            convictionBtn.textContent = original;
            return;
          }

          convictionBtn.textContent = "Creating pool…";
          const prepPoolRes = await fetch("/api/conviction/prepare-pool", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ baseMint: status.baseMint, quoteMint: status.quoteMint, creatorPublicKey: connectedWallet, livePrice: status.livePrice }),
          });
          const prepPool = await prepPoolRes.json();
          if (!prepPoolRes.ok) throw new Error(prepPool.error ?? `HTTP ${prepPoolRes.status}`);

          convictionBtn.textContent = "Approve pool creation…";
          await signAndSubmit(prepPool.transactionBase64, prepPool.blockhash, prepPool.lastValidBlockHeight);
          dlmmPoolAddress = prepPool.poolAddress;
          toast("DLMM pool created - now set up the position.", { type: "success" });
        }

        const amounts = await amountsDialog(baseSymbol, quoteSymbol);
        if (!amounts) {
          convictionBtn.disabled = false;
          convictionBtn.textContent = original;
          return;
        }

        convictionBtn.textContent = "Approve position…";
        const prepPosRes = await fetch("/api/conviction/prepare-position", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dlmmPoolAddress, baseMint: status.baseMint, quoteMint: status.quoteMint, creatorPublicKey: connectedWallet, baseAmountUi: amounts.baseAmountUi, quoteAmountUi: amounts.quoteAmountUi }),
        });
        const prepPos = await prepPosRes.json();
        if (!prepPosRes.ok) throw new Error(prepPos.error ?? `HTTP ${prepPosRes.status}`);

        convictionBtn.textContent = "Confirming on-chain…";
        await signAndSubmit(prepPos.transactionBase64, prepPos.blockhash, prepPos.lastValidBlockHeight);
        toast(`Conviction Pool position opened (${baseSymbol}).`, { type: "success", duration: 10000 });
      } catch (err) {
        toast(`Conviction Pool failed: ${err.message}`, { type: "error", duration: 10000 });
      } finally {
        convictionBtn.disabled = false;
        convictionBtn.textContent = original;
      }
    }
  });

  (async function init() {
    try {
      const res = await fetch("/api/dbc-presets");
      const data = await res.json();
      allPresets = data.presets ?? [];
    } catch (err) {
      console.error("Failed to load presets for label lookup:", err);
    }
    refreshLaunchedTokens();
  })();
})();
