(function () {
  "use strict";
  if (!window.gsap) return;

  const mm = gsap.matchMedia();

  function carregarScrollTrigger() {
    return new Promise((resolve) => {
      if (window.ScrollTrigger) return resolve(true);
      const asset = document.getElementById("assetScrollTrigger");
      const script = document.createElement("script");
      script.src = asset ? asset.href : "js/vendor/ScrollTrigger.min.js";
      script.onload = () => resolve(!!window.ScrollTrigger);
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });
  }

  function quandoDerFolga(acao) {
    let feito = false;
    function uma() {
      if (feito) return;
      feito = true;
      window.removeEventListener("scroll", uma);
      window.removeEventListener("pointerdown", uma);
      acao();
    }
    window.addEventListener("scroll", uma, { once: true, passive: true });
    window.addEventListener("pointerdown", uma, { once: true, passive: true });
    if ("requestIdleCallback" in window) requestIdleCallback(uma, { timeout: 2500 });
    else setTimeout(uma, 1200);
  }

  function fontesProntas() {
    if (!document.fonts || !document.fonts.ready) return Promise.resolve();
    return Promise.race([
      document.fonts.ready,
      new Promise((r) => setTimeout(r, 600)),
    ]);
  }

  function criarBlocoDeMarcador(titulo) {
    const bloco = document.createElement("span");
    bloco.className = "hero-bloco";
    bloco.setAttribute("aria-hidden", "true");
    titulo.insertBefore(bloco, titulo.firstChild);
    return bloco;
  }

  function entradaDoTitulo(titulo, split) {
    const palavras = split.words;
    const destaque = titulo.querySelector("em");
    const linha = gsap.timeline();

    gsap.set(titulo, { opacity: 1 });

    const podeMarcarTexto = destaque && destaque.getClientRects().length === 1;
    let bloco = null;
    let larguraFinal = 0;

    if (podeMarcarTexto) {
      const CORPO = parseFloat(getComputedStyle(titulo).fontSize) || 16;
      const recuo = 0.2 * CORPO + 0.04 * CORPO;
      const a = destaque.getBoundingClientRect();
      const t = titulo.getBoundingClientRect();
      larguraFinal = a.width;
      bloco = criarBlocoDeMarcador(titulo);
      titulo.classList.add("esta-digitando");
      gsap.set(bloco, {
        left: a.left - t.left, top: a.top - t.top + recuo,
        width: 0, height: a.height - recuo,
        backgroundColor: "var(--blush-150)", opacity: 1,
      });
    }

    gsap.set(palavras, { opacity: 0, y: 14 });

    const duracaoPalavras = 0.5;
    const staggerPalavras = 0.055;
    linha.to(palavras, {
      opacity: 1, y: 0, duration: duracaoPalavras, stagger: staggerPalavras, ease: "power3.out",
    }, 0);

    if (bloco) {
      const inicioDoTraco = duracaoPalavras + staggerPalavras * (palavras.length - 1) - 0.25;
      linha.to(bloco, { width: larguraFinal, duration: 0.4, ease: "power2.inOut" }, Math.max(inicioDoTraco, 0));
      linha.call(() => {
        titulo.classList.remove("esta-digitando");
        bloco.remove();
        split.revert();
      });
    } else {
      linha.call(() => split.revert());
    }

    return linha;
  }

  function entradaDoHero() {
    const hero = document.querySelector(".hero");
    if (!hero) return;

    const titulo = hero.querySelector(".hero-title");
    const arte = hero.querySelector(".hero-art");
    const lacos = Array.from(hero.querySelectorAll(".hero-art .floaty"));
    const texto = [
      hero.querySelector(".hero-lead"),
      ...hero.querySelectorAll(".hero .d-flex.flex-wrap > *"),
      ...hero.querySelectorAll(".hero-stats > div"),
    ].filter(Boolean);

    if (titulo) gsap.set(titulo, { opacity: 0 });
    if (texto.length) gsap.set(texto, { opacity: 0, y: 18 });
    if (arte) gsap.set(arte, { opacity: 0, scale: 0.96 });
    if (lacos.length) gsap.set(lacos, { opacity: 0 });

    fontesProntas().then(() => {
      const tl = gsap.timeline({ defaults: { ease: "power3.out" } });

      let split = null;
      if (window.SplitText && titulo) {
        gsap.registerPlugin(SplitText);
        try {
          split = new SplitText(titulo, { type: "words" });
        } catch (e) {
          split = null;
        }
      }

      if (split && split.words.length) {
        tl.add(entradaDoTitulo(titulo, split), 0);
      } else if (titulo) {
        tl.to(titulo, { opacity: 1, duration: 0.8 });
      }

      if (arte) tl.to(arte, { opacity: 1, scale: 1, duration: 1.1 }, 0.15);
      if (texto.length) {
        tl.to(texto, { opacity: 1, y: 0, duration: 0.7, stagger: 0.07 }, 0.35);
      }
      if (lacos.length) {
        tl.to(lacos, { opacity: 1, duration: 0.6, stagger: 0.06 }, 0.5);
      }
    });
  }

  /* ⚠️ fromTo, NUNCA from. Com ScrollTrigger, o from() guarda o valor atual
     como destino e o refresh o relê depois de já ter zerado o elemento — o
     tween passa a animar de zero para zero. */
  function entradaDoRodape() {
    const rodape = document.querySelector(".plc-footer");
    if (!rodape) return;

    const colunas = gsap.utils.toArray(
      ".plc-footer-marca, .plc-footer-col, .plc-footer-pagamento"
    );
    if (colunas.length) {
      gsap.fromTo(colunas,
        { opacity: 0, y: 22 },
        {
          opacity: 1, y: 0, duration: 0.6, stagger: 0.08, ease: "power2.out",
          onComplete() { gsap.set(this.targets(), { clearProps: "opacity,transform" }); },
          scrollTrigger: { trigger: rodape, start: "top 88%" },
        }
      );
    }

    const selos = gsap.utils.toArray(".pay-logo-badge");
    if (selos.length) {
      gsap.fromTo(selos,
        { opacity: 0, y: 10, scale: 0.94 },
        {
          opacity: 1, y: 0, scale: 1, duration: 0.45, stagger: 0.045,
          ease: "back.out(1.6)", delay: 0.15,
          onComplete() { gsap.set(this.targets(), { clearProps: "opacity,transform" }); },
          scrollTrigger: { trigger: ".plc-footer-pagamento", start: "top 92%" },
        }
      );
    }
  }

  const TITULOS = "#colecoes h2, #historia h2, #sobre h2, #depoimentos h2, #contato h2";

  function entradaDosTitulos() {
    const titulos = gsap.utils.toArray(TITULOS);
    if (!titulos.length) return;
    if (window.SplitText) gsap.registerPlugin(SplitText);

    titulos.forEach((titulo) => {
      let split = null;
      if (window.SplitText) {
        try {
          split = new SplitText(titulo, { type: "words" });
        } catch (e) {
          split = null;
        }
      }
      const alvos = split && split.words.length ? split.words : [titulo];

      gsap.fromTo(alvos,
        { opacity: 0, y: 20 },
        {
          opacity: 1, y: 0, duration: 0.6, stagger: 0.045, ease: "power3.out",
          onComplete() {
            if (split) split.revert();
            else gsap.set(this.targets(), { clearProps: "opacity,transform" });
          },
          scrollTrigger: { trigger: titulo, start: "top 88%" },
        }
      );
    });
  }

  /* ⚠️ Cada alvo aqui foi escolhido por NÃO ter transform próprio no CSS —
     dois donos do mesmo transform se cancelam. Não use .hero-photo-wrap: ela
     tem translate(-50%,-50%) fixo. */
  function camadasComParallax() {
    const camadas = [
      [".hero-flutuantes", 90],
      ["#historia .instagram-feed-card", -46],
    ];

    camadas.forEach(([seletor, distancia]) => {
      const alvos = gsap.utils.toArray(seletor);
      if (!alvos.length) return;
      gsap.fromTo(alvos,
        { y: -distancia / 2 },
        {
          y: distancia / 2,
          ease: "none",
          scrollTrigger: {
            trigger: alvos[0].closest("section, header") || alvos[0],
            start: "top bottom",
            end: "bottom top",
            scrub: true,
            invalidateOnRefresh: true,
          },
        }
      );
    });
  }

  function fitaGuia() {
    const fita = document.querySelector(".fita-guia");
    if (!fita) return;

    const fio = fita.querySelector(".fita-guia-fio");
    const laco = fita.querySelector(".fita-guia-laco");
    const AMOSTRAS = 240;
    let comprimento = 0, comprimentoNaTela = 0, tabelaDeTela = null;

    /* ⚠️ O tracejado é medido em px de TELA (efeito do
       vector-effect:non-scaling-stroke), e getTotalLength devolve unidades do
       viewBox — 1008 contra ~880px reais. Sem esta tabela o rosa terminava
       aos 87% e o laço seguia sozinho. */
    function medir() {
      if (!fio || !fio.getTotalLength) return;
      comprimento = fio.getTotalLength();
      const ctm = fio.getScreenCTM();
      tabelaDeTela = new Float64Array(AMOSTRAS + 1);
      let acumulado = 0, anterior = null;
      for (let i = 0; i <= AMOSTRAS; i++) {
        const ponto = fio.getPointAtLength((comprimento * i) / AMOSTRAS);
        const naTela = ctm ? ponto.matrixTransform(ctm) : ponto;
        if (anterior) acumulado += Math.hypot(naTela.x - anterior.x, naTela.y - anterior.y);
        tabelaDeTela[i] = acumulado;
        anterior = naTela;
      }
      comprimentoNaTela = acumulado || comprimento;
      gsap.set(fio, { strokeDasharray: comprimentoNaTela, strokeDashoffset: comprimentoNaTela });
    }

    function telaAte(pr) {
      if (!tabelaDeTela) return comprimentoNaTela * pr;
      const pos = Math.min(Math.max(pr, 0), 1) * AMOSTRAS;
      const i = Math.floor(pos);
      if (i >= AMOSTRAS) return tabelaDeTela[AMOSTRAS];
      return tabelaDeTela[i] + (tabelaDeTela[i + 1] - tabelaDeTela[i]) * (pos - i);
    }
    medir();

    return ScrollTrigger.create({
      start: 0,
      end: () => ScrollTrigger.maxScroll(window),
      scrub: true,
      invalidateOnRefresh: true,
      onRefresh: medir,
      onUpdate(self) {
        const p = self.progress;
        fita.style.setProperty("--progresso", p.toFixed(4));
        if (fio && comprimentoNaTela) {
          fio.style.strokeDashoffset = String(comprimentoNaTela - telaAte(p));
          if (laco && fio.getPointAtLength) {
            const ponto = fio.getPointAtLength(comprimento * p);
            laco.style.top = (ponto.y / 1000) * 100 + "%";
            /* ⚠️ Na faixa estreita do celular o laço não cavalga a onda: seguir
               o x jogaria a ponta dele sobre a primeira letra da página. */
            if (fita.clientWidth > 20) {
              laco.style.left = (ponto.x / 60) * 100 + "%";
            } else if (laco.style.left) {
              laco.style.left = "";
            }
          }
        }
      },
    });
  }

  function entregaGuiada({ comTrava = false } = {}) {
    const wrap = document.querySelector(".process-wrap");
    const passos = gsap.utils.toArray("#sobre .process-step");
    if (!wrap || passos.length < 3) return;

    const van = document.querySelector(".process-truck");
    const pacote = document.getElementById("processPackage");
    const visivel = (el) => el && getComputedStyle(el).display !== "none";
    const movel = visivel(van) ? van : pacote;
    if (!visivel(movel)) return;

    const ehVan = movel === van;
    const CHEGADA = ehVan ? 0.1 : 0.3;
    movel.classList.add("is-guiada");

    /* ⚠️ offsetLeft/offsetTop, não getBoundingClientRect: o rect devolve a
       posição ANIMADA e estes ícones nunca param de flutuar — dava alvo errado
       por 25-30px. Somar a cadeia de offsetParent porque .process-wrap é um
       .row do Bootstrap, com margem negativa. */
    function centroDoPasso(passo) {
      const icone = passo.querySelector(".process-icon-wrap") || passo;
      const pai = movel.offsetParent;
      let x = 0, y = 0, n = icone;
      while (n && n !== pai) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
      return { x: x + icone.offsetWidth / 2, y: y + icone.offsetHeight / 2 };
    }
    const partida = () => wrap.getBoundingClientRect().width * 0.14;

    const secao = document.getElementById("sobre");
    const caixa = secao && secao.querySelector(":scope > .sobre-caixa");
    const trava = comTrava && caixa;
    const RAMPA = 0.25;
    const PAUSA = 0.5;

    /* ⚠️ Quem segura a seção parada é o pin (fixed: o navegador mantém, não
       treme). A caixa de dentro só faz a entrada e a saída, sem scrub
       amortecido — com atraso, a página subia na hora e a caixa voltava
       depois: a tela "pulava". A derivada desta curva vai de 0 a 1 na
       entrada, é 0 durante o pin e volta de 1 a 0 na saída; casada com o pin,
       a velocidade na tela nunca salta. */
    function rampaComPausa(r) {
      const sobe = (u) => (u - Math.sin(Math.PI * u) / Math.PI) / 2;
      const desce = (v) => (v + Math.sin(Math.PI * v) / Math.PI) / 2;
      return (t) => {
        if (t < r) return sobe(t / r);
        if (t <= 1 - r) return 0.5;
        return 0.5 + desce((t - (1 - r)) / r);
      };
    }

    let parada;

    /* ⚠️ Precisa ser passado na CRIAÇÃO do gatilho: o ScrollTrigger guarda a
       referência agora, e atribuir vars.onUpdate depois não faz nada — em
       silêncio. */
    function acender(progresso) {
      const naVez = Math.min(
        Math.floor(progresso * (passos.length - 1) + CHEGADA),
        passos.length - 1
      );
      passos.forEach((passo, i) => passo.classList.toggle("is-na-vez", i === naVez));
    }

    function aCadaQuadro(self) {
      movel.classList.add("is-andando");
      clearTimeout(parada);
      parada = setTimeout(() => movel.classList.remove("is-andando"), 120);
      acender(self.progress);
    }

    const gatilho = {
      trigger: wrap,
      scrub: 0.6,
      invalidateOnRefresh: true,
      refreshPriority: 1,
      onUpdate: aCadaQuadro,
      onRefresh: (self) => acender(self.progress),
    };

    if (trava) {
      /* ⚠️ Números absolutos, por offsetTop: a caixa se move, e o
         ScrollTrigger mediria o gatilho já deslocado. Sem anticipatePin: ele
         prende antes da hora, com a caixa ainda freando, e ela dá um tranco
         de ~10px ao entrar na trava pelos dois lados. */
      const tela = () => window.innerHeight;
      const topoNoDocumento = (el) => { let y = 0; for (let n = el; n; n = n.offsetParent) y += n.offsetTop; return y; };
      const inicio = () => topoNoDocumento(caixa) + caixa.offsetHeight / 2 + tela() * RAMPA / 2 - tela() / 2;
      gatilho.trigger = secao;
      gatilho.start = () => inicio();
      gatilho.end = () => inicio() + tela() * PAUSA;
      gatilho.pin = true;
      gsap.set(secao, { paddingBottom: `${RAMPA * 100}vh` });
    } else if (ehVan) {
      const linha = () => centroDoPasso(passos[0]).y;
      gatilho.start = () => `top+=${linha()} 80%`;
      gatilho.end = () => `top+=${linha()} 30%`;
    } else {
      /* ⚠️ Preso aos ícones, não à seção: com "top 80%" a parada no passo 1
         caía com o ícone ainda abaixo da tela e o pacote sumia antes de ele
         aparecer. Assim cada parada acontece com o seu ícone a 60% da tela. */
      gatilho.start = () => `top+=${centroDoPasso(passos[0]).y} 60%`;
      gatilho.end = () => `top+=${centroDoPasso(passos[2]).y} 60%`;
    }

    const tl = gsap.timeline({ scrollTrigger: gatilho });

    if (trava) {
      gsap.fromTo(caixa, { y: 0 }, {
        y: () => window.innerHeight * RAMPA,
        ease: rampaComPausa(RAMPA / (PAUSA + 2 * RAMPA)),
        scrollTrigger: {
          start: () => tl.scrollTrigger.start - window.innerHeight * RAMPA,
          end: () => tl.scrollTrigger.end + window.innerHeight * RAMPA,
          scrub: true,
          invalidateOnRefresh: true,
        },
      });
    }

    if (ehVan) {
      tl.fromTo(movel,
        { x: () => centroDoPasso(passos[0]).x - partida() },
        { x: () => centroDoPasso(passos[2]).x - partida(), ease: "none", duration: 1 }
      );
    } else {
      /* ⚠️ 68px à DIREITA do ícone, nunca no centro dele. Na altura de um
         ícone essa faixa está vazia; na linha do meio ficam todos os títulos,
         e o pacote parava em cima da palavra "Personalize". */
      const DESVIO_X = 68;
      const emX = (i) => centroDoPasso(passos[i]).x + DESVIO_X + "px";
      const emY = (i) => centroDoPasso(passos[i]).y + "px";
      tl.fromTo(movel,
        { left: () => emX(0), top: () => emY(0) },
        { left: () => emX(1), top: () => emY(1), ease: "none", duration: 1 }
      ).to(movel,
        { left: () => emX(2), top: () => emY(2), ease: "none", duration: 1 }
      );

      /* ⚠️ Só aparece PARADO. Entre um ícone e outro ele cruza o título e o
         parágrafo do passo, então some no caminho e volta na chegada — era o
         que o @keyframes antigo fazia com opacity:0, e que se perdeu quando o
         GSAP virou dono da posição. */
      tl.fromTo(movel,
        { opacity: 1 },
        { opacity: 0, duration: CHEGADA, ease: "none" }, 0
      ).to(movel, { opacity: 1, duration: CHEGADA, ease: "none" }, 1 - CHEGADA)
        .to(movel, { opacity: 0, duration: CHEGADA, ease: "none" }, 1)
        .to(movel, { opacity: 1, duration: CHEGADA, ease: "none" }, 2 - CHEGADA);
    }

    return tl;
  }

  /* ⚠️ Inclina os GRUPOS de dentro, não a faixa nem o track: o track já é dono
     do transform pelo keyframe scrollx, e inclinar o fundo abre um vão
     triangular nos cantos. */
  function marqueeReativo() {
    const grupos = gsap.utils.toArray(".plc-marquee-group");
    if (!grupos.length) return;

    const inclinar = gsap.quickTo(grupos, "skewY", { duration: 0.5, ease: "power3" });
    let parada;

    return ScrollTrigger.create({
      onUpdate(self) {
        inclinar(gsap.utils.clamp(-2.5, 2.5, self.getVelocity() / 900));
        clearTimeout(parada);
        parada = setTimeout(() => inclinar(0), 140);
      },
    });
  }

  let gatilhosDaVitrine = [];

  const DOBRA = 0.88;

  function entrarEmCascata(lote) {
    return gsap.to(lote, {
      opacity: 1,
      y: 0,
      duration: 0.65,
      stagger: 0.08,
      ease: "power2.out",
      overwrite: true,
      onComplete() {
        gsap.set(this.targets(), { clearProps: "opacity,transform" });
      },
    });
  }

  /* ⚠️ A grade de produtos chega depois, por fetch, e tem ~1800px. Os
     refresh() do fim do arquivo rodam no load e no fonts.ready, que podem
     acontecer antes dela existir — e aí todo gatilho abaixo fica medido numa
     página sem produtos. O setTimeout evita refresh reentrante e agrupa as
     chamadas (vitrine:render dispara a cada tecla da busca). */
  let remedidaPendente;
  function remedirGatilhos() {
    clearTimeout(remedidaPendente);
    remedidaPendente = setTimeout(() => ScrollTrigger.refresh(), 200);
  }

  function animarVitrine() {
    gatilhosDaVitrine = gatilhosDaVitrine.filter((st) => {
      if (st.trigger && st.trigger.isConnected) return true;
      st.kill();
      return false;
    });

    const grid = document.getElementById("productsGrid");
    if (!grid) return;
    const cards = gsap.utils.toArray(grid.querySelectorAll(".reveal:not(.is-visible)"));
    if (!cards.length) { remedirGatilhos(); return; }

    cards.forEach((el) =>
      el.classList.remove("reveal", "reveal-delay-1", "reveal-delay-2", "reveal-delay-3")
    );
    gsap.set(cards, { opacity: 0, y: 28 });

    const limite = window.innerHeight * DOBRA;
    const agora = [];
    const depois = [];
    cards.forEach((el) => {
      (el.getBoundingClientRect().top < limite ? agora : depois).push(el);
    });

    remedirGatilhos();

    if (agora.length) entrarEmCascata(agora);
    if (depois.length) {
      gatilhosDaVitrine = gatilhosDaVitrine.concat(
        ScrollTrigger.batch(depois, {
          start: "top " + Math.round(DOBRA * 100) + "%",
          refreshPriority: -3,
          onEnter: entrarEmCascata,
        })
      );
    }
  }

  function entradaDoHeroSemMovimento() {
    const hero = document.querySelector(".hero");
    if (!hero) return;
    const titulo = hero.querySelector(".hero-title");
    const arte = hero.querySelector(".hero-art");
    const lacos = hero.querySelectorAll(".hero-art .floaty");
    const texto = [
      hero.querySelector(".hero-lead"),
      ...hero.querySelectorAll(".hero .d-flex.flex-wrap > *"),
      ...hero.querySelectorAll(".hero-stats > div"),
    ].filter(Boolean);
    gsap.set([titulo, arte, ...lacos, ...texto].filter(Boolean), { clearProps: "opacity,transform" });
  }

  mm.add("(prefers-reduced-motion: no-preference)", () => {
    entradaDoHero();
  });
  mm.add("(prefers-reduced-motion: reduce)", () => {
    entradaDoHeroSemMovimento();
  });

  function fitaDasGarantias({ animar }) {
    const grade = document.querySelector(".garantias");
    const cartoes = grade ? Array.from(grade.querySelectorAll(".garantia")) : [];
    if (cartoes.length < 2 || !("ResizeObserver" in window)) return;

    const NS = "http://www.w3.org/2000/svg";
    const FORA = 24;
    const ONDA = 12;
    const MEIO_LACO = 21;
    const LINHA_DO_LACO = 0.6;

    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "fita-garantias");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const base = document.createElementNS(NS, "path");
    base.setAttribute("class", "fita-garantias-base");
    svg.append(base);

    const laco = document.createElementNS(NS, "svg");
    laco.setAttribute("class", "fita-garantias-laco");
    laco.setAttribute("aria-hidden", "true");
    laco.setAttribute("focusable", "false");
    laco.setAttribute("viewBox", "0 0 100 70");
    const uso = document.createElementNS(NS, "use");
    uso.setAttribute("href", "#bow-shape");
    laco.append(uso);

    grade.prepend(svg);
    grade.append(laco);

    function centro(el) {
      let x = el.offsetWidth / 2, y = el.offsetHeight / 2;
      for (let n = el; n && n !== grade; n = n.offsetParent) { x += n.offsetLeft; y += n.offsetTop; }
      return { x, y };
    }

    let umaColuna = false;
    let limites = { min: -Infinity, max: Infinity };

    function pontos() {
      const W = grade.clientWidth, H = grade.clientHeight;
      const r = grade.getBoundingClientRect();
      const folgaEsq = Math.max(0, r.left), folgaDir = Math.max(0, window.innerWidth - r.right);
      const foraEsq = Math.max(0, Math.min(FORA, folgaEsq - MEIO_LACO));
      const foraDir = Math.max(0, Math.min(FORA, folgaDir - MEIO_LACO));
      limites = { min: -Math.max(0, folgaEsq - 4), max: W + Math.max(0, folgaDir - 4) };

      const icones = cartoes.map((c, i) => ({ p: centro(c.querySelector(".garantia-icone")), i }));
      const linhas = [];
      icones.forEach((it) => {
        const linha = linhas.find((l) => Math.abs(l.y - it.p.y) < 8);
        if (linha) linha.itens.push(it); else linhas.push({ y: it.p.y, itens: [it] });
      });
      linhas.sort((a, b) => a.y - b.y);
      linhas.forEach((l, n) => { l.itens.sort((a, b) => a.p.x - b.p.x); if (n % 2) l.itens.reverse(); });
      umaColuna = linhas.every((l) => l.itens.length === 1);

      const pts = [], paradas = [];
      const poe = (p, cartao) => { if (cartao !== undefined) paradas.push({ indice: pts.length, cartao }); pts.push(p); };

      if (umaColuna) {
        const itens = linhas.map((l) => l.itens[0]);
        poe({ x: itens[0].p.x, y: -FORA });
        itens.forEach((it, k) => {
          if (k > 0) {
            const a = itens[k - 1].p;
            poe({ x: (a.x + it.p.x) / 2 + (k % 2 ? ONDA : -ONDA), y: (a.y + it.p.y) / 2 });
          }
          poe(it.p, it.i);
        });
        poe({ x: itens[itens.length - 1].p.x, y: H + FORA });
      } else {
        linhas.forEach((l, n) => {
          const indo = n % 2 === 0;
          poe({ x: indo ? -foraEsq : W + foraDir, y: l.y });
          l.itens.forEach((it, k) => {
            if (k > 0) {
              const a = l.itens[k - 1].p;
              poe({ x: (a.x + it.p.x) / 2, y: (a.y + it.p.y) / 2 + (k % 2 ? ONDA : -ONDA) });
            }
            poe(it.p, it.i);
          });
          poe({ x: indo ? W + foraDir : -foraEsq, y: l.y });
        });
      }
      return { pts, paradas };
    }

    /* ⚠️ Os pontos de controle ficam presos dentro da tela: uma Bézier nunca
       sai da área dos seus pontos de controle, e sem isso a volta do tablet
       passava da borda e aparecia cortada. */
    function trechos(pts) {
      const x = (v) => Math.max(limites.min, Math.min(limites.max, v));
      const out = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
        const c1x = x(p1.x + (p2.x - p0.x) / 6), c1y = p1.y + (p2.y - p0.y) / 6;
        const c2x = x(p2.x - (p3.x - p1.x) / 6), c2y = p2.y - (p3.y - p1.y) / 6;
        out.push(`C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`);
      }
      return out;
    }

    let comprimento = 0, marcas = [], alturas = null, tocou = false, tl = null;

    function aplicarAte(ate) {
      const s = comprimento ? ate / comprimento : 0;
      const resto = String(comprimento - ate);
      base.style.strokeDashoffset = resto;
      const p = base.getPointAtLength(Math.max(0, Math.min(comprimento, ate)));
      gsap.set(laco, { x: p.x, y: p.y, xPercent: -50, yPercent: -50, rotation: s < 1 ? Math.sin(s * 14) * 10 : 0 });
      marcas.forEach(({ px, cartao }) => { if (ate >= px - 1) cartoes[cartao].classList.add("is-atada"); });
    }

    function comprimentoNaAltura(y) {
      if (!alturas) return 0;
      if (y <= alturas[0].y) return 0;
      const ultima = alturas[alturas.length - 1];
      if (y >= ultima.y) return comprimento;
      let i = 1;
      while (alturas[i].y < y) i++;
      const a = alturas[i - 1], b = alturas[i];
      return a.len + (b.len - a.len) * ((y - a.y) / ((b.y - a.y) || 1));
    }

    function acompanharRolagem() {
      if (!animar || !umaColuna) return;
      const ate = comprimentoNaAltura(window.innerHeight * LINHA_DO_LACO - grade.getBoundingClientRect().top);
      gsap.set(laco, { opacity: ate > 0 ? 1 : 0 });
      aplicarAte(ate);
      if (ate >= comprimento) tocou = true;
    }

    function desenhar() {
      const W = grade.clientWidth, H = grade.clientHeight;
      svg.setAttribute("width", W);
      svg.setAttribute("height", H);
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      const { pts, paradas } = pontos();
      const partes = trechos(pts);
      const inicio = `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
      const d = [inicio, ...partes].join(" ");
      base.setAttribute("d", d);
      comprimento = base.getTotalLength();

      const regua = document.createElementNS(NS, "path");
      svg.append(regua);
      marcas = paradas.map(({ indice, cartao }) => {
        regua.setAttribute("d", [inicio, ...partes.slice(0, indice)].join(" "));
        return { px: indice ? regua.getTotalLength() : 0, cartao };
      });
      regua.remove();

      alturas = null;
      if (umaColuna) {
        alturas = [];
        for (let k = 0; k <= 160; k++) {
          const len = (comprimento * k) / 160;
          alturas.push({ len, y: base.getPointAtLength(len).y });
        }
      }

      base.style.strokeDasharray = String(comprimento);
      if (!animar || (tocou && !umaColuna)) {
        gsap.set(laco, { opacity: 1 });
        aplicarAte(comprimento);
      } else if (umaColuna) {
        acompanharRolagem();
      } else {
        base.style.strokeDashoffset = String(comprimento);
        gsap.set(laco, { opacity: 0 });
      }
    }

    function esperarEntrada() {
      const inicio = performance.now();
      return new Promise((pronto) => {
        (function checar() {
          const entraram = cartoes.every((c) => {
            const cs = getComputedStyle(c);
            return cs.opacity === "1" && cs.transform === "none";
          });
          if (entraram || performance.now() - inicio > 3000) return pronto();
          requestAnimationFrame(checar);
        })();
      });
    }

    function tocar() {
      if (tl || tocou || umaColuna) return;
      desenhar();
      const estado = { s: 0 };
      gsap.to(laco, { opacity: 1, duration: 0.25 });
      tl = gsap.to(estado, {
        s: 1,
        duration: 1.8,
        ease: "power1.inOut",
        onUpdate: () => aplicarAte(comprimento * estado.s),
        onComplete: () => { tocou = true; aplicarAte(comprimento); },
      });
    }

    let quadroDeTamanho = 0;
    function redesenhar() {
      if (quadroDeTamanho) return;
      quadroDeTamanho = requestAnimationFrame(() => {
        quadroDeTamanho = 0;
        if (tl && tl.isActive()) tl.progress(1);
        desenhar();
      });
    }

    desenhar();
    const ro = new ResizeObserver(redesenhar);
    ro.observe(grade);
    window.addEventListener("resize", redesenhar);

    let io = null, vista = null, quadroDeRolagem = 0, ouvindo = false;
    const aoRolar = () => {
      if (quadroDeRolagem) return;
      quadroDeRolagem = requestAnimationFrame(() => { quadroDeRolagem = 0; acompanharRolagem(); });
    };
    if (animar) {
      io = new IntersectionObserver((entradas) => {
        if (umaColuna || !entradas.some((e) => e.isIntersecting)) return;
        io.disconnect();
        esperarEntrada().then(tocar);
      }, { threshold: 0.35 });
      io.observe(grade);

      vista = new IntersectionObserver(([e]) => {
        if (e.isIntersecting && !ouvindo) {
          window.addEventListener("scroll", aoRolar, { passive: true });
          ouvindo = true;
        } else if (!e.isIntersecting && ouvindo) {
          window.removeEventListener("scroll", aoRolar);
          ouvindo = false;
        }
        aoRolar();
      }, { rootMargin: "25% 0px" });
      vista.observe(grade);
    }

    return () => {
      if (io) io.disconnect();
      if (vista) vista.disconnect();
      ro.disconnect();
      window.removeEventListener("resize", redesenhar);
      window.removeEventListener("scroll", aoRolar);
      cancelAnimationFrame(quadroDeRolagem);
      cancelAnimationFrame(quadroDeTamanho);
      if (tl) tl.kill();
      svg.remove();
      laco.remove();
      cartoes.forEach((c) => c.classList.remove("is-atada"));
    };
  }

  mm.add("(prefers-reduced-motion: no-preference)", () => fitaDasGarantias({ animar: true }));
  mm.add("(prefers-reduced-motion: reduce)", () => fitaDasGarantias({ animar: false }));

  function notaQueSobe(secao) {
    const alvo = secao.querySelector(".avaliacoes-resumo strong");
    const estrela = secao.querySelector(".avaliacoes-resumo i");
    if (!alvo) return;
    const final = Number(String(alvo.textContent).replace(",", "."));
    if (!Number.isFinite(final)) return;
    const contador = { v: 0 };
    const escrever = () => { alvo.textContent = contador.v.toFixed(1).replace(".", ","); };
    escrever();
    const tl = gsap.timeline({ scrollTrigger: { trigger: secao, start: "top 80%", once: true } });
    tl.to(contador, { v: final, duration: 1.2, ease: "power2.out", onUpdate: escrever, onComplete: () => { alvo.textContent = final.toFixed(1).replace(".", ","); } });
    if (estrela) tl.fromTo(estrela, { rotation: -180, scale: 0.3 }, { rotation: 0, scale: 1, duration: 0.9, ease: "back.out(2.2)" }, 0);
  }

  function estrelasAcendendo(card, atraso) {
    const estrelas = card.querySelectorAll(".avaliacao-estrelas i");
    if (!estrelas.length) return;
    gsap.fromTo(estrelas,
      { scale: 0, rotation: -120, opacity: 0 },
      { scale: 1, rotation: 0, opacity: 1, duration: 0.45, stagger: 0.07, delay: atraso, ease: "back.out(2.6)", clearProps: "transform,opacity" }
    );
  }

  function presenteDasAvaliacoes() {
    const secao = document.getElementById("avaliacoes");
    const grade = secao && secao.querySelector(".avaliacoes-grade");
    const cards = grade ? gsap.utils.toArray(".avaliacao-card", grade) : [];
    if (cards.length < 2) return null;

    const total = cards.length;
    const q = (seletor) => secao.querySelector(seletor);
    const controles = q(".avaliacoes-controles");
    const atualEl = q(".avaliacoes-contador-atual");
    const trilho = q(".avaliacoes-trilho-fita");
    const [setaAnterior, setaProxima] = [...secao.querySelectorAll(".avaliacoes-seta")];
    const fita = q(".presente-fita");
    const lacinho = q(".presente-lacinho");
    const camadaEnfeites = q(".avaliacoes-enfeites");
    const enfeites = [...secao.querySelectorAll(".avaliacoes-enfeite")];
    const lacinhoFitas = lacinho ? [...lacinho.querySelectorAll("path")] : [];
    const alcas = [q(".laco-alca-esq"), q(".laco-alca-dir")].filter(Boolean);
    const pontas = [q(".laco-ponta-esq"), q(".laco-ponta-dir")].filter(Boolean);
    const no = q(".laco-no");
    const brilhos = [...secao.querySelectorAll(".laco-brilho")];
    const dois = (n) => String(n).padStart(2, "0");
    const noCelular = () => window.matchMedia("(max-width: 767.98px)").matches;

    function topoFixo() {
      const nav = document.getElementById("mainNav");
      return nav ? Math.round(nav.getBoundingClientRect().bottom) : 0;
    }

    secao.style.setProperty("--topo-fixo", `${topoFixo()}px`);
    secao.classList.add("is-presente");
    if (controles) controles.hidden = false;
    notaQueSobe(secao);

    function peca(el, cx, cy) {
      const estado = { r: 0, s: 1, x: 0, y: 0, o: 0 };
      const aplicar = () => {
        el.setAttribute("transform", `translate(${cx + estado.x} ${cy + estado.y}) rotate(${estado.r}) scale(${Math.max(0.001, estado.s)}) translate(${-cx} ${-cy})`);
        el.style.opacity = estado.o;
      };
      aplicar();
      return { el, estado, aplicar };
    }
    const pAlcas = alcas.map((el) => peca(el, 120, 72));
    const pPontas = pontas.map((el, i) => peca(el, i ? 126 : 114, 80));
    const pNo = no ? [peca(no, 120, 72)] : [];
    const pBrilhos = brilhos.map((el) => peca(el, 120, 72));
    const todasAsPecas = [...pAlcas, ...pPontas, ...pNo, ...pBrilhos];
    const anima = (lista, de, para, extra = {}) => ({
      alvos: lista.map((p) => p.estado),
      de, para: { ...para, onUpdate: () => lista.forEach((p) => p.aplicar()), ...extra },
    });

    if (fita) gsap.set(fita, { clipPath: "inset(0% 50% 0% 50%)" });
    const amarrar = gsap.timeline({ scrollTrigger: { trigger: secao, start: "top 85%", once: true } });
    if (fita) amarrar.to(fita, { clipPath: "inset(0% 0% 0% 0%)", duration: 1.3, ease: "power2.inOut" });
    pAlcas.forEach((p, i) => {
      const m = anima([p], { s: 0.2, r: i ? 40 : -40, o: 0 }, { s: 1, r: 0, o: 1, duration: 0.75, ease: "back.out(1.7)" });
      amarrar.fromTo(m.alvos, m.de, m.para, i ? "<0.09" : "-=0.5");
    });
    if (pPontas.length) {
      const m = anima(pPontas, { y: -16, o: 0 }, { y: 0, o: 1, duration: 0.6, ease: "power3.out", stagger: 0.07 });
      amarrar.fromTo(m.alvos, m.de, m.para, "-=0.5");
    }
    if (pNo.length) {
      const m = anima(pNo, { s: 0.01, o: 0 }, { s: 1, o: 1, duration: 0.45, ease: "back.out(2.4)" });
      amarrar.fromTo(m.alvos, m.de, m.para, "-=0.35");
    }
    if (pBrilhos.length) {
      const m = anima(pBrilhos, { o: 0 }, { o: 1, duration: 0.5 });
      amarrar.fromTo(m.alvos, m.de, m.para, "-=0.2");
    }

    let balanco = null;
    let lacinhoTl = null;
    function formarLacinho() {
      if (!lacinho || !secao.classList.contains("is-amarrado")) return;
      if (lacinhoTl) lacinhoTl.kill();
      lacinhoTl = gsap.timeline()
        .set(lacinho, { opacity: 1, y: 8, rotation: -10, scale: 0.9 })
        .set(lacinhoFitas, { strokeDashoffset: 1 })
        .to(lacinhoFitas, { strokeDashoffset: 0, duration: 1.2, ease: "power2.inOut", stagger: 0.06 })
        .to(lacinho, { y: 0, rotation: 0, scale: 1, duration: 1.2, ease: "sine.out" }, 0)
        .to(lacinho, { y: -3, rotation: 4, duration: 1.3, ease: "sine.inOut" })
        .to(lacinhoFitas, { strokeDashoffset: -1, duration: 1, ease: "power2.in", stagger: 0.04 })
        .to(lacinho, { y: -12, rotation: 14, opacity: 0, duration: 1, ease: "power1.in" }, "<");
    }

    amarrar.eventCallback("onComplete", () => {
      secao.classList.add("is-amarrado");
      if (pPontas.length && !balanco) {
        balanco = gsap.to(pPontas.map((p) => p.estado), {
          r: (i) => (i ? 5 : -5), duration: 2.8, ease: "sine.inOut", yoyo: true, repeat: -1,
          stagger: 0.4, onUpdate: () => pPontas.forEach((p) => p.aplicar()),
        });
      }
      formarLacinho();
    });

    const PROFUNDIDADE = 3;
    function lugar(posicao) {
      const p = Math.min(posicao, PROFUNDIDADE);
      return { yPercent: 0, y: p * 18, scale: 1 - p * 0.045, rotation: 0, opacity: posicao <= PROFUNDIDADE ? 1 - posicao * 0.13 : 0 };
    }
    cards.forEach((card, i) => gsap.set(card, { ...lugar(i), zIndex: total - i, transformOrigin: "50% 100%" }));

    let indiceAtual = -1;
    let tempoAtual = 0;
    function marcar(progresso) {
      tempoAtual = progresso * total;
      const indice = gsap.utils.clamp(0, total - 1, Math.round(tempoAtual - 1));
      if (trilho) trilho.style.transform = `scaleX(${gsap.utils.clamp(0, 1, (tempoAtual - 1) / (total - 1))})`;
      if (setaAnterior) setaAnterior.disabled = tempoAtual < 1.05;
      if (setaProxima) setaProxima.disabled = indice >= total - 1 && tempoAtual > total - 0.05;
      if (indice === indiceAtual || tempoAtual < 0.9) return;
      indiceAtual = indice;
      if (atualEl) atualEl.textContent = dois(indice + 1);
      estrelasAcendendo(cards[indice], 0.05);
      formarLacinho();
    }

    const tl = gsap.timeline({
      defaults: { duration: 1 },
      scrollTrigger: {
        trigger: secao,
        start: () => `top ${topoFixo()}px`,
        end: () => `+=${total * window.innerHeight * (noCelular() ? 0.6 : 0.72)}`,
        pin: true,
        scrub: 0.6,
        snap: { snapTo: 1 / total, inertia: false, duration: { min: 0.2, max: 0.55 }, delay: 0.1, ease: "power1.inOut" },
        invalidateOnRefresh: true,
        onUpdate: (self) => marcar(self.progress),
        onRefresh: () => secao.style.setProperty("--topo-fixo", `${topoFixo()}px`),
      },
    });

    tl.from(grade, { y: 36, opacity: 0.18, ease: "power2.out", duration: 0.6 }, 0.35);

    for (let passo = 1; passo < total; passo++) {
      tl.to(cards[passo - 1], { yPercent: -118, rotation: passo % 2 ? 6 : -6, opacity: 0, scale: 0.96, ease: "power2.in" }, passo);
      for (let j = passo; j < total; j++) tl.to(cards[j], { ...lugar(j - passo), ease: "power2.out" }, passo);
    }
    enfeites.forEach((el, i) => {
      const p = Number(el.dataset.profundidade) || 1;
      tl.fromTo(el, { y: 0, rotation: 0 }, { y: -p * 38, rotation: (i % 2 ? 1 : -1) * p * 5, ease: "none", duration: total, immediateRender: false }, 0);
    });
    marcar(0);

    let aoMoverMouse = null;
    if (camadaEnfeites && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      const xPara = gsap.quickTo(camadaEnfeites, "x", { duration: 1.2, ease: "power3.out" });
      const yPara = gsap.quickTo(camadaEnfeites, "y", { duration: 1.2, ease: "power3.out" });
      aoMoverMouse = (e) => {
        xPara((e.clientX / window.innerWidth - 0.5) * -22);
        yPara((e.clientY / window.innerHeight - 0.5) * -14);
      };
      secao.addEventListener("pointermove", aoMoverMouse);
    }

    let navegacao = null;
    let alvoNavegacao = -1;
    function indiceDaRolagem(st) {
      const t = st.progress * total;
      return t < 0.95 ? -1 : gsap.utils.clamp(0, total - 1, Math.round(t - 1));
    }
    function pararNavegacao() {
      if (navegacao) navegacao.kill();
      navegacao = null;
    }
    function irPara(delta) {
      const st = tl.scrollTrigger;
      if (!st) return;
      const base = navegacao ? alvoNavegacao : indiceDaRolagem(st);
      const alvo = gsap.utils.clamp(0, total - 1, base + delta);
      if (alvo === base && navegacao) return;
      const destino = Math.round(st.start + (st.end - st.start) * ((alvo + 1) / total));
      const encaixe = st.getTween && st.getTween(true);
      if (encaixe) encaixe.kill();
      pararNavegacao();
      alvoNavegacao = alvo;
      const rolagem = { y: window.scrollY };
      navegacao = gsap.to(rolagem, {
        y: destino,
        duration: gsap.utils.clamp(0.45, 0.9, Math.abs(destino - rolagem.y) / 1400),
        ease: "power2.inOut",
        onUpdate: () => window.scrollTo({ top: rolagem.y, behavior: "instant" }),
        onComplete: () => { navegacao = null; },
      });
    }
    const aoRolarManual = () => { if (navegacao) pararNavegacao(); };

    const aoClicar = (e) => {
      const seta = e.target.closest(".avaliacoes-seta");
      if (seta) irPara(Number(seta.dataset.ir) || 1);
    };
    const aoTeclar = (e) => {
      if (e.key === "ArrowRight") { e.preventDefault(); irPara(1); }
      if (e.key === "ArrowLeft") { e.preventDefault(); irPara(-1); }
    };
    let toqueX = 0, toqueY = 0;
    const aoTocar = (e) => { toqueX = e.touches[0].clientX; toqueY = e.touches[0].clientY; };
    const aoSoltar = (e) => {
      const dx = e.changedTouches[0].clientX - toqueX;
      const dy = e.changedTouches[0].clientY - toqueY;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3) irPara(dx < 0 ? 1 : -1);
    };
    secao.addEventListener("click", aoClicar);
    secao.addEventListener("keydown", aoTeclar);
    grade.addEventListener("touchstart", aoTocar, { passive: true });
    grade.addEventListener("touchend", aoSoltar, { passive: true });
    window.addEventListener("wheel", aoRolarManual, { passive: true });
    window.addEventListener("touchmove", aoRolarManual, { passive: true });

    return () => {
      if (tl.scrollTrigger) tl.scrollTrigger.kill(true);
      tl.kill();
      if (amarrar.scrollTrigger) amarrar.scrollTrigger.kill();
      amarrar.kill();
      secao.removeEventListener("click", aoClicar);
      secao.removeEventListener("keydown", aoTeclar);
      grade.removeEventListener("touchstart", aoTocar);
      grade.removeEventListener("touchend", aoSoltar);
      window.removeEventListener("wheel", aoRolarManual);
      window.removeEventListener("touchmove", aoRolarManual);
      pararNavegacao();
      if (aoMoverMouse) secao.removeEventListener("pointermove", aoMoverMouse);
      gsap.set([camadaEnfeites, ...enfeites].filter(Boolean), { clearProps: "transform" });
      if (balanco) balanco.kill();
      if (lacinhoTl) lacinhoTl.kill();
      secao.classList.remove("is-amarrado");
      gsap.set(lacinho, { clearProps: "all" });
      gsap.set(lacinhoFitas, { clearProps: "strokeDashoffset" });
      secao.classList.remove("is-presente");
      if (controles) controles.hidden = true;
      gsap.set(cards, { clearProps: "transform,opacity,zIndex,transformOrigin" });
      gsap.set(grade, { clearProps: "transform,opacity" });
      todasAsPecas.forEach((p) => { p.el.removeAttribute("transform"); p.el.style.opacity = ""; });
      if (fita) gsap.set(fita, { clearProps: "clipPath" });
    };
  }

  function animacoesDeRolagem() {
    gsap.registerPlugin(ScrollTrigger);

    mm.add("(min-width: 992px) and (prefers-reduced-motion: no-preference)", () => {
      const tl = entregaGuiada({ comTrava: true });
      return () => { if (tl && tl.scrollTrigger) tl.scrollTrigger.kill(); };
    });

    mm.add("(min-width: 768px) and (max-width: 991.98px) and (prefers-reduced-motion: no-preference)", () => {
      const tl = entregaGuiada();
      return () => { if (tl && tl.scrollTrigger) tl.scrollTrigger.kill(); };
    });

    mm.add("(max-width: 767.98px) and (prefers-reduced-motion: no-preference)", () => {
      const tl = entregaGuiada();
      return () => { if (tl && tl.scrollTrigger) tl.scrollTrigger.kill(); };
    });

    mm.add("(prefers-reduced-motion: no-preference)", () => presenteDasAvaliacoes());

    mm.add("(prefers-reduced-motion: no-preference)", () => {
      entradaDoRodape();
      entradaDosTitulos();
      camadasComParallax();
      const gatilhoDaFaixa = marqueeReativo();
      const gatilhoDaFita = fitaGuia();
      animarVitrine();
      document.addEventListener("vitrine:render", animarVitrine);
      return () => {
        document.removeEventListener("vitrine:render", animarVitrine);
        if (gatilhoDaFaixa) gatilhoDaFaixa.kill();
        if (gatilhoDaFita) gatilhoDaFita.kill();
      };
    });

    ScrollTrigger.refresh();
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => ScrollTrigger.refresh());
    }
  }

  if (window.matchMedia("(prefers-reduced-motion: no-preference)").matches) {
    quandoDerFolga(() => {
      carregarScrollTrigger().then((ok) => {
        if (ok) animacoesDeRolagem();
      });
    });
  }
})();
