(function(){
  "use strict";

  const INTERVALO = 5000;
  const SAIDA = 600;

  const faixa = document.getElementById("faixaPromo");
  if(!faixa) return;

  const telaPromo = faixa.querySelector(".faixa-promo-slide");
  const telaCupom = document.getElementById("faixaPromoCupom");
  const laco = faixa.querySelector(".faixa-promo-laco");
  if(!telaPromo || !telaCupom) return;

  function ligar(){
    const api = window.PLCCupomToast;
    if(!api) return;

    telaCupom.addEventListener("click", () => api.abrir());

    const telas = [telaPromo, telaCupom];
    let atual = 0;
    let relogio = null;
    let limpeza = null;

    function trocar(){
      const saindo = telas[atual];
      atual = (atual + 1) % telas.length;
      const entrando = telas[atual];

      entrando.classList.remove("esta-saindo");
      entrando.hidden = false;
      void entrando.offsetWidth;

      saindo.classList.remove("is-ativa");
      saindo.classList.add("esta-saindo");
      entrando.classList.add("is-ativa");

      if(laco){
        laco.classList.remove("esta-pulsando");
        void laco.offsetWidth;
        laco.classList.add("esta-pulsando");
      }

      clearTimeout(limpeza);
      limpeza = setTimeout(() => {
        saindo.classList.remove("esta-saindo");
        saindo.hidden = true;
      }, SAIDA);
    }

    function rodar(){
      if(relogio) return;
      relogio = setInterval(trocar, INTERVALO);
    }
    function pausar(){
      clearInterval(relogio);
      relogio = null;
    }

    faixa.addEventListener("mouseenter", pausar);
    faixa.addEventListener("mouseleave", rodar);
    faixa.addEventListener("focusin", pausar);
    faixa.addEventListener("focusout", rodar);
    document.addEventListener("visibilitychange", () => {
      if(document.hidden) pausar(); else rodar();
    });

    document.addEventListener("plc:cupom-assinado", () => {
      pausar();
      clearTimeout(limpeza);
      telas.forEach(t => t.classList.remove("is-ativa", "esta-saindo"));
      telaCupom.hidden = true;
      telaPromo.hidden = false;
      telaPromo.classList.add("is-ativa");
    }, { once: true });

    rodar();
  }

  if(window.PLCCupomToast) ligar();
  else document.addEventListener("plc:cupom-toast-pronto", ligar, { once: true });
})();
