(function(){
  "use strict";

  function escapeHTML(str){
    return String(str).replace(/[&<>"']/g, ch => ({
      "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
    }[ch]));
  }

  function fetchWithTimeout(url, options, timeoutMs){
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 8000);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
  }

  const navAccount = document.getElementById("navAccount");
  const navAccountMobile = document.getElementById("navAccountMobile");

  const ICONS = {
    user:  `<circle cx="12" cy="8" r="3.6"/><path d="M4.9 20a7.1 7.1 0 0 1 14.2 0"/>`,
    admin: `<path d="M12 3.2 19 6v5.6c0 4.3-2.9 7.6-7 8.4-4.1-.8-7-4.1-7-8.4V6z"/><path d="m9.2 12.2 1.9 1.9 3.7-3.9"/>`,
    exit:  `<path d="M14.2 4.2h3.9a1.8 1.8 0 0 1 1.8 1.8v12a1.8 1.8 0 0 1-1.8 1.8h-3.9"/><path d="m9 8.3-4 3.7 4 3.7"/><path d="M5 12h9.6"/>`
  };
  function pill(icon, label){
    return `<svg class="account-icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[icon]}</svg>
            <span class="account-pill-label">${label}</span>`;
  }

  const secondaryOnlyDesktop = navAccountMobile ? " d-none d-xl-inline-flex" : "";

  function renderLoggedOut(){
    if(navAccount){
      navAccount.innerHTML =
        `<a href="conta.html" class="account-pill" aria-label="Entrar na sua conta">${pill("user", "Entrar")}</a>`;
    }
    if(navAccountMobile){
      navAccountMobile.innerHTML = `<a href="conta.html" class="plc-nav-link"><i class="bi bi-person me-1"></i>Entrar / Cadastrar</a>`;
    }
  }

  function renderLoggedIn(user){
    const firstName = escapeHTML(String(user.name || "").trim().split(" ")[0] || "cliente");
    const adminLinkMobile = user.isAdmin
      ? `<a href="admin.html" class="plc-nav-link"><i class="bi bi-shield-lock me-1"></i>Painel admin</a>` : "";
    if(navAccount){
      const adminPill = user.isAdmin
        ? `<a href="admin.html" class="account-pill${secondaryOnlyDesktop}" aria-label="Painel administrativo">${pill("admin", "Admin")}</a>` : "";
      navAccount.innerHTML = `
        ${adminPill}
        <a href="pedidos.html" class="account-pill account-pill-primary" aria-label="Minha conta">${pill("user", `<span class="account-pill-ola">Olá, </span>${firstName}`)}</a>
        <button type="button" class="account-pill${secondaryOnlyDesktop}" id="logoutBtn" aria-label="Sair da conta">${pill("exit", "Sair")}</button>
      `;
      document.getElementById("logoutBtn")?.addEventListener("click", logout);
    }
    if(navAccountMobile){
      navAccountMobile.innerHTML = `
        ${adminLinkMobile}
        <a href="pedidos.html" class="plc-nav-link"><i class="bi bi-bag-check me-1"></i>Minha conta</a>
        <button type="button" class="plc-nav-link text-start p-0 border-0 bg-transparent" id="logoutBtnMobile">Sair (${firstName})</button>
      `;
      document.getElementById("logoutBtnMobile")?.addEventListener("click", logout);
    }
  }

  async function logout(){
    try{
      await fetch("/api/auth/logout", { method: "POST" });
    }catch(err){
      console.warn("Falha ao encerrar sessão no servidor (limpando mesmo assim):", err);
    }
    window.location.href = "index.html";
  }

  let sessaoResolvida = false;
  let sessao = { user: null, falhou: false };

  /* ⚠️ Duas armadilhas silenciosas moram aqui.
     1) Quem escuta "plc:auth" pode chegar depois do disparo: script com defer
        roda em ordem, mas o navegador atende a fila de eventos enquanto
        espera o próximo arquivo baixar. Por isso o resultado fica guardado.
     2) A resposta guardada sai numa microtarefa, nunca na hora: chamar o
        callback de imediato o executaria no meio do script que acabou de
        pedir, antes das const de baixo existirem (ReferenceError de TDZ). */
  function aoSaberDaSessao(callback){
    if(sessaoResolvida){ Promise.resolve().then(() => callback(sessao)); return; }
    document.addEventListener("plc:auth", (e) => callback(e.detail), { once: true });
  }

  async function checkSession(){
    let user = null;
    let falhou = false;
    try{
      const res = await fetchWithTimeout("/api/auth/me");
      if(res.ok) user = await res.json();
      else if(res.status !== 401) falhou = true;
    }catch(err){
      console.warn("Não foi possível verificar a sessão:", err);
      falhou = true;
    }
    try{
      if(user) renderLoggedIn(user); else renderLoggedOut();
    } finally {
      sessao = { user, falhou };
      sessaoResolvida = true;
      document.dispatchEvent(new CustomEvent("plc:auth", { detail: sessao }));
    }
    return user;
  }

  window.addEventListener("pageshow", () => {
    if(!sessaoResolvida) checkSession();
  });

  window.PLCAuth = { checkSession, aoSaberDaSessao, escapeHTML, logout };
  checkSession();
})();
