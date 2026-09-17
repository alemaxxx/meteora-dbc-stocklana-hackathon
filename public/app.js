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
    error: document.getElementById("launch-error"),
    success: document.getElementById("launch-success"),
    confirmBtn: document.getElementById("launch-confirm-btn"),
    launchedRows: document.getElementById("launched-rows"),
    launchedEmpty: document.getElementById("launched-empty"),
  };

  let allPresets = [];
  let selectedPresetId = null;
  let imageDataUrl = null;
  const LARGE_SOL_THRESHOLD = 0.5; // same "fat finger" guard from the original Lançar Token Bot

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

  // ---- curve presets ----
  async function loadPresets() {
    try {
      const res = await fetch("/api/dbc-presets");
      const data = await res.json();
      allPresets = data.presets ?? [];
      els.presetChips.innerHTML = allPresets
        .map((p) => `<button type="button" class="token-chip" data-preset="${p.id}">${p.label.split(" - ")[0]}</button>`)
        .join("");
      if (allPresets.length > 0) selectPreset(allPresets[0].id);
    } catch (err) {
      console.error("Failed to load presets:", err);
    }
  }

  function selectPreset(id) {
    selectedPresetId = id;
    els.presetChips.querySelectorAll(".token-chip").forEach((c) => {
      c.classList.toggle("is-selected", c.dataset.preset === id);
    });
    const preset = allPresets.find((p) => p.id === id);
    els.presetHint.textContent = preset?.label ?? "";
  }

  els.presetChips.addEventListener("click", (ev) => {
    const chip = ev.target.closest(".token-chip");
    if (chip) selectPreset(chip.dataset.preset);
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
    if (!selectedPresetId) {
      els.error.textContent = "No curve preset available - check /api/dbc-presets.";
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
      if (Number(rawFirstBuy) > LARGE_SOL_THRESHOLD) {
        const ok = await confirmDialog(
          `You entered ${rawFirstBuy} SOL for the initial buy - that's well above what's normal for this field. Are you sure this isn't a mistake?`,
          { title: "Unusual value", confirmText: "Confirm anyway", danger: true }
        );
        if (!ok) return;
      }
      firstBuySolUi = Number(rawFirstBuy);
    }

    const confirmed = await confirmDialog(
      "This sends a real on-chain transaction (mint + Meteora DBC curve). Double-check name, symbol and values.",
      { title: "Launch token?", confirmText: "Launch", danger: true }
    );
    if (!confirmed) return;

    els.confirmBtn.disabled = true;
    els.confirmBtn.textContent = "Launching… (mint + DBC curve)";

    try {
      const res = await fetch("/api/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, symbol, imageDataUrl, presetId: selectedPresetId, firstBuySolUi }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      els.success.innerHTML = `Token launched! Mint: <span class="mono">${data.mint}</span> · Pool: <a href="${solscanLink(data.poolAddress)}" target="_blank" rel="noopener" class="sf-meteora-link">DBC curve ↗</a>`;
      els.success.hidden = false;
      window.refreshWalletBalance?.();
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
          ? `<span class="pill pill--error" title="${(token.error ?? "").replace(/"/g, "&quot;")}">error</span>`
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
    tr.innerHTML = `
      <td>
        <span class="pool-name">${token.name ?? "?"}${token.symbol ? ` (${token.symbol})` : ""}</span>
        <span class="pool-addr">${token.mint ? shortAddr(token.mint) : "—"}${token.mint ? `<button type="button" class="copy-btn" data-copy="${token.mint}" title="Copy mint">⧉</button>` : ""}</span>
      </td>
      <td class="mono">${preset ? preset.label.split(" - ")[0] : token.presetId ?? "—"}</td>
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
          window.refreshWalletBalance?.();
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
      const original = claimBtn.textContent;
      claimBtn.disabled = true;
      claimBtn.textContent = "Claiming…";
      try {
        const res = await fetch(`/api/launched-tokens/${encodeURIComponent(claimBtn.dataset.id)}/claim-fees`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        toast("Fees claimed (creator + partner).", { type: "success" });
        window.refreshWalletBalance?.();
      } catch (err) {
        toast(`Failed to claim fees: ${err.message}`, { type: "error", duration: 8000 });
      } finally {
        claimBtn.disabled = false;
        claimBtn.textContent = original;
      }
    }
  });

  loadPresets();
  refreshLaunchedTokens();
})();
