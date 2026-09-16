(function(){
  "use strict";

  function escapeHTML(str){
    return String(str).replace(/[&<>"']/g, ch => ({
      "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
    }[ch]));
  }

  const formatMoney = window.PLCPricing.formatMoney;
  function formatDate(ts){
    return new Date(ts).toLocaleDateString("pt-BR", { day:"2-digit", month:"short", year:"numeric" });
  }

  const PAYMENT_METHOD_LABELS = { pix: "Pix", card: "Cartão ou boleto" };

  const STATUS_LABELS = {
    "pendente":    { label:"Pagamento pendente", cls:"order-status-pending" },
    "em análise":  { label:"Pagamento em análise", cls:"order-status-pending" },
    "pago":        { label:"Pago", cls:"order-status-paid" },
    "recusado":    { label:"Pagamento recusado", cls:"order-status-failed" },
    "cancelado":   { label:"Cancelado", cls:"order-status-failed" },
    "reembolsado": { label:"Reembolsado", cls:"order-status-failed" },
    "estornado":   { label:"Estornado", cls:"order-status-failed" },
  };

  const stateLoading = document.getElementById("ordersLoading");
  const stateEmpty = document.getElementById("ordersEmpty");
  const stateError = document.getElementById("ordersError");
  const stateLoggedOut = document.getElementById("ordersLoggedOut");
  const listEl = document.getElementById("ordersList");
  const retryBtn = document.getElementById("ordersRetryBtn");

  function showOnly(target){
    [stateLoading, stateEmpty, stateError, stateLoggedOut, listEl].forEach(node => {
      if(node) node.classList.toggle("d-none", node !== target);
    });
  }

  function blocoDeAvaliacao(order){
    if(!order.avaliarUrl) return "";
    const url = escapeHTML(order.avaliarUrl);
    const resumo = order.avaliacao || { produtos: 0, feitas: 0, pendentes: 0, completa: false };

    if(order.fulfillmentStatus === "postado"){
      return `
        <a href="${url}" class="pedido-avaliar is-chegou">
          <span class="pedido-avaliar-icone" aria-hidden="true"><i class="bi bi-gift"></i></span>
          <span class="pedido-avaliar-texto">
            <strong>Seu pedido já chegou?</strong>
            <span>Confirme o recebimento e conte o que achou das peças.</span>
          </span>
          <span class="pedido-avaliar-acao">Recebi <i class="bi bi-chevron-right" aria-hidden="true"></i></span>
        </a>`;
    }

    if(!resumo.completa){
      const faltam = resumo.produtos - resumo.feitas;
      const detalhe = resumo.feitas > 0
        ? `Falta${faltam === 1 ? "" : "m"} ${faltam} ${faltam === 1 ? "peça" : "peças"} para avaliar.`
        : "Leva um minutinho e ajuda outras clientes a escolher.";
      return `
        <a href="${url}" class="pedido-avaliar is-avaliar">
          <span class="pedido-avaliar-texto">
            <span class="pedido-avaliar-estrelas" aria-hidden="true">${'<i class="bi bi-star-fill"></i>'.repeat(5)}</span>
            <strong>Como ficaram os laços?</strong>
            <span>${detalhe}</span>
          </span>
          <span class="pedido-avaliar-acao">Avaliar <i class="bi bi-chevron-right" aria-hidden="true"></i></span>
        </a>`;
    }

    return `
      <div class="pedido-avaliar is-feita">
        <span class="pedido-avaliar-icone" aria-hidden="true"><i class="bi bi-check2-circle"></i></span>
        <span class="pedido-avaliar-texto">
          <strong>Você avaliou este pedido</strong>
          <span>${resumo.pendentes > 0 ? "A loja ainda vai ler antes de publicar." : "Obrigada por contar pra gente!"}</span>
        </span>
        ${resumo.pendentes > 0 ? `<a href="${url}" class="pedido-avaliar-link">Ajustar</a>` : ""}
      </div>`;
  }

  function renderOrders(orders){
    if(!orders.length){ showOnly(stateEmpty); return; }
    listEl.innerHTML = orders.map(order => {
      const status = STATUS_LABELS[order.status] || { label: escapeHTML(order.status), cls:"order-status-pending" };
      const itemsHtml = order.items.map(item => `
        <li class="d-flex justify-content-between gap-3">
          <span>${item.qty}x ${escapeHTML(item.name)}</span>
          <span>${item.unitPrice != null ? formatMoney(item.unitPrice * item.qty) : "—"}</span>
        </li>
      `).join("");
      const shippingLabel = order.shipping?.name ? ` — ${escapeHTML(order.shipping.name)}` : "";
      return `
        <div class="order-card">
          <div class="d-flex align-items-start flex-wrap gap-2 mb-2">
            <div>
              <div class="fw-semibold">Pedido #${escapeHTML(order.reference.slice(0, 8))}</div>
              <div class="small" style="color:var(--ink-soft)">${formatDate(order.createdAt)}</div>
            </div>
            <div class="d-flex flex-column align-items-end gap-1 ms-auto">
              <span class="order-status ${status.cls}">${status.label}</span>
              ${order.status === "pendente" ? `
              <button type="button" class="btn btn-outline-blush btn-sm resume-payment-btn" data-reference="${escapeHTML(order.reference)}">
                Continuar pagamento
              </button>` : ""}
              ${order.status === "pago" ? `
              <a href="acompanhar-pedido.html?pedido=${encodeURIComponent(order.reference)}" class="btn btn-outline-blush btn-sm">
                Acompanhar pedido
              </a>` : ""}
            </div>
          </div>
          ${order.status === "pendente" ? `<div class="small text-danger mb-2 resume-payment-error d-none"></div>` : ""}
          ${blocoDeAvaliacao(order)}
          <ul class="list-unstyled small mb-2">${itemsHtml}</ul>
          <div class="d-flex justify-content-between small">
            <span>Subtotal</span><span>${formatMoney(order.subtotal)}</span>
          </div>
          ${order.discount > 0 ? `
          <div class="d-flex justify-content-between small" style="color:var(--blush-700)">
            <span>Desconto${order.couponCode ? " (" + escapeHTML(order.couponCode) + ")" : ""}</span>
            <span>-${formatMoney(order.discount)}</span>
          </div>` : ""}
          ${order.pixDiscount > 0 ? `
          <div class="d-flex justify-content-between small" style="color:var(--blush-700)">
            <span>Desconto Pix</span><span>-${formatMoney(order.pixDiscount)}</span>
          </div>` : ""}
          ${order.promoDiscount > 0 ? `
          <div class="d-flex justify-content-between small" style="color:var(--blush-700)">
            <span>Leve 4, pague 3</span><span>-${formatMoney(order.promoDiscount)}</span>
          </div>` : ""}
          <div class="d-flex justify-content-between small">
            <span>Frete${shippingLabel}</span><span>${formatMoney(order.shippingPrice)}</span>
          </div>
          <div class="d-flex justify-content-between fw-semibold pt-2 mt-1 border-top" style="border-color:var(--blush-100)!important">
            <span>Total <span class="fw-normal small" style="color:var(--ink-soft)">· ${escapeHTML(PAYMENT_METHOD_LABELS[order.paymentMethod] || "Cartão ou boleto")}</span></span>
            <span style="color:var(--blush-700)">${formatMoney(order.total)}</span>
          </div>
        </div>
      `;
    }).join("");
    showOnly(listEl);
  }

  async function loadOrders(){
    showOnly(stateLoading);
    try{
      const res = await fetch("/api/orders");
      if(res.status === 401){ showOnly(stateLoggedOut); return; }
      if(!res.ok) throw new Error("Falha ao carregar pedidos (HTTP " + res.status + ").");
      const data = await res.json();
      renderOrders(Array.isArray(data.orders) ? data.orders : []);
    }catch(err){
      console.error("Erro ao carregar pedidos:", err);
      showOnly(stateError);
    }
  }

  retryBtn?.addEventListener("click", async () => {
    showOnly(stateLoading);
    const user = await PLCAuth.checkSession();
    if(user) loadOrders(); else showOnly(stateLoggedOut);
  });

  listEl?.addEventListener("click", async (e) => {
    const btn = e.target.closest(".resume-payment-btn");
    if(!btn) return;
    const card = btn.closest(".order-card");
    const errorEl = card?.querySelector(".resume-payment-error");
    if(errorEl){ errorEl.classList.add("d-none"); errorEl.textContent = ""; }
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "Preparando...";
    try{
      const res = await fetch(`/api/orders/${encodeURIComponent(btn.dataset.reference)}/resume-payment`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(data.error || "Não foi possível continuar o pagamento agora.");

      if(data.qrCode){
        sessionStorage.setItem("plc_pix_pendente", JSON.stringify(data));
        window.location.href = "pagamento-pix.html";
        return;
      }
      if(!data.init_point) throw new Error("O servidor não devolveu o link de pagamento. Tente novamente.");
      window.location.href = data.init_point;
    }catch(err){
      console.error("Erro ao continuar pagamento:", err);
      if(errorEl){
        errorEl.textContent = err.message || "Não foi possível continuar o pagamento agora. Tente novamente.";
        errorEl.classList.remove("d-none");
      }
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  const accountDanger = document.getElementById("accountDanger");
  const deleteBtn = document.getElementById("deleteAccountBtn");
  const deleteModalEl = document.getElementById("deleteAccountModal");
  const deleteForm = document.getElementById("deleteAccountForm");
  const deletePasswordEl = document.getElementById("deleteAccountPassword");
  const deleteErrorEl = document.getElementById("deleteAccountError");
  const deleteConfirmBtn = document.getElementById("deleteAccountConfirm");
  const deleteModal = deleteModalEl ? new bootstrap.Modal(deleteModalEl) : null;

  deleteBtn?.addEventListener("click", () => {
    if(deleteErrorEl) deleteErrorEl.textContent = "";
    if(deletePasswordEl) deletePasswordEl.value = "";
    deleteModal?.show();
  });

  deleteForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = deletePasswordEl.value;
    if(!password){ deleteErrorEl.textContent = "Digite sua senha."; return; }
    deleteConfirmBtn.disabled = true;
    deleteErrorEl.textContent = "";
    try{
      const res = await fetch("/api/auth/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if(res.status === 401){ deleteErrorEl.textContent = "Senha incorreta."; return; }
      if(!res.ok){
        const data = await res.json().catch(() => ({}));
        deleteErrorEl.textContent = data.error || "Não foi possível excluir a conta agora.";
        return;
      }
      window.location.href = "index.html?conta=excluida";
    }catch(err){
      console.error("Erro ao excluir conta:", err);
      deleteErrorEl.textContent = "Sem conexão com o servidor. Tente novamente.";
    }finally{
      deleteConfirmBtn.disabled = false;
    }
  });

  PLCAuth.aoSaberDaSessao(({ user, falhou }) => {
    if(user){
      loadOrders();
      accountDanger?.classList.remove("d-none");
      return;
    }
    accountDanger?.classList.add("d-none");
    showOnly(falhou ? stateError : stateLoggedOut);
  });
})();
