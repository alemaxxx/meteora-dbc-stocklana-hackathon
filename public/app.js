(function () {
  const els = {
    image: document.getElementById("launch-image"),
    imageUploadBtn: document.getElementById("launch-image-upload-btn"),
    imageFileInput: document.getElementById("launch-image-file"),
    name: document.getElementById("launch-name"),
    symbol: document.getElementById("launch-symbol"),
    presetTabs: document.getElementById("preset-tabs"),
    presetSearch: document.getElementById("preset-search"),
    presetGrid: document.getElementById("preset-grid"),
    presetHint: document.getElementById("preset-hint"),
    firstBuy: document.getElementById("launch-firstbuy"),
    firstBuyLabel: document.getElementById("launch-firstbuy-label"),
    summaryList: document.getElementById("summary-list"),
    error: document.getElementById("launch-error"),
    success: document.getElementById("launch-success"),
    confirmBtn: document.getElementById("launch-confirm-btn"),
  };

  let allPresets = [];
  let presetGroups = new Map(); // group label -> preset[] (includes the synthetic "pyth:" entries)
  let activeGroup = null;
  let selectedPresetId = null;
  let selectedPythSymbol = null;
  let lastPythPreview = null; // { stockUsd, solUsd, migrationMarketCap } from the last successful Pyth fetch, for the summary panel
  let imageDataUrl = null;
  const LARGE_SOL_THRESHOLD = 0.5; // same "fat finger" guard from the original Lançar Token Bot

  // Wallet connect/sign state now lives in navBar.js's window.CurveForgeWallet
  // (shared across every page's nav, 2026-09-30) - read .address/.handle
  // directly at the two points below that need them, rather than keeping a
  // local copy that could drift out of sync.

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

  // A DBC pool (pre-migration) isn't a DAMM v2 pool yet - only used for the
  // post-launch success link here; explore.js has its own copy for the
  // full table (plus meteoraLink, for migrated pools).
  function solscanLink(address) {
    return `https://solscan.io/account/${address}`;
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
  // Rendered as a scoped SEARCH + CATEGORY TABS + CARD GRID (2026-09-30,
  // replacing one <select> per group) - grouped by preset.group (set in
  // dbcConfig.js). A dropdown-per-category stops scaling once the
  // Backpack Securities catalog keeps growing (60+ tickers already); this
  // mirrors the pattern a real competitor (StonkFun) uses for the exact
  // same problem - see project_frontend_redesign_research memory.
  // Pyth-anchored options are prefixed "pyth:" in their id to distinguish
  // them from a plain preset id without a second selection mechanism.

  // Turns a preset into {badge, title, subtitle} for its card - each
  // group's label format is different (see dbcConfig.js), so this picks
  // out the short symbol/name that actually matters to scan quickly
  // instead of showing the full, long preset.label on every card.
  function presetDisplay(preset) {
    if (preset.id.startsWith("pyth:")) {
      const title = preset.id.slice(5);
      const company = preset.label.split(": ")[1]?.split(" (")[0] ?? title;
      return { badge: title.slice(0, 2).toUpperCase(), title, subtitle: company };
    }
    if (preset.quoteSymbol) {
      // "Quoted in real {Company Name} ({SYMBOL...}) - ..." (dbcConfig.js)
      const company = preset.label.split("real ")[1]?.split(" (")[0] ?? preset.quoteSymbol;
      return { badge: preset.quoteSymbol.slice(0, 2).toUpperCase(), title: preset.quoteSymbol, subtitle: company };
    }
    // Fee-shape curves: "{Name} ({fee details}) - {note}" - just the name is short enough to be the title.
    const title = preset.label.split(" (")[0];
    return { badge: title.slice(0, 2).toUpperCase(), title, subtitle: "SOL-quoted curve" };
  }

  function shortGroupLabel(group) {
    if (group.startsWith("Real stock — ")) return group.slice("Real stock — ".length).split(" (")[0];
    return group;
  }

  // ---- launch summary panel - derived, plain-language meaning of the
  // currently selected preset (see project_frontend_redesign_research
  // memory: StonkFun's "launch summary" side panel). Only ever shows
  // numbers already present on the preset object or already returned by a
  // live Pyth fetch - never an invented/estimated figure (e.g. no "SOL
  // cost estimate", since nothing in this codebase actually measures
  // that). ----
  function formatFeeRange(preset) {
    const start = (preset.startingFeeBps / 100).toString().replace(/\.0$/, "");
    const end = (preset.endingFeeBps / 100).toString().replace(/\.0$/, "");
    if (preset.startingFeeBps === preset.endingFeeBps && !preset.schedulerDurationSeconds) return `Flat ${start}%`;
    const hours = preset.schedulerDurationSeconds / 3600;
    const durationLabel = hours >= 1 ? `${hours}h` : `${preset.schedulerDurationSeconds}s`;
    return `${start}% → ${end}% over ${durationLabel}`;
  }

  function summaryRow(label, value) {
    return `<div class="summary-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
  }

  function renderSummary() {
    const name = els.name.value.trim();
    const symbol = els.symbol.value.trim().toUpperCase();
    const tokenLabel = name || symbol ? `${name || "?"}${symbol ? ` (${symbol})` : ""}` : "—";
    const firstBuyRaw = els.firstBuy.value.trim();

    let rows = [summaryRow("Token", tokenLabel)];

    if (selectedPythSymbol) {
      const quoteLabel = `SOL (live-anchored to ${selectedPythSymbol})`;
      rows.push(summaryRow("Quote asset", quoteLabel));
      rows.push(summaryRow("Migrates to", "DAMM v2 pool"));
      if (lastPythPreview && lastPythPreview.symbol === selectedPythSymbol) {
        rows.push(summaryRow(`${selectedPythSymbol} price`, `$${lastPythPreview.stockUsd.toFixed(2)}`));
        rows.push(summaryRow("Migration threshold", `${lastPythPreview.migrationMarketCap.toFixed(4)} SOL`));
      } else {
        rows.push(summaryRow("Migration threshold", "Fetching live price…"));
      }
      rows.push(summaryRow("Initial buy", firstBuyRaw ? `${firstBuyRaw} SOL` : "None (curve starts empty)"));
    } else {
      const preset = allPresets.find((p) => p.id === selectedPresetId);
      if (!preset) {
        els.summaryList.innerHTML = `<p class="summary-list__empty">Pick a curve preset to see what it means.</p>`;
        return;
      }
      const quoteSymbol = preset.quoteSymbol ?? "SOL";
      rows.push(summaryRow("Quote asset", quoteSymbol));
      rows.push(summaryRow("Total supply", preset.totalTokenSupply.toLocaleString("en-US")));
      rows.push(summaryRow("Migrates to LP", `${preset.percentageSupplyOnMigration}% of supply`));
      rows.push(summaryRow("Migration threshold", `${preset.migrationQuoteThreshold} ${quoteSymbol}`));
      rows.push(summaryRow("Trading fee", formatFeeRange(preset)));
      if (preset.migratedPoolFee?.collectFeeMode === MIGRATED_COLLECT_FEE_MODE_COMPOUNDING) {
        rows.push(summaryRow("Migrated pool", `Compounds ${preset.migratedPoolFee.compoundingFeeBps / 100}% of fees`));
      } else {
        rows.push(summaryRow("Migrates to", "DAMM v2 pool"));
      }
      rows.push(summaryRow("Initial buy", firstBuyRaw ? `${firstBuyRaw} ${quoteSymbol}` : `None (curve starts empty)`));
    }

    els.summaryList.innerHTML = rows.join("");
  }
  // Numeric value of the SDK's MigratedCollectFeeMode.Compounding (= 2, a
  // plain numeric enum - checked against the installed SDK's compiled
  // output rather than guessed) - recognized here without importing the
  // whole SDK client-side, just to label the compounding-damm-v2 preset
  // correctly in the summary panel.
  const MIGRATED_COLLECT_FEE_MODE_COMPOUNDING = 2;

  [els.name, els.symbol, els.firstBuy].forEach((el) => el.addEventListener("input", renderSummary));

  async function loadPresets() {
    try {
      const res = await fetch("/api/dbc-presets");
      const data = await res.json();
      allPresets = data.presets ?? [];

      const groups = new Map();
      for (const p of allPresets) {
        const key = p.group ?? "Other";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
      }

      // Pyth-anchored options are a SEPARATE, static list (no live Pyth
      // call here) so they always render even if Pyth itself is
      // unreachable or this project's trial key has expired - only
      // picking one triggers a live fetch (see selectPythSymbol below),
      // which fails gracefully on its own.
      try {
        const pythRes = await fetch("/api/pyth-presets");
        const pythData = await pythRes.json();
        const pythSymbols = pythData.symbols ?? [];
        if (pythSymbols.length > 0) {
          groups.set(
            "Live-priced (Pyth)",
            pythSymbols.map((s) => ({ id: `pyth:${s.symbol}`, label: `🔴 Live: ${s.label}` }))
          );
        }
      } catch (err) {
        console.error("Failed to load Pyth-anchored presets:", err);
      }

      // Sorted alphabetically by display label within each group (2026-09-26)
      // - with 59+ stock-quoted presets now, browsing them in whatever order
      // they happen to be defined in dbcConfig.js stopped being usable.
      presetGroups = new Map(
        [...groups.entries()].map(([group, presets]) => [group, [...presets].sort((a, b) => a.label.localeCompare(b.label))])
      );
      activeGroup = presetGroups.keys().next().value ?? null;

      renderTabs();
      renderGrid();

      if (allPresets.length > 0) selectPreset(allPresets[0].id);
    } catch (err) {
      console.error("Failed to load presets:", err);
    }
  }

  function renderTabs() {
    els.presetTabs.innerHTML = [...presetGroups.entries()]
      .map(
        ([group, presets]) =>
          `<button type="button" class="preset-tab${group === activeGroup ? " is-active" : ""}" data-group="${escapeHtml(group)}">${escapeHtml(shortGroupLabel(group))}<span class="preset-tab__count">${presets.length}</span></button>`
      )
      .join("");
  }

  function renderGrid() {
    const presets = presetGroups.get(activeGroup) ?? [];
    const query = els.presetSearch.value.trim().toLowerCase();
    const filtered = query
      ? presets.filter((p) => p.label.toLowerCase().includes(query) || p.id.toLowerCase().includes(query))
      : presets;

    if (filtered.length === 0) {
      els.presetGrid.innerHTML = `<p class="preset-picker__empty">No presets match "${escapeHtml(els.presetSearch.value)}" in this category.</p>`;
      return;
    }

    const activeId = selectedPythSymbol ? `pyth:${selectedPythSymbol}` : selectedPresetId;
    els.presetGrid.innerHTML = filtered
      .map((p) => {
        const { badge, title, subtitle } = presetDisplay(p);
        return `<button type="button" class="preset-card${p.id === activeId ? " is-selected" : ""}" data-id="${p.id}" title="${escapeHtml(p.label)}">
          <span class="preset-card__badge">${escapeHtml(badge)}</span>
          <span class="preset-card__title">${escapeHtml(title)}</span>
          <span class="preset-card__subtitle">${escapeHtml(subtitle)}</span>
        </button>`;
      })
      .join("");
  }

  // Switches to whichever tab/group actually holds `id` (if it isn't the
  // currently active one) and re-renders the grid so its card shows as
  // selected - used when a preset is picked programmatically (the
  // default on load) rather than by clicking a card directly.
  function revealPresetInGrid(id) {
    if (!presetGroups.get(activeGroup)?.some((p) => p.id === id)) {
      const owningGroup = [...presetGroups.entries()].find(([, presets]) => presets.some((p) => p.id === id))?.[0];
      if (owningGroup) activeGroup = owningGroup;
    }
    els.presetSearch.value = "";
    renderTabs();
    renderGrid();
  }

  function selectPreset(id) {
    selectedPresetId = id;
    selectedPythSymbol = null;
    revealPresetInGrid(id);
    const preset = allPresets.find((p) => p.id === id);
    els.presetHint.textContent = preset?.label ?? "";
    // Presets quoted in a real xStock (see dbcConfig.js's "stock-quoted-*"
    // presets, 2026-09-22) trade against that stock directly, not SOL -
    // the initial-buy field's label needs to reflect that or "0.05" would
    // look like SOL when it's actually 0.05 of a real tokenized share.
    els.firstBuyLabel.textContent = `${preset?.quoteSymbol ?? "SOL"} for initial buy (optional)`;
    renderSummary();
  }

  async function selectPythSymbol(symbol) {
    selectedPresetId = null;
    selectedPythSymbol = symbol;
    lastPythPreview = null;
    revealPresetInGrid(`pyth:${symbol}`);
    els.firstBuyLabel.textContent = "SOL for initial buy (optional)";
    els.presetHint.textContent = `Fetching ${symbol}'s live price from Pyth…`;
    renderSummary();
    try {
      const res = await fetch(`/api/pyth-presets/${encodeURIComponent(symbol)}/preview`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      // selection may have moved on to something else while this was in flight
      if (selectedPythSymbol !== symbol) return;
      els.presetHint.textContent =
        `${symbol} @ $${data.stockUsd.toFixed(2)} (SOL @ $${data.solUsd.toFixed(2)}) - ` +
        `curve migrates at ${data.migrationMarketCap.toFixed(4)} SOL, anchored to this live price.`;
      lastPythPreview = { symbol, stockUsd: data.stockUsd, solUsd: data.solUsd, migrationMarketCap: data.migrationMarketCap };
      renderSummary();
    } catch (err) {
      if (selectedPythSymbol !== symbol) return;
      els.presetHint.textContent = `Couldn't fetch ${symbol}'s live Pyth price (${err.message}). Pick a different preset.`;
    }
  }

  els.presetTabs.addEventListener("click", (ev) => {
    const tab = ev.target.closest(".preset-tab");
    if (!tab) return;
    activeGroup = tab.dataset.group;
    els.presetSearch.value = "";
    renderTabs();
    renderGrid();
  });

  els.presetSearch.addEventListener("input", renderGrid);

  els.presetGrid.addEventListener("click", (ev) => {
    const card = ev.target.closest(".preset-card");
    if (!card) return;
    const id = card.dataset.id;
    if (id.startsWith("pyth:")) selectPythSymbol(id.slice(5));
    else selectPreset(id);
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
    const connectedWallet = window.CurveForgeWallet?.address;
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
      const walletHandle = window.CurveForgeWallet.handle;
      const signedBytes = await window.WalletConnect.signTransaction(walletHandle.wallet, walletHandle.account, unsignedBytes);
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

      els.success.innerHTML = `Token launched! Mint: <span class="mono">${data.mint}</span> · Pool: <a href="${solscanLink(data.poolAddress)}" target="_blank" rel="noopener" class="sf-meteora-link">DBC curve ↗</a> · <a href="explore.html">View in Explore →</a>`;
      els.success.hidden = false;
    } catch (err) {
      els.error.textContent = err.message;
      els.error.hidden = false;
    } finally {
      els.confirmBtn.disabled = false;
      els.confirmBtn.textContent = "Launch Token";
    }
  });

  // Launched-tokens table + progress/migrate/claim actions moved to
  // explore.js (2026-09-30, part of the Home/Launch/Explore/Docs split) -
  // this page is just the launch form now.

  loadPresets();
})();
