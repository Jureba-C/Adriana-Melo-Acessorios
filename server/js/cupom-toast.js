(function(){
  "use strict";

  const STORAGE_KEY = "plc_cupom_toast_email_enviado";
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const toastEl = document.getElementById("couponToast");
  if(!toastEl) return;

  if(localStorage.getItem(STORAGE_KEY)){
    return; 
  }

  let dadosCupom = null;
  try{
    dadosCupom = JSON.parse(toastEl.dataset.cupom || "null");
  }catch(err){
    console.warn("Dados do cupom de boas-vindas ilegíveis:", err);
  }
  if(!dadosCupom?.code || !dadosCupom?.percentOff){
    return; 
  }
  document.getElementById("couponToastPercent").textContent = `${dadosCupom.percentOff}%`;

  const toast = new bootstrap.Toast(toastEl, { autohide: false });
  const form = document.getElementById("couponToastForm");
  const emailInput = document.getElementById("couponToastEmail");
  const errorEl = document.getElementById("couponToastError");
  const revealEl = document.getElementById("couponToastReveal");
  const codeEl = document.getElementById("couponToastCode");
  const copyBtn = document.getElementById("couponToastCopyBtn");
  const closeBtn = toastEl.querySelector(".coupon-toast-close");

  window.PLCCupomToast = {
    abrir(){
      toast.show();
      if(!emailInput.disabled) emailInput.focus();
    },
  };
  document.dispatchEvent(new CustomEvent("plc:cupom-toast-pronto"));

  closeBtn.addEventListener("click", (e) => {
    e.preventDefault();
    const semAnimacao = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if(semAnimacao){
      toast.hide();
      return;
    }
    toastEl.classList.add("coupon-toast-closing");
    toastEl.addEventListener("animationend", () => toast.hide(), { once: true });
  });

  function mostrarErro(msg){
    errorEl.textContent = msg;
    errorEl.classList.add("show");
    emailInput.classList.add("is-invalid");
  }
  function limparErro(){
    errorEl.classList.remove("show");
    emailInput.classList.remove("is-invalid");
  }

  let enviando = false;
  async function validarEEnviar(){
    const email = emailInput.value.trim();
    if(!email) return; 
    if(!EMAIL_RE.test(email)){
      mostrarErro("E-mail inválido");
      return;
    }
    if(enviando) return;
    limparErro();
    enviando = true;
    form.classList.add("coupon-toast-submitting");
    try{
      const res = await fetch("/api/newsletter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(data.error || "Não foi possível agora.");

      if(data.coupon){
        codeEl.textContent = data.coupon;
      }else{

        revealEl.querySelector(".coupon-toast-success-text").textContent =
          "Inscrição confirmada! Fique de olho no seu e-mail para novidades.";
        revealEl.querySelector(".coupon-toast-code-row").remove();
      }
      form.hidden = true;
      revealEl.classList.add("show");
      emailInput.disabled = true;
      document.dispatchEvent(new CustomEvent("plc:cupom-assinado"));
    }catch(err){
      console.error("Falha ao inscrever pelo cupom da notificação:", err);
      mostrarErro(err.message || "Não foi possível agora. Tente de novo.");
    }finally{
      enviando = false;
      form.classList.remove("coupon-toast-submitting");
    }
    try{
      localStorage.setItem(STORAGE_KEY, "1");
    }catch(err){
      console.warn("Não foi possível salvar no localStorage:", err);
    }
  }

  emailInput.addEventListener("blur", validarEEnviar);
  form.addEventListener("submit", (e) => { e.preventDefault(); validarEEnviar(); });

  emailInput.addEventListener("input", limparErro);

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

  copyBtn.addEventListener("click", async () => {
    const codigo = codeEl.textContent;
    let copiou = false;
    try{
      await navigator.clipboard.writeText(codigo);
      copiou = true;
    }catch(err){
      console.warn("Área de transferência indisponível, tentando o modo antigo:", err);
      copiou = copiarPeloCampo(codigo);
    }
    const original = copyBtn.innerHTML;
    copyBtn.innerHTML = copiou
      ? `<i class="bi bi-check2"></i> Copiado!`
      : `<i class="bi bi-clipboard"></i> Copie manualmente`;
    if(copiou) copyBtn.classList.add("is-copied");
    setTimeout(() => {
      copyBtn.innerHTML = original;
      copyBtn.classList.remove("is-copied");
    }, 2000);
  });

  function algumOverlayAberto(){
    return !!document.querySelector(".modal.show, .offcanvas.show");
  }

  document.addEventListener("show.bs.modal", () => {
    if(toastEl.classList.contains("show")) toast.hide();
  });
  document.addEventListener("show.bs.offcanvas", () => {
    if(toastEl.classList.contains("show")) toast.hide();
  });

  PLCAuth.aoSaberDaSessao(({ user }) => {
    if(user) return;
    setTimeout(() => {
      if(algumOverlayAberto()) return;
      toast.show();
    }, 1200);
  });
})();
