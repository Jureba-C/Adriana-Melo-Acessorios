(function(){
  "use strict";

  const MENSAGEM_PADRAO = "Achei esse ateliê de laços feitos à mão e amei 🎀";

  function comUtm(url, origem){
    const u = new URL(url, window.location.origin);
    u.searchParams.set("utm_source", origem);
    u.searchParams.set("utm_medium", "social");
    u.searchParams.set("utm_campaign", "compartilhar");
    return u.toString();
  }

  function enderecoDe(bloco){
    return bloco.dataset.shareUrl || window.location.origin + "/";
  }

  function mensagemDe(bloco){
    return bloco.dataset.shareText || MENSAGEM_PADRAO;
  }

  function montarLinks(base, mensagem){
    return {
      whatsapp: `https://api.whatsapp.com/send?text=${encodeURIComponent(`${mensagem} ${comUtm(base, "whatsapp")}`)}`,
      facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(comUtm(base, "facebook"))}`,
      pinterest: `https://pinterest.com/pin/create/button/?url=${encodeURIComponent(comUtm(base, "pinterest"))}&description=${encodeURIComponent(mensagem)}`,
      telegram: `https://t.me/share/url?url=${encodeURIComponent(comUtm(base, "telegram"))}&text=${encodeURIComponent(mensagem)}`,
    };
  }

  function atualizar(bloco){
    if(!bloco) return;
    const links = montarLinks(enderecoDe(bloco), mensagemDe(bloco));
    bloco.querySelectorAll("[data-share]").forEach((el) => {
      const destino = links[el.dataset.share];
      if(destino) el.href = destino;
    });
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

  function ligar(bloco){
    if(bloco.dataset.shareLigado) { atualizar(bloco); return; }
    bloco.dataset.shareLigado = "1";
    atualizar(bloco);

    const nativo = bloco.querySelector(".share-btn-native");
    if(nativo && navigator.share){
      nativo.hidden = false;
      nativo.addEventListener("click", async () => {
        try{
          await navigator.share({
            title: "Adriana Melo Acessórios",
            text: mensagemDe(bloco),
            url: comUtm(enderecoDe(bloco), "nativo"),
          });
        }catch(err){
          if(err.name !== "AbortError") console.warn("Falha ao compartilhar:", err);
        }
      });
    }

    const copiar = bloco.querySelector(".share-btn-copy");
    if(copiar){
      copiar.addEventListener("click", async () => {
        const endereco = comUtm(enderecoDe(bloco), "link");
        let copiou = false;
        try{
          await navigator.clipboard.writeText(endereco);
          copiou = true;
        }catch(err){
          console.warn("Área de transferência indisponível, tentando o modo antigo:", err);
          copiou = copiarPeloCampo(endereco);
        }
        const original = copiar.innerHTML;
        const estado = copiou
          ? { classe: "is-copied", icone: "bi-check2" }
          : { classe: "is-failed", icone: "bi-exclamation-triangle" };
        copiar.innerHTML = `<i class="bi ${estado.icone}"></i>`;
        copiar.classList.add(estado.classe);
        setTimeout(() => {
          copiar.innerHTML = original;
          copiar.classList.remove(estado.classe);
        }, 2000);
      });
    }
  }

  document.querySelectorAll(".share-block").forEach(ligar);

  window.PLCCompartilhar = { ligar, atualizar };
})();
