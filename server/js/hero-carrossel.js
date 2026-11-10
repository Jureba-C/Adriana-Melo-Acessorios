(function(){
  "use strict";

  const semMovimento = window.matchMedia("(prefers-reduced-motion: reduce)");

  const raiz = document.getElementById("heroCarrossel");
  const pista = raiz && raiz.querySelector(".hero-slides");
  const modelo = raiz && raiz.querySelector("#heroSlidesExtras");
  const extras = modelo ? [...modelo.content.querySelectorAll(".hero-slide")] : [];
  const inicial = raiz && raiz.querySelector(".is-inicial");
  if(inicial) setTimeout(() => inicial.classList.remove("is-inicial"), 2600);

  if(raiz && pista && extras.length){
    const INTERVALO = 3500;
    const caixaPontos = raiz.querySelector(".hero-pontos");
    const pausa = raiz.querySelector(".hero-pausa");
    const vivo = raiz.querySelector(".hero-vivo");
    const slides = [...pista.children];
    const pontos = [];
    const total = 1 + extras.length;
    const TROCA_MEIO = 480, TROCA_TOTAL = 1000;
    const fita = raiz.querySelector(".banner-puxada");
    let atual = 0, timer = null, travado = false, perto = false, visivel = false, troca = 0, inicioTroca = 0;

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

    function aplicar(){
      slides.forEach((s, n) => { s.classList.toggle("is-ativa", n === atual); s.classList.remove("is-inicial"); });
    }

    function mostrar(i, anunciar){
      atual = (i + total) % total;
      materializar(atual);
      pontos.forEach((p, n) => p.setAttribute("aria-current", n === atual ? "true" : "false"));
      materializar(atual + 1);
      if(anunciar && vivo) vivo.textContent = `Destaque ${atual + 1} de ${total}: ${slides[atual].dataset.legenda || ""}`;
      if(!fita || !visivel || semMovimento.matches){ aplicar(); return; }
      if(raiz.classList.contains("is-trocando")){
        const resta = TROCA_MEIO - (performance.now() - inicioTroca);
        clearTimeout(troca);
        if(resta <= 0) aplicar();
        else troca = setTimeout(aplicar, resta);
        return;
      }
      if(slides[atual].classList.contains("is-ativa")) return;
      inicioTroca = performance.now();
      raiz.classList.add("is-trocando");
      troca = setTimeout(aplicar, TROCA_MEIO);
      setTimeout(() => raiz.classList.remove("is-trocando"), TROCA_TOTAL);
    }

    function reiniciar(){
      clearInterval(timer);
      timer = null;
      const ativo = visivel && !travado && !perto && !semMovimento.matches;
      raiz.classList.toggle("is-fora", !visivel);
      raiz.classList.toggle("is-parado", !ativo);
      if(ativo){
        timer = setInterval(() => mostrar(atual + 1, false), INTERVALO);
        pontos[atual].getAnimations({ subtree: true }).forEach((a) => { a.cancel(); a.play(); });
      }
    }

    for(let i = 0; i < total; i++){
      const ponto = document.createElement("button");
      ponto.type = "button";
      ponto.className = "hero-ponto";
      ponto.setAttribute("aria-label", `Destaque ${i + 1} de ${total}`);
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
        pausa.setAttribute("aria-label", travado ? "Retomar a troca dos destaques" : "Pausar a troca dos destaques");
        reiniciar();
      });
    }

    [[".banner-anterior", -1], [".banner-proximo", 1]].forEach(([seletor, passo]) => {
      const seta = raiz.querySelector(seletor);
      if(!seta) return;
      seta.hidden = false;
      seta.addEventListener("click", () => { mostrar(atual + passo, true); reiniciar(); });
    });

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

    if(window.matchMedia("(hover: hover) and (pointer: fine)").matches && !semMovimento.matches){
      let quadro = 0, alvoX = 0, alvoY = 0;
      raiz.addEventListener("pointermove", (e) => {
        const r = raiz.getBoundingClientRect();
        alvoX = ((e.clientX - r.left) / r.width - .5) * 2;
        alvoY = ((e.clientY - r.top) / r.height - .5) * 2;
        if(quadro) return;
        quadro = requestAnimationFrame(() => {
          quadro = 0;
          raiz.style.setProperty("--px", alvoX.toFixed(3));
          raiz.style.setProperty("--py", alvoY.toFixed(3));
        });
      });
      raiz.addEventListener("pointerleave", () => {
        raiz.style.setProperty("--px", "0");
        raiz.style.setProperty("--py", "0");
      });
    }

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

  const etiqueta = document.querySelector(".vantagens");
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
