(function(){
  "use strict";

  const STORAGE_KEY = "plc_pix_pendente";
  const INTERVALO_MS = 4000;      
  const LIMITE_MS = 20 * 60 * 1000; 

  const statePagar = document.getElementById("statePagar");
  const stateSemDados = document.getElementById("stateSemDados");

  function showOnly(el){
    [statePagar, stateSemDados].forEach(s => s.classList.toggle("d-none", s !== el));
  }

  function brl(v){
    return Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  let dados = null;
  try{
    dados = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
  }catch(err){
    console.warn("Dados do Pix ilegíveis:", err);
  }

  if(!dados?.reference || !dados?.qrCode){
    showOnly(stateSemDados);
    return;
  }

  document.getElementById("pixAmount").textContent = brl(dados.total);
  document.getElementById("pixCode").value = dados.qrCode;

  const qrImg = document.getElementById("pixQrImg");
  if(dados.qrCodeBase64){
    qrImg.src = `data:image/png;base64,${dados.qrCodeBase64}`;
  }else{

    document.getElementById("pixQrFrame").remove();
  }

  if(dados.expiresAt){
    const q = new Date(dados.expiresAt);
    if(!isNaN(q)){
      document.getElementById("pixExpiry").textContent =
        `Este código vale até ${q.toLocaleString("pt-BR", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" })}.`;
    }
  }

  const copyBtn = document.getElementById("pixCopyBtn");
  copyBtn.addEventListener("click", async () => {
    const campo = document.getElementById("pixCode");
    try{
      await navigator.clipboard.writeText(dados.qrCode);
    }catch(err){

      console.warn("Área de transferência indisponível, selecionando o texto:", err);
      campo.focus();
      campo.select();
    }
    copyBtn.innerHTML = `<i class="bi bi-check2"></i> Copiado`;
    setTimeout(() => { copyBtn.innerHTML = `<i class="bi bi-clipboard"></i> Copiar`; }, 2000);
  });

  const statusEl = document.getElementById("pixStatus");
  const comecou = Date.now();
  let timer = null;

  function pararDePerguntar(){
    clearInterval(timer);
    timer = null;
  }

  function confirmar(){
    pararDePerguntar();
    sessionStorage.removeItem(STORAGE_KEY);

    try{
      localStorage.removeItem("plc_cart_v1");
    }catch(err){
      console.warn("Não foi possível limpar o carrinho salvo:", err);
    }
    location.replace(`pagamento-sucesso.html?external_reference=${encodeURIComponent(dados.reference)}`);
  }

  async function checarStatus(){
    if(Date.now() - comecou > LIMITE_MS){
      pararDePerguntar();
      statusEl.innerHTML = `<i class="bi bi-info-circle"></i> Ainda não recebemos a confirmação. Se você já pagou, o pedido aparece em <a href="pedidos.html">Meus pedidos</a> assim que o banco confirmar.`;
      return;
    }
    try{
      const res = await fetch(`/api/orders/${encodeURIComponent(dados.reference)}/status`);
      if(!res.ok) return;               
      const { status } = await res.json();
      if(status === "pago") return confirmar();
      if(status === "recusado" || status === "cancelado"){
        pararDePerguntar();
        statusEl.innerHTML = `<i class="bi bi-exclamation-triangle"></i> Este pagamento foi ${status}. <a href="index.html">Voltar à loja</a>.`;
      }
    }catch(err){

      console.warn("Falha ao consultar o status do pedido:", err);
    }
  }

  timer = setInterval(checarStatus, INTERVALO_MS);
  checarStatus();

  document.addEventListener("visibilitychange", () => {
    if(!document.hidden && timer) checarStatus();
  });
})();
