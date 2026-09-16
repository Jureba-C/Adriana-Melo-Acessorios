(function(){
  "use strict";

  function escapeHTML(str){
    return String(str).replace(/[&<>"']/g, ch => ({
      "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
    }[ch]));
  }

  function formatDate(ts){
    if(!ts) return "";
    return new Date(ts).toLocaleDateString("pt-BR", { day:"2-digit", month:"short", year:"numeric" });
  }
  function formatDateTime(v){
    if(!v) return "";
    const d = typeof v === "number" ? new Date(v) : new Date(v);
    if(Number.isNaN(d.getTime())) return escapeHTML(String(v));
    return d.toLocaleString("pt-BR", { day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" });
  }

  const PAYMENT_ISSUE_LABELS = {
    "pendente": "Este pedido ainda está aguardando confirmação de pagamento.",
    "em análise": "O pagamento deste pedido está em análise.",
    "recusado": "O pagamento deste pedido foi recusado.",
    "cancelado": "Este pedido foi cancelado.",
    "reembolsado": "Este pedido foi reembolsado.",
    "estornado": "O pagamento deste pedido foi estornado.",
  };
  const STATUS_LABELS = {
    "pendente":    { label:"Pagamento pendente", cls:"order-status-pending" },
    "em análise":  { label:"Pagamento em análise", cls:"order-status-pending" },
    "pago":        { label:"Pago", cls:"order-status-paid" },
    "recusado":    { label:"Pagamento recusado", cls:"order-status-failed" },
    "cancelado":   { label:"Cancelado", cls:"order-status-failed" },
    "reembolsado": { label:"Reembolsado", cls:"order-status-failed" },
    "estornado":   { label:"Estornado", cls:"order-status-failed" },
  };

  const FULFILLMENT_STEPS = [
    { key: "confirmado", label: "Confirmado" },
    { key: "em_producao", label: "Em produção" },
    { key: "postado", label: "Postado" },
    { key: "entregue", label: "Entregue" },
  ];

  const stateLoading = document.getElementById("trackLoading");
  const stateLoggedOut = document.getElementById("trackLoggedOut");
  const stateNotFound = document.getElementById("trackNotFound");
  const stateError = document.getElementById("trackError");
  const content = document.getElementById("trackContent");
  const retryBtn = document.getElementById("trackRetryBtn");

  function showOnly(target){
    [stateLoading, stateLoggedOut, stateNotFound, stateError, content].forEach(node => {
      if(node) node.classList.toggle("d-none", node !== target);
    });
  }

  function getReferenceFromQuery(){
    return new URLSearchParams(window.location.search).get("pedido") || "";
  }

  function renderTimeline(fulfillmentStatus){
    const currentIndex = fulfillmentStatus
      ? FULFILLMENT_STEPS.findIndex(s => s.key === fulfillmentStatus)
      : 0;
    const timeline = document.getElementById("trackTimeline");
    timeline.innerHTML = FULFILLMENT_STEPS.map((step, i) => {
      const cls = i < currentIndex ? "is-done" : i === currentIndex ? "is-current" : "";
      return `
        <div class="fulfillment-step ${cls}">
          <span class="fulfillment-dot"></span>
          <span>${escapeHTML(step.label)}</span>
        </div>
      `;
    }).join("");
  }

  function renderShipping(order){
    const wrap = document.getElementById("trackShippingWrap");
    const noCode = document.getElementById("trackNoCode");
    const withCode = document.getElementById("trackWithCode");
    wrap.classList.remove("d-none");

    if(!order.trackingCode){
      noCode.classList.remove("d-none");
      withCode.classList.add("d-none");
      return;
    }
    noCode.classList.add("d-none");
    withCode.classList.remove("d-none");

    document.getElementById("trackCode").textContent = order.trackingCode;
    const link = document.getElementById("trackCarrierLink");
    if(order.carrierUrl){
      link.href = order.carrierUrl;
      link.classList.remove("d-none");
    }else{
      link.classList.add("d-none");
    }

    const events = order.tracking?.events || [];
    const noRoute = document.getElementById("trackNoRoute");
    const routeEl = document.getElementById("trackRoute");
    if(!events.length){
      noRoute.classList.remove("d-none");
      routeEl.classList.add("d-none");
      routeEl.innerHTML = "";
      return;
    }
    noRoute.classList.add("d-none");
    routeEl.classList.remove("d-none");
    routeEl.innerHTML = events.map(ev => `
      <li class="tracking-route-item">
        ${ev.date ? `<div class="tracking-route-date">${escapeHTML(formatDateTime(ev.date))}</div>` : ""}
        <div class="tracking-route-desc">${escapeHTML(ev.description || "")}${ev.location ? ` — ${escapeHTML(ev.location)}` : ""}</div>
      </li>
    `).join("");
  }

  function renderOrder(order){
    document.getElementById("trackReference").textContent = `Pedido #${order.reference.slice(0, 8)}`;
    document.getElementById("trackDate").textContent = formatDate(order.createdAt);
    const status = STATUS_LABELS[order.status] || { label: escapeHTML(order.status), cls:"order-status-pending" };
    const badge = document.getElementById("trackStatusBadge");
    badge.textContent = status.label;
    badge.className = `order-status ${status.cls}`;

    const timelineWrap = document.getElementById("trackTimelineWrap");
    const paymentIssue = document.getElementById("trackPaymentIssue");
    const shippingWrap = document.getElementById("trackShippingWrap");

    if(order.status !== "pago"){
      timelineWrap.classList.add("d-none");
      shippingWrap.classList.add("d-none");
      paymentIssue.classList.remove("d-none");
      document.getElementById("trackPaymentIssueText").textContent =
        PAYMENT_ISSUE_LABELS[order.status] || "Não há atualização de envio para este pedido.";
      return;
    }

    paymentIssue.classList.add("d-none");
    timelineWrap.classList.remove("d-none");
    renderTimeline(order.fulfillmentStatus);
    renderConfirmacao(order);
    renderShipping(order);
  }

  const recebiWrap = document.getElementById("trackRecebiWrap");
  const recebiBtn = document.getElementById("trackRecebiBtn");
  const recebiFeedback = document.getElementById("trackRecebiFeedback");
  const avaliarWrap = document.getElementById("trackAvaliarWrap");
  const avaliarLink = document.getElementById("trackAvaliarLink");
  let referenciaAtual = "";
  let avaliarUrlAtual = "";

  function mostrarAvaliar(visivel){
    if(!avaliarWrap || !avaliarLink) return;
    if(visivel && avaliarUrlAtual) avaliarLink.href = avaliarUrlAtual;
    avaliarWrap.classList.toggle("d-none", !(visivel && avaliarUrlAtual));
  }

  function renderConfirmacao(order){
    if(!recebiWrap) return;
    referenciaAtual = order.reference;
    avaliarUrlAtual = order.avaliarUrl || "";
    const podeConfirmar = order.fulfillmentStatus === "postado";
    recebiWrap.classList.toggle("d-none", !podeConfirmar);
    recebiFeedback.classList.add("d-none");
    if(recebiBtn) recebiBtn.disabled = false;
    mostrarAvaliar(order.fulfillmentStatus === "entregue" && !order.avaliado);
  }

  recebiBtn?.addEventListener("click", async () => {
    if(!referenciaAtual) return;
    recebiBtn.disabled = true;
    try{
      const res = await fetch(`/api/orders/${encodeURIComponent(referenciaAtual)}/recebi`, { method: "POST" });
      if(!res.ok) throw new Error("falhou");
      recebiWrap.classList.add("d-none");
      renderTimeline("entregue");
      recebiFeedback.textContent = "Que bom que chegou! Obrigada 💗";
      recebiFeedback.classList.remove("d-none");
      recebiWrap.classList.remove("d-none");
      recebiBtn.classList.add("d-none");
      mostrarAvaliar(true);
    }catch(err){
      recebiBtn.disabled = false;
    }
  });

  async function loadOrder(){
    const reference = getReferenceFromQuery();
    if(!reference){
      showOnly(stateNotFound);
      return;
    }
    showOnly(stateLoading);
    try{
      const res = await fetch(`/api/orders/${encodeURIComponent(reference)}`);
      if(res.status === 401){ showOnly(stateLoggedOut); return; }
      if(res.status === 404){ showOnly(stateNotFound); return; }
      if(!res.ok) throw new Error("Falha ao carregar pedido (HTTP " + res.status + ").");
      const order = await res.json();
      renderOrder(order);
      showOnly(content);
    }catch(err){
      console.error("Erro ao carregar pedido:", err);
      showOnly(stateError);
    }
  }

  retryBtn?.addEventListener("click", async () => {
    showOnly(stateLoading);
    const user = await PLCAuth.checkSession();
    if(user) loadOrder(); else showOnly(stateLoggedOut);
  });

  PLCAuth.aoSaberDaSessao(({ user, falhou }) => {
    if(user) loadOrder();
    else if(falhou) showOnly(stateError);
    else showOnly(stateLoggedOut);
  });
})();
