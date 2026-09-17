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
  const LARGE_SOL_THRESHOLD = 0.5; // mesma trava de "dedo gordo" do Lançar Token Bot original

  function meteoraLink(poolAddress) {
    return `https://app.meteora.ag/dammv2/${poolAddress}`;
  }
  // Pool DBC (pré-migração) não é uma pool DAMM v2 - meteoraLink() só serve
  // depois de migrar. Antes disso, link pro explorer genérico.
  function solscanLink(address) {
    return `https://solscan.io/account/${address}`;
  }
  function formatShortTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  // ---- imagem (upload ou Ctrl+V) ----
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

  // ---- presets de curva ----
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
      console.error("Falha ao carregar presets:", err);
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

  // ---- lançamento ----
  els.confirmBtn.addEventListener("click", async () => {
    els.error.hidden = true;
    els.success.hidden = true;

    const name = els.name.value.trim();
    const symbol = els.symbol.value.trim().toUpperCase();

    if (!name || !symbol) {
      els.error.textContent = "Preencha nome e símbolo.";
      els.error.hidden = false;
      return;
    }
    if (!imageDataUrl) {
      els.error.textContent = "Escolha uma imagem pro token (upload ou Ctrl+V).";
      els.error.hidden = false;
      return;
    }
    if (!selectedPresetId) {
      els.error.textContent = "Nenhum preset de curva disponível - confira /api/dbc-presets.";
      els.error.hidden = false;
      return;
    }

    let firstBuySolUi;
    const rawFirstBuy = els.firstBuy.value.trim();
    if (rawFirstBuy) {
      if (Number(rawFirstBuy) <= 0) {
        els.error.textContent = "Se informar uma compra inicial, o valor precisa ser maior que zero (ou deixe vazio).";
        els.error.hidden = false;
        return;
      }
      if (Number(rawFirstBuy) > LARGE_SOL_THRESHOLD) {
        const ok = await confirmDialog(
          `Você digitou ${rawFirstBuy} SOL pra compra inicial - isso é bem mais que o normal pra esse campo. Tem certeza que não foi engano?`,
          { title: "Valor incomum", confirmText: "Confirmar mesmo assim", danger: true }
        );
        if (!ok) return;
      }
      firstBuySolUi = Number(rawFirstBuy);
    }

    const confirmed = await confirmDialog(
      "Isso envia uma transação real na blockchain (mint + curva Meteora DBC). Confira nome, símbolo e valores com atenção.",
      { title: "Lançar token?", confirmText: "Lançar", danger: true }
    );
    if (!confirmed) return;

    els.confirmBtn.disabled = true;
    els.confirmBtn.textContent = "Lançando… (mint + curva DBC)";

    try {
      const res = await fetch("/api/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, symbol, imageDataUrl, presetId: selectedPresetId, firstBuySolUi }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      els.success.innerHTML = `Token lançado! Mint: <span class="mono">${data.mint}</span> · Pool: <a href="${solscanLink(data.poolAddress)}" target="_blank" rel="noopener" class="sf-meteora-link">curva DBC ↗</a>`;
      els.success.hidden = false;
      window.refreshWalletBalance?.();
      refreshLaunchedTokens();
    } catch (err) {
      els.error.textContent = err.message;
      els.error.hidden = false;
    } finally {
      els.confirmBtn.disabled = false;
      els.confirmBtn.textContent = "Lançar Token";
    }
  });

  // ---- tabela de tokens lançados ----
  function renderRow(token) {
    const tr = document.createElement("tr");
    const statusHtml =
      token.status === "success"
        ? `<span class="pill pill--success">criada</span>`
        : token.status === "error"
          ? `<span class="pill pill--error" title="${(token.error ?? "").replace(/"/g, "&quot;")}">erro</span>`
          : `<span class="pill pill--pending">pendente</span>`;

    let poolCell = "—";
    if (token.poolAddress) {
      if (token.dbcMigrated) {
        poolCell = `<a class="sf-meteora-link" href="${meteoraLink(token.poolAddress)}" target="_blank" rel="noopener" title="${token.poolAddress}">abrir na Meteora ↗</a>
          <span class="fee-rate__base">migrada pra DAMM v2</span>
          <div class="dbc-actions">
            <button type="button" class="sf-action-btn dbc-claim-btn" data-id="${token.id}">Sacar taxas</button>
          </div>`;
      } else {
        poolCell = `<a class="sf-meteora-link" href="${solscanLink(token.poolAddress)}" target="_blank" rel="noopener" title="${token.poolAddress}">curva DBC ↗</a>
          <div class="dbc-actions">
            <button type="button" class="sf-action-btn dbc-progress-btn" data-id="${token.id}">Ver progresso</button>
            <button type="button" class="sf-action-btn dbc-migrate-btn" data-id="${token.id}">Migrar pra DAMM v2</button>
            <button type="button" class="sf-action-btn dbc-claim-btn" data-id="${token.id}">Sacar taxas</button>
          </div>`;
      }
    }

    const preset = allPresets.find((p) => p.id === token.presetId);
    tr.innerHTML = `
      <td>
        <span class="pool-name">${token.name ?? "?"}${token.symbol ? ` (${token.symbol})` : ""}</span>
        <span class="pool-addr">${token.mint ? shortAddr(token.mint) : "—"}${token.mint ? `<button type="button" class="copy-btn" data-copy="${token.mint}" title="Copiar mint">⧉</button>` : ""}</span>
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
      console.error("Falha ao listar tokens lançados:", err);
    }
  }

  // ---- ações DBC (progresso/migrar/sacar) - sempre sob clique ----
  document.addEventListener("click", async (ev) => {
    const progressBtn = ev.target.closest(".dbc-progress-btn");
    if (progressBtn) {
      const original = progressBtn.textContent;
      progressBtn.disabled = true;
      progressBtn.textContent = "Consultando…";
      try {
        const res = await fetch(`/api/launched-tokens/${encodeURIComponent(progressBtn.dataset.id)}/progress`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        toast(`Progresso da curva: ${(data.progress * 100).toFixed(1)}% do limiar de migração.`, { type: "info" });
      } catch (err) {
        toast(`Falha ao consultar progresso: ${err.message}`, { type: "error", duration: 8000 });
      } finally {
        progressBtn.disabled = false;
        progressBtn.textContent = original;
      }
      return;
    }

    const migrateBtn = ev.target.closest(".dbc-migrate-btn");
    if (migrateBtn) {
      const confirmed = await confirmDialog(
        "Só funciona (e só gasta SOL) se a curva já atingiu o limiar do preset - caso contrário não faz nada.",
        { title: "Migrar pra uma pool DAMM v2 de verdade?", confirmText: "Migrar", danger: true }
      );
      if (!confirmed) return;
      const original = migrateBtn.textContent;
      migrateBtn.disabled = true;
      migrateBtn.textContent = "Migrando…";
      try {
        const res = await fetch(`/api/launched-tokens/${encodeURIComponent(migrateBtn.dataset.id)}/migrate`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        if (data.migrated) {
          toast(`Migrado! Pool DAMM v2: ${data.newPoolAddress ?? "(endereço não calculado, confira a transação)"}`, { type: "success", duration: 10000 });
          window.refreshWalletBalance?.();
          refreshLaunchedTokens();
        } else if (data.alreadyMigrated) {
          toast("Essa pool já tinha sido migrada.", { type: "info" });
          refreshLaunchedTokens();
        } else {
          toast(`Ainda não atingiu o limiar de migração (progresso: ${((data.progress ?? 0) * 100).toFixed(1)}%).`, { type: "warning" });
        }
      } catch (err) {
        toast(`Falha ao migrar: ${err.message}`, { type: "error", duration: 8000 });
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
      claimBtn.textContent = "Sacando…";
      try {
        const res = await fetch(`/api/launched-tokens/${encodeURIComponent(claimBtn.dataset.id)}/claim-fees`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        toast("Taxas sacadas (creator + partner).", { type: "success" });
        window.refreshWalletBalance?.();
      } catch (err) {
        toast(`Falha ao sacar taxas: ${err.message}`, { type: "error", duration: 8000 });
      } finally {
        claimBtn.disabled = false;
        claimBtn.textContent = original;
      }
    }
  });

  loadPresets();
  refreshLaunchedTokens();
})();
