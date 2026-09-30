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
  };

  let allPresets = []; // only for resolving a launched token's preset label - fetched once, read-only here

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
