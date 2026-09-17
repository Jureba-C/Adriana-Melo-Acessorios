(function(){
  "use strict";

  const abasEl = document.getElementById("contaAbas");
  if(!abasEl) return;

  const abas = [...abasEl.querySelectorAll(".conta-aba")];
  const paineis = {
    pedidos: document.getElementById("painelPedidos"),
    dados: document.getElementById("painelDados"),
    seguranca: document.getElementById("painelSeguranca"),
  };
  let perfilCarregado = false;

  function abrirAba(nome, { foco = false, atualizarHash = true } = {}){
    if(!paineis[nome]) nome = "pedidos";
    abas.forEach(aba => {
      const ativa = aba.dataset.aba === nome;
      aba.classList.toggle("is-ativa", ativa);
      aba.setAttribute("aria-selected", String(ativa));
      aba.tabIndex = ativa ? 0 : -1;
      if(ativa && foco) aba.focus();
    });
    Object.entries(paineis).forEach(([chave, painel]) => { if(painel) painel.hidden = chave !== nome; });
    if(atualizarHash){
      const url = nome === "pedidos" ? location.pathname + location.search : `#${nome}`;
      history.replaceState(null, "", url);
    }
    if(nome === "dados" && !perfilCarregado) carregarPerfil();
  }

  abasEl.addEventListener("click", (e) => {
    const aba = e.target.closest(".conta-aba");
    if(aba) abrirAba(aba.dataset.aba);
  });
  abasEl.addEventListener("keydown", (e) => {
    const i = abas.findIndex(a => a.classList.contains("is-ativa"));
    let alvo = null;
    if(e.key === "ArrowRight") alvo = abas[(i + 1) % abas.length];
    if(e.key === "ArrowLeft") alvo = abas[(i - 1 + abas.length) % abas.length];
    if(e.key === "Home") alvo = abas[0];
    if(e.key === "End") alvo = abas[abas.length - 1];
    if(!alvo) return;
    e.preventDefault();
    abrirAba(alvo.dataset.aba, { foco: true });
  });
  window.addEventListener("hashchange", () => abrirAba(location.hash.slice(1), { atualizarHash: false }));

  function mensagem(el, texto, tipo){
    if(!el) return;
    el.textContent = texto;
    el.classList.remove("d-none", "is-ok", "is-erro");
    el.classList.add(tipo === "ok" ? "is-ok" : "is-erro");
  }
  function limpar(el){ el?.classList.add("d-none"); }

  async function enviar(url, metodo, corpo){
    const res = await fetch(url, {
      method: metodo,
      headers: corpo ? { "Content-Type": "application/json" } : undefined,
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    const dados = await res.json().catch(() => ({}));
    if(res.status === 429) throw new Error("Muitas tentativas. Espere alguns minutos e tente de novo.");
    if(!res.ok) throw new Error(dados.error || "Não foi possível salvar agora. Tente de novo.");
    return dados;
  }

  function comBotao(botao, textoCarregando, acao){
    return async () => {
      const original = botao.innerHTML;
      botao.disabled = true;
      botao.textContent = textoCarregando;
      try{ await acao(); }
      finally{ botao.disabled = false; botao.innerHTML = original; }
    };
  }

  function mascaraTelefone(valor){
    const d = String(valor || "").replace(/\D/g, "").slice(0, 11);
    if(d.length <= 2) return d ? `(${d}` : "";
    if(d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    if(d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }

  const perfil = {
    form: document.getElementById("perfilForm"),
    nome: document.getElementById("perfilNome"),
    telefone: document.getElementById("perfilTelefone"),
    nascimento: document.getElementById("perfilNascimento"),
    cpf: document.getElementById("perfilCpf"),
    msg: document.getElementById("perfilMsg"),
    salvar: document.getElementById("perfilSalvar"),
    emailAtual: document.getElementById("emailAtual"),
  };

  function preencherPerfil(dados){
    perfil.nome.value = dados.name || "";
    perfil.telefone.value = mascaraTelefone(dados.telefone);
    perfil.nascimento.value = dados.nascimento || "";
    perfil.cpf.textContent = dados.cpfMascarado || "não informado";
    perfil.emailAtual.textContent = dados.email || "—";
  }

  async function carregarPerfil(){
    try{
      const res = await fetch("/api/auth/perfil");
      if(!res.ok) throw new Error();
      preencherPerfil(await res.json());
      perfilCarregado = true;
      limpar(perfil.msg);
    }catch{
      mensagem(perfil.msg, "Não conseguimos carregar seus dados agora. Recarregue a página.", "erro");
    }
  }

  const hoje = new Date();
  perfil.nascimento.max = `${hoje.getFullYear() - 13}-${String(hoje.getMonth() + 1).padStart(2, "0")}-${String(hoje.getDate()).padStart(2, "0")}`;
  perfil.nascimento.min = `${hoje.getFullYear() - 110}-01-01`;

  perfil.telefone.addEventListener("input", () => {
    perfil.telefone.value = mascaraTelefone(perfil.telefone.value);
  });

  perfil.form.addEventListener("submit", (e) => {
    e.preventDefault();
    limpar(perfil.msg);
    if(perfil.nome.value.trim().length < 2){
      mensagem(perfil.msg, "Digite seu nome.", "erro");
      perfil.nome.focus();
      return;
    }
    comBotao(perfil.salvar, "Salvando...", async () => {
      try{
        const dados = await enviar("/api/auth/perfil", "PUT", {
          name: perfil.nome.value,
          telefone: perfil.telefone.value,
          nascimento: perfil.nascimento.value,
        });
        preencherPerfil(dados);
        mensagem(perfil.msg, "Dados salvos. 💗", "ok");
        window.PLCAuth?.checkSession?.();
      }catch(err){
        mensagem(perfil.msg, err.message, "erro");
      }
    })();
  });

  const emailForm = document.getElementById("emailForm");
  const emailNovo = document.getElementById("emailNovo");
  const emailSenha = document.getElementById("emailSenha");
  const emailMsg = document.getElementById("emailMsg");
  emailForm.addEventListener("submit", (e) => {
    e.preventDefault();
    limpar(emailMsg);
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNovo.value.trim())){
      mensagem(emailMsg, "Digite um e-mail válido.", "erro");
      emailNovo.focus();
      return;
    }
    if(!emailSenha.value){
      mensagem(emailMsg, "Confirme com sua senha atual.", "erro");
      emailSenha.focus();
      return;
    }
    comBotao(document.getElementById("emailSalvar"), "Trocando...", async () => {
      try{
        const dados = await enviar("/api/auth/email", "PUT", { email: emailNovo.value, senhaAtual: emailSenha.value });
        preencherPerfil(dados);
        emailNovo.value = "";
        emailSenha.value = "";
        mensagem(emailMsg, "Pronto! Use o novo e-mail para entrar. Mandamos um aviso para o e-mail antigo.", "ok");
      }catch(err){
        mensagem(emailMsg, err.message, "erro");
      }
    })();
  });

  const senhaForm = document.getElementById("senhaForm");
  const senhaAtual = document.getElementById("senhaAtual");
  const senhaNova = document.getElementById("senhaNova");
  const senhaConfirma = document.getElementById("senhaConfirma");
  const senhaMsg = document.getElementById("senhaMsg");
  senhaForm.addEventListener("submit", (e) => {
    e.preventDefault();
    limpar(senhaMsg);
    if(!senhaAtual.value){ mensagem(senhaMsg, "Digite sua senha atual.", "erro"); senhaAtual.focus(); return; }
    if(senhaNova.value.length < 8){ mensagem(senhaMsg, "A nova senha precisa ter pelo menos 8 caracteres.", "erro"); senhaNova.focus(); return; }
    if(senhaNova.value !== senhaConfirma.value){ mensagem(senhaMsg, "As duas senhas novas não são iguais.", "erro"); senhaConfirma.focus(); return; }
    comBotao(document.getElementById("senhaSalvar"), "Trocando...", async () => {
      try{
        const dados = await enviar("/api/auth/senha", "PUT", { senhaAtual: senhaAtual.value, novaSenha: senhaNova.value });
        senhaForm.reset();
        const outros = dados.sessoesEncerradas > 0 ? ` Saímos de ${dados.sessoesEncerradas === 1 ? "1 outro aparelho" : `${dados.sessoesEncerradas} outros aparelhos`}.` : "";
        mensagem(senhaMsg, `Senha trocada.${outros}`, "ok");
      }catch(err){
        mensagem(senhaMsg, err.message, "erro");
      }
    })();
  });

  const sairOutrosBtn = document.getElementById("sairOutrosBtn");
  const sairOutrosMsg = document.getElementById("sairOutrosMsg");
  sairOutrosBtn.addEventListener("click", () => {
    limpar(sairOutrosMsg);
    comBotao(sairOutrosBtn, "Encerrando...", async () => {
      try{
        const dados = await enviar("/api/auth/sair-outros", "POST");
        mensagem(sairOutrosMsg, dados.sessoesEncerradas > 0
          ? `Pronto: ${dados.sessoesEncerradas === 1 ? "1 aparelho desconectado" : `${dados.sessoesEncerradas} aparelhos desconectados`}.`
          : "Nenhum outro aparelho estava conectado.", "ok");
      }catch(err){
        mensagem(sairOutrosMsg, err.message, "erro");
      }
    })();
  });

  window.PLCAuth?.aoSaberDaSessao(({ user }) => {
    abasEl.classList.toggle("d-none", !user);
    if(!user){
      Object.entries(paineis).forEach(([chave, painel]) => { if(painel) painel.hidden = chave !== "pedidos"; });
      return;
    }
    abrirAba(location.hash.slice(1), { atualizarHash: false });
  });
})();
