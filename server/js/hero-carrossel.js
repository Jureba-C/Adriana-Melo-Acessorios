(function(){
  "use strict";

  const semMovimento = window.matchMedia("(prefers-reduced-motion: reduce)");

  const raiz = document.getElementById("heroCarrossel");
  const pista = raiz && raiz.querySelector(".hero-slides");
  const modelo = raiz && raiz.querySelector("#heroSlidesExtras");
  const extras = modelo ? [...modelo.content.querySelectorAll(".hero-slide")] : [];

  if(raiz && pista && extras.length){
    const INTERVALO = 5000;
    const caixaPontos = raiz.querySelector(".hero-pontos");
    const pausa = raiz.querySelector(".hero-pausa");
    const vivo = raiz.querySelector(".hero-vivo");
    const slides = [...pista.children];
    const pontos = [];
    const total = 1 + extras.length;
    let atual = 0, timer = null, travado = false, perto = false, visivel = false;

    raiz.setAttribute("aria-roledescription", "carrossel");
    slides[0].setAttribute("role", "group");
    slides[0].setAttribute("aria-roledescription", "slide");
    slides[0].setAttribute("aria-label", `1 de ${total}`);

    function materializar(i){
      while(slides.length <= i && slides.length < total){
        const no = extras[slides.length - 1].cloneNode(true);
        no.setAttribute("role", "group");
        no.setAttribute("aria-roledescription", "slide");
        no.setAttribute("aria-label", `${slides.length + 1} de ${total}`);
        pista.appendChild(no);
        slides.push(no);
        const img = no.querySelector("img");
        if(img && img.decode) img.decode().catch(() => {});
      }
    }

    function mostrar(i, anunciar){
      atual = (i + total) % total;
      materializar(atual);
      slides.forEach((s, n) => s.classList.toggle("is-ativa", n === atual));
      pontos.forEach((p, n) => p.setAttribute("aria-current", n === atual ? "true" : "false"));
      materializar(atual + 1);
      if(anunciar && vivo) vivo.textContent = `Foto ${atual + 1} de ${total}: ${slides[atual].dataset.legenda || ""}`;
    }

    function reiniciar(){
      clearInterval(timer);
      timer = null;
      if(visivel && !travado && !perto && !semMovimento.matches){
        timer = setInterval(() => mostrar(atual + 1, false), INTERVALO);
      }
    }

    for(let i = 0; i < total; i++){
      const ponto = document.createElement("button");
      ponto.type = "button";
      ponto.className = "hero-ponto";
      ponto.setAttribute("aria-label", `Foto ${i + 1} de ${total}`);
      ponto.setAttribute("aria-current", i === 0 ? "true" : "false");
      ponto.addEventListener("click", () => { mostrar(i, true); reiniciar(); });
      caixaPontos.appendChild(ponto);
      pontos.push(ponto);
    }

    if(!semMovimento.matches){
      pausa.hidden = false;
      pausa.addEventListener("click", () => {
        travado = !travado;
        pausa.classList.toggle("is-pausado", travado);
        pausa.setAttribute("aria-pressed", String(travado));
        pausa.setAttribute("aria-label", travado ? "Retomar a troca das fotos" : "Pausar a troca das fotos");
        reiniciar();
      });
    }

    raiz.addEventListener("pointerenter", () => { perto = true; reiniciar(); });
    raiz.addEventListener("pointerleave", () => { perto = false; reiniciar(); });
    raiz.addEventListener("focusin", () => { perto = true; reiniciar(); });
    raiz.addEventListener("focusout", (e) => {
      if(!raiz.contains(e.relatedTarget)){ perto = false; reiniciar(); }
    });
    raiz.addEventListener("keydown", (e) => {
      if(e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      mostrar(atual + (e.key === "ArrowRight" ? 1 : -1), true);
      pontos[atual].focus();
      reiniciar();
    });

    let toqueX = null;
    pista.addEventListener("touchstart", (e) => { toqueX = e.touches[0].clientX; }, { passive: true });
    pista.addEventListener("touchend", (e) => {
      if(toqueX === null) return;
      const dx = e.changedTouches[0].clientX - toqueX;
      toqueX = null;
      if(Math.abs(dx) < 45) return;
      mostrar(atual + (dx < 0 ? 1 : -1), true);
      reiniciar();
    }, { passive: true });

    new IntersectionObserver((entradas) => {
      visivel = entradas[0].isIntersecting;
      if(visivel) materializar(1);
      reiniciar();
    }, { threshold: 0.25 }).observe(raiz);

    semMovimento.addEventListener("change", reiniciar);
    document.addEventListener("visibilitychange", () => {
      if(document.hidden) visivel = false;
      reiniciar();
    });
  }

  const etiqueta = document.querySelector(".hero-stats");
  const numeros = etiqueta ? [...etiqueta.querySelectorAll("[data-contar]")] : [];
  if(!numeros.length || semMovimento.matches) return;

  function formatar(el, valor){
    const casas = Number(el.dataset.casas) || 0;
    const texto = valor.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
    return `${el.dataset.prefixo || ""}${texto}${el.dataset.sufixo || ""}`;
  }

  new IntersectionObserver((entradas, observador) => {
    if(!entradas[0].isIntersecting) return;
    observador.disconnect();
    numeros.forEach((el) => {
      const final = el.textContent;
      const alvo = Number(el.dataset.contar) || 0;
      const casas = Number(el.dataset.casas) || 0;
      const inicio = performance.now();
      const passo = (agora) => {
        const t = Math.min(1, (agora - inicio) / 1200);
        const suave = 1 - Math.pow(1 - t, 3);
        el.textContent = formatar(el, casas ? alvo * suave : Math.round(alvo * suave));
        if(t < 1) requestAnimationFrame(passo);
        else el.textContent = final;
      };
      requestAnimationFrame(passo);
    });
  }, { threshold: 0.4 }).observe(etiqueta);
})();
