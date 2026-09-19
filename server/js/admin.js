(function(){
  "use strict";

  function escapeHTML(str){
    return String(str).replace(/[&<>"']/g, ch => ({
      "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
    }[ch]));
  }

  function safeColor(color){
    return /^#[0-9a-fA-F]{3,8}$/.test(String(color || "")) ? color : "#F4B4CC";
  }

  function fetchWithTimeout(url, options, timeoutMs){
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 8000);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
  }

  function copiarPeloCampo(texto){
    const campo = document.createElement("textarea");
    campo.value = texto;
    campo.setAttribute("readonly", "");
    campo.style.cssText = "position:fixed; top:0; left:-9999px; opacity:0";
    document.body.appendChild(campo);
    try{
      campo.select();
      return document.execCommand("copy");
    }catch{
      return false;
    }finally{
      campo.remove();
    }
  }

  async function copiarTexto(texto){
    try{
      await navigator.clipboard.writeText(texto);
      return true;
    }catch(err){
      console.warn("Área de transferência indisponível, tentando o modo antigo:", err);
      return copiarPeloCampo(texto);
    }
  }

  const formatMoney = window.PLCPricing.formatMoney;
  function formatDate(ts){
    return new Date(ts).toLocaleString("pt-BR", { day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" });
  }

  function imageFor(product){
    return product.photoUrl || "";
  }
  const BOW_PLACEHOLDER = `<span class="admin-thumb-placeholder" aria-hidden="true"><svg class="bow-icon"><use href="#bow-shape"/></svg></span>`;

  const PAYMENT_METHOD_LABELS = { pix: "Pix", card: "Cartão ou boleto" };

  let CATEGORY_LABELS = {
    "laco-unico":  "Laço Único",
    "parzinho":    "Parzinho",
    "laco-g":      "Laço G",
    "laco-pompom": "Laço Pompom",
    "tiara":       "Tiara",
    "kit":         "Kit",
    "bolsa":       "Bolsa",
    "cabide":      "Cabide",
  };
  let currentCategories = Object.entries(CATEGORY_LABELS).map(([slug, label]) => ({ slug, label, builtin: true }));
  function applyCategories(categories){
    if(!Array.isArray(categories) || categories.length === 0) return;
    currentCategories = categories;
    CATEGORY_LABELS = Object.fromEntries(categories.map(c => [c.slug, c.label]));
  }

  function renderCategoryOptions(selectEl, selectedSlug){
    selectEl.innerHTML = currentCategories
      .map(c => `<option value="${escapeHTML(c.slug)}">${escapeHTML(c.label)}</option>`).join("");
    if(selectedSlug) selectEl.value = selectedSlug;
  }

  function normalizarTexto(s){
    return String(s).toLowerCase()
      .replace(/[áàâã]/g, "a")
      .replace(/[éèê]/g, "e")
      .replace(/[íìî]/g, "i")
      .replace(/[óòôõ]/g, "o")
      .replace(/[úùû]/g, "u")
      .replace(/ç/g, "c");
  }
  /* ⚠️ A ORDEM decide: o primeiro que casar vence. "Laço Parzinho" tem que
     bater em Parzinho antes de Laço Único, "Kit Bolsa com Laço" em Kit antes
     de Bolsa. O fallback aceita "laça" porque existe produto assim no
     catálogo. */
  const DETECTORES_DE_CATEGORIA = [
    { rotulo: "Laço G",       regex: /\(\s*g\s*\)|\bgrande\b/ },
    { rotulo: "Laço Pompom",  regex: /\bpompom\b/ },
    { rotulo: "Parzinho",     regex: /\bparzinhos?\b/ },
    { rotulo: "Tiara",        regex: /\btiaras?\b/ },
    { rotulo: "Cabide",       regex: /\bcabides?\b/ },
    { rotulo: "Kit",          regex: /\bkits?\b/ },
    { rotulo: "Bolsa",        regex: /\bbolsas?\b/ },
    { rotulo: "Laço Único",   regex: /\bunico\b|\blac[oa]s?\b|\blacinhos?\b/ },
  ];
  function detectarCategoriaPorNome(nome){
    const texto = normalizarTexto(nome);
    for(const { rotulo, regex } of DETECTORES_DE_CATEGORIA){
      if(regex.test(texto)) return rotulo;
    }
    return null;
  }

  async function garantirCategoria(rotulo){
    const existente = currentCategories.find(c => c.label.toLowerCase() === rotulo.toLowerCase());
    if(existente) return existente;
    try{
      const res = await fetchWithTimeout("/api/admin/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: rotulo }),
      });
      const data = await res.json().catch(() => ({}));
      if(!res.ok) return null;
      currentCategories = [...currentCategories, data];
      return data;
    }catch{
      return null;
    }
  }

  async function autoDetectarCategoria(nome, selectEl){
    if(selectEl.dataset.categoriaManual === "true") return;
    const rotulo = detectarCategoriaPorNome(nome);
    if(!rotulo) return;
    const categoria = await garantirCategoria(rotulo);
    if(categoria && selectEl.dataset.categoriaManual !== "true"){
      renderCategoryOptions(selectEl, categoria.slug);
    }
  }
  function comAtraso(fn, ms){
    let temporizador = null;
    return (...args) => {
      clearTimeout(temporizador);
      temporizador = setTimeout(() => fn(...args), ms);
    };
  }
  const autoDetectarCategoriaEditar = comAtraso(autoDetectarCategoria, 400);

  const STATUS_LABELS = {
    "pendente":    { label:"Pagamento pendente", cls:"order-status-pending" },
    "em análise":  { label:"Pagamento em análise", cls:"order-status-pending" },
    "pago":        { label:"Pago", cls:"order-status-paid" },
    "recusado":    { label:"Pagamento recusado", cls:"order-status-failed" },
    "cancelado":   { label:"Cancelado", cls:"order-status-failed" },
    "reembolsado": { label:"Reembolsado", cls:"order-status-failed" },
    "estornado":   { label:"Estornado", cls:"order-status-failed" },
  };

  const stateLoading = document.getElementById("adminLoading");
  const stateLoggedOut = document.getElementById("adminLoggedOut");
  const stateForbidden = document.getElementById("adminForbidden");
  const stateError = document.getElementById("adminError");
  const stateTwoFactor = document.getElementById("adminTwoFactorSetup");
  const stateRecovery = document.getElementById("adminRecoveryCodes");
  const contentEl = document.getElementById("adminContent");
  const retryBtn = document.getElementById("adminRetryBtn");

  const statsRowEl = document.getElementById("statsRow");
  const productsTableBodyEl = document.getElementById("productsTableBody");
  const stateEmpty = document.getElementById("adminEmpty");
  const listEl = document.getElementById("adminList");
  const pendingCartsSectionEl = document.getElementById("pendingCartsSection");
  const pendingCartsListEl = document.getElementById("pendingCartsList");
  const messagesListEl = document.getElementById("messagesList");
  const couponsTableBodyEl = document.getElementById("couponsTableBody");
  const newCouponFormEl = document.getElementById("newCouponForm");
  const couponFormMsgEl = document.getElementById("couponFormMsg");
  const couponSaveBtnEl = document.getElementById("couponSaveBtn");

  function showOnly(target){
    [stateLoading, stateLoggedOut, stateForbidden, stateError,
     stateTwoFactor, stateRecovery, contentEl].forEach(node => {
      if(node) node.classList.toggle("d-none", node !== target);
    });

    document.body.classList.toggle(
      "admin-gate-active", target === stateTwoFactor || target === stateRecovery
    );
  }

  let tfaSecret = null;

  async function startTwoFactorSetup(){
    showOnly(stateTwoFactor);
    try{
      const res = await fetch("/api/admin/2fa/setup", {
        method: "POST", headers: { "Content-Type": "application/json" },
      });
      if(!res.ok) throw new Error("falha ao preparar");
      const data = await res.json();
      tfaSecret = data.secret;
      document.getElementById("tfaQr").src = data.qrDataUri;

      document.getElementById("tfaSecret").textContent = data.secret.replace(/(.{4})/g, "$1 ").trim();
    }catch{
      showOnly(stateError);
    }
  }

  document.getElementById("tfaActivateForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("tfaActivateBtn");
    const msg = document.getElementById("tfaMsg");
    const codeEl = document.getElementById("tfaCode");
    msg.textContent = "";
    msg.classList.remove("text-danger");
    btn.disabled = true;
    try{
      const res = await fetch("/api/admin/2fa/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: tfaSecret, code: codeEl.value.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(data.error || "Não foi possível ativar agora.");
      renderRecoveryCodes(data.recoveryCodes);
    }catch(err){
      msg.textContent = err.message;
      msg.classList.add("text-danger");
      codeEl.select();

      codeEl.classList.remove("tfa-shake");
      void codeEl.offsetWidth;
      codeEl.classList.add("tfa-shake");
    }finally{
      btn.disabled = false;
    }
  });

  function renderRecoveryCodes(codes){
    const list = document.getElementById("tfaRecoveryList");
    list.innerHTML = "";
    codes.forEach(code => {
      const li = document.createElement("li");

      li.textContent = code;
      list.appendChild(li);
    });
    document.getElementById("tfaCopyCodesBtn").onclick = async () => {
      const copiou = await copiarTexto(codes.join("\n"));
      const btn = document.getElementById("tfaCopyCodesBtn");
      btn.innerHTML = copiou
        ? '<i class="bi bi-check2"></i> Copiado!'
        : '<i class="bi bi-clipboard"></i> Copie manualmente';
      setTimeout(() => { btn.innerHTML = '<i class="bi bi-clipboard"></i> Copiar códigos'; }, 2000);
    };
    showOnly(stateRecovery);
  }

  document.getElementById("tfaSavedCheck")?.addEventListener("change", (e) => {
    document.getElementById("tfaDoneBtn").disabled = !e.target.checked;
  });
  document.getElementById("tfaDoneBtn")?.addEventListener("click", () => loadDashboard());

  const adminTabsEl = document.getElementById("adminTabs");
  const tabButtons = [...document.querySelectorAll(".admin-tab-btn")];
  const tabPanels = [...document.querySelectorAll(".admin-tab-panel")];

  function switchTab(tabName){
    const target = tabPanels.find(p => p.dataset.tabPanel === tabName);
    if(!target) return;
    tabButtons.forEach(btn => btn.classList.toggle("is-active", btn.dataset.tab === tabName));
    tabPanels.forEach(panel => panel.classList.toggle("d-none", panel !== target));
  }

  adminTabsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".admin-tab-btn");
    if(btn) switchTab(btn.dataset.tab);
  });

  function renderStats(stats){

    const avgTicket = stats.totalOrders ? stats.totalRevenue / stats.totalOrders : 0;
    statsRowEl.innerHTML = `
      <div class="stat-tile stat-tile--revenue">
        <div class="stat-tile-icon"><i class="bi bi-wallet2"></i></div>
        <div>
          <span class="stat-value">${formatMoney(stats.totalRevenue)}</span>
          <span class="stat-label">Vendas totais</span>
        </div>
      </div>
      <div class="stat-tile stat-tile--orders">
        <div class="stat-tile-icon"><i class="bi bi-bag-check"></i></div>
        <div>
          <span class="stat-value">${stats.totalOrders}</span>
          <span class="stat-label">Total de pedidos</span>
        </div>
      </div>
      <div class="stat-tile stat-tile--avg">
        <div class="stat-tile-icon"><i class="bi bi-graph-up-arrow"></i></div>
        <div>
          <span class="stat-value">${formatMoney(avgTicket)}</span>
          <span class="stat-label">Ticket médio</span>
        </div>
      </div>
    `;
  }

  const MONTH_LABELS = ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];
  const salesChartEl = document.getElementById("salesChart");

  function computeMonthlySales(orders, monthsWindow){
    const now = new Date();
    const buckets = [];
    for(let i = monthsWindow - 1; i >= 0; i--){
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      buckets.push({ year: d.getFullYear(), month: d.getMonth(), revenue: 0, count: 0 });
    }
    orders
      .filter(o => o.status === "pago")
      .forEach(o => {
        const d = new Date(o.createdAt);
        const bucket = buckets.find(b => b.year === d.getFullYear() && b.month === d.getMonth());
        if(bucket){ bucket.revenue += o.total; bucket.count += 1; }
      });
    return buckets;
  }

  function renderSalesChart(orders){
    const buckets = computeMonthlySales(orders, 6);
    const maxRevenue = Math.max(...buckets.map(b => b.revenue), 0);
    const now = new Date();

    salesChartEl.innerHTML = buckets.map(b => {
      const isCurrent = b.year === now.getFullYear() && b.month === now.getMonth();

      const pct = maxRevenue > 0 ? Math.max((b.revenue / maxRevenue) * 100, 3) : 3;
      const orderWord = b.count === 1 ? "pedido" : "pedidos";
      return `
        <div class="sales-chart-bar-wrap${isCurrent ? " is-current" : ""}">
          <div class="sales-chart-tooltip">${formatMoney(b.revenue)}<small>${b.count} ${orderWord}</small></div>
          <div class="sales-chart-bar" style="--bar-pct:${pct}%"></div>
          <span class="sales-chart-month">${MONTH_LABELS[b.month]}${isCurrent ? "<small>atual</small>" : ""}</span>
        </div>
      `;
    }).join("");
  }

  function renderBarList(el, items, emptyMessage){
    if(!el) return;
    if(!items.length){
      el.innerHTML = `<p class="admin-hint mb-0">${escapeHTML(emptyMessage)}</p>`;
      return;
    }
    const max = Math.max(...items.map(i => i.value), 0);
    el.innerHTML = items.map(item => {

      const pct = max > 0 ? Math.max((item.value / max) * 100, 2) : 2;
      return `
        <div class="bar-row">
          <div class="bar-row-head">
            <span class="bar-row-label">${escapeHTML(item.label)}</span>
            <span class="bar-row-value">${escapeHTML(item.display)}</span>
          </div>
          <div class="bar-row-track"><div class="bar-row-fill" style="width:${pct}%"></div></div>
          ${item.meta ? `<span class="bar-row-meta">${escapeHTML(item.meta)}</span>` : ""}
        </div>`;
    }).join("");
  }

  const paidOrdersOf = (orders) => orders.filter(o => o.status === "pago");

  function tallyItems(orders, keyOf){
    const totals = new Map();
    for(const order of paidOrdersOf(orders)){
      for(const item of order.items || []){
        const key = keyOf(item);
        if(key == null) continue;
        const acc = totals.get(key) || { units: 0, revenue: 0 };
        acc.units += item.qty;
        acc.revenue += (item.unitPrice || 0) * item.qty;
        totals.set(key, acc);
      }
    }
    return [...totals.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => b.revenue - a.revenue);
  }

  function renderCategoryChart(orders, products){
    const categoryOf = new Map(products.map(p => [p.id, p.category]));
    const rows = tallyItems(orders, item => categoryOf.get(item.id) || "sem-categoria");
    renderBarList(
      document.getElementById("categoryChart"),
      rows.map(r => ({
        label: CATEGORY_LABELS[r.key] || "Sem categoria",
        value: r.revenue,
        display: formatMoney(r.revenue),
        meta: `${r.units} ${r.units === 1 ? "unidade" : "unidades"}`,
      })),
      "Nenhuma venda paga ainda."
    );
  }

  function renderTopProductsChart(orders){

    const rows = tallyItems(orders, item => item.name || `Produto #${item.id}`)
      .sort((a, b) => b.units - a.units)
      .slice(0, 5);
    renderBarList(
      document.getElementById("topProductsChart"),
      rows.map(r => ({
        label: r.key,
        value: r.units,
        display: `${r.units} un.`,
        meta: formatMoney(r.revenue),
      })),
      "Nenhuma venda paga ainda."
    );
  }

  function renderStatusChart(orders){
    const counts = new Map();
    for(const order of orders){
      counts.set(order.status, (counts.get(order.status) || 0) + 1);
    }
    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const total = orders.length;
    renderBarList(
      document.getElementById("statusChart"),
      rows.map(([status, count]) => ({
        label: STATUS_LABELS[status]?.label || status,
        value: count,
        display: String(count),
        meta: total > 0 ? `${Math.round((count / total) * 100)}% dos pedidos` : "",
      })),
      "Nenhum pedido registrado ainda."
    );
  }

  function renderPaymentChart(orders){
    const totals = new Map();
    for(const order of paidOrdersOf(orders)){
      const method = order.paymentMethod || "card";
      const acc = totals.get(method) || { count: 0, revenue: 0 };
      acc.count += 1;
      acc.revenue += order.total;
      totals.set(method, acc);
    }
    const rows = [...totals.entries()].sort((a, b) => b[1].revenue - a[1].revenue);
    renderBarList(
      document.getElementById("paymentChart"),
      rows.map(([method, v]) => ({
        label: PAYMENT_METHOD_LABELS[method] || method,
        value: v.revenue,
        display: formatMoney(v.revenue),
        meta: `${v.count} ${v.count === 1 ? "pedido" : "pedidos"}`,
      })),
      "Nenhuma venda paga ainda."
    );
  }

  const PENDING_CART_MIN_AGE_MS = 60 * 60 * 1000;
  const PENDING_CART_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

  function whatsappDigitsWithCountryCode(phone){
    let digits = String(phone || "").replace(/\D/g, "");
    if(!digits) return "";
    if(digits.length > 11) digits = digits.replace(/^0+/, "");
    if(digits.length >= 12 && digits.startsWith("55")) return digits;
    return `55${digits}`;
  }
  function whatsappUrl(phone, message){
    const phoneDigits = whatsappDigitsWithCountryCode(phone);
    if(!phoneDigits) return null;
    /* ⚠️ api.whatsapp.com, nunca wa.me: o redirecionamento do wa.me troca todo
       caractere acima de Latin-1 por "?" — emoji some sem erro nenhum. */
    return `https://api.whatsapp.com/send?phone=${phoneDigits}&text=${encodeURIComponent(message)}`;
  }

  function whatsappRecoveryUrl(order){
    const firstName = String(order.customer?.nome || "").trim().split(" ")[0] || "";
    const itemNames = order.items.map(i => i.name).join(", ");
    const msg = `Olá${firstName ? " " + firstName : ""}! Vi que você começou uma compra (${itemNames}) aqui na Adriana Melo Acessórios e queria saber se posso ajudar a finalizar 💗`;
    return whatsappUrl(order.customer?.telefone, msg);
  }

  const WHATSAPP_POST_SALE_MESSAGE = "Olá, recebemos o seu pedido na Adriana Melo Acessórios e estamos à disposição para qualquer dúvida.";
  function whatsappContactUrl(order){
    return whatsappUrl(order.customer?.telefone, WHATSAPP_POST_SALE_MESSAGE);
  }

  function descricaoDoPedido(order){
    const itens = Array.isArray(order.items) ? order.items : [];
    if(!itens.length) return "";
    if(itens.length === 1) return `*${itens[0].name}*`;
    return `*${itens[0].name}* e mais ${itens.length - 1} ${itens.length - 1 === 1 ? "peça" : "peças"}`;
  }

  function whatsappPostagemUrl(order){
    if(!order.trackingCode) return null;
    const primeiroNome = String(order.customer?.nome || "").trim().split(" ")[0] || "";
    const link = `${location.origin}/acompanhar-pedido.html?pedido=${encodeURIComponent(order.reference)}`;
    const oQueSaiu = descricaoDoPedido(order);
    const msg = [
      `Olá${primeiroNome ? ", " + primeiroNome : ""}! 🎀`,
      "",
      oQueSaiu
        ? `Seu pedido ${oQueSaiu} saiu do ateliê e já está a caminho.`
        : "Seu pedido saiu do ateliê e já está a caminho.",
      "",
      `Código de rastreio: *${order.trackingCode}*`,
      "Acompanhe a entrega por aqui:",
      link,
      "",
      "Fico à disposição por aqui para o que precisar.",
      "",
      "🎀 *Adriana Melo Acessórios*",
      "Laços feitos à mão em Brasília",
    ].join("\n");
    return whatsappUrl(order.customer?.telefone, msg);
  }

  function textoDoAviso(order){
    const aviso = order.avisoDePostagem;
    if(!order.trackingCode) return "";
    if(!aviso) return `<span class="aviso-postagem is-pendente"><i class="bi bi-hourglass-split me-1"></i>Cliente ainda não avisada</span>`;
    if(aviso.enviadoEm) return `<span class="aviso-postagem is-enviado"><i class="bi bi-check-circle me-1"></i>Cliente avisada em ${escapeHTML(formatDate(aviso.enviadoEm))}</span>`;
    if(aviso.ultimoErro) return `<span class="aviso-postagem is-erro"><i class="bi bi-exclamation-triangle me-1"></i>Não consegui avisar: ${escapeHTML(aviso.ultimoErro)}</span>`;
    return `<span class="aviso-postagem is-pendente"><i class="bi bi-hourglass-split me-1"></i>Aviso na fila para envio</span>`;
  }

  function renderPendingCarts(orders){
    const now = Date.now();
    const pending = orders.filter(o => {
      if(o.status !== "pendente") return false;
      const age = now - o.createdAt;
      return age >= PENDING_CART_MIN_AGE_MS && age <= PENDING_CART_MAX_AGE_MS;
    });

    if(!pending.length){
      pendingCartsSectionEl.classList.add("d-none");
      return;
    }
    pendingCartsSectionEl.classList.remove("d-none");
    pendingCartsListEl.innerHTML = pending.map(order => {
      const recoveryUrl = whatsappRecoveryUrl(order);
      return `
      <div class="order-card">
        <div class="d-flex align-items-start flex-wrap gap-2 mb-2">
          <div>
            <div class="fw-semibold">${escapeHTML(order.customer?.nome || "Cliente")}</div>
            <div class="small text-ink-soft">Iniciado em ${formatDate(order.createdAt)}</div>
          </div>
          <span class="order-status order-status-pending ms-auto">${escapeHTML(order.items.length)} ${order.items.length === 1 ? "item" : "itens"} — ${formatMoney(order.total)}</span>
        </div>
        <div class="d-flex flex-wrap gap-2">
          ${recoveryUrl ? `
          <a href="${recoveryUrl}" target="_blank" rel="noopener noreferrer" class="btn-outline-blush">
            <i class="bi bi-whatsapp me-1"></i>Chamar no WhatsApp
          </a>` : ""}
          <button type="button" class="btn-outline-blush delete-order-btn" data-ref="${escapeHTML(order.reference)}"><i class="bi bi-trash3 me-1"></i>Apagar carrinho</button>
        </div>
      </div>
    `;
    }).join("");
  }

  async function deleteOrderWithConfirm(reference, onSuccess){
    if(!confirm("Apagar este pedido? Essa ação não pode ser desfeita.")) return;
    try{
      const res = await fetchWithTimeout(`/api/admin/orders/${encodeURIComponent(reference)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(data.error || "Não foi possível apagar o pedido.");
      onSuccess?.();
    }catch(err){
      alert(err.message || "Não foi possível apagar o pedido agora.");
    }
  }

  pendingCartsListEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".delete-order-btn");
    if(!btn) return;
    deleteOrderWithConfirm(btn.dataset.ref, () => loadDashboard());
  });

  async function deleteContactMessageWithConfirm(id, onSuccess){
    if(!confirm("Apagar esta mensagem? Essa ação não pode ser desfeita.")) return;
    try{
      const res = await fetchWithTimeout(`/api/admin/contact-messages/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(data.error || "Não foi possível apagar a mensagem.");
      onSuccess?.();
    }catch(err){
      alert(err.message || "Não foi possível apagar a mensagem agora.");
    }
  }
  messagesListEl?.addEventListener("click", (e) => {
    const btn = e.target.closest(".delete-message-btn");
    if(!btn) return;
    deleteContactMessageWithConfirm(Number(btn.dataset.id), () => loadDashboard());
  });

  let productsCache = [];

  const CUSTOM_PRODUCT_ID_START = 1000;

  function renderProductsTable(products){
    productsCache = products;
    productsTableBodyEl.innerHTML = products.map((p) => {
      const isCustom = p.id >= CUSTOM_PRODUCT_ID_START;
      return `
      <tr data-product-id="${p.id}" class="${p.hidden ? "is-hidden-product" : ""}">
        <td>
          <button type="button" class="admin-drag-handle" data-id="${p.id}" tabindex="0"
                  aria-label="Arrastar ${escapeHTML(p.name)} para reordenar — setas para cima/baixo também funcionam">
            <i class="bi bi-grip-vertical"></i>
          </button>
        </td>
        <td>${imageFor(p)
          ? `<img class="admin-product-thumb" src="${escapeHTML(imageFor(p))}" alt="${escapeHTML(p.name)}" width="44" height="44" loading="lazy">`
          : BOW_PLACEHOLDER}</td>
        <td>${escapeHTML(p.name)}${p.hidden ? ` <span class="admin-hidden-pill">Oculto</span>` : ""}</td>
        <td>${formatMoney(p.price)}</td>
        <td class="small text-ink-soft">${escapeHTML(CATEGORY_LABELS[p.category] || p.category || "—")}</td>
        <td>${(p.badges && p.badges.length) ? p.badges.map(b => `<span class="admin-badge-pill">${escapeHTML(b)}</span>`).join("") : "—"}</td>
        <td>
          <div class="admin-row-actions">
            <button type="button" class="btn-outline-blush edit-product-btn" data-id="${p.id}">Editar</button>
            <button type="button" class="delete-order-icon-btn toggle-hidden-product-btn" data-id="${p.id}"
                    aria-label="${p.hidden ? "Mostrar" : "Ocultar"} ${escapeHTML(p.name)} na vitrine"
                    title="${p.hidden ? "Mostrar na vitrine" : "Ocultar da vitrine"}">
              <i class="bi ${p.hidden ? "bi-eye" : "bi-eye-slash"}"></i>
            </button>
            ${isCustom
              ? `<button type="button" class="delete-order-icon-btn delete-product-btn" data-id="${p.id}" aria-label="Excluir produto"><i class="bi bi-trash3"></i></button>`
              : `<button type="button" class="delete-order-icon-btn" disabled title="Produto do catálogo original — não pode ser excluído. Use o ícone de olho para ocultá-lo em vez de excluir."><i class="bi bi-trash3"></i></button>`}
          </div>
        </td>
      </tr>
    `;
    }).join("");
  }

  const organizarCategoriasBtn = document.getElementById("organizarCategoriasBtn");
  const productsOrderMsgEl = document.getElementById("productsOrderMsg");

  function avisoDeProdutos(texto, ehErro){
    if(!productsOrderMsgEl) return;
    productsOrderMsgEl.textContent = texto;
    productsOrderMsgEl.className = "small mb-2 account-msg" + (ehErro ? " text-danger" : "");
  }

  organizarCategoriasBtn?.addEventListener("click", async () => {
    const mudancas = [];
    for(const p of productsCache){
      const rotulo = detectarCategoriaPorNome(p.name);
      if(!rotulo) continue;
      const atual = CATEGORY_LABELS[p.category] || p.category || "";
      if(atual.toLowerCase() === rotulo.toLowerCase()) continue;
      mudancas.push({ produto: p, de: atual || "sem categoria", para: rotulo });
    }

    if(!mudancas.length){
      avisoDeProdutos("Nada a mudar: todos os produtos reconhecidos já estão na categoria certa.");
      return;
    }

    const exemplos = mudancas.slice(0, 8).map(m => `• ${m.produto.name}: ${m.de} → ${m.para}`).join("\n");
    const resto = mudancas.length > 8 ? `\n…e mais ${mudancas.length - 8}.` : "";
    const plural = mudancas.length === 1 ? "produto vai mudar" : "produtos vão mudar";
    if(!confirm(`${mudancas.length} ${plural} de categoria:\n\n${exemplos}${resto}\n\nAplicar?`)) return;

    organizarCategoriasBtn.disabled = true;
    let feitos = 0;
    try{
      for(const { produto, para } of mudancas){
        avisoDeProdutos(`Organizando... ${feitos + 1} de ${mudancas.length}`);
        const categoria = await garantirCategoria(para);
        if(!categoria) throw new Error(`Não foi possível criar a categoria "${para}".`);
        const res = await fetchWithTimeout(`/api/admin/products/${produto.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category: categoria.slug }),
        });
        if(!res.ok){
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `Falha ao salvar "${produto.name}".`);
        }
        feitos++;
      }
      avisoDeProdutos(`Pronto: ${feitos} ${feitos === 1 ? "produto organizado" : "produtos organizados"}.`);
      await loadDashboard();
    }catch(err){
      avisoDeProdutos(`${err.message} ${feitos} de ${mudancas.length} já foram alterados.`, true);
      await loadDashboard();
    }finally{
      organizarCategoriasBtn.disabled = false;
    }
  });

  const editModalEl = document.getElementById("editProductModal");
  const editModal = new bootstrap.Modal(editModalEl);
  const editForm = document.getElementById("editProductForm");
  const epId = document.getElementById("epId");
  const epName = document.getElementById("epName");
  const epDescription = document.getElementById("epDescription");
  const epPrice = document.getElementById("epPrice");
  const epPhotoFile = document.getElementById("epPhotoFile");
  const epAddPhotoBtn = document.getElementById("epAddPhotoBtn");
  const epPhotosListEl = document.getElementById("epPhotosList");
  const epPhotoStatus = document.getElementById("epPhotoStatus");
  const epCategory = document.getElementById("epCategory");
  const epBadgeBestseller = document.getElementById("epBadgeBestseller");
  const epBadgeNew = document.getElementById("epBadgeNew");
  const epSoldOut = document.getElementById("epSoldOut");
  const epPreview = document.getElementById("epPreview");
  const epPreviewPlaceholder = document.getElementById("epPreviewPlaceholder");
  const epPreviewName = document.getElementById("epPreviewName");
  const epPreviewPrice = document.getElementById("epPreviewPrice");
  const epCropper = document.getElementById("epCropper");
  const epCropStage = document.getElementById("epCropStage");
  const epCropImg = document.getElementById("epCropImg");
  const epCropZoom = document.getElementById("epCropZoom");
  const epCropCancel = document.getElementById("epCropCancel");
  const epCropConfirm = document.getElementById("epCropConfirm");
  const epMsg = document.getElementById("epMsg");
  const epSaveBtn = document.getElementById("epSaveBtn");

  let editOriginal = null;

  let pendingPhotos = [];
  let photoCropTarget = null;
  let photoUploadInFlight = false;

  function selectedBadges(){
    return [epBadgeBestseller, epBadgeNew].filter(cb => cb.checked).map(cb => cb.value);
  }

  function setPreviewPhoto(url){
    const hasPhoto = Boolean(url);
    if(hasPhoto) epPreview.src = url;
    else epPreview.removeAttribute("src");
    epPreview.classList.toggle("d-none", !hasPhoto);
    epPreviewPlaceholder.classList.toggle("d-none", hasPhoto);
  }

  function renderPhotoList(){
    epPhotosListEl.innerHTML = pendingPhotos.map((url, i) => `
      <div class="ep-photo-item">
        <div class="ep-photo-thumb">
          <img src="${escapeHTML(url)}" alt="Foto ${i + 1} do produto" width="64" height="64" loading="lazy">
          ${i === 0 ? `<span class="ep-photo-cover-badge">Capa</span>` : ""}
        </div>
        <div class="ep-photo-actions">
          <button type="button" class="ep-photo-move-btn" data-action="left" data-index="${i}" ${i === 0 ? "disabled" : ""} aria-label="Mover foto ${i + 1} para a esquerda"><i class="bi bi-chevron-left"></i></button>
          <button type="button" class="ep-photo-move-btn" data-action="right" data-index="${i}" ${i === pendingPhotos.length - 1 ? "disabled" : ""} aria-label="Mover foto ${i + 1} para a direita"><i class="bi bi-chevron-right"></i></button>
          <button type="button" class="ep-photo-recrop-btn" data-action="recrop" data-index="${i}" aria-label="Ajustar recorte da foto ${i + 1}"><i class="bi bi-crop"></i></button>
          <button type="button" class="ep-photo-remove-btn" data-action="remove" data-index="${i}" aria-label="Remover foto ${i + 1}"><i class="bi bi-x-lg"></i></button>
        </div>
      </div>
    `).join("");
    setPreviewPhoto(pendingPhotos[0] || "");
  }

  epPhotosListEl.addEventListener("click", (e) => {
    if(photoUploadInFlight) return;
    const btn = e.target.closest("button[data-action]");
    if(!btn) return;
    const index = Number(btn.dataset.index);
    const action = btn.dataset.action;
    if(action === "left" && index > 0){
      [pendingPhotos[index - 1], pendingPhotos[index]] = [pendingPhotos[index], pendingPhotos[index - 1]];
      renderPhotoList();
    }else if(action === "right" && index < pendingPhotos.length - 1){
      [pendingPhotos[index + 1], pendingPhotos[index]] = [pendingPhotos[index], pendingPhotos[index + 1]];
      renderPhotoList();
    }else if(action === "remove"){
      pendingPhotos.splice(index, 1);
      renderPhotoList();
    }else if(action === "recrop"){
      photoCropTarget = index;
      epCropImg.crossOrigin = "anonymous";
      openCropper(pendingPhotos[index]);
    }
  });

  epAddPhotoBtn.addEventListener("click", () => {
    if(pendingPhotos.length >= 8){
      epPhotoStatus.textContent = "Máximo de 8 fotos por produto.";
      epPhotoStatus.className = "small mt-1 is-error";
      return;
    }
    photoCropTarget = null;
    epPhotoFile.value = "";
    epPhotoFile.click();
  });

  function syncPreviewText(){
    epPreviewName.textContent = epName.value.trim() || "Nome do produto";
    const price = Number(epPrice.value);
    epPreviewPrice.textContent = Number.isFinite(price) && price > 0 ? formatMoney(price) : "—";
  }
  epName.addEventListener("input", syncPreviewText);
  epName.addEventListener("input", () => autoDetectarCategoriaEditar(epName.value, epCategory));
  epCategory.addEventListener("change", () => { epCategory.dataset.categoriaManual = "true"; });
  epPrice.addEventListener("input", syncPreviewText);

  function openEditModal(productId){
    const product = productsCache.find(p => p.id === productId);
    if(!product) return;
    epId.value = product.id;
    epName.value = product.name;
    epDescription.value = product.description || "";
    epPrice.value = product.price;
    epPhotoFile.value = "";
    epCategory.dataset.categoriaManual = "false";
    renderCategoryOptions(epCategory, product.category || "");
    epBadgeBestseller.checked = (product.badges || []).includes("Mais vendido");
    epBadgeNew.checked = (product.badges || []).includes("Novo");
    epSoldOut.checked = Boolean(product.soldOut);

    pendingPhotos = Array.isArray(product.photos) ? [...product.photos] : (product.photoUrl ? [product.photoUrl] : []);
    photoCropTarget = null;
    renderPhotoList();
    syncPreviewText();

    closeCropper();
    epMsg.textContent = "";
    epMsg.className = "small account-msg";
    epPhotoStatus.textContent = "";
    epPhotoStatus.className = "small mt-1";
    photoUploadInFlight = false;
    editOriginal = {
      name: product.name,
      description: product.description || "",
      price: product.price,
      photos: [...pendingPhotos],
      category: product.category || "",
      badges: [...(product.badges || [])].sort(),
      soldOut: Boolean(product.soldOut),
    };
    editModal.show();
  }

  const CROP_OUTPUT_W = 800;
  const CROP_OUTPUT_H = 1200;
  const CROP_JPEG_QUALITY = 0.9;

  const crop = { natW: 0, natH: 0, baseScale: 1, zoom: 1, x: 0, y: 0, objectUrl: null, stageW: 0, stageH: 0 };

  function cropClampAndRender(){
    const dispW = crop.natW * crop.baseScale * crop.zoom;
    const dispH = crop.natH * crop.baseScale * crop.zoom;

    crop.x = Math.min(0, Math.max(crop.stageW - dispW, crop.x));
    crop.y = Math.min(0, Math.max(crop.stageH - dispH, crop.y));
    epCropImg.style.width = `${dispW}px`;
    epCropImg.style.height = `${dispH}px`;
    epCropImg.style.transform = `translate(${crop.x}px, ${crop.y}px)`;
  }

  function cropSetZoom(nextZoom, anchorX, anchorY){
    const clamped = Math.min(Number(epCropZoom.max), Math.max(Number(epCropZoom.min), nextZoom));
    const ax = anchorX ?? crop.stageW / 2;
    const ay = anchorY ?? crop.stageH / 2;
    const ratio = clamped / crop.zoom;
    crop.x = ax - (ax - crop.x) * ratio;
    crop.y = ay - (ay - crop.y) * ratio;
    crop.zoom = clamped;
    epCropZoom.value = String(clamped);
    cropClampAndRender();
  }

  function openCropper(src){
    epCropper.classList.remove("d-none");
    epCropImg.onload = () => {
      crop.natW = epCropImg.naturalWidth;
      crop.natH = epCropImg.naturalHeight;
      crop.stageW = epCropStage.clientWidth;
      crop.stageH = epCropStage.clientHeight;

      crop.baseScale = Math.max(crop.stageW / crop.natW, crop.stageH / crop.natH);
      crop.zoom = 1;
      epCropZoom.value = "1";

      crop.x = (crop.stageW - crop.natW * crop.baseScale) / 2;
      crop.y = (crop.stageH - crop.natH * crop.baseScale) / 2;
      cropClampAndRender();
      epCropStage.focus();
    };
    epCropImg.src = src;
  }

  function closeCropper(){
    epCropper.classList.remove("is-zooming");
    epCropper.classList.add("d-none");
    epCropStage.classList.remove("is-dragging");
    if(crop.objectUrl){

      URL.revokeObjectURL(crop.objectUrl);
      crop.objectUrl = null;
    }
  }

  let dragging = false, dragStartX = 0, dragStartY = 0, dragOriginX = 0, dragOriginY = 0;
  epCropStage.addEventListener("pointerdown", (e) => {
    if(!epCropImg.src) return;
    dragging = true;
    dragStartX = e.clientX; dragStartY = e.clientY;
    dragOriginX = crop.x; dragOriginY = crop.y;
    epCropStage.classList.add("is-dragging");
    epCropStage.setPointerCapture(e.pointerId);
  });
  epCropStage.addEventListener("pointermove", (e) => {
    if(!dragging) return;
    crop.x = dragOriginX + (e.clientX - dragStartX);
    crop.y = dragOriginY + (e.clientY - dragStartY);
    cropClampAndRender();
  });
  const endDrag = () => { dragging = false; epCropStage.classList.remove("is-dragging"); };
  epCropStage.addEventListener("pointerup", endDrag);
  epCropStage.addEventListener("pointercancel", endDrag);

  epCropStage.addEventListener("wheel", (e) => {
    if(!epCropImg.src) return;
    e.preventDefault();
    const rect = epCropStage.getBoundingClientRect();
    cropSetZoom(crop.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  epCropZoom.addEventListener("input", () => {
    epCropper.classList.add("is-zooming");
    cropSetZoom(Number(epCropZoom.value));
  });
  epCropZoom.addEventListener("change", () => epCropper.classList.remove("is-zooming"));

  epCropStage.addEventListener("keydown", (e) => {
    if(!epCropImg.src) return;
    const step = e.shiftKey ? 20 : 5;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if(moves[e.key]){
      e.preventDefault();
      crop.x += moves[e.key][0];
      crop.y += moves[e.key][1];
      cropClampAndRender();
      return;
    }
    if(e.key === "+" || e.key === "="){ e.preventDefault(); cropSetZoom(crop.zoom * 1.1); }
    if(e.key === "-" || e.key === "_"){ e.preventDefault(); cropSetZoom(crop.zoom / 1.1); }
  });

  function exportCroppedBlob(){
    return new Promise((resolve, reject) => {
      const canvas = document.createElement("canvas");
      canvas.width = CROP_OUTPUT_W;
      canvas.height = CROP_OUTPUT_H;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, CROP_OUTPUT_W, CROP_OUTPUT_H);

      const scale = crop.baseScale * crop.zoom;
      ctx.drawImage(epCropImg, -crop.x / scale, -crop.y / scale, crop.stageW / scale, crop.stageH / scale,
                    0, 0, CROP_OUTPUT_W, CROP_OUTPUT_H);
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error("Não foi possível preparar a imagem recortada.")),
        "image/jpeg",
        CROP_JPEG_QUALITY
      );
    });
  }

  function uploadPhotoBlob(blob){
    const id = Number(epId.value);
    const formData = new FormData();
    formData.append("photo", new File([blob], `produto-${id}.jpg`, { type: "image/jpeg" }));

    photoUploadInFlight = true;
    epSaveBtn.disabled = true;
    epCropConfirm.disabled = true;
    epPhotoStatus.textContent = "Enviando imagem...";
    epPhotoStatus.className = "small mt-1";

    return fetchWithTimeout(`/api/admin/products/${id}/photo`, { method: "POST", body: formData }, 20000)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if(!res.ok) throw new Error(data.error || "Não foi possível enviar a imagem.");
        if(photoCropTarget === null) pendingPhotos.push(data.photoUrl);
        else pendingPhotos[photoCropTarget] = data.photoUrl;
        photoCropTarget = null;
        renderPhotoList();
        epPhotoStatus.textContent = "Imagem enviada. Clique em salvar para publicar.";
        epPhotoStatus.classList.add("is-success");
      })
      .catch((err) => {
        epPhotoStatus.textContent = err.message || "Erro ao enviar a imagem.";
        epPhotoStatus.classList.add("is-error");
        photoCropTarget = null;
        epPhotoFile.value = "";
      })
      .finally(() => {
        photoUploadInFlight = false;
        epSaveBtn.disabled = false;
        epCropConfirm.disabled = false;
      });
  }

  function handleEpFileSelected(file){
    if(!file) return;
    epMsg.textContent = "";
    epMsg.className = "small account-msg";
    epPhotoStatus.textContent = "";
    epPhotoStatus.className = "small mt-1";
    if(crop.objectUrl) URL.revokeObjectURL(crop.objectUrl);
    crop.objectUrl = URL.createObjectURL(file);
    openCropper(crop.objectUrl);
  }

  epPhotoFile.addEventListener("change", () => {
    handleEpFileSelected(epPhotoFile.files[0]);
  });

  const epPhotoDropzone = document.getElementById("epPhotoDropzone");
  ["dragenter", "dragover"].forEach(evt => epPhotoDropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    epPhotoDropzone.classList.add("is-dragover");
  }));
  epPhotoDropzone.addEventListener("dragleave", (e) => {
    if(!epPhotoDropzone.contains(e.relatedTarget)) epPhotoDropzone.classList.remove("is-dragover");
  });
  epPhotoDropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    epPhotoDropzone.classList.remove("is-dragover");
    if(pendingPhotos.length >= 8){
      epPhotoStatus.textContent = "Máximo de 8 fotos por produto.";
      epPhotoStatus.className = "small mt-1 is-error";
      return;
    }
    const file = [...(e.dataTransfer?.files || [])][0];
    if(!file) return;
    photoCropTarget = null;
    handleEpFileSelected(file);
  });

  epCropCancel.addEventListener("click", () => {
    closeCropper();
    epPhotoFile.value = "";
    photoCropTarget = null;
  });

  epCropConfirm.addEventListener("click", async () => {
    try{
      const blob = await exportCroppedBlob();
      closeCropper();
      await uploadPhotoBlob(blob);
    }catch(err){
      epPhotoStatus.textContent = err.message || "Não foi possível recortar a imagem.";
      epPhotoStatus.className = "small mt-1 is-error";
    }
  });

  let salvandoOrdem = false;

  async function saveProductsOrder(nova){
    renderProductsTable(nova);
    if(salvandoOrdem) return;
    salvandoOrdem = true;
    const msg = document.getElementById("productsOrderMsg");
    msg.textContent = "Salvando a ordem...";
    msg.className = "small mb-2 account-msg";
    try{
      const res = await fetchWithTimeout("/api/admin/products/order", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: nova.map(p => p.id) }),
      });
      const data = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(data.error || "Não foi possível salvar a ordem.");
      msg.textContent = "Ordem salva — a vitrine já está nesta ordem.";
      msg.className = "small mb-2 account-msg text-success";
    }catch(err){
      console.error("Erro ao salvar a ordem dos produtos:", err);
      msg.textContent = err.message || "Não foi possível salvar a ordem.";
      msg.className = "small mb-2 account-msg text-danger";
      await loadDashboard();
    }finally{
      salvandoOrdem = false;
    }
  }

  function moverProdutoPorTeclado(id, direcao){
    if(salvandoOrdem) return;
    const de = productsCache.findIndex(p => p.id === id);
    const para = direcao === "up" ? de - 1 : de + 1;
    if(de === -1 || para < 0 || para >= productsCache.length) return;
    const nova = [...productsCache];
    [nova[de], nova[para]] = [nova[para], nova[de]];
    saveProductsOrder(nova);
    requestAnimationFrame(() => {
      productsTableBodyEl.querySelector(`.admin-drag-handle[data-id="${id}"]`)?.focus();
    });
  }

  let drag = null;

  function rowFor(id){
    return productsTableBodyEl.querySelector(`tr[data-product-id="${id}"]`);
  }

  function applyDragGap(){
    productsCache.forEach((p, i) => {
      if(p.id === drag.id) return;
      const row = rowFor(p.id);
      if(!row) return;
      let shift = 0;
      if(drag.origIndex < drag.newIndex && i > drag.origIndex && i <= drag.newIndex) shift = -1;
      else if(drag.origIndex > drag.newIndex && i >= drag.newIndex && i < drag.origIndex) shift = 1;
      row.style.transform = shift ? `translateY(${shift * drag.rowHeight}px)` : "";
    });
  }

  function clearDragStyles(){
    productsTableBodyEl.querySelectorAll("tr[data-product-id]").forEach(r => {
      r.style.transform = "";
      r.classList.remove("is-dragging");
    });
    productsTableBodyEl.classList.remove("is-reordering");
  }

  function onDragPointerMove(e){
    if(!drag || e.pointerId !== drag.pointerId) return;
    const deltaY = e.clientY - drag.startY;
    drag.row.style.transform = `translateY(${deltaY}px)`;
    const rawIndex = drag.origIndex + Math.round(deltaY / drag.rowHeight);
    const newIndex = Math.max(0, Math.min(productsCache.length - 1, rawIndex));
    if(newIndex !== drag.newIndex){
      drag.newIndex = newIndex;
      applyDragGap();
    }
  }

  function onDragPointerUp(e){
    if(!drag || e.pointerId !== drag.pointerId) return;
    const { id, origIndex, newIndex } = drag;
    clearDragStyles();
    window.removeEventListener("pointermove", onDragPointerMove);
    window.removeEventListener("pointerup", onDragPointerUp);
    window.removeEventListener("pointercancel", onDragPointerUp);
    drag = null;
    if(newIndex === origIndex) return;
    const nova = [...productsCache];
    const [moved] = nova.splice(origIndex, 1);
    nova.splice(newIndex, 0, moved);
    saveProductsOrder(nova);
  }

  productsTableBodyEl.addEventListener("pointerdown", (e) => {
    if(salvandoOrdem) return;
    const handle = e.target.closest(".admin-drag-handle");
    if(!handle) return;
    const row = handle.closest("tr");
    const id = Number(handle.dataset.id);
    const origIndex = productsCache.findIndex(p => p.id === id);
    if(origIndex === -1) return;
    drag = {
      id, row, pointerId: e.pointerId, startY: e.clientY,
      origIndex, newIndex: origIndex, rowHeight: row.getBoundingClientRect().height,
    };
    handle.setPointerCapture(e.pointerId);
    row.classList.add("is-dragging");
    productsTableBodyEl.classList.add("is-reordering");
    window.addEventListener("pointermove", onDragPointerMove);
    window.addEventListener("pointerup", onDragPointerUp);
    window.addEventListener("pointercancel", onDragPointerUp);
    e.preventDefault();
  });

  productsTableBodyEl.addEventListener("keydown", (e) => {
    const handle = e.target.closest(".admin-drag-handle");
    if(!handle || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    moverProdutoPorTeclado(Number(handle.dataset.id), e.key === "ArrowUp" ? "up" : "down");
  });

  productsTableBodyEl.addEventListener("click", (e) => {
    const editBtn = e.target.closest(".edit-product-btn");
    if(editBtn){ openEditModal(Number(editBtn.dataset.id)); return; }
    const deleteBtn = e.target.closest(".delete-product-btn");
    if(deleteBtn){ deleteProductWithConfirm(Number(deleteBtn.dataset.id)); return; }
    const toggleHiddenBtn = e.target.closest(".toggle-hidden-product-btn");
    if(toggleHiddenBtn) toggleProductHidden(Number(toggleHiddenBtn.dataset.id));
  });

  async function toggleProductHidden(id){
    const product = productsCache.find(p => p.id === id);
    if(!product) return;
    const nextHidden = !product.hidden;
    try{
      const res = await fetchWithTimeout(`/api/admin/products/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: nextHidden }),
      });
      const data = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(data.error || "Não foi possível atualizar o produto.");
      product.hidden = data.hidden;
      renderProductsTable(productsCache);
    }catch(err){
      alert(err.message || "Não foi possível atualizar o produto agora.");
    }
  }

  async function deleteProductWithConfirm(id){
    if(!confirm("Excluir este produto? Essa ação não pode ser desfeita.")) return;
    try{
      const res = await fetchWithTimeout(`/api/admin/products/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(data.error || "Não foi possível excluir o produto.");
      productsCache = productsCache.filter(p => p.id !== id);
      renderProductsTable(productsCache);
    }catch(err){
      alert(err.message || "Não foi possível excluir o produto agora.");
    }
  }

  editForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if(photoUploadInFlight) return; 
    const id = Number(epId.value);
    const name = epName.value.trim();
    const description = epDescription.value.trim();
    const price = Number(epPrice.value);
    const category = epCategory.value;
    const badges = selectedBadges();

    const patch = {};
    if(name !== editOriginal.name) patch.name = name;
    if(description !== editOriginal.description) patch.description = description;
    if(price !== editOriginal.price) patch.price = price;
    if(JSON.stringify(pendingPhotos) !== JSON.stringify(editOriginal.photos)) patch.photos = pendingPhotos;
    if(category !== editOriginal.category) patch.category = category;
    const sortedBadges = [...badges].sort();
    if(JSON.stringify(sortedBadges) !== JSON.stringify(editOriginal.badges)) patch.badges = badges;
    if(epSoldOut.checked !== editOriginal.soldOut) patch.soldOut = epSoldOut.checked;

    if(Object.keys(patch).length === 0){
      editModal.hide();
      return;
    }

    epMsg.textContent = "";
    epMsg.className = "small account-msg";
    epSaveBtn.disabled = true;
    epSaveBtn.textContent = "Salvando...";

    try{
      const res = await fetch(`/api/admin/products/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(data.error || "Não foi possível salvar o produto.");

      const idx = productsCache.findIndex(p => p.id === id);
      if(idx !== -1) productsCache[idx] = data;
      renderProductsTable(productsCache);

      editModal.hide();
    }catch(err){
      epMsg.textContent = err.message || "Erro ao salvar.";
      epMsg.classList.add("text-danger");
    }finally{
      epSaveBtn.disabled = false;
      epSaveBtn.textContent = "Salvar alterações";
    }
  });

  async function promptNewCategory(selectToUpdate){
    const label = prompt("Nome da nova categoria (ex.: Aniversário):");
    if(!label || !label.trim()) return;
    try{
      const res = await fetchWithTimeout("/api/admin/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(data.error || "Não foi possível criar a categoria.");
      currentCategories = [...currentCategories, data];
      selectToUpdate.dataset.categoriaManual = "true";
      renderCategoryOptions(selectToUpdate, data.slug);
      if(selectToUpdate === apCategory) atualizarDescricaoAutomatica();
    }catch(err){
      alert(err.message || "Não foi possível criar a categoria agora.");
    }
  }
  document.getElementById("epNewCategoryBtn").addEventListener("click", () => promptNewCategory(epCategory));

  const addProductModalEl = document.getElementById("addProductModal");
  const addProductModal = new bootstrap.Modal(addProductModalEl);
  const addProductForm = document.getElementById("addProductForm");
  const apName = document.getElementById("apName");
  const apDescription = document.getElementById("apDescription");
  const apPrice = document.getElementById("apPrice");
  const apWeight = document.getElementById("apWeight");
  const apWidth = document.getElementById("apWidth");
  const apHeight = document.getElementById("apHeight");
  const apLength = document.getElementById("apLength");
  const apCategory = document.getElementById("apCategory");

  function atualizarDescricaoAutomatica(){
    if(apDescription.dataset.descricaoManual === "true") return;
    const nome = apName.value.trim();
    if(!nome){ apDescription.value = ""; return; }
    const categoria = currentCategories.find(c => c.slug === apCategory.value);
    apDescription.value = categoria
      ? `${nome} — laço artesanal feito à mão pela Adriana Melo Acessórios, ideal para ${categoria.label.toLowerCase()}.`
      : `${nome} — laço artesanal feito à mão pela Adriana Melo Acessórios.`;
  }
  apDescription.addEventListener("input", () => { apDescription.dataset.descricaoManual = "true"; });

  async function aoDigitarNomeAdicionar(){
    await autoDetectarCategoria(apName.value, apCategory);
    atualizarDescricaoAutomatica();
  }
  const aoDigitarNomeAdicionarComAtraso = comAtraso(aoDigitarNomeAdicionar, 400);
  apName.addEventListener("input", aoDigitarNomeAdicionarComAtraso);
  apCategory.addEventListener("change", () => {
    apCategory.dataset.categoriaManual = "true";
    atualizarDescricaoAutomatica();
  });
  const apBadgeBestseller = document.getElementById("apBadgeBestseller");
  const apBadgeNew = document.getElementById("apBadgeNew");
  const apMsg = document.getElementById("apMsg");
  const apSaveBtn = document.getElementById("apSaveBtn");
  const apPhotoFile = document.getElementById("apPhotoFile");
  const apAddPhotoBtn = document.getElementById("apAddPhotoBtn");
  const apPhotosListEl = document.getElementById("apPhotosList");
  const apPhotoStatus = document.getElementById("apPhotoStatus");

  let apPendingPhotos = [];

  function fitPhotoTo23(file){
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = CROP_OUTPUT_W;
        canvas.height = CROP_OUTPUT_H;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, CROP_OUTPUT_W, CROP_OUTPUT_H);

        const scale = Math.max(CROP_OUTPUT_W / img.naturalWidth, CROP_OUTPUT_H / img.naturalHeight);
        const srcW = CROP_OUTPUT_W / scale;
        const srcH = CROP_OUTPUT_H / scale;
        ctx.drawImage(img, (img.naturalWidth - srcW) / 2, (img.naturalHeight - srcH) / 2, srcW, srcH,
                      0, 0, CROP_OUTPUT_W, CROP_OUTPUT_H);
        URL.revokeObjectURL(objectUrl);
        canvas.toBlob(
          (blob) => blob ? resolve(blob) : reject(new Error("Não foi possível preparar a imagem.")),
          "image/jpeg",
          CROP_JPEG_QUALITY
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error(`Não foi possível ler "${file.name}".`));
      };
      img.src = objectUrl;
    });
  }

  function renderApPhotoList(){
    apPhotosListEl.innerHTML = apPendingPhotos.map((p, i) => `
      <div class="ep-photo-item">
        <div class="ep-photo-thumb">
          <img src="${escapeHTML(p.previewUrl)}" alt="Foto ${i + 1} do produto" width="64" height="64">
          ${i === 0 ? `<span class="ep-photo-cover-badge">Capa</span>` : ""}
        </div>
        <div class="ep-photo-actions">
          <button type="button" class="ep-photo-move-btn" data-action="left" data-index="${i}" ${i === 0 ? "disabled" : ""} aria-label="Mover foto ${i + 1} para a esquerda"><i class="bi bi-chevron-left"></i></button>
          <button type="button" class="ep-photo-move-btn" data-action="right" data-index="${i}" ${i === apPendingPhotos.length - 1 ? "disabled" : ""} aria-label="Mover foto ${i + 1} para a direita"><i class="bi bi-chevron-right"></i></button>
          <button type="button" class="ep-photo-remove-btn" data-action="remove" data-index="${i}" aria-label="Remover foto ${i + 1}"><i class="bi bi-x-lg"></i></button>
        </div>
      </div>
    `).join("");
  }

  function resetApPhotos(){
    apPendingPhotos.forEach(p => URL.revokeObjectURL(p.previewUrl));
    apPendingPhotos = [];
    apPhotoFile.value = "";
    apPhotoStatus.textContent = "";
    apPhotoStatus.className = "small mt-1";
    renderApPhotoList();
  }

  apPhotosListEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if(!btn) return;
    const index = Number(btn.dataset.index);
    const action = btn.dataset.action;
    if(action === "left" && index > 0){
      [apPendingPhotos[index - 1], apPendingPhotos[index]] = [apPendingPhotos[index], apPendingPhotos[index - 1]];
    }else if(action === "right" && index < apPendingPhotos.length - 1){
      [apPendingPhotos[index + 1], apPendingPhotos[index]] = [apPendingPhotos[index], apPendingPhotos[index + 1]];
    }else if(action === "remove"){
      URL.revokeObjectURL(apPendingPhotos[index].previewUrl);
      apPendingPhotos.splice(index, 1);
    }else{
      return;
    }
    renderApPhotoList();
  });

  apAddPhotoBtn.addEventListener("click", () => {
    if(apPendingPhotos.length >= 8){
      apPhotoStatus.textContent = "Máximo de 8 fotos por produto.";
      apPhotoStatus.className = "small mt-1 is-error";
      return;
    }
    apPhotoFile.value = "";
    apPhotoFile.click();
  });

  async function handleApFiles(files){
    if(!files.length) return;
    apPhotoStatus.textContent = "";
    apPhotoStatus.className = "small mt-1";

    const livres = 8 - apPendingPhotos.length;
    const aceitos = files.slice(0, Math.max(0, livres));
    try{
      for(const file of aceitos){
        const blob = await fitPhotoTo23(file);
        apPendingPhotos.push({ blob, previewUrl: URL.createObjectURL(blob) });
      }
      renderApPhotoList();
      if(files.length > aceitos.length){
        apPhotoStatus.textContent = "Máximo de 8 fotos por produto — as demais foram ignoradas.";
        apPhotoStatus.className = "small mt-1 is-error";
      }
    }catch(err){
      renderApPhotoList();
      apPhotoStatus.textContent = err.message || "Não foi possível preparar a imagem.";
      apPhotoStatus.className = "small mt-1 is-error";
    }
  }

  apPhotoFile.addEventListener("change", async () => {
    await handleApFiles([...apPhotoFile.files]);
    apPhotoFile.value = "";
  });

  const apPhotoDropzone = document.getElementById("apPhotoDropzone");
  ["dragenter", "dragover"].forEach(evt => apPhotoDropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    apPhotoDropzone.classList.add("is-dragover");
  }));
  apPhotoDropzone.addEventListener("dragleave", (e) => {
    if(!apPhotoDropzone.contains(e.relatedTarget)) apPhotoDropzone.classList.remove("is-dragover");
  });
  apPhotoDropzone.addEventListener("drop", async (e) => {
    e.preventDefault();
    apPhotoDropzone.classList.remove("is-dragover");
    await handleApFiles([...(e.dataTransfer?.files || [])]);
  });

  document.getElementById("apNewCategoryBtn").addEventListener("click", () => promptNewCategory(apCategory));

  const manageCategoriesModalEl = document.getElementById("manageCategoriesModal");
  const manageCategoriesModal = new bootstrap.Modal(manageCategoriesModalEl);
  const manageCategoriesListEl = document.getElementById("manageCategoriesList");
  const manageCategoriesMsgEl = document.getElementById("manageCategoriesMsg");

  function renderManageCategoriesList(){
    manageCategoriesListEl.innerHTML = currentCategories.map(c => `
      <div class="manage-category-row" data-slug="${escapeHTML(c.slug)}">
        <span class="manage-category-label">${escapeHTML(c.label)}</span>
        ${c.builtin
          ? `<span class="manage-category-tag">fixa</span>`
          : `<div class="admin-row-actions">
              <button type="button" class="edit-order-icon-btn rename-category-btn" data-slug="${escapeHTML(c.slug)}" data-label="${escapeHTML(c.label)}" aria-label="Renomear categoria" title="Renomear categoria"><i class="bi bi-pencil"></i></button>
              <button type="button" class="delete-order-icon-btn delete-category-btn" data-slug="${escapeHTML(c.slug)}" aria-label="Excluir categoria" title="Excluir categoria"><i class="bi bi-trash3"></i></button>
            </div>`}
      </div>
    `).join("");
  }

  function openManageCategoriesModal(){
    manageCategoriesMsgEl.textContent = "";
    manageCategoriesMsgEl.className = "small account-msg mt-2";
    renderManageCategoriesList();
    manageCategoriesModal.show();
  }
  document.getElementById("epManageCategoriesBtn").addEventListener("click", openManageCategoriesModal);
  document.getElementById("apManageCategoriesBtn").addEventListener("click", openManageCategoriesModal);

  function refreshCategorySelects(){
    renderCategoryOptions(epCategory, epCategory.value);
    renderCategoryOptions(apCategory, apCategory.value);
  }

  manageCategoriesListEl.addEventListener("click", async (e) => {
    const renameBtn = e.target.closest(".rename-category-btn");
    if(renameBtn){
      const slug = renameBtn.dataset.slug;
      const novoNome = prompt("Novo nome da categoria:", renameBtn.dataset.label);
      if(!novoNome || !novoNome.trim() || novoNome.trim() === renameBtn.dataset.label) return;
      try{
        const res = await fetchWithTimeout(`/api/admin/categories/${encodeURIComponent(slug)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: novoNome.trim() }),
        });
        const data = await res.json().catch(() => ({}));
        if(!res.ok) throw new Error(data.error || "Não foi possível renomear a categoria.");
        currentCategories = currentCategories.map(c => c.slug === slug ? { ...c, label: data.label } : c);
        renderManageCategoriesList();
        refreshCategorySelects();
      }catch(err){
        manageCategoriesMsgEl.textContent = err.message || "Erro ao renomear a categoria.";
        manageCategoriesMsgEl.classList.add("text-danger");
      }
      return;
    }
    const deleteBtn = e.target.closest(".delete-category-btn");
    if(deleteBtn){
      const slug = deleteBtn.dataset.slug;
      const categoria = currentCategories.find(c => c.slug === slug);
      if(!confirm(`Excluir a categoria "${categoria?.label || slug}"? Essa ação não pode ser desfeita.`)) return;
      try{
        const res = await fetchWithTimeout(`/api/admin/categories/${encodeURIComponent(slug)}`, { method: "DELETE" });
        const data = await res.json().catch(() => ({}));
        if(!res.ok) throw new Error(data.error || "Não foi possível excluir a categoria.");
        currentCategories = currentCategories.filter(c => c.slug !== slug);
        renderManageCategoriesList();
        refreshCategorySelects();
      }catch(err){
        manageCategoriesMsgEl.textContent = err.message || "Erro ao excluir a categoria.";
        manageCategoriesMsgEl.classList.add("text-danger");
      }
    }
  });

  document.getElementById("addProductBtn").addEventListener("click", () => {
    addProductForm.reset();
    resetApPhotos();
    apCategory.dataset.categoriaManual = "false";
    apDescription.dataset.descricaoManual = "false";
    renderCategoryOptions(apCategory, "");
    apMsg.textContent = "";
    apMsg.className = "small account-msg";
    addProductModal.show();
  });

  addProductForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      name: apName.value.trim(),
      description: apDescription.value.trim(),
      price: Number(apPrice.value),
      weight: Number(apWeight.value),
      width: Number(apWidth.value),
      height: Number(apHeight.value),
      length: Number(apLength.value),
      category: apCategory.value,
      badges: [apBadgeBestseller, apBadgeNew].filter(cb => cb.checked).map(cb => cb.value),
    };

    apMsg.textContent = "";
    apMsg.className = "small account-msg";
    apSaveBtn.disabled = true;
    apSaveBtn.textContent = "Criando...";

    try{
      const res = await fetchWithTimeout("/api/admin/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(data.error || "Não foi possível criar o produto.");

      let fotosComProblema = false;
      if(apPendingPhotos.length){
        apSaveBtn.textContent = "Enviando fotos...";
        const urls = [];
        for(const [i, foto] of apPendingPhotos.entries()){
          try{
            const formData = new FormData();
            formData.append("photo", new File([foto.blob], `produto-${data.id}.jpg`, { type: "image/jpeg" }));
            const up = await fetchWithTimeout(`/api/admin/products/${data.id}/photo`, { method: "POST", body: formData }, 20000);
            const upData = await up.json().catch(() => ({}));
            if(!up.ok) throw new Error(upData.error || "falha no envio");
            urls.push(upData.photoUrl);
          }catch(err){
            console.error(`Falha ao enviar a foto ${i + 1}:`, err);
            fotosComProblema = true;
          }
        }
        if(urls.length){
          const patch = await fetchWithTimeout(`/api/admin/products/${data.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ photos: urls }),
          });
          if(!patch.ok) fotosComProblema = true;
        }
      }

      addProductModal.hide();
      resetApPhotos();

      await loadDashboard();
      openEditModal(data.id);
      if(fotosComProblema){
        alert("O produto foi criado, mas pelo menos uma foto não subiu. Confira a lista de fotos e adicione de novo o que faltar.");
      }
    }catch(err){
      apMsg.textContent = err.message || "Erro ao criar o produto.";
      apMsg.classList.add("text-danger");
    }finally{
      apSaveBtn.disabled = false;
      apSaveBtn.textContent = "Criar produto";
    }
  });

  function mascararCpf(valor){
    const d = String(valor || "").replace(/\D/g, "");
    return d.length === 11 ? `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9)}` : (valor || "");
  }
  function mascararCep(valor){
    const d = String(valor || "").replace(/\D/g, "");
    return d.length === 8 ? `${d.slice(0,5)}-${d.slice(5)}` : (valor || "");
  }

  function camposDoCliente(order){
    const a = order.address || {};
    const c = order.customer || {};
    return [
      ["Nome", c.nome || a.nome],
      ["CPF", mascararCpf(c.cpf || a.cpf)],
      ["Telefone", c.telefone || a.telefone],
      ["CEP", mascararCep(a.cep)],
      ["Rua", a.rua],
      ["Número", a.numero],
      ["Complemento", a.complemento],
      ["Bairro", a.bairro],
      ["Cidade", a.cidade],
      ["UF", a.uf],
      ["E-mail da conta", c.email],
    ].filter(([, valor]) => valor != null && String(valor).trim() !== "");
  }

  function linhaCopiavel(rotulo, valor){
    const texto = String(valor);
    return `
      <div class="order-field">
        <span class="order-field-label">${escapeHTML(rotulo)}</span>
        <span class="order-field-value">${escapeHTML(texto)}</span>
        <button type="button" class="copy-field-btn" data-copiar="${escapeHTML(texto)}"
                aria-label="Copiar ${escapeHTML(rotulo.toLowerCase())}" title="Copiar ${escapeHTML(rotulo.toLowerCase())}">
          <i class="bi bi-clipboard"></i>
        </button>
      </div>`;
  }

  const pedidosAbertos = new Set();
  const dadosDaClienteAbertos = new Set();

  function proximoPasso(order){
    if(order.status !== "pago") return null;
    if(order.fulfillmentStatus === "entregue") return { texto: "Entregue", cls: "is-pronto" };
    if(!order.trackingCode) return { texto: "Falta postar", cls: "is-agora" };
    return { texto: "A caminho", cls: "is-andamento" };
  }

  function orderCardHTML(order){
    const status = STATUS_LABELS[order.status] || { label: escapeHTML(order.status), cls:"order-status-pending" };
    const ref = order.reference;
    const isPaid = order.status === "pago";

    const contactUrl = isPaid ? whatsappContactUrl(order) : null;

    const itemsHtml = order.items.map(item => `
      <li class="d-flex align-items-center justify-content-between gap-3">
        <span class="d-flex align-items-center gap-2">
          ${item.photoUrl
            ? `<img class="admin-product-thumb" src="${escapeHTML(item.photoUrl)}" alt="${escapeHTML(item.name)}" width="44" height="44" loading="lazy">`
            : BOW_PLACEHOLDER}
          <span>${item.qty}x ${escapeHTML(item.name)}</span>
        </span>
        <span class="flex-shrink-0">${item.unitPrice != null ? formatMoney(item.unitPrice * item.qty) : "—"}</span>
      </li>
    `).join("");

    const passo = proximoPasso(order);
    const aberto = pedidosAbertos.has(ref);
    const dadosFechados = !dadosDaClienteAbertos.has(ref);
    const quem = (order.customer?.nome || order.address?.nome || "").split(" ")[0] || "";

    return `
      <div class="order-card${aberto ? " is-aberto" : ""}" id="pedido-${escapeHTML(ref)}" data-ref="${escapeHTML(ref)}">
        <div class="order-card-topo">
          <button type="button" class="order-card-head" data-ref="${escapeHTML(ref)}"
                  aria-expanded="${aberto ? "true" : "false"}" aria-controls="corpo-${escapeHTML(ref)}">
            <i class="bi bi-chevron-right order-card-seta" aria-hidden="true"></i>
            <span class="order-card-info">
              <span class="order-card-titulo">#${escapeHTML(ref.slice(0, 8))}${quem ? ` · ${escapeHTML(quem)}` : ""}</span>
              <span class="order-card-sub">${formatDate(order.createdAt)} · ${formatMoney(order.total)}</span>
            </span>
            <span class="order-card-tags">
              ${order.avaliacao ? `<span class="order-avaliado" title="Nota média que a cliente deu">★ ${escapeHTML(String(order.avaliacao.media).replace(".", ","))}</span>` : ""}
              ${passo ? `<span class="order-passo ${passo.cls}">${passo.texto}</span>` : ""}
              <span class="order-status ${status.cls}">${status.label}</span>
            </span>
          </button>
          ${!isPaid ? `<button type="button" class="delete-order-icon-btn delete-order-btn" data-ref="${escapeHTML(ref)}" aria-label="Apagar pedido" title="Apagar pedido"><i class="bi bi-trash3"></i></button>` : ""}
        </div>

        <div class="order-card-corpo" id="corpo-${escapeHTML(ref)}"${aberto ? "" : " hidden"}>
        <button type="button" class="dados-toggle${dadosFechados ? "" : " is-aberto"}" data-ref="${escapeHTML(ref)}"
                aria-expanded="${dadosFechados ? "false" : "true"}" aria-controls="dados-${escapeHTML(ref)}">
          <i class="bi bi-chevron-right dados-toggle-seta" aria-hidden="true"></i>Dados da cliente
        </button>
        <div class="order-fields small mb-3" id="dados-${escapeHTML(ref)}"${dadosFechados ? " hidden" : ""}>
          ${camposDoCliente(order).map(([rotulo, valor]) => linhaCopiavel(rotulo, valor)).join("")}
          ${order.shipping?.name ? `<div class="order-field"><span class="order-field-label">Envio</span><span class="order-field-value">${escapeHTML(order.shipping.name)}</span></div>` : ""}
        </div>

        ${contactUrl ? `
        <div class="mb-3">
          <a href="${contactUrl}" target="_blank" rel="noopener noreferrer" class="btn-outline-blush btn-sm-blush" title="Abrir conversa no WhatsApp com o cliente">
            <i class="bi bi-whatsapp me-1"></i>Contatar via WhatsApp
          </a>
        </div>` : ""}

        <ul class="list-unstyled small mb-2">${itemsHtml}</ul>

        ${order.discount > 0 ? `
        <div class="d-flex justify-content-between small text-blush">
          <span>Desconto${order.couponCode ? " (" + escapeHTML(order.couponCode) + ")" : ""}</span>
          <span>-${formatMoney(order.discount)}</span>
        </div>` : ""}
        ${order.pixDiscount > 0 ? `
        <div class="d-flex justify-content-between small text-blush">
          <span>Desconto Pix</span><span>-${formatMoney(order.pixDiscount)}</span>
        </div>` : ""}
        ${order.promoDiscount > 0 ? `
        <div class="d-flex justify-content-between small text-blush">
          <span>Leve 4, pague 3</span><span>-${formatMoney(order.promoDiscount)}</span>
        </div>` : ""}

        <div class="d-flex justify-content-between fw-semibold pt-2 mt-1 border-top" style="border-color:var(--blush-100)!important">
          <span>Total <span class="fw-normal small text-ink-soft">· ${escapeHTML(PAYMENT_METHOD_LABELS[order.paymentMethod] || "Cartão ou boleto")}</span></span>
          <span class="text-blush">${formatMoney(order.total)}</span>
        </div>

        ${isPaid ? `
        <div class="tracking-row mt-3 pt-3 border-top" style="border-color:var(--blush-100)!important">
          <div class="tracking-bloco">
            <label class="tracking-bloco-titulo" for="tracking-${escapeHTML(ref)}">Código de rastreio</label>
            <div class="d-flex gap-2 flex-wrap align-items-center">
              <input type="text" class="form-control form-control-sm tracking-input" id="tracking-${escapeHTML(ref)}"
                     value="${escapeHTML(order.trackingCode || "")}" placeholder="Ex.: ME123456789BR" maxlength="60">
              <button type="button" class="btn-outline-blush save-tracking-btn" data-ref="${escapeHTML(ref)}" title="Comprou a etiqueta no site do Melhor Envio? Cole aqui o código de rastreio que eles deram e salve — a cliente acompanha ao vivo do mesmo jeito.">Salvar</button>
              <button type="button" class="btn-outline-blush generate-label-btn" data-ref="${escapeHTML(ref)}" title="Compra a etiqueta no Melhor Envio (gasta saldo real) e preenche o código automaticamente"><i class="bi bi-stars me-1"></i>Comprar etiqueta</button>
            </div>
          </div>

          ${order.trackingCode ? `
          <div class="tracking-bloco">
            <span class="tracking-bloco-titulo">Entrega</span>
            <div class="d-flex gap-2 flex-wrap align-items-center">
              ${order.fulfillmentStatus === "postado" ? `
              <button type="button" class="btn-outline-blush check-delivery-btn" data-ref="${escapeHTML(ref)}" title="Pergunta ao Melhor Envio se o pedido já chegou"><i class="bi bi-search me-1"></i>Conferir no Melhor Envio</button>
              <button type="button" class="btn-outline-blush mark-delivered-btn" data-ref="${escapeHTML(ref)}" title="Marca este pedido como entregue"><i class="bi bi-check2-circle me-1"></i>Marcar como entregue</button>
              ` : order.fulfillmentStatus === "entregue" ? `<span class="small fw-semibold" style="color:var(--color-success)"><i class="bi bi-check2-circle me-1"></i>Entregue${order.deliveredAt ? " em " + escapeHTML(formatDate(order.deliveredAt)) : ""}</span>` : `<span class="small" style="color:var(--ink-soft)">Aguardando a postagem.</span>`}
            </div>
          </div>

          <div class="tracking-bloco">
            <span class="tracking-bloco-titulo">Aviso à cliente</span>
            <div class="d-flex gap-2 flex-wrap align-items-center">
              ${whatsappPostagemUrl(order) ? `
              <a class="btn-outline-blush" href="${escapeHTML(whatsappPostagemUrl(order))}" target="_blank" rel="noopener" title="Abre a conversa com a cliente já com o código e o link"><i class="bi bi-whatsapp me-1"></i>Avisar no WhatsApp</a>
              ` : ""}
              <button type="button" class="btn-outline-blush resend-notice-btn" data-ref="${escapeHTML(ref)}" title="Reenvia o e-mail de 'seu pedido foi postado' com o código já salvo"><i class="bi bi-send me-1"></i>Avisar de novo por e-mail</button>
              <button type="button" class="btn-outline-blush pedir-avaliacao-btn" data-ref="${escapeHTML(ref)}" title="Manda para a cliente o link para ela contar o que achou"><i class="bi bi-star-fill me-1"></i>Pedir avaliação</button>
            </div>
            ${textoDoAviso(order)}
          </div>` : ""}

          <span class="small tracking-feedback" data-ref-feedback="${escapeHTML(ref)}"></span>
        </div>
        ` : ""}
        </div>
      </div>
    `;
  }

  function alternarPedido(ref){
    const card = document.getElementById(`pedido-${ref}`);
    if(!card) return;
    const head = card.querySelector(".order-card-head");
    const corpo = card.querySelector(".order-card-corpo");
    if(!head || !corpo) return;
    const abrindo = corpo.hidden;
    corpo.hidden = !abrindo;
    head.setAttribute("aria-expanded", String(abrindo));
    card.classList.toggle("is-aberto", abrindo);
    if(abrindo) pedidosAbertos.add(ref); else pedidosAbertos.delete(ref);
  }

  function abrirPedido(ref){
    if(pedidosAbertos.has(ref)) return;
    alternarPedido(ref);
  }

  function alternarDadosDaCliente(ref){
    const card = document.getElementById(`pedido-${ref}`);
    const botao = card?.querySelector(".dados-toggle");
    const campos = document.getElementById(`dados-${ref}`);
    if(!botao || !campos) return;
    const abrindo = campos.hidden;
    campos.hidden = !abrindo;
    botao.setAttribute("aria-expanded", String(abrindo));
    botao.classList.toggle("is-aberto", abrindo);
    if(abrindo) dadosDaClienteAbertos.add(ref); else dadosDaClienteAbertos.delete(ref);
  }

  function highlightFromQuery(){
    const params = new URLSearchParams(window.location.search);
    const ref = params.get("pedido");
    if(!ref) return;

    switchTab("pedidos");

    const card = document.getElementById(`pedido-${ref}`);
    if(!card) return;
    abrirPedido(ref);
    card.scrollIntoView({ behavior:"smooth", block:"center" });
    card.classList.add("is-highlighted");
    setTimeout(() => card.classList.remove("is-highlighted"), 4000);
  }

  const GRUPOS_DE_SITUACAO = {
    pago:      ["pago"],
    pendente:  ["pendente", "em análise"],
    cancelado: ["recusado", "cancelado", "reembolsado", "estornado"],
  };
  const GRUPOS_DE_ENTREGA = {
    enviado:  ["postado"],
    entregue: ["entregue"],
  };
  const VAZIO_POR_SITUACAO = {
    todos:     "Nenhum pedido registrado ainda.",
    pago:      "Nenhum pedido pago ainda.",
    pendente:  "Nenhum pedido aguardando pagamento.",
    enviado:   "Nenhum pedido postado esperando entrega.",
    entregue:  "Nenhum pedido entregue ainda.",
    cancelado: "Nenhum pedido cancelado ou recusado.",
  };

  let situacaoDePedidos = "todos";
  let todosOsPedidos = [];

  function pedidosDaSituacao(situacao){
    if(situacao === "todos") return todosOsPedidos;
    const porEntrega = GRUPOS_DE_ENTREGA[situacao];
    if(porEntrega) return todosOsPedidos.filter(o => porEntrega.includes(o.fulfillmentStatus));
    const aceitos = GRUPOS_DE_SITUACAO[situacao] || [];
    return todosOsPedidos.filter(o => aceitos.includes(o.status));
  }

  function atualizarContagemDeSituacoes(){
    const grupo = document.getElementById("ordersFilter");
    if(!grupo) return;
    grupo.querySelectorAll(".chip").forEach(chip => {
      const n = pedidosDaSituacao(chip.dataset.situacao).length;
      /* Contagem em atributo, não dentro do texto do botão: foi a armadilha
         da vitrine, onde o rótulo da categoria é lido de chip.textContent. */
      chip.dataset.contagem = String(n);
      chip.setAttribute("aria-label", `${chip.textContent.trim()}: ${n}`);
    });
  }

  document.getElementById("ordersFilter")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if(!btn) return;
    document.querySelectorAll("#ordersFilter .chip").forEach(c => {
      c.classList.remove("active");
      c.setAttribute("aria-pressed", "false");
    });
    btn.classList.add("active");
    btn.setAttribute("aria-pressed", "true");
    situacaoDePedidos = btn.dataset.situacao;
    btn.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
    renderOrders(pedidosDaSituacao(situacaoDePedidos));
  });

  function renderOrders(orders){
    const vazioEl = stateEmpty.querySelector("p");
    if(vazioEl) vazioEl.textContent = VAZIO_POR_SITUACAO[situacaoDePedidos] || VAZIO_POR_SITUACAO.todos;
    if(!orders.length){
      stateEmpty.classList.remove("d-none");
      listEl.classList.add("d-none");
      return;
    }
    stateEmpty.classList.add("d-none");
    listEl.classList.remove("d-none");
    if(orders.length === 1) pedidosAbertos.add(orders[0].reference);
    listEl.innerHTML = orders.map(orderCardHTML).join("");
    highlightFromQuery();
  }

  async function saveTracking(ref, trackingCode, feedbackEl){
    feedbackEl.textContent = "Salvando...";
    feedbackEl.classList.remove("is-success", "is-error");
    try{
      const res = await fetch(`/api/admin/orders/${encodeURIComponent(ref)}/tracking`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackingCode }),
      });
      const data = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(data.error || "Não foi possível salvar.");
      feedbackEl.textContent = "Salvo! Avisando a cliente...";
      feedbackEl.classList.add("is-success");
      setTimeout(loadDashboard, 1200);
    }catch(err){
      feedbackEl.textContent = err.message || "Erro ao salvar.";
      feedbackEl.classList.add("is-error");
    }
  }

  async function conferirEntrega(ref, feedbackEl, btn){
    const rotulo = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = "Consultando...";
    feedbackEl.textContent = "";
    feedbackEl.classList.remove("is-success", "is-error");
    try{
      const res = await fetchWithTimeout(`/api/admin/orders/${encodeURIComponent(ref)}/conferir-entrega`, { method: "POST" }, 20000);
      const data = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(data.error || "Não foi possível consultar.");
      if(data.entregue){
        feedbackEl.textContent = data.quando
          ? `O Melhor Envio confirmou a entrega em ${formatDate(data.quando)}.`
          : "O Melhor Envio confirmou a entrega.";
        feedbackEl.classList.add("is-success");
        loadDashboard();
      }else if(data.semResposta){
        feedbackEl.textContent = "O Melhor Envio não achou movimentação para esse código ainda. Tente daqui a pouco.";
        feedbackEl.classList.add("is-error");
      }else{
        feedbackEl.textContent = data.ultimoEvento
          ? `Ainda a caminho — último: ${data.ultimoEvento}`
          : "Ainda a caminho.";
      }
    }catch(err){
      feedbackEl.textContent = err.message || "Erro ao consultar o Melhor Envio.";
      feedbackEl.classList.add("is-error");
    }finally{
      btn.disabled = false;
      btn.innerHTML = rotulo;
    }
  }

  async function pedirAvaliacao(ref, feedbackEl, btn){
    const rotulo = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = "Enviando...";
    feedbackEl.textContent = "";
    feedbackEl.classList.remove("is-success", "is-error");
    try{
      const res = await fetchWithTimeout(`/api/admin/orders/${encodeURIComponent(ref)}/pedir-avaliacao`, { method: "POST" }, 20000);
      const data = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(data.error || "Não foi possível pedir a avaliação.");
      feedbackEl.textContent = data.entregue
        ? "Convite enviado: a cliente recebeu o link para avaliar."
        : "Enviado: a cliente vai confirmar o recebimento e já pode avaliar pelo mesmo e-mail.";
      feedbackEl.classList.add("is-success");
    }catch(err){
      feedbackEl.textContent = err.message || "Erro ao pedir a avaliação.";
      feedbackEl.classList.add("is-error");
    }finally{
      btn.disabled = false;
      btn.innerHTML = rotulo;
    }
  }

  async function reenviarAviso(ref, feedbackEl, btn){
    const rotulo = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = "Enviando...";
    feedbackEl.textContent = "";
    feedbackEl.classList.remove("is-success", "is-error");
    try{
      const res = await fetchWithTimeout(`/api/admin/orders/${encodeURIComponent(ref)}/avisar-postagem`, { method: "POST" }, 20000);
      const data = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(data.error || "Não foi possível reenviar.");
      feedbackEl.textContent = data.aviso?.enviadoEm ? "Aviso enviado para a cliente." : "Aviso na fila para envio.";
      feedbackEl.classList.add("is-success");
      loadDashboard();
    }catch(err){
      feedbackEl.textContent = err.message || "Erro ao reenviar o aviso.";
      feedbackEl.classList.add("is-error");
    }finally{
      btn.disabled = false;
      btn.innerHTML = rotulo;
    }
  }

  async function generateLabel(ref, feedbackEl, btn){
    if(!confirm("Gerar a etiqueta de envio agora? Isso compra o frete de verdade no Melhor Envio (gasta saldo da conta).")) return;
    const originalLabel = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = "Gerando...";
    feedbackEl.textContent = "";
    feedbackEl.classList.remove("is-success", "is-error");
    try{
      const res = await fetchWithTimeout(`/api/admin/orders/${encodeURIComponent(ref)}/generate-label`, { method: "POST" }, 20000);
      const data = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(data.error || "Não foi possível gerar a etiqueta.");
      const input = document.getElementById(`tracking-${ref}`);
      if(input && data.trackingCode) input.value = data.trackingCode;
      feedbackEl.textContent = data.trackingCode ? "Código gerado!" : "Etiqueta comprada, mas sem código de rastreio na resposta — confira no painel do Melhor Envio.";
      feedbackEl.classList.add("is-success");
    }catch(err){
      feedbackEl.textContent = err.message || "Erro ao gerar etiqueta.";
      feedbackEl.classList.add("is-error");
    }finally{
      btn.disabled = false;
      btn.innerHTML = originalLabel;
    }
  }

  async function markDelivered(ref, feedbackEl, btn){
    if(!confirm("Marcar este pedido como entregue?")) return;
    btn.disabled = true;
    feedbackEl.textContent = "Salvando...";
    feedbackEl.classList.remove("is-success", "is-error");
    try{
      const res = await fetch(`/api/admin/orders/${encodeURIComponent(ref)}/delivered`, { method: "PATCH" });
      const data = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(data.error || "Não foi possível marcar como entregue.");
      feedbackEl.textContent = "Entregue!";
      feedbackEl.classList.add("is-success");
      btn.outerHTML = `<span class="small fw-semibold" style="color:var(--color-success)"><i class="bi bi-check2-circle me-1"></i>Entregue</span>`;
    }catch(err){
      feedbackEl.textContent = err.message || "Erro ao marcar como entregue.";
      feedbackEl.classList.add("is-error");
      btn.disabled = false;
    }
  }

  async function copiarCampo(btn){
    const copiou = await copiarTexto(btn.dataset.copiar || "");
    const icone = btn.querySelector("i");
    if(!icone) return;
    icone.className = copiou ? "bi bi-check2" : "bi bi-exclamation-triangle";
    btn.classList.toggle("is-copied", copiou);
    setTimeout(() => {
      icone.className = "bi bi-clipboard";
      btn.classList.remove("is-copied");
    }, 2000);
  }

  listEl.addEventListener("click", (e) => {
    const trackBtn = e.target.closest(".save-tracking-btn");
    const labelBtn = e.target.closest(".generate-label-btn");
    const deliveredBtn = e.target.closest(".mark-delivered-btn");
    const resendBtn = e.target.closest(".resend-notice-btn");
    const avaliacaoBtn = e.target.closest(".pedir-avaliacao-btn");
    const checkBtn = e.target.closest(".check-delivery-btn");
    const deleteBtn = e.target.closest(".delete-order-btn");
    const copyBtn = e.target.closest(".copy-field-btn");
    const headBtn = e.target.closest(".order-card-head");
    const dadosBtn = e.target.closest(".dados-toggle");

    if(dadosBtn){
      alternarDadosDaCliente(dadosBtn.dataset.ref);
      return;
    }

    if(headBtn){
      alternarPedido(headBtn.dataset.ref);
      return;
    }

    if(copyBtn){
      copiarCampo(copyBtn);
      return;
    }

    if(deliveredBtn){
      const ref = deliveredBtn.dataset.ref;
      const feedbackEl = listEl.querySelector(`[data-ref-feedback="${ref}"]`);
      if(feedbackEl) markDelivered(ref, feedbackEl, deliveredBtn);
      return;
    }

    if(resendBtn){
      const ref = resendBtn.dataset.ref;
      const feedbackEl = listEl.querySelector(`[data-ref-feedback="${ref}"]`);
      if(feedbackEl) reenviarAviso(ref, feedbackEl, resendBtn);
      return;
    }

    if(avaliacaoBtn){
      const ref = avaliacaoBtn.dataset.ref;
      const feedbackEl = listEl.querySelector(`[data-ref-feedback="${ref}"]`);
      if(feedbackEl) pedirAvaliacao(ref, feedbackEl, avaliacaoBtn);
      return;
    }

    if(checkBtn){
      const ref = checkBtn.dataset.ref;
      const feedbackEl = listEl.querySelector(`[data-ref-feedback="${ref}"]`);
      if(feedbackEl) conferirEntrega(ref, feedbackEl, checkBtn);
      return;
    }

    if(trackBtn){
      const ref = trackBtn.dataset.ref;
      const input = document.getElementById(`tracking-${ref}`);
      const feedbackEl = listEl.querySelector(`[data-ref-feedback="${ref}"]`);
      if(input && feedbackEl) saveTracking(ref, input.value.trim(), feedbackEl);
      return;
    }
    if(labelBtn){
      const ref = labelBtn.dataset.ref;
      const feedbackEl = listEl.querySelector(`[data-ref-feedback="${ref}"]`);
      if(feedbackEl) generateLabel(ref, feedbackEl, labelBtn);
      return;
    }
    if(deleteBtn){
      deleteOrderWithConfirm(deleteBtn.dataset.ref, () => loadDashboard());
    }
  });

  function toggleBlock(el, show){
    el?.classList.toggle("d-none", !show);
  }

  const WHATSAPP_SEM_COMPRA_MESSAGE =
    "Oi! Aqui é da Adriana Melo Acessórios. Vi que você se cadastrou na loja e queria saber se posso ajudar a escolher um laço 💗";

  let segmentoDeClientes = "compraram";
  let dadosDeClientes = { customers: [], contas: [], subscribers: [] };

  function temCarrinhoPendente(c){
    const agora = Date.now();
    return (c.orders || []).some(o => {
      if(o.status !== "pendente") return false;
      const idade = agora - o.createdAt;
      return idade >= PENDING_CART_MIN_AGE_MS && idade <= PENDING_CART_MAX_AGE_MS;
    });
  }

  function linhasDoSegmento(seg){
    const { customers, contas, subscribers } = dadosDeClientes;

    if(seg === "compraram"){
      return customers.filter(c => c.paidOrders > 0);
    }
    if(seg === "carrinho"){
      return customers.filter(temCarrinhoPendente);
    }

    const semCompra = customers.filter(c => c.paidOrders === 0);
    const emailsJaListados = new Set(
      customers.map(c => String(c.email || "").toLowerCase()).filter(Boolean)
    );

    const deContas = contas
      .filter(a => !a.jaComprou && !emailsJaListados.has(String(a.email || "").toLowerCase()))
      .map(a => {
        emailsJaListados.add(String(a.email || "").toLowerCase());
        return {
          identity: `conta:${a.id}`, nome: a.name || "—", email: a.email,
          telefone: a.telefone, aniversario: a.aniversario, hasAccount: true, origem: "conta criada",
          totalOrders: 0, paidOrders: 0, totalSpent: 0,
          lastOrderAt: a.createdAt, orders: [],
        };
      });

    /* ⚠️ Quem pediu descadastro fica de fora: esta lista existe para a lojista
       mandar mensagem, e contatar quem saiu da newsletter seria errado. */
    const deNewsletter = subscribers
      .filter(sb => !sb.unsubscribedAt)
      .filter(sb => !emailsJaListados.has(String(sb.email || "").toLowerCase()))
      .map(sb => ({
        identity: `news:${sb.email}`, nome: "—", email: sb.email,
        telefone: null, hasAccount: false, origem: "pediu cupom",
        totalOrders: 0, paidOrders: 0, totalSpent: 0,
        lastOrderAt: sb.createdAt, orders: [],
      }));

    return [...semCompra, ...deContas, ...deNewsletter]
      .sort((a, b) => (b.lastOrderAt || 0) - (a.lastOrderAt || 0));
  }

  const DICAS_DE_SEGMENTO = {
    "compraram": "Quem já pagou pelo menos um pedido, ordenado por quanto gastou. Clique numa linha para ver os pedidos.",
    "nao-compraram": "Quem deixou contato e ainda não comprou: conta criada no site ou pedido do cupom. Quem se descadastrou da newsletter não aparece aqui.",
    "carrinho": "Quem começou o pagamento e não finalizou, entre 1 hora e 14 dias atrás — o mesmo recorte da seção \"Pendentes para recuperar\" na aba de pedidos.",
  };

  function atualizarContagemDeSegmentos(){
    const grupo = document.getElementById("customersFilter");
    if(!grupo) return;
    grupo.querySelectorAll(".chip").forEach(chip => {
      const n = linhasDoSegmento(chip.dataset.seg).length;
      chip.dataset.contagem = String(n);
      chip.setAttribute("aria-label", `${chip.textContent.trim()}: ${n}`);
    });
  }

  function aplicarSegmentoDeClientes(){
    const dica = document.getElementById("customersHint");
    if(dica) dica.textContent = DICAS_DE_SEGMENTO[segmentoDeClientes] || "";
    atualizarContagemDeSegmentos();
    renderCustomers(linhasDoSegmento(segmentoDeClientes));
  }

  document.getElementById("customersFilter")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if(!btn) return;
    document.querySelectorAll("#customersFilter .chip").forEach(c => {
      c.classList.remove("active");
      c.setAttribute("aria-pressed", "false");
    });
    btn.classList.add("active");
    btn.setAttribute("aria-pressed", "true");
    segmentoDeClientes = btn.dataset.seg;
    btn.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
    aplicarSegmentoDeClientes();
  });

  function renderCustomers(customers){
    const body = document.getElementById("customersTableBody");
    const wrap = document.getElementById("customersTableWrap");
    const empty = document.getElementById("customersEmpty");
    if(!body) return;

    toggleBlock(wrap, customers.length > 0);
    toggleBlock(empty, customers.length === 0);
    if(!customers.length){ body.innerHTML = ""; return; }

    body.innerHTML = customers.map((c, i) => {
      const mensagem = segmentoDeClientes === "compraram" ? WHATSAPP_POST_SALE_MESSAGE
                     : segmentoDeClientes === "carrinho"  ? null
                     : WHATSAPP_SEM_COMPRA_MESSAGE;
      const pendente = segmentoDeClientes === "carrinho"
        ? (c.orders || []).find(o => o.status === "pendente") : null;
      const contactUrl = mensagem
        ? whatsappUrl(c.telefone, mensagem)
        : whatsappUrl(c.telefone, `Olá${c.nome && c.nome !== "—" ? " " + String(c.nome).split(" ")[0] : ""}! Vi que você começou uma compra aqui na Adriana Melo Acessórios e queria saber se posso ajudar a finalizar 💗`);
      const historyRows = c.orders.map(o => `
        <div class="d-flex justify-content-between gap-2 py-1 small">
          <span>${formatDate(o.createdAt)}</span>
          <span>${escapeHTML(o.reference)}</span>
          <span>${escapeHTML(STATUS_LABELS[o.status]?.label || o.status)}${o.couponCode ? ` · ${escapeHTML(o.couponCode)}` : ""}</span>
          <strong>${formatMoney(o.total)}</strong>
        </div>`).join("");

      return `
      <tr class="customer-row" data-customer-index="${i}" style="cursor:pointer">
        <td>
          <strong>${escapeHTML(c.nome)}</strong>
          ${c.hasAccount ? '<span class="admin-badge-pill ms-1">tem conta</span>' : ""}
          ${c.origem ? `<span class="admin-badge-pill ms-1">${escapeHTML(c.origem)}</span>` : ""}
          ${c.aniversario ? `<span class="admin-badge-pill ms-1" title="Aniversário"><i class="bi bi-gift"></i> ${escapeHTML(c.aniversario)}</span>` : ""}
        </td>
        <td class="small">
          ${c.email ? escapeHTML(c.email) + "<br>" : ""}
          ${c.telefone ? escapeHTML(c.telefone) : ""}
          ${contactUrl
            ? ` <a href="${contactUrl}" target="_blank" rel="noopener noreferrer" title="Abrir conversa no WhatsApp"><i class="bi bi-whatsapp"></i></a>`
            /* ⚠️ Sem telefone não há link — e isso precisa ser DITO. Um ícone
               que não faz nada ao toque é pior que ícone nenhum. */
            : ` <span class="text-ink-soft">${c.telefone ? "" : "sem telefone"}</span>`}
        </td>
        <td class="text-center">${c.paidOrders}<span class="text-ink-soft">/${c.totalOrders}</span></td>
        <td class="text-end"><strong>${formatMoney(c.totalSpent)}</strong></td>
        <td class="small">${formatDate(c.lastOrderAt)}</td>
      </tr>
      <tr class="customer-history d-none" data-history-for="${i}">
        <td colspan="5" style="background:var(--blush-50)">${historyRows}</td>
      </tr>`;
    }).join("");

    body.querySelectorAll(".customer-row").forEach(row => {
      row.addEventListener("click", () => {
        const target = body.querySelector(`[data-history-for="${row.dataset.customerIndex}"]`);
        target?.classList.toggle("d-none");
      });
    });
  }

  function renderContactMessages(messages){
    const list = messagesListEl;
    const empty = document.getElementById("messagesEmpty");
    if(!list) return;

    toggleBlock(list, messages.length > 0);
    toggleBlock(empty, messages.length === 0);
    list.innerHTML = messages.map(m => {
      const contactUrl = whatsappUrl(m.telefone, "Olá! Recebemos a sua mensagem na Adriana Melo Acessórios.");
      return `
      <div class="order-card">
        <div class="d-flex flex-wrap justify-content-between gap-2 mb-2">
          <strong>${escapeHTML(m.nome)}</strong>
          <span class="small text-ink-soft">${formatDate(m.createdAt)}</span>
        </div>
        <p class="mb-2">${escapeHTML(m.mensagem)}</p>
        <div class="d-flex flex-wrap align-items-center gap-2 small">
          <span>${escapeHTML(m.telefone)}</span>
          ${m.ocasiao ? `<span class="admin-badge-pill">${escapeHTML(m.ocasiao)}</span>` : ""}
          ${contactUrl ? `<a href="${contactUrl}" target="_blank" rel="noopener noreferrer" class="btn-outline-blush btn-sm-blush"><i class="bi bi-whatsapp me-1"></i>Responder</a>` : ""}
          <button type="button" class="delete-order-icon-btn delete-message-btn ms-auto" data-id="${m.id}" aria-label="Apagar mensagem"><i class="bi bi-trash3"></i></button>
        </div>
      </div>`;
    }).join("");
  }

  function renderSubscribers(subscribers){
    const body = document.getElementById("subscribersTableBody");
    const wrap = document.getElementById("subscribersTableWrap");
    const empty = document.getElementById("subscribersEmpty");
    if(!body) return;

    toggleBlock(wrap, subscribers.length > 0);
    toggleBlock(empty, subscribers.length === 0);
    body.innerHTML = subscribers.map(s =>
      `<tr><td>${escapeHTML(s.email)}</td><td class="small">${formatDate(s.createdAt)}</td></tr>`
    ).join("");
  }

  function downloadCSV(filename, header, rows){
    const escapeCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [header, ...rows].map(r => r.map(escapeCell).join(",")).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function renderCouponsTable(coupons){
    if(!coupons.length){
      couponsTableBodyEl.innerHTML = `<tr><td colspan="4" class="text-center small py-3 text-ink-soft">Nenhum cupom cadastrado.</td></tr>`;
      return;
    }
    couponsTableBodyEl.innerHTML = coupons.map(c => `
      <tr data-code="${escapeHTML(c.code)}">
        <td class="fw-semibold">${escapeHTML(c.code)}</td>
        <td>${c.percentOff}%</td>
        <td class="small text-ink-soft">${escapeHTML(c.description || "—")}</td>
        <td class="text-end">
          <div class="admin-row-actions">
            <button type="button" class="edit-order-icon-btn edit-coupon-btn" data-code="${escapeHTML(c.code)}" data-percent="${c.percentOff}" data-desc="${escapeHTML(c.description || "")}" aria-label="Editar cupom" title="Editar cupom"><i class="bi bi-pencil"></i></button>
            <button type="button" class="delete-order-icon-btn delete-coupon-btn" data-code="${escapeHTML(c.code)}" aria-label="Apagar cupom" title="Apagar cupom"><i class="bi bi-trash3"></i></button>
          </div>
        </td>
      </tr>
    `).join("");
  }

  couponsTableBodyEl.addEventListener("click", async (e) => {
    const deleteBtn = e.target.closest(".delete-coupon-btn");
    if(deleteBtn){
      const code = deleteBtn.dataset.code;
      if(!confirm(`Apagar o cupom ${code}? Ele deixa de funcionar no checkout imediatamente.`)) return;
      try{
        const res = await fetchWithTimeout(`/api/admin/coupons/${encodeURIComponent(code)}`, { method: "DELETE" });
        const data = await res.json().catch(() => ({}));
        if(!res.ok) throw new Error(data.error || "Não foi possível apagar o cupom.");
        loadDashboard();
      }catch(err){
        alert(err.message || "Não foi possível apagar o cupom agora.");
      }
      return;
    }
    const editBtn = e.target.closest(".edit-coupon-btn");
    if(editBtn){
      document.getElementById("ecCode").textContent = editBtn.dataset.code;
      document.getElementById("ecOriginalCode").value = editBtn.dataset.code;
      document.getElementById("ecPercent").value = editBtn.dataset.percent;
      document.getElementById("ecDesc").value = editBtn.dataset.desc;
      document.getElementById("ecMsg").textContent = "";
      editCouponModal.show();
    }
  });

  const editCouponModalEl = document.getElementById("editCouponModal");
  const editCouponModal = new bootstrap.Modal(editCouponModalEl);
  const editCouponForm = document.getElementById("editCouponForm");
  const ecSaveBtn = document.getElementById("ecSaveBtn");
  editCouponForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = document.getElementById("ecOriginalCode").value;
    const percentOff = Number(document.getElementById("ecPercent").value);
    const description = document.getElementById("ecDesc").value.trim();
    const msgEl = document.getElementById("ecMsg");

    msgEl.textContent = "";
    msgEl.className = "small account-msg";
    ecSaveBtn.disabled = true;
    try{
      const res = await fetchWithTimeout(`/api/admin/coupons/${encodeURIComponent(code)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ percentOff, description }),
      });
      const data = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(data.error || "Não foi possível salvar.");
      editCouponModal.hide();
      loadDashboard();
    }catch(err){
      msgEl.textContent = err.message || "Erro ao salvar o cupom.";
      msgEl.classList.add("text-danger");
    }finally{
      ecSaveBtn.disabled = false;
    }
  });

  newCouponFormEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = document.getElementById("couponCode").value.trim();
    const percentOff = Number(document.getElementById("couponPercent").value);
    const description = document.getElementById("couponDesc").value.trim();

    couponFormMsgEl.textContent = "";
    couponFormMsgEl.className = "small account-msg";
    couponSaveBtnEl.disabled = true;
    try{
      const res = await fetchWithTimeout("/api/admin/coupons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, percentOff, description }),
      });
      const data = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(data.error || "Não foi possível criar o cupom.");
      newCouponFormEl.reset();
      loadDashboard();
    }catch(err){
      couponFormMsgEl.textContent = err.message || "Erro ao criar cupom.";
      couponFormMsgEl.classList.add("text-danger");
    }finally{
      couponSaveBtnEl.disabled = false;
    }
  });

  /* ============================ CARREGAMENTO ============================ */

  function wireExports(customers, subscribers){
    const customersBtn = document.getElementById("exportCustomersBtn");
    if(customersBtn){
      /* ⚠️ Exporta o RECORTE que está na tela, não a lista completa. Baixar
         "clientes.csv" com todo mundo enquanto o filtro mostra outra coisa
         seria o tipo de discrepância que só se descobre depois de mandar
         mensagem para a pessoa errada. */
      customersBtn.onclick = () => {
        const visiveis = linhasDoSegmento(segmentoDeClientes);
        downloadCSV(
          `clientes-${segmentoDeClientes}.csv`,
          ["Nome", "E-mail", "Telefone", "Origem", "Pedidos pagos", "Pedidos totais", "Total gasto", "Última compra"],
          visiveis.map(c => [
            c.nome, c.email || "", c.telefone || "", c.origem || "fez pedido",
            c.paidOrders, c.totalOrders,
            (c.totalSpent || 0).toFixed(2).replace(".", ","),
            formatDate(c.lastOrderAt),
          ])
        );
      };
    }
    const subsBtn = document.getElementById("exportSubscribersBtn");
    if(subsBtn){
      subsBtn.onclick = () => downloadCSV(
        "lista-de-emails.csv",
        ["E-mail", "Cadastrou em"],
        subscribers.map(s => [s.email, formatDate(s.createdAt)])
      );
    }
  }

  async function loadDashboard(){
    showOnly(stateLoading);
    try{
      const responses = await Promise.all([
        fetchWithTimeout("/api/admin/orders"),
        fetchWithTimeout("/api/admin/products"),
        fetchWithTimeout("/api/admin/coupons"),
        fetchWithTimeout("/api/admin/customers"),
        fetchWithTimeout("/api/admin/leads"),
      ]);
      const [ordersRes, productsRes, couponsRes, customersRes, leadsRes] = responses;
      if(responses.some(r => r.status === 401)){ showOnly(stateLoggedOut); return; }
      if(responses.some(r => r.status === 403)){

        const negado = responses.find(r => r.status === 403);
        const corpo = await negado.clone().json().catch(() => ({}));
        if(corpo.needsTwoFactorSetup) return startTwoFactorSetup();
        showOnly(stateForbidden);
        return;
      }
      const failed = responses.find(r => !r.ok);
      if(failed){
        throw new Error("Falha ao carregar o painel (HTTP " + failed.status + ").");
      }
      const ordersData = await ordersRes.json();
      const productsData = await productsRes.json();
      const couponsData = await couponsRes.json();
      const customersData = await customersRes.json();
      const leadsData = await leadsRes.json();

      const orders = Array.isArray(ordersData.orders) ? ordersData.orders : [];
      showOnly(contentEl);
      const products = Array.isArray(productsData.products) ? productsData.products : [];
      applyCategories(productsData.categories);
      renderStats(ordersData.stats || { totalRevenue: 0, totalOrders: 0 });
      renderSalesChart(orders);
      renderCategoryChart(orders, products);
      renderTopProductsChart(orders);
      renderStatusChart(orders);
      renderPaymentChart(orders);
      renderPendingCarts(orders);
      renderProductsTable(products);
      renderCouponsTable(Array.isArray(couponsData.coupons) ? couponsData.coupons : []);
      todosOsPedidos = orders;
      atualizarContagemDeSituacoes();
      renderOrders(pedidosDaSituacao(situacaoDePedidos));

      const customers = Array.isArray(customersData.customers) ? customersData.customers : [];
      const subscribers = Array.isArray(leadsData.subscribers) ? leadsData.subscribers : [];
      const contas = Array.isArray(customersData.contas) ? customersData.contas : [];
      // Guardadas para os três recortes poderem ser trocados sem novo fetch.
      dadosDeClientes = { customers, contas, subscribers };
      aplicarSegmentoDeClientes();
      renderContactMessages(Array.isArray(leadsData.messages) ? leadsData.messages : []);
      renderSubscribers(subscribers);
      wireExports(customers, subscribers);
    }catch(err){
      console.error("Erro ao carregar painel administrativo:", err);
      showOnly(stateError);
    }
  }

  retryBtn?.addEventListener("click", async () => {
    showOnly(stateLoading);
    const user = await PLCAuth.checkSession();
    if(!user) showOnly(stateLoggedOut);
    else if(!user.isAdmin) showOnly(stateForbidden);
    else loadDashboard();
  });

  /* Baixar toda a base numa planilha Excel (.xlsx). O arquivo é gerado no
     servidor (rota /api/admin/export.xlsx, protegida por sessão + 2FA); aqui
     usamos fetch para conseguir tratar erro (sessão expirada, etc.) em vez de
     navegar direto para um JSON de erro. */
  const exportAllBtn = document.getElementById("exportAllBtn");
  exportAllBtn?.addEventListener("click", async () => {
    const original = exportAllBtn.innerHTML;
    exportAllBtn.disabled = true;
    exportAllBtn.innerHTML = `<i class="bi bi-hourglass-split me-1"></i>Gerando...`;
    try{
      const res = await fetchWithTimeout("/api/admin/export.xlsx", {}, 30000);
      if(!res.ok){
        let msg = "Não foi possível gerar a planilha agora.";
        try{ msg = (await res.json()).error || msg; }catch{}
        throw new Error(msg);
      }
      const blob = await res.blob();
      const dispo = res.headers.get("Content-Disposition") || "";
      const match = dispo.match(/filename="([^"]+)"/);
      const filename = match ? match[1] : "adriana-melo.xlsx";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    }catch(err){
      console.error("Erro ao baixar planilha:", err);
      alert(err.message || "Não foi possível gerar a planilha agora.");
    }finally{
      exportAllBtn.disabled = false;
      exportAllBtn.innerHTML = original;
    }
  });

  const instagramReconnectBtn = document.getElementById("instagramReconnectBtn");
  const instagramReconnectResult = document.getElementById("instagramReconnectResult");
  instagramReconnectBtn?.addEventListener("click", async () => {
    const original = instagramReconnectBtn.innerHTML;
    instagramReconnectBtn.disabled = true;
    instagramReconnectBtn.innerHTML = `<i class="bi bi-hourglass-split me-1"></i>Testando...`;
    instagramReconnectResult.textContent = "";
    instagramReconnectResult.classList.remove("is-success", "is-error");
    try{
      const res = await fetchWithTimeout("/api/admin/instagram/reconnect", { method: "POST" }, 15000);
      const data = await res.json().catch(() => ({}));
      if(!res.ok || !data.ok) throw new Error(data.error || "Não foi possível conectar.");
      instagramReconnectResult.textContent = `Conectado como @${data.username} — o feed já deve aparecer na home.`;
      instagramReconnectResult.classList.add("is-success");
    }catch(err){
      instagramReconnectResult.textContent = err.message || "Não foi possível conectar.";
      instagramReconnectResult.classList.add("is-error");
    }finally{
      instagramReconnectBtn.disabled = false;
      instagramReconnectBtn.innerHTML = original;
    }
  });

  const avaliacoesListaEl = document.getElementById("avaliacoesLista");
  const avaliacoesVazioEl = document.getElementById("avaliacoesVazio");
  const avaliacoesContadorEl = document.getElementById("avaliacoesContador");
  const ROTULO_STATUS_AVALIACAO = { pendente: "Aguardando você", publicada: "Publicada", oculta: "Oculta" };

  function estrelasTexto(nota){
    return "★".repeat(nota) + "☆".repeat(5 - nota);
  }

  function cartaoAvaliacao(r){
    const quem = [r.firstName, r.city].filter(Boolean).map(escapeHTML).join(" · ") || "Cliente";
    const acoes = [];
    if(r.status !== "publicada"){
      acoes.push(`<button type="button" class="btn-blush btn-sm-blush avaliacao-acao" data-acao="publicar" data-id="${r.id}"><i class="bi bi-check2-circle me-1"></i>Publicar</button>`);
      if(r.photoUrl) acoes.push(`<button type="button" class="btn-outline-blush btn-sm-blush avaliacao-acao" data-acao="publicar-sem-foto" data-id="${r.id}">Publicar sem a foto</button>`);
    }
    if(r.status !== "oculta") acoes.push(`<button type="button" class="btn-outline-blush btn-sm-blush avaliacao-acao" data-acao="ocultar" data-id="${r.id}">Ocultar</button>`);
    acoes.push(`<button type="button" class="btn-outline-blush btn-sm-blush avaliacao-acao" data-acao="excluir" data-id="${r.id}"><i class="bi bi-trash3 me-1"></i>Excluir</button>`);

    return `
      <div class="order-card admin-avaliacao" id="avaliacao-${r.id}">
        <div class="admin-avaliacao-topo">
          <div>
            <div class="admin-avaliacao-produto">${escapeHTML(r.productName)}</div>
            <div class="admin-avaliacao-quem">${quem} · ${formatDate(r.createdAt)} · pedido #${escapeHTML(String(r.reference).slice(0, 8))}</div>
          </div>
          <span class="admin-avaliacao-status is-${escapeHTML(r.status)}">${ROTULO_STATUS_AVALIACAO[r.status] || escapeHTML(r.status)}</span>
        </div>
        <div class="avaliacao-estrelas" role="img" aria-label="${r.rating} de 5 estrelas" style="font-size:1.1rem">${estrelasTexto(r.rating)}</div>
        ${r.comment ? `<p class="admin-avaliacao-texto">${escapeHTML(r.comment)}</p>` : `<p class="admin-avaliacao-texto text-ink-soft">Sem comentário.</p>`}
        ${r.photoUrl ? `<img class="admin-avaliacao-foto" src="${escapeHTML(r.photoUrl)}" alt="Foto enviada pela cliente" loading="lazy" width="140" height="140">
        <span class="small text-ink-soft">Uso da imagem autorizado em ${formatDate(r.photoConsentAt)}.</span>` : ""}
        <div class="admin-avaliacao-acoes">${acoes.join("")}</div>
        <span class="small tracking-feedback" data-avaliacao-feedback="${r.id}"></span>
      </div>`;
  }

  async function carregarAvaliacoes(){
    if(!avaliacoesListaEl) return;
    try{
      const res = await fetchWithTimeout("/api/admin/avaliacoes", {}, 15000);
      if(!res.ok) throw new Error();
      const dados = await res.json();
      const lista = Array.isArray(dados.avaliacoes) ? dados.avaliacoes : [];
      avaliacoesVazioEl.classList.toggle("d-none", lista.length > 0);
      avaliacoesListaEl.classList.toggle("d-none", lista.length === 0);
      avaliacoesListaEl.innerHTML = lista.map(cartaoAvaliacao).join("");
      const pendentes = Number(dados.pendentes) || 0;
      avaliacoesContadorEl.textContent = String(pendentes);
      avaliacoesContadorEl.classList.toggle("d-none", pendentes === 0);
    }catch{
      avaliacoesVazioEl.classList.remove("d-none");
      avaliacoesVazioEl.querySelector("p").textContent = "Não consegui carregar as avaliações agora.";
    }
  }

  avaliacoesListaEl?.addEventListener("click", async (e) => {
    const botao = e.target.closest(".avaliacao-acao");
    if(!botao) return;
    const id = botao.dataset.id;
    const acao = botao.dataset.acao;
    if(acao === "excluir" && !confirm("Excluir esta avaliação de vez? A foto, se houver, também é apagada.")) return;
    const feedback = avaliacoesListaEl.querySelector(`[data-avaliacao-feedback="${id}"]`);
    const rotas = {
      "publicar": { url: `/api/admin/avaliacoes/${id}/publicar`, method: "POST", body: {} },
      "publicar-sem-foto": { url: `/api/admin/avaliacoes/${id}/publicar`, method: "POST", body: { semFoto: true } },
      "ocultar": { url: `/api/admin/avaliacoes/${id}/ocultar`, method: "POST", body: {} },
      "excluir": { url: `/api/admin/avaliacoes/${id}`, method: "DELETE" },
    };
    const rota = rotas[acao];
    if(!rota) return;
    botao.disabled = true;
    try{
      const res = await fetchWithTimeout(rota.url, {
        method: rota.method,
        headers: rota.body ? { "Content-Type": "application/json" } : undefined,
        body: rota.body ? JSON.stringify(rota.body) : undefined,
      }, 15000);
      const corpo = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(corpo.error || "Não foi possível concluir.");
      await carregarAvaliacoes();
    }catch(err){
      botao.disabled = false;
      if(feedback){
        feedback.textContent = err.message || "Não foi possível concluir.";
        feedback.classList.add("is-error");
      }
    }
  });

  const testarAvisoBtn = document.getElementById("testarAvisoBtn");
  const testarAvisoResult = document.getElementById("testarAvisoResult");
  const avisoVendaResumo = document.getElementById("avisoVendaResumo");

  async function carregarSituacaoDoAviso(){
    if(!avisoVendaResumo) return;
    try{
      const res = await fetchWithTimeout("/api/admin/aviso-de-venda", {}, 10000);
      if(!res.ok) throw new Error();
      const d = await res.json();
      const partes = [];
      if(!d.para){
        partes.push("⚠️ Nenhum e-mail está cadastrado para receber os avisos: hoje você não fica sabendo quando alguém compra.");
      }else{
        partes.push(`Toda venda nova é avisada em ${d.para}.`);
      }
      if(!d.smtpConfigurado) partes.push("⚠️ O envio de e-mails do site não está configurado no servidor.");
      if(d.presos > 0){
        partes.push(`${d.presos} aviso(s) ainda não saíram${d.ultimoErro ? `: ${d.ultimoErro}` : "."}`);
      }else if(d.ultimoEnviadoEm){
        partes.push(`Último aviso entregue em ${formatDate(d.ultimoEnviadoEm)}.`);
      }
      if(!d.tarefasEm){
        partes.push("⚠️ As tarefas automáticas (entrega automática, \"seu pedido chegou?\" e pedido de avaliação) nunca rodaram neste servidor — o agendamento no painel da hospedagem precisa ser criado.");
      }else if(Date.now() - d.tarefasEm > 60 * 60 * 1000){
        partes.push(`⚠️ As tarefas automáticas não rodam desde ${formatDate(d.tarefasEm)} — confira o agendamento no painel da hospedagem.`);
      }else{
        partes.push(`Tarefas automáticas rodando (última vez em ${formatDate(d.tarefasEm)}).`);
      }
      partes.push("Não tem certeza se chega? Mande um teste.");
      avisoVendaResumo.textContent = partes.join(" ");
    }catch{
      avisoVendaResumo.textContent = "Não consegui conferir a situação do aviso de venda agora.";
    }
  }

  testarAvisoBtn?.addEventListener("click", async () => {
    const original = testarAvisoBtn.innerHTML;
    testarAvisoBtn.disabled = true;
    testarAvisoBtn.innerHTML = `<i class="bi bi-hourglass-split me-1"></i>Enviando...`;
    testarAvisoResult.textContent = "";
    testarAvisoResult.classList.remove("is-success", "is-error");
    try{
      const res = await fetchWithTimeout("/api/admin/aviso-de-venda/testar", { method: "POST" }, 20000);
      const data = await res.json().catch(() => ({}));
      if(!res.ok || !data.ok) throw new Error(data.error || "Não foi possível enviar.");
      testarAvisoResult.textContent = `Enviado para ${data.para} — confira sua caixa de entrada (e o spam).`;
      testarAvisoResult.classList.add("is-success");
      carregarSituacaoDoAviso();
    }catch(err){
      testarAvisoResult.textContent = err.message || "Não foi possível enviar.";
      testarAvisoResult.classList.add("is-error");
    }finally{
      testarAvisoBtn.disabled = false;
      testarAvisoBtn.innerHTML = original;
    }
  });

  const heroGradeEl = document.getElementById("heroGrade");
  const heroMsgEl = document.getElementById("heroMsg");
  const heroAvisoPadraoEl = document.getElementById("heroPadraoAviso");
  const heroModalEl = document.getElementById("heroFotoModal");
  const heroModal = heroModalEl ? new bootstrap.Modal(heroModalEl) : null;
  const heroFormEl = document.getElementById("heroFotoForm");
  const heroFileEl = document.getElementById("heroFotoFile");
  const heroPreviewEl = document.getElementById("heroFotoPreview");
  const heroVazioEl = document.getElementById("heroFotoVazio");
  const heroFocusEl = document.getElementById("heroFotoFocus");
  const heroLegendaEl = document.getElementById("heroFotoLegenda");
  const heroAltEl = document.getElementById("heroFotoAlt");
  const heroErroEl = document.getElementById("heroFotoErro");
  const heroSalvarEl = document.getElementById("heroFotoSalvar");
  const heroIdEl = document.getElementById("heroFotoId");

  let heroCache = [];
  let heroMax = 6;
  let heroSalvandoOrdem = false;

  function heroAviso(texto, erro){
    heroMsgEl.textContent = texto || "";
    heroMsgEl.classList.toggle("text-danger", Boolean(erro));
  }

  function heroCartao(foto, i){
    const capa = i === 0 ? '<span class="hero-admin-capa">capa</span>' : "";
    return `
      <div class="hero-admin-card" data-hero-id="${escapeHTML(foto.id)}">
        <div class="hero-admin-foto">
          <img src="${escapeHTML(foto.url)}" alt="${escapeHTML(foto.alt)}" loading="lazy">
          <span class="hero-admin-ordem">${i + 1}</span>
          ${capa}
        </div>
        <div class="hero-admin-corpo">
          <span class="hero-admin-legenda">${escapeHTML(foto.legenda)}</span>
          <div class="hero-admin-acoes">
            <button type="button" class="hero-admin-btn" data-hero-mover="-1" ${i === 0 ? "disabled" : ""}
                    aria-label="Mover para antes"><i class="bi bi-chevron-left" aria-hidden="true"></i></button>
            <button type="button" class="hero-admin-btn" data-hero-mover="1" ${i === heroCache.length - 1 ? "disabled" : ""}
                    aria-label="Mover para depois"><i class="bi bi-chevron-right" aria-hidden="true"></i></button>
            <button type="button" class="hero-admin-btn" data-hero-editar
                    aria-label="Editar esta foto"><i class="bi bi-pencil" aria-hidden="true"></i></button>
            <button type="button" class="hero-admin-btn is-apagar" data-hero-apagar
                    aria-label="Apagar esta foto"><i class="bi bi-trash3" aria-hidden="true"></i></button>
          </div>
        </div>
      </div>`;
  }

  function heroCartaoPadrao(foto, i){
    return `
      <div class="hero-admin-card is-padrao">
        <div class="hero-admin-foto">
          <img src="${escapeHTML(foto.url)}" alt="${escapeHTML(foto.alt)}" loading="lazy">
          <span class="hero-admin-ordem">${i + 1}</span>
        </div>
        <div class="hero-admin-corpo">
          <span class="hero-admin-legenda">${escapeHTML(foto.legenda)}</span>
        </div>
      </div>`;
  }

  function heroRender(dados){
    heroCache = dados.fotos;
    heroMax = dados.max;
    heroAvisoPadraoEl.classList.toggle("d-none", !dados.usandoPadrao);
    heroGradeEl.innerHTML = dados.usandoPadrao
      ? dados.padrao.map(heroCartaoPadrao).join("")
      : heroCache.map(heroCartao).join("");
    document.getElementById("heroAddBtn").disabled = heroCache.length >= heroMax;
  }

  async function heroCarregar(){
    try{
      const res = await fetchWithTimeout("/api/admin/hero/fotos");
      if(!res.ok) throw new Error("Não foi possível carregar as fotos do topo.");
      heroRender(await res.json());
    }catch(err){
      console.error("Erro ao carregar as fotos do topo:", err);
      heroAviso(err.message || "Não foi possível carregar as fotos do topo.", true);
    }
  }

  function heroAbrirModal(foto){
    heroErroEl.textContent = "";
    heroFormEl.reset();
    heroIdEl.value = foto ? foto.id : "";
    document.getElementById("heroFotoModalLabel").textContent = foto ? "Editar foto do topo" : "Adicionar foto do topo";
    document.getElementById("heroFotoArquivoBloco").classList.toggle("d-none", Boolean(foto));
    heroFileEl.required = !foto;
    if(foto){
      heroLegendaEl.value = foto.legenda;
      heroAltEl.value = foto.alt;
      heroFocusEl.value = foto.focus;
      heroPreviewEl.src = foto.url;
      heroPreviewEl.classList.remove("d-none");
      heroVazioEl.classList.add("d-none");
    }else{
      heroPreviewEl.src = "";
      heroPreviewEl.classList.add("d-none");
      heroVazioEl.classList.remove("d-none");
    }
    heroPreviewFoco();
    heroModal.show();
  }

  function heroPreviewFoco(){
    heroPreviewEl.classList.toggle("is-topo", heroFocusEl.value === "top");
    heroPreviewEl.classList.toggle("is-baixo", heroFocusEl.value === "bottom");
  }

  heroFocusEl?.addEventListener("change", heroPreviewFoco);

  heroFileEl?.addEventListener("change", () => {
    const arquivo = heroFileEl.files?.[0];
    if(!arquivo){
      heroPreviewEl.classList.add("d-none");
      heroVazioEl.classList.remove("d-none");
      return;
    }
    const leitor = new FileReader();
    leitor.onload = () => {
      heroPreviewEl.src = leitor.result;
      heroPreviewEl.classList.remove("d-none");
      heroVazioEl.classList.add("d-none");
    };
    leitor.readAsDataURL(arquivo);
  });

  document.getElementById("heroAddBtn")?.addEventListener("click", () => heroAbrirModal(null));

  heroFormEl?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = heroIdEl.value;
    const legenda = heroLegendaEl.value.trim();
    const alt = heroAltEl.value.trim();
    if(!legenda) return void (heroErroEl.textContent = "Escreva a legenda curta.");
    if(!alt) return void (heroErroEl.textContent = "Escreva a descrição da foto.");
    if(!id && !heroFileEl.files?.[0]) return void (heroErroEl.textContent = "Escolha a foto.");

    heroErroEl.textContent = "";
    heroSalvarEl.disabled = true;
    const rotulo = heroSalvarEl.textContent;
    heroSalvarEl.textContent = "Salvando...";
    try{
      let res;
      if(id){
        res = await fetchWithTimeout(`/api/admin/hero/fotos/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ alt, legenda, focus: heroFocusEl.value }),
        });
      }else{
        const corpo = new FormData();
        corpo.append("photo", heroFileEl.files[0]);
        corpo.append("alt", alt);
        corpo.append("legenda", legenda);
        corpo.append("focus", heroFocusEl.value);
        res = await fetchWithTimeout("/api/admin/hero/fotos", { method: "POST", body: corpo }, 30000);
      }
      const dados = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(dados.error || "Não foi possível salvar a foto.");
      heroModal.hide();
      heroAviso(id ? "Foto atualizada — o site já mostra assim." : "Foto adicionada ao topo do site.");
      await heroCarregar();
    }catch(err){
      console.error("Erro ao salvar a foto do topo:", err);
      heroErroEl.textContent = err.message || "Não foi possível salvar a foto.";
    }finally{
      heroSalvarEl.disabled = false;
      heroSalvarEl.textContent = rotulo;
    }
  });

  async function heroSalvarOrdem(nova){
    if(heroSalvandoOrdem) return;
    heroSalvandoOrdem = true;
    const anterior = heroCache;
    heroCache = nova;
    heroGradeEl.innerHTML = heroCache.map(heroCartao).join("");
    heroAviso("Salvando a ordem...");
    try{
      const res = await fetchWithTimeout("/api/admin/hero/fotos/ordem", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: nova.map(f => f.id) }),
      });
      const dados = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(dados.error || "Não foi possível salvar a ordem.");
      heroAviso("Ordem salva — o topo do site já está nesta ordem.");
    }catch(err){
      console.error("Erro ao salvar a ordem das fotos do topo:", err);
      heroCache = anterior;
      heroGradeEl.innerHTML = heroCache.map(heroCartao).join("");
      heroAviso(err.message || "Não foi possível salvar a ordem.", true);
    }finally{
      heroSalvandoOrdem = false;
    }
  }

  heroGradeEl?.addEventListener("click", async (e) => {
    const card = e.target.closest("[data-hero-id]");
    if(!card) return;
    const id = card.dataset.heroId;
    const i = heroCache.findIndex(f => f.id === id);
    if(i === -1) return;

    const mover = e.target.closest("[data-hero-mover]");
    if(mover){
      const destino = i + Number(mover.dataset.heroMover);
      if(destino < 0 || destino >= heroCache.length) return;
      const nova = [...heroCache];
      [nova[i], nova[destino]] = [nova[destino], nova[i]];
      return void heroSalvarOrdem(nova);
    }

    if(e.target.closest("[data-hero-editar]")) return void heroAbrirModal(heroCache[i]);

    if(e.target.closest("[data-hero-apagar]")){
      const ultima = heroCache.length === 1;
      const pergunta = ultima
        ? "Apagar a última foto sua? O topo volta a mostrar as cinco fotos que já vieram prontas."
        : "Apagar esta foto do topo do site?";
      if(!confirm(pergunta)) return;
      try{
        const res = await fetchWithTimeout(`/api/admin/hero/fotos/${encodeURIComponent(id)}`, { method: "DELETE" });
        if(!res.ok) throw new Error("Não foi possível apagar a foto.");
        heroAviso(ultima ? "Foto apagada — o topo voltou para as fotos que já vieram prontas." : "Foto apagada do topo.");
        await heroCarregar();
      }catch(err){
        console.error("Erro ao apagar a foto do topo:", err);
        heroAviso(err.message || "Não foi possível apagar a foto.", true);
      }
    }
  });

  const depGradeEl = document.getElementById("depGrade");
  const depMsgEl = document.getElementById("depMsg");
  const depModalEl = document.getElementById("depModal");
  const depModal = depModalEl ? new bootstrap.Modal(depModalEl) : null;
  const depFormEl = document.getElementById("depForm");
  const depIdEl = document.getElementById("depId");
  const depTextoEl = document.getElementById("depTexto");
  const depNomeEl = document.getElementById("depNome");
  const depCidadeEl = document.getElementById("depCidade");
  const depOrigemEl = document.getElementById("depOrigem");
  const depFotoEl = document.getElementById("depFoto");
  const depConsentEl = document.getElementById("depConsentimento");
  const depErroEl = document.getElementById("depErro");
  const depSalvarEl = document.getElementById("depSalvar");

  let depCache = [];
  let depMax = 6;
  let depSalvandoOrdem = false;

  function depAviso(texto, erro){
    depMsgEl.textContent = texto || "";
    depMsgEl.classList.toggle("text-danger", Boolean(erro));
  }

  function depCartao(d, i){
    const origem = d.origem === "instagram"
      ? '<i class="bi bi-instagram" aria-hidden="true"></i> Instagram'
      : '<i class="bi bi-whatsapp" aria-hidden="true"></i> WhatsApp';
    const quem = [d.nome, d.cidade].filter(Boolean).map(escapeHTML).join(" · ");
    return `
      <div class="hero-admin-card depoimento-card${d.status === "oculto" ? " is-oculto" : ""}" data-dep-id="${d.id}">
        ${d.fotoUrl ? `<div class="hero-admin-foto"><img src="${escapeHTML(d.fotoUrl)}" alt="" loading="lazy"><span class="hero-admin-ordem">${i + 1}</span></div>` : `<span class="hero-admin-ordem depoimento-ordem-solta">${i + 1}</span>`}
        <div class="hero-admin-corpo">
          <span class="depoimento-origem">${origem}${d.status === "oculto" ? ' · <span class="depoimento-oculto">oculto</span>' : ""}</span>
          <blockquote class="depoimento-texto">${escapeHTML(d.texto)}</blockquote>
          <span class="depoimento-quem">${quem}</span>
          <div class="hero-admin-acoes">
            <button type="button" class="hero-admin-btn" data-dep-mover="-1" ${i === 0 ? "disabled" : ""}
                    aria-label="Mover para antes"><i class="bi bi-chevron-left" aria-hidden="true"></i></button>
            <button type="button" class="hero-admin-btn" data-dep-mover="1" ${i === depCache.length - 1 ? "disabled" : ""}
                    aria-label="Mover para depois"><i class="bi bi-chevron-right" aria-hidden="true"></i></button>
            <button type="button" class="hero-admin-btn" data-dep-editar
                    aria-label="Editar este depoimento"><i class="bi bi-pencil" aria-hidden="true"></i></button>
            <button type="button" class="hero-admin-btn is-apagar" data-dep-apagar
                    aria-label="Apagar este depoimento"><i class="bi bi-trash3" aria-hidden="true"></i></button>
          </div>
        </div>
      </div>`;
  }

  function depRender(dados){
    depCache = dados.depoimentos;
    depMax = dados.max;
    depGradeEl.innerHTML = depCache.length
      ? depCache.map(depCartao).join("")
      : `<p class="admin-hint mb-0">Nenhum depoimento ainda. Enquanto não houver avaliação de cliente que comprou pelo site, a seção mostra um convite.</p>`;
    document.getElementById("depAddBtn").disabled = depCache.length >= depMax;
  }

  async function depCarregar(){
    try{
      const res = await fetchWithTimeout("/api/admin/depoimentos");
      if(!res.ok) throw new Error("Não foi possível carregar os depoimentos.");
      depRender(await res.json());
    }catch(err){
      console.error("Erro ao carregar depoimentos:", err);
      depAviso(err.message || "Não foi possível carregar os depoimentos.", true);
    }
  }

  function depAbrirModal(d){
    depErroEl.textContent = "";
    depFormEl.reset();
    depIdEl.value = d ? d.id : "";
    document.getElementById("depModalLabel").textContent = d ? "Editar depoimento" : "Adicionar depoimento";
    document.getElementById("depFotoBloco").classList.toggle("d-none", Boolean(d));
    document.getElementById("depConsentimentoBloco").classList.toggle("d-none", Boolean(d));
    if(d){
      depTextoEl.value = d.texto;
      depNomeEl.value = d.nome;
      depCidadeEl.value = d.cidade || "";
      depOrigemEl.value = d.origem;
    }
    depModal.show();
  }

  document.getElementById("depAddBtn")?.addEventListener("click", () => depAbrirModal(null));

  depFormEl?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = depIdEl.value;
    const texto = depTextoEl.value.trim();
    const nome = depNomeEl.value.trim();
    if(!texto) return void (depErroEl.textContent = "Cole a mensagem da cliente.");
    if(!nome) return void (depErroEl.textContent = "Escreva o primeiro nome da cliente.");
    if(!id && !depConsentEl.checked){
      return void (depErroEl.textContent = "Confirme que a cliente autorizou publicar a mensagem.");
    }

    depErroEl.textContent = "";
    depSalvarEl.disabled = true;
    const rotulo = depSalvarEl.textContent;
    depSalvarEl.textContent = "Salvando...";
    try{
      let res;
      if(id){
        res = await fetchWithTimeout(`/api/admin/depoimentos/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ texto, nome, cidade: depCidadeEl.value.trim(), origem: depOrigemEl.value, status: "publicado" }),
        });
      }else{
        const corpo = new FormData();
        corpo.append("texto", texto);
        corpo.append("nome", nome);
        corpo.append("cidade", depCidadeEl.value.trim());
        corpo.append("origem", depOrigemEl.value);
        corpo.append("consentimento", "true");
        if(depFotoEl.files?.[0]) corpo.append("foto", depFotoEl.files[0]);
        res = await fetchWithTimeout("/api/admin/depoimentos", { method: "POST", body: corpo }, 30000);
      }
      const dados = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(dados.error || "Não foi possível salvar.");
      depModal.hide();
      depAviso(id ? "Depoimento atualizado." : "Depoimento publicado no site.");
      await depCarregar();
    }catch(err){
      console.error("Erro ao salvar depoimento:", err);
      depErroEl.textContent = err.message || "Não foi possível salvar.";
    }finally{
      depSalvarEl.disabled = false;
      depSalvarEl.textContent = rotulo;
    }
  });

  async function depSalvarOrdem(nova){
    if(depSalvandoOrdem) return;
    depSalvandoOrdem = true;
    const anterior = depCache;
    depCache = nova;
    depGradeEl.innerHTML = depCache.map(depCartao).join("");
    depAviso("Salvando a ordem...");
    try{
      const res = await fetchWithTimeout("/api/admin/depoimentos/ordem", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: nova.map(d => d.id) }),
      });
      const dados = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(dados.error || "Não foi possível salvar a ordem.");
      depAviso("Ordem salva.");
    }catch(err){
      console.error("Erro ao salvar a ordem dos depoimentos:", err);
      depCache = anterior;
      depGradeEl.innerHTML = depCache.map(depCartao).join("");
      depAviso(err.message || "Não foi possível salvar a ordem.", true);
    }finally{
      depSalvandoOrdem = false;
    }
  }

  depGradeEl?.addEventListener("click", async (e) => {
    const card = e.target.closest("[data-dep-id]");
    if(!card) return;
    const id = Number(card.dataset.depId);
    const i = depCache.findIndex(d => d.id === id);
    if(i === -1) return;

    const mover = e.target.closest("[data-dep-mover]");
    if(mover){
      const destino = i + Number(mover.dataset.depMover);
      if(destino < 0 || destino >= depCache.length) return;
      const nova = [...depCache];
      [nova[i], nova[destino]] = [nova[destino], nova[i]];
      return void depSalvarOrdem(nova);
    }

    if(e.target.closest("[data-dep-editar]")) return void depAbrirModal(depCache[i]);

    if(e.target.closest("[data-dep-apagar]")){
      if(!confirm("Apagar este depoimento do site?")) return;
      try{
        const res = await fetchWithTimeout(`/api/admin/depoimentos/${encodeURIComponent(id)}`, { method: "DELETE" });
        if(!res.ok) throw new Error("Não foi possível apagar.");
        depAviso("Depoimento apagado.");
        await depCarregar();
      }catch(err){
        console.error("Erro ao apagar depoimento:", err);
        depAviso(err.message || "Não foi possível apagar.", true);
      }
    }
  });

  PLCAuth.aoSaberDaSessao(({ user, falhou }) => {
    if(user) return user.isAdmin ? (loadDashboard(), carregarSituacaoDoAviso(), carregarAvaliacoes(), heroCarregar(), depCarregar()) : showOnly(stateForbidden);
    showOnly(falhou ? stateError : stateLoggedOut);
  });
})();
