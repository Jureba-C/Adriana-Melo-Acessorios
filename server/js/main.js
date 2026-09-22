(function(){
  "use strict";

  const products = [
    { id:1, name:"Laço Bailarina", cat:"laco-unico", catLabel:"Laço Único", price:34.90, color:"#F4B4CC", badges:[], desc:"Laço em cetim rosa bebê, leve e confortável para o dia a dia." },
    { id:2, name:"Laço Duquesa", cat:"laco-unico", catLabel:"Laço Único", price:49.90, color:"#DD6E9B", badges:["Mais vendido"], desc:"Cetim duplo com volume extra, perfeito para festas e ensaios." },
    { id:3, name:"Laço Recém-nascida", cat:"laco-unico", catLabel:"Laço Único", price:29.90, color:"#FBEAF0", badges:[], desc:"Presilha macia em algodão, indicada para os primeiros meses." },
    { id:4, name:"Laço Pérola", cat:"laco-unico", catLabel:"Laço Único", price:59.90, color:"#F8ECF1", badges:[], desc:"Detalhes em pérolas para o dia especial do batizado." },
    { id:5, name:"Laço Borboleta", cat:"laco-unico", catLabel:"Laço Único", price:44.90, color:"#EA8FB4", badges:[], desc:"Formato de borboleta com fita de organza, ideal para festas infantis." },
    { id:6, name:"Kit Presente 3 Laços", cat:"kit", catLabel:"Kit", price:89.90, color:"#C05480", badges:["Novo"], desc:"Trio de laços em tons de rosa, embalado em caixa para presente." },
    { id:7, name:"Laço Tiara Flor", cat:"tiara", catLabel:"Tiara", price:39.90, color:"#F4B4CC", badges:[], desc:"Tiara macia com flor de tecido, confortável para uso prolongado." },
    { id:8, name:"Laço Personalizado", cat:"laco-unico", catLabel:"Laço Único", price:64.90, color:"#DD6E9B", badges:["Novo"], desc:"Bordado com o nome que você escolher, na cor da fita que combinar." },
  ];

  function escapeHTML(str){
    return String(str).replace(/[&<>"']/g, ch => ({
      "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
    }[ch]));
  }

  function safeColor(color){
    return /^#[0-9a-fA-F]{3,8}$/.test(String(color || "")) ? color : "#F4B4CC";
  }

  function fetchWithTimeout(url, options, timeoutMs){
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 12000);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
  }

  const productsById = new Map(products.map(p => [p.id, p]));

  const PALETA_DECORATIVA = ["#F4B4CC", "#DD6E9B", "#FBEAF0", "#F8ECF1", "#EA8FB4", "#C05480"];

  const pricing = window.PLCPricing;
  const formatMoney = pricing.formatMoney;

  function imageFor(p){
    return p.image || "";
  }

  /* ⚠️ Só as fotos em /api/products/photos/<uuid> respondem ?w=, e a largura
     tem que existir em LARGURAS_DE_FOTO (server.js) — fora da lista volta o
     original de 1600px. */
  const ROTA_FOTO_REDIMENSIONAVEL =
    /^\/api\/products\/photos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  function redimensionavel(url){
    return ROTA_FOTO_REDIMENSIONAVEL.test(url || "");
  }

  function urlDaFoto(url, largura){
    return redimensionavel(url) ? `${url}?w=${largura}` : url;
  }

  function srcsetDe(url, larguras){
    if(!redimensionavel(url)) return "";
    return larguras.map(w => `${escapeHTML(url)}?w=${w} ${w}w`).join(", ");
  }

  const SIZES_DO_CARD = "(max-width: 767.98px) 50vw, (max-width: 991.98px) 33vw, 285px";

  function atributosDeFoto(url, larguras, sizes){
    const src = redimensionavel(url)
      ? `${escapeHTML(url)}?w=${larguras[larguras.length - 1]}`
      : escapeHTML(url);
    const set = srcsetDe(url, larguras);
    return `src="${src}"${set ? ` srcset="${set}" sizes="${sizes}"` : ""}`;
  }
  function photosFor(p){
    if(Array.isArray(p?.photos) && p.photos.length) return p.photos;
    const img = imageFor(p);
    return img ? [img] : [];
  }

  let cartCount = 0;
  let currentFilter = "todos";

  const grid = document.getElementById("productsGrid");
  const cartCountEl = document.getElementById("cartCount");
  const cartCountMobileEl = document.getElementById("cartCountMobile");
  const cartToast = new bootstrap.Toast(document.getElementById("cartToast"));
  const checkoutHintToastEl = document.getElementById("checkoutHintToast");
  const checkoutHintToastBody = document.getElementById("checkoutHintToastBody");
  const checkoutHintToast = new bootstrap.Toast(checkoutHintToastEl, { delay: 4000 });
  function showCheckoutHintToast(text){
    checkoutHintToastBody.textContent = text;
    checkoutHintToast.show();
  }
  if(new URLSearchParams(location.search).get("conta") === "excluida"){
    showCheckoutHintToast("Sua conta foi excluída e seus dados pessoais, removidos.");
    history.replaceState(null, "", location.pathname);
  }
  const cartPillEl = document.querySelector(".cart-pill");

  const revealObserver = ("IntersectionObserver" in window)
    ? new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if(entry.isIntersecting){
            entry.target.classList.add("is-visible");
            revealObserver.unobserve(entry.target);
          }
        });
      }, { threshold: 0.15, rootMargin: "0px 0px -10% 0px" })
    : null;

  function observeReveal(root){
    (root || document).querySelectorAll(".reveal:not(.is-visible)").forEach(el => {
      if(revealObserver) revealObserver.observe(el);
      else el.classList.add("is-visible");
    });
  }
  observeReveal();

  const processTruckEl = document.getElementById("processTruck");
  const processPackageEl = document.getElementById("processPackage");
  const processWrapEl = processTruckEl?.closest(".process-wrap");

  function posicionarParadasMobile(){
    if(!processWrapEl) return;
    const icones = processWrapEl.querySelectorAll(".process-icon-wrap");
    if(icones.length < 3) return;
    const wrapRect = processWrapEl.getBoundingClientRect();
    const centroVertical = el => {
      const r = el.getBoundingClientRect();
      return r.top - wrapRect.top + r.height / 2;
    };
    const posX = el => {
      const r = el.getBoundingClientRect();
      const centroX = r.left - wrapRect.left + r.width / 2;
      return centroX + r.width / 2 + 8;
    };
    processWrapEl.style.setProperty("--x1", `${posX(icones[0])}px`);
    processWrapEl.style.setProperty("--x2", `${posX(icones[1])}px`);
    processWrapEl.style.setProperty("--x3", `${posX(icones[2])}px`);
    processWrapEl.style.setProperty("--y1", `${centroVertical(icones[0])}px`);
    processWrapEl.style.setProperty("--y2", `${centroVertical(icones[1])}px`);
    processWrapEl.style.setProperty("--y3", `${centroVertical(icones[2])}px`);
  }
  posicionarParadasMobile();
  window.addEventListener("resize", posicionarParadasMobile);
  window.addEventListener("load", posicionarParadasMobile);
  if(document.fonts?.ready) document.fonts.ready.then(posicionarParadasMobile);

  processPackageEl?.addEventListener("animationiteration", posicionarParadasMobile);

  if(processWrapEl && "IntersectionObserver" in window){
    new IntersectionObserver((entries, obs) => {
      entries.forEach(entry => {
        if(!entry.isIntersecting) return;
        posicionarParadasMobile();
        setTimeout(() => {
          processTruckEl?.classList.add("is-dirigindo");
          processPackageEl?.classList.add("is-dirigindo");
        }, 500);
        obs.unobserve(entry.target);
      });
    }, { threshold: 0, rootMargin: "0px 0px -25% 0px" }).observe(processWrapEl);
  }

  function bumpCartIcon(){
    if(!cartPillEl) return;
    cartPillEl.classList.remove("is-bumped");
    void cartPillEl.offsetWidth; 
    cartPillEl.classList.add("is-bumped");
    cartPillEl.addEventListener("animationend", () => cartPillEl.classList.remove("is-bumped"), { once: true });
  }

  function flyToCart(originEl, color){
    if(!cartPillEl || !originEl) return;
    const start = originEl.getBoundingClientRect();
    const end = cartPillEl.getBoundingClientRect();
    const dot = document.createElement("div");
    dot.className = "fly-dot";
    dot.style.background = color || "var(--blush-600)";
    dot.style.transform = `translate(${start.left + start.width / 2 - 7}px, ${start.top + start.height / 2 - 7}px)`;
    document.body.appendChild(dot);

    requestAnimationFrame(() => {
      const x = end.left + end.width / 2 - 7;
      const y = end.top + end.height / 2 - 7;
      dot.style.transform = `translate(${x}px, ${y}px) scale(.3)`;
      dot.style.opacity = "0";
    });

    const cleanup = () => dot.remove();
    dot.addEventListener("transitionend", cleanup, { once: true });
    setTimeout(cleanup, 900); 
  }

  function pulseAddButton(btn){
    const icon = btn?.querySelector("i");
    if(!icon) return;

    if(btn.classList.contains("is-added")) return;
    const original = icon.className;
    btn.classList.add("is-added");
    icon.className = "bi bi-check-lg";
    setTimeout(() => {
      btn.classList.remove("is-added");
      icon.className = original;
    }, 900);
  }

  function celebrateAddToCart(originEl, color){
    flyToCart(originEl, color);
    bumpCartIcon();
  }

  function wireImage(imgEl){
    imgEl.addEventListener("load", () => {
      imgEl.classList.add("is-loaded");
      imgEl.closest(".product-thumb, .cart-item-thumb, .qv-thumb")?.classList.remove("is-loading");
    });
    imgEl.addEventListener("error", () => {
      imgEl.classList.add("is-error");
      imgEl.closest(".product-thumb, .cart-item-thumb, .qv-thumb")?.classList.remove("is-loading");
    });
  }

  const PAGINA = 12;
  let buscaAtual = "";
  let visiveis = PAGINA;

  function normalizarBusca(texto){
    return String(texto ?? "")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().trim();
  }

  function produtosFiltrados(){
    const termo = normalizarBusca(buscaAtual);
    return products.filter(p => {
      if(currentFilter !== "todos" && p.cat !== currentFilter) return false;
      if(!termo) return true;
      return normalizarBusca(p.name).includes(termo);
    });
  }

  function rotuloCurtoDeParcelamento(pay){
    const plano = pay.installment;
    if(plano.count <= 1) return "";
    if(!plano.interestFree) return `ou ${pay.installmentLabel}`;
    return `${plano.count}x de ${formatMoney(plano.value)}`;
  }

  function enderecoDoProduto(p){
    return p.slug || PLCProdutoUrl.caminhoDoProduto(p.id, p.name);
  }

  function cartaoDeProdutoHTML(p, i){
      const pay = pricing.paymentSummaryFor(p.price);
      const parcelamento = rotuloCurtoDeParcelamento(pay);
      const photo = imageFor(p);
      return `
      <div class="col-6 col-md-4 col-lg-3 reveal reveal-delay-${i % 4}">
        <div class="product-card${p.badges?.length ? " is-featured" : ""}${p.soldOut ? " is-soldout" : ""}" data-id="${p.id}" role="button" tabindex="0" aria-label="Ver detalhes de ${escapeHTML(p.name)}">
          <div class="product-thumb${photo ? " is-loading" : ""}" style="background:${safeColor(p.color)}22">
            ${p.soldOut || p.badges?.length ? `<div class="product-badges">${
              p.soldOut ? `<span class="product-badge is-soldout">Esgotado</span>` : ""
            }${(p.badges || []).map(b => `<span class="product-badge">${escapeHTML(b)}</span>`).join("")}</div>` : ""}
            <button type="button" class="product-quickview" aria-label="Ver detalhes de ${escapeHTML(p.name)}"><i class="bi bi-eye"></i></button>
            ${photo ? `<img
              ${atributosDeFoto(photo, [400, 600], SIZES_DO_CARD)}
              alt="${escapeHTML(p.name)} — ${escapeHTML(p.catLabel)}"
              width="600" height="600"
              loading="lazy" decoding="async">` : ""}
            <svg class="bow-icon" style="color:${safeColor(p.color)}; position:absolute"><use href="#bow-shape"/></svg>
          </div>
          <div class="product-body">
            <div class="product-cat">${escapeHTML(p.catLabel)}</div>
            <div class="product-name"><a class="product-name-link" href="${enderecoDoProduto(p)}">${escapeHTML(p.name)}</a></div>
            <div class="d-flex align-items-end justify-content-between gap-2">
              <div class="product-pricing">
                <span class="product-price">${formatMoney(p.price)}</span>
                <span class="product-pix">${formatMoney(pay.pixPrice)} <small>no Pix</small></span>
                ${parcelamento ? `<span class="product-installment">${escapeHTML(parcelamento)}</span>` : ""}
              </div>
              <button class="btn-add flex-shrink-0" data-id="${p.id}"${p.soldOut ? " disabled" : ""} aria-label="${p.soldOut ? `${escapeHTML(p.name)} está esgotado` : `Adicionar ${escapeHTML(p.name)} ao carrinho`}"><i class="bi bi-plus-lg"></i></button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderProducts(){
    const todos = produtosFiltrados();
    const list = todos.slice(0, visiveis);
    atualizarResumoVitrine(todos.length, list.length);
    grid.innerHTML = list.map(cartaoDeProdutoHTML).join("");
    grid.querySelectorAll(".product-thumb img").forEach(wireImage);
    observeReveal(grid);
    document.dispatchEvent(new CustomEvent("vitrine:render"));
  }

  function acrescentarProdutos(){
    const todos = produtosFiltrados();
    const jaNaTela = grid.children.length;
    visiveis += PAGINA;
    const novos = todos.slice(jaNaTela, visiveis);
    if(!novos.length){
      atualizarResumoVitrine(todos.length, Math.min(visiveis, todos.length));
      return;
    }
    grid.insertAdjacentHTML("beforeend", novos.map(cartaoDeProdutoHTML).join(""));
    Array.from(grid.children).slice(jaNaTela).forEach(el => {
      el.querySelectorAll(".product-thumb img").forEach(wireImage);
    });
    atualizarResumoVitrine(todos.length, Math.min(visiveis, todos.length));
    observeReveal(grid);
    document.dispatchEvent(new CustomEvent("vitrine:render"));
  }

  const vitrineContagemEl = document.getElementById("vitrineContagem");
  const vitrineVazioEl = document.getElementById("vitrineVazio");
  const vitrineVazioTermoEl = document.getElementById("vitrineVazioTermo");
  const vitrineMaisWrapEl = document.getElementById("vitrineMaisWrap");
  const vitrineMaisBtn = document.getElementById("vitrineMais");
  const buscaInput = document.getElementById("buscaProduto");
  const buscaLimparBtn = document.getElementById("buscaLimpar");

  function atualizarResumoVitrine(total, mostrando){
    if(vitrineContagemEl){
      vitrineContagemEl.textContent = total === 0
        ? "Nenhum produto encontrado"
        : (total === 1 ? "1 produto" : `${total} produtos`) +
          (mostrando < total ? ` · mostrando ${mostrando}` : "");
    }
    if(vitrineVazioEl){
      vitrineVazioEl.classList.toggle("d-none", total > 0);
      if(vitrineVazioTermoEl) vitrineVazioTermoEl.textContent = buscaAtual.trim();
    }
    if(vitrineMaisWrapEl) vitrineMaisWrapEl.classList.toggle("d-none", mostrando >= total);
    if(buscaLimparBtn) buscaLimparBtn.classList.toggle("d-none", !buscaAtual);
  }

  function aplicarRecorte(){
    visiveis = PAGINA;
    renderProducts();
  }

  if(buscaInput){
    let debounce;
    buscaInput.addEventListener("input", () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { buscaAtual = buscaInput.value; aplicarRecorte(); }, 180);
    });
    buscaInput.addEventListener("keydown", (e) => {
      if(e.key === "Escape" && buscaInput.value){
        e.preventDefault();
        buscaInput.value = ""; buscaAtual = ""; aplicarRecorte();
      }
    });
  }
  buscaLimparBtn?.addEventListener("click", () => {
    if(buscaInput) buscaInput.value = "";
    buscaAtual = "";
    aplicarRecorte();
    buscaInput?.focus();
  });
  vitrineMaisBtn?.addEventListener("click", acrescentarProdutos);

  renderProducts();

  function categoryLabelFor(catSlug){
    const chip = document.querySelector(`#filterGroup .chip[data-cat="${CSS.escape(catSlug)}"]`);
    return chip ? chip.textContent.trim() : catSlug;
  }
  function sameBadges(a, b){
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }

  function ensureCategoryChips(categories){
    const group = document.getElementById("filterGroup");
    (Array.isArray(categories) ? categories : []).forEach(c => {
      if(!c?.slug || group.querySelector(`.chip[data-cat="${CSS.escape(c.slug)}"]`)) return;
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.type = "button";
      chip.dataset.cat = c.slug;
      chip.setAttribute("aria-pressed", "false");
      /* ⚠️ Só o rótulo aqui dentro: categoryLabelFor() lê chip.textContent, e
         qualquer coisa a mais vira "Tiara 8" no card. Contagem vai em
         atributo. */
      chip.textContent = c.label || c.slug;
      group.appendChild(chip);
    });
  }

  const linhaDeCategorias = document.querySelector(".chip-linha");
  const btnVerTodas = document.getElementById("verTodasCategorias");
  const btnVerTodasTexto = document.getElementById("verTodasCategoriasTexto");

  function categoriasForaDaVista(){
    const group = document.getElementById("filterGroup");
    if(!group) return 0;
    const visiveis = [...group.querySelectorAll(".chip")].filter(c => !c.hidden);
    const limite = group.getBoundingClientRect().right;
    return visiveis.filter(c => c.getBoundingClientRect().right > limite + 1).length;
  }

  function atualizarBotaoDeCategorias(){
    if(!linhaDeCategorias || !btnVerTodas) return;
    if(linhaDeCategorias.classList.contains("esta-aberta")) return;
    const fora = categoriasForaDaVista();
    btnVerTodas.classList.toggle("d-none", fora === 0);
    if(fora > 0){
      btnVerTodasTexto.textContent = "+" + fora;
      btnVerTodas.setAttribute("aria-label", "Ver todas as categorias — " + fora + " fora da tela");
    }
  }

  btnVerTodas?.addEventListener("click", () => {
    const aberta = linhaDeCategorias.classList.toggle("esta-aberta");
    btnVerTodas.setAttribute("aria-expanded", String(aberta));
    if(aberta){
      btnVerTodasTexto.textContent = "Ver menos";
      btnVerTodas.setAttribute("aria-label", "Mostrar menos categorias");
    }else{
      document.getElementById("filterGroup").scrollTo({ left: 0, behavior: "smooth" });
      atualizarBotaoDeCategorias();
    }
  });

  window.addEventListener("resize", atualizarBotaoDeCategorias);
  document.addEventListener("vitrine:render", atualizarBotaoDeCategorias);
  if(document.fonts && document.fonts.ready){
    document.fonts.ready.then(atualizarBotaoDeCategorias);
  }

  function esconderCategoriasVazias(){
    const group = document.getElementById("filterGroup");
    if(!group) return;
    const comProduto = new Set(products.map(p => p.cat));
    group.querySelectorAll(".chip").forEach(chip => {
      const cat = chip.dataset.cat;
      if(cat === "todos") return;
      const vazia = !comProduto.has(cat);
      chip.hidden = vazia;
      if(vazia && currentFilter === cat){
        currentFilter = "todos";
        const todos = group.querySelector('.chip[data-cat="todos"]');
        group.querySelectorAll(".chip").forEach(c => {
          c.classList.remove("active");
          c.setAttribute("aria-pressed", "false");
        });
        if(todos){ todos.classList.add("active"); todos.setAttribute("aria-pressed", "true"); }
        aplicarRecorte();
      }
    });
  }

  async function loadProductOverrides(){
    try{
      const res = await fetch("/api/products");
      if(!res.ok) return;
      const data = await res.json();
      ensureCategoryChips(data.categories);
      let changed = false;
      (Array.isArray(data.products) ? data.products : []).forEach(o => {
        const p = productsById.get(o.id);
        if(!p){
          if(!o.name || o.price == null) return;
          const fresh = {
            id: o.id, name: o.name, price: o.price,
            cat: o.category || "", catLabel: o.category ? categoryLabelFor(o.category) : "",
            color: PALETA_DECORATIVA[o.id % PALETA_DECORATIVA.length],
            badges: Array.isArray(o.badges) ? o.badges : [],
            soldOut: Boolean(o.soldOut),
            slug: o.slug || null,
            desc: o.description || "Peça exclusiva, feita à mão pela Adriana Melo Acessórios.",
            image: o.photoUrl || null,
            photos: Array.isArray(o.photos) ? o.photos : (o.photoUrl ? [o.photoUrl] : []),
          };
          products.push(fresh);
          productsById.set(o.id, fresh);
          changed = true;
          return;
        }
        if(o.name && o.name !== p.name){ p.name = o.name; changed = true; }
        if(o.slug && o.slug !== p.slug){ p.slug = o.slug; changed = true; }
        if(o.description && o.description !== p.desc){ p.desc = o.description; changed = true; }
        if(o.price != null && o.price !== p.price){ p.price = o.price; changed = true; }
        if(o.photoUrl && o.photoUrl !== p.image){ p.image = o.photoUrl; changed = true; }
        if(Array.isArray(o.photos) && !sameBadges(o.photos, photosFor(p))){ p.photos = o.photos; changed = true; }
        if(o.category && o.category !== p.cat){
          p.cat = o.category;
          p.catLabel = categoryLabelFor(o.category);
          changed = true;
        }
        if(Array.isArray(o.badges) && !sameBadges(o.badges, p.badges || [])){
          p.badges = o.badges;
          changed = true;
        }
        if(Boolean(o.soldOut) !== Boolean(p.soldOut)){
          p.soldOut = Boolean(o.soldOut);
          changed = true;
        }
      });
      const serverIds = Array.isArray(data.products) ? data.products.map(o => o.id) : null;
      if(serverIds){
        const currentOrder = products.map(p => p.id).join(",");
        const nextOrder = serverIds.join(",");
        if(currentOrder !== nextOrder){
          const reordered = serverIds.map(id => productsById.get(id)).filter(Boolean);
          products.length = 0;
          products.push(...reordered);
          changed = true;
        }
      }
      if(changed){ renderProducts(); renderCart(); }
      esconderCategoriasVazias();
      atualizarBotaoDeCategorias();
      verifyPaymentRules(data.paymentRules);
    }catch(err){
      console.warn("Não foi possível verificar atualizações do catálogo:", err);
    }
  }

  const PRICING_RELOAD_KEY = "plc_pricing_reloaded";
  function verifyPaymentRules(serverRules){
    if(!serverRules) return;
    const same = Object.keys(pricing.PAYMENT_RULES)
      .every(k => serverRules[k] === pricing.PAYMENT_RULES[k]);
    if(same){ sessionStorage.removeItem(PRICING_RELOAD_KEY); return; }
    if(sessionStorage.getItem(PRICING_RELOAD_KEY)){
      console.error("Regras de pagamento do servidor continuam diferentes das do navegador após recarregar.", serverRules);
      return;
    }
    sessionStorage.setItem(PRICING_RELOAD_KEY, "1");
    window.location.reload();
  }

  function abrirProdutoDoEndereco(){
    const id = Number(document.body.dataset.produto);
    if(!Number.isInteger(id) || !findProduct(id)) return;
    aberturaPorEndereco = true;
    openQuickView(id, { fromPopState: true });
  }

  loadProductOverrides().then(abrirProdutoDoEndereco);

  document.getElementById("filterGroup").addEventListener("click", function(e){
    const btn = e.target.closest(".chip");
    if(!btn) return;
    document.querySelectorAll("#filterGroup .chip").forEach(c => {
      c.classList.remove("active");
      c.setAttribute("aria-pressed", "false");
    });
    btn.classList.add("active");
    btn.setAttribute("aria-pressed", "true");
    currentFilter = btn.dataset.cat;
    btn.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
    aplicarRecorte();
  });

  const CART_KEY = "plc_cart_v1";

  function loadCart(){
    try{
      const raw = localStorage.getItem(CART_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if(!Array.isArray(parsed)) return [];
      return parsed
        .filter(i => i && Number.isInteger(i.id) && Number.isInteger(i.qty))
        .reduce((acc, i) => {
          const existente = acc.find(x => x.id === i.id);
          if(existente) existente.qty = Math.min(10, existente.qty + i.qty);
          else acc.push({ id: i.id, qty: Math.min(10, Math.max(1, i.qty)) });
          return acc;
        }, []);
    }catch(err){
      console.warn("Carrinho salvo estava corrompido, começando vazio.", err);
      return [];
    }
  }

  function saveCart(){
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  }

  let cart = loadCart();

  function findProduct(id){
    return productsById.get(id);
  }

  function cartTotalQty(){
    return cart.reduce((sum, i) => sum + i.qty, 0);
  }

  function cartSubtotal(){
    return cart.reduce((sum, i) => {
      const p = findProduct(i.id);
      return p ? sum + p.price * i.qty : sum;
    }, 0);
  }

  function updateCartBadges(){
    const n = cartTotalQty();
    cartCountEl.textContent = n;
    if(cartCountMobileEl) cartCountMobileEl.textContent = n;
  }

  function patchCartItemQty(id, qty){
    const row = cartItemsList.querySelector(`.cart-item[data-id="${id}"]`);
    if(!row) return false;
    const qtyEl = row.querySelector(".cart-qty span");
    if(qtyEl) qtyEl.textContent = qty;
    return true;
  }

  const PENDING_ITEM_KEY = "plc_item_pendente";

  function addToCart(id, qty){
    if(findProduct(id)?.soldOut) return;

    if(!currentUser){
      try{
        sessionStorage.setItem(PENDING_ITEM_KEY, JSON.stringify({ id, qty }));
      }catch(err){
        console.warn("Não foi possível guardar o item pendente:", err);
      }

      if(!sessionChecked){
        redirectAoSaberDaSessao = true;
        return;
      }
      window.location.href = "/conta.html?retorno=carrinho";
      return;
    }

    const existing = cart.find(i => i.id === id);
    if(existing){
      existing.qty = Math.min(10, existing.qty + qty);
      saveCart();
      updateCartBadges();
      if(patchCartItemQty(id, existing.qty)){
        resetShipping();
        updateTotals();
      } else {
        renderCart();
      }
    } else {
      cart.push({ id, qty: Math.min(10, Math.max(1, qty)) });
      saveCart();
      updateCartBadges();
      renderCart();
    }
    cartToast.show();
  }

  function removeFromCart(id){
    cart = cart.filter(i => i.id !== id);
    saveCart();
    updateCartBadges();
    renderCart();
  }

  function setQty(id, qty){
    const item = cart.find(i => i.id === id);
    if(!item) return;
    item.qty = Math.min(10, Math.max(1, qty));
    saveCart();
    updateCartBadges();
    patchCartItemQty(id, item.qty);
    resetShipping();
    updateTotals();
  }

  const cartItemsList = document.getElementById("cartItemsList");
  const cartEmptyState = document.getElementById("cartEmptyState");
  const cartRecommendationsEl = document.getElementById("cartRecommendations");
  const cartRecsListEl = document.getElementById("cartRecsList");
  const cartSubtotalEl = document.getElementById("cartSubtotal");
  const cartDiscountRow = document.getElementById("cartDiscountRow");
  const cartCouponCodeEl = document.getElementById("cartCouponCode");
  const cartDiscountEl = document.getElementById("cartDiscount");
  const cartPromoRow = document.getElementById("cartPromoRow");
  const cartPromoDiscountEl = document.getElementById("cartPromoDiscount");
  const cartPixRow = document.getElementById("cartPixRow");
  const cartPixPercentEl = document.getElementById("cartPixPercent");
  const cartPixDiscountEl = document.getElementById("cartPixDiscount");
  const cartShippingPriceEl = document.getElementById("cartShippingPrice");
  const cartTotalEl = document.getElementById("cartTotal");
  const cartInstallmentNoteEl = document.getElementById("cartInstallmentNote");
  const payMethodGroupEl = document.getElementById("payMethodGroup");
  const pmPixNoteEl = document.getElementById("pmPixNote");
  const pmCardNoteEl = document.getElementById("pmCardNote");
  const cartOffcanvasEl = document.getElementById("cartOffcanvas");
  const cartOffcanvasLabel = document.getElementById("cartOffcanvasLabel");
  const cartBackBtn = document.getElementById("cartBackBtn");
  const cartFooter = document.getElementById("cartFooter");
  const cartStep1 = document.getElementById("cartStep1");
  const cartStep2 = document.getElementById("cartStep2");
  const cartShippingRow = document.getElementById("cartShippingRow");
  const cartChosenShippingEl = document.getElementById("cartChosenShipping");
  const couponToggle = document.getElementById("couponToggle");
  const couponFields = document.getElementById("couponFields");
  const checkoutBtn = document.getElementById("checkoutBtn");
  const checkoutMsg = document.getElementById("checkoutMsg");
  const cartLoginNotice = document.getElementById("cartLoginNotice");
  const couponInput = document.getElementById("couponInput");
  const couponApplyBtn = document.getElementById("couponApplyBtn");
  const couponMsgEl = document.getElementById("couponMsg");

  let shipping = null; 

  let currentUser = null;

  let sessionChecked = false;
  let redirectAoSaberDaSessao = false;

  let coupon = null; 

  function currentDiscount(subtotal){
    return coupon ? Math.round(subtotal * coupon.percentOff / 100 * 100) / 100 : 0;
  }

  function currentPromoDiscount(){
    const couponFactor = coupon ? (1 - coupon.percentOff / 100) : 1;
    const itensComCupom = cart.map(i => {
      const p = findProduct(i.id);
      return p ? { qty: i.qty, price: pricing.round2(p.price * couponFactor) } : null;
    }).filter(Boolean);
    return pricing.promoLeve4Pague3For(itensComCupom);
  }

  let paymentMethod = "pix";

  function updateTotals(){
    const subtotal = cartSubtotal();
    const discount = currentDiscount(subtotal);
    cartSubtotalEl.textContent = formatMoney(subtotal);

    if(discount > 0){
      cartDiscountRow.classList.remove("d-none");
      cartCouponCodeEl.textContent = `(${coupon.code})`;
      cartDiscountEl.textContent = "-" + formatMoney(discount);
    } else {
      cartDiscountRow.classList.add("d-none");
    }

    const afterCoupon = pricing.round2(subtotal - discount);
    const pixDiscount = pricing.pixDiscountFor(afterCoupon);
    const shippingPrice = shipping ? shipping.price : 0;
    const promoDiscount = currentPromoDiscount();

    cartPromoRow.classList.toggle("d-none", promoDiscount <= 0);
    cartPromoDiscountEl.textContent = "-" + formatMoney(promoDiscount);

    pmPixNoteEl.textContent = pixDiscount > 0
      ? `${pricing.PAYMENT_RULES.pixDiscountPercent}% de desconto`
      : "à vista";
    pmCardNoteEl.textContent = pricing.installmentPlanFor(afterCoupon + shippingPrice).count > 1
      ? `até ${pricing.installmentPlanFor(afterCoupon + shippingPrice).count}x sem juros`
      : "à vista";

    const isPix = paymentMethod === "pix";
    cartPixRow.classList.toggle("d-none", !isPix || pixDiscount <= 0);
    cartPixPercentEl.textContent = `(${pricing.PAYMENT_RULES.pixDiscountPercent}%)`;
    cartPixDiscountEl.textContent = "-" + formatMoney(pixDiscount);

    const total = pricing.round2(afterCoupon - (isPix ? pixDiscount : 0) - promoDiscount + shippingPrice);
    cartShippingRow.classList.toggle("d-none", !shipping);
    if(shipping) cartShippingPriceEl.textContent = formatMoney(shipping.price);
    cartTotalEl.textContent = formatMoney(total);

    const plan = pricing.installmentPlanFor(total);
    cartInstallmentNoteEl.textContent = (!isPix && plan.count > 1)
      ? `ou ${pricing.installmentLabelFor(total)} no cartão`
      : "";

    renderPrimaryButton();
  }

  let cartStep = 1;

  function irParaPasso(passo){
    cartStep = passo;
    cartOffcanvasEl.dataset.step = String(passo);
    cartOffcanvasLabel.textContent = passo === 2 ? "Entrega e pagamento" : "Seu carrinho";
    cartBackBtn.setAttribute("aria-label", passo === 2 ? "Voltar para a sacola" : "Voltar para a loja");
    if(passo === 2) cartBackBtn.removeAttribute("data-bs-dismiss");
    else cartBackBtn.setAttribute("data-bs-dismiss", "offcanvas");
    cartOffcanvasEl.querySelector(".offcanvas-body").scrollTop = 0;
    renderChosenShipping();
    renderPrimaryButton();
  }

  function renderChosenShipping(){
    if(!shipping){ cartChosenShippingEl.innerHTML = ""; return; }
    cartChosenShippingEl.innerHTML = `
      <span>
        <span class="cart-chosen-name">${escapeHTML(shipping.name)}</span>
        <span class="cart-chosen-days">${escapeHTML(shipping.delivery_time)}</span>
      </span>
      <span class="cart-chosen-price">${formatMoney(shipping.price)}</span>`;
  }

  function renderPrimaryButton(){
    const vazio = cart.length === 0;
    cartFooter.classList.toggle("d-none", vazio);
    if(vazio) return;

    if(cartStep === 1){
      checkoutBtn.disabled = false;
      checkoutBtn.classList.toggle("is-pending", !shipping);
      checkoutBtn.innerHTML = shipping
        ? "Continuar"
        : `<i class="bi bi-truck"></i> Calcule o frete para continuar`;
      renderCheckoutHint(null);
      return;
    }

    const pendente = checkoutBlockInfo();
    checkoutBtn.disabled = false;
    checkoutBtn.classList.toggle("is-pending", !!pendente);
    checkoutBtn.innerHTML = currentUser
      ? `<i class="bi bi-lock-fill"></i> Ir para pagamento`
      : `<i class="bi bi-box-arrow-in-right"></i> Entrar para finalizar`;
    renderCheckoutHint(pendente);
  }

  function checkoutBlockInfo(){
    if(!currentUser || cart.length === 0) return null;
    if(!shipping){
      return { icon: "bi-truck", text: "Informe seu CEP e calcule o frete para liberar o pagamento." };
    }
    const faltando = missingAddressFields();
    if(faltando.length > 0){
      return { icon: "bi-geo-alt", text: `Falta completar ${faltando.join(", ")} para liberar o pagamento.` };
    }
    return null;
  }

  function renderCheckoutHint(pendente){
    checkoutMsg.innerHTML = pendente ? `<i class="bi ${pendente.icon}"></i> ${pendente.text}` : "";
  }

  function renderAuthGate(){
    cartLoginNotice?.classList.toggle("d-none", !!currentUser);
    renderPrimaryButton();
  }
  PLCAuth.aoSaberDaSessao(({ user }) => {
    currentUser = user;
    sessionChecked = true;
    renderAuthGate();

    prefillFromAccount();

    if(!currentUser && redirectAoSaberDaSessao){
      window.location.href = "/conta.html?retorno=carrinho";
      return;
    }
    resgatarItemPendente();
    updateTotals();
  });

  function resgatarItemPendente(){
    if(!currentUser) return;
    let pendente = null;
    try{
      pendente = JSON.parse(sessionStorage.getItem(PENDING_ITEM_KEY) || "null");
    }catch(err){
      console.warn("Item pendente ilegível:", err);
    }

    sessionStorage.removeItem(PENDING_ITEM_KEY);
    if(pendente?.id) addToCart(Number(pendente.id), Number(pendente.qty) || 1);
  }
  renderAuthGate();

  const gatewayTextEl = document.getElementById("cartGatewayText");

  function syncPayMethodSelection(){
    payMethodGroupEl.querySelectorAll(".pay-method").forEach(label => {
      label.classList.toggle("selected", label.querySelector("input").checked);
    });

    if(gatewayTextEl){
      gatewayTextEl.innerHTML = paymentMethod === "pix"
        ? `Você paga com o QR code aqui mesmo, <strong>sem sair do site</strong>.`
        : `Você conclui a compra no <strong>Mercado Pago</strong>, com segurança.`;
    }
  }
  payMethodGroupEl.addEventListener("change", (e) => {
    const input = e.target.closest("input[name='payMethod']");
    if(!input) return;
    paymentMethod = input.value === "pix" ? "pix" : "card";
    syncPayMethodSelection();
    updateTotals();
  });
  syncPayMethodSelection();

  function resetShipping(){
    shipping = null;
    document.getElementById("shippingOptions").innerHTML = "";
    if(cartStep === 2) irParaPasso(1);
    renderChosenShipping();
    document.getElementById("shippingMsg").textContent = cart.length
      ? "Informe seu CEP para ver as opções de entrega."
      : "";
  }

  function resetCoupon(){
    coupon = null;
    if(couponInput) couponInput.value = "";
    if(couponMsgEl) couponMsgEl.textContent = "";
  }

  function renderCart(){

    const vazio = cart.length === 0;
    cartStep1.classList.toggle("d-none", vazio);
    cartStep2.classList.toggle("d-none", vazio);
    cartFooter.classList.toggle("d-none", vazio);
    if(vazio && cartStep !== 1) irParaPasso(1);

    if(cart.length === 0){
      cartItemsList.innerHTML = "";
      cartEmptyState.classList.remove("d-none");
      resetCoupon();
    } else {
      cartEmptyState.classList.add("d-none");
      cartItemsList.innerHTML = cart.map(item => {
        const p = findProduct(item.id);
        if(!p) return "";
        const tint = safeColor(p.color);
        const photo = imageFor(p);
        return `
          <div class="cart-item" data-id="${p.id}">
            <div class="cart-item-thumb${photo ? " is-loading" : ""}" style="background:${tint}22">
              ${photo ? `<img src="${escapeHTML(urlDaFoto(photo, 160))}" alt="${escapeHTML(p.name)}" width="64" height="64" loading="lazy" decoding="async">` : ""}
              <svg class="bow-icon" style="color:${tint}"><use href="#bow-shape"/></svg>
            </div>
            <div class="cart-item-body">
              <div class="cart-item-head">
                <span class="cart-item-name">${escapeHTML(p.name)}</span>
                <span class="cart-item-price">${formatMoney(p.price)}<small>un.</small></span>
              </div>
              <div class="cart-item-controls">
                <div class="cart-qty">
                  <button type="button" class="cart-qty-minus" aria-label="Diminuir quantidade">−</button>
                  <span>${item.qty}</span>
                  <button type="button" class="cart-qty-plus" aria-label="Aumentar quantidade">+</button>
                </div>
                <button type="button" class="cart-item-remove" aria-label="Remover ${escapeHTML(p.name)}"><i class="bi bi-trash3"></i></button>
              </div>
            </div>
          </div>
        `;
      }).join("");
      cartItemsList.querySelectorAll(".cart-item-thumb img").forEach(wireImage);
    }
    renderCartRecommendations();
    resetShipping();

    checkoutMsg.classList.remove("show");
    checkoutMsg.innerHTML = "";
    updateTotals();
  }

  function pickCartRecommendations(){
    const inCartIds = new Set(cart.map(i => i.id));
    const inCartCats = new Set(cart.map(i => findProduct(i.id)?.cat).filter(Boolean));
    const candidates = products.filter(p => !inCartIds.has(p.id));
    const byBadgeFirst = (a, b) => (b.badges?.length ? 1 : 0) - (a.badges?.length ? 1 : 0);

    const otherCategories = candidates.filter(p => !inCartCats.has(p.cat)).sort(byBadgeFirst);
    const sameCategory = candidates.filter(p => inCartCats.has(p.cat)).sort(byBadgeFirst);
    return [...otherCategories, ...sameCategory].slice(0, 2);
  }

  function renderCartRecommendations(){
    const recs = cart.length ? pickCartRecommendations() : [];
    if(!recs.length){
      cartRecommendationsEl.classList.add("d-none");
      return;
    }
    cartRecommendationsEl.classList.remove("d-none");
    cartRecsListEl.innerHTML = recs.map(p => {
      const photo = imageFor(p);
      return `
      <div class="cart-rec-item" data-id="${p.id}">
        <div class="cart-rec-thumb" style="background:${safeColor(p.color)}22">
          ${photo ? `<img src="${escapeHTML(urlDaFoto(photo, 160))}" alt="${escapeHTML(p.name)}" width="44" height="44" loading="lazy" decoding="async">` : ""}
          <svg class="bow-icon" style="color:${safeColor(p.color)}"><use href="#bow-shape"/></svg>
        </div>
        <div class="flex-grow-1">
          <div class="cart-rec-name">${escapeHTML(p.name)}</div>
          <div class="cart-rec-price">${formatMoney(p.price)}</div>
        </div>
        <button type="button" class="cart-rec-add" data-id="${p.id}" aria-label="Adicionar ${escapeHTML(p.name)} ao carrinho"><i class="bi bi-plus-lg"></i></button>
      </div>
    `;
    }).join("");
    cartRecsListEl.querySelectorAll(".cart-rec-thumb img").forEach(wireImage);
  }

  cartRecsListEl.addEventListener("click", function(e){
    const btn = e.target.closest(".cart-rec-add");
    if(!btn) return;
    const id = Number(btn.dataset.id);
    if(findProduct(id)?.soldOut){
      showCheckoutHintToast("Esse produto está esgotado no momento.");
      return;
    }
    addToCart(id, 1);
    bumpCartIcon();
  });

  cartItemsList.addEventListener("click", function(e){
    const row = e.target.closest(".cart-item");
    if(!row) return;
    const id = Number(row.dataset.id);
    const item = cart.find(i => i.id === id);
    if(e.target.closest(".cart-qty-plus")){
      if(item) setQty(id, item.qty + 1);
    } else if(e.target.closest(".cart-qty-minus")){
      if(!item || item.qty <= 1){ removeFromCart(id); } else { setQty(id, item.qty - 1); }
    } else if(e.target.closest(".cart-item-remove")){
      removeFromCart(id);
    }
  });

  updateCartBadges();

  const cepInput = document.getElementById("cepInput");
  const calcShippingBtn = document.getElementById("calcShippingBtn");
  const shippingMsgEl = document.getElementById("shippingMsg");
  const shippingOptionsEl = document.getElementById("shippingOptions");
  const saveAddressCheck = document.getElementById("saveAddressCheck");
  const addrInputs = {
    nome: document.getElementById("addrNome"),
    telefone: document.getElementById("addrTelefone"),
    cpf: document.getElementById("addrCpf"),
    rua: document.getElementById("addrRua"),
    numero: document.getElementById("addrNumero"),
    complemento: document.getElementById("addrComplemento"),
    bairro: document.getElementById("addrBairro"),
    cidade: document.getElementById("addrCidade"),
    uf: document.getElementById("addrUf"),
  };

  function getAddress(){
    return {
      nome: addrInputs.nome.value.trim(),
      telefone: addrInputs.telefone.value.trim(),
      cpf: addrInputs.cpf.value.replace(/\D/g, ""),
      rua: addrInputs.rua.value.trim(),
      numero: addrInputs.numero.value.trim(),
      complemento: addrInputs.complemento.value.trim(),
      bairro: addrInputs.bairro.value.trim(),
      cidade: addrInputs.cidade.value.trim(),
      uf: addrInputs.uf.value.trim(),
    };
  }

  function isValidPhoneBR(value){
    const digits = value.replace(/\D/g, "");
    return digits.length === 10 || digits.length === 11;
  }

  function maskPhoneBR(value){
    const digits = value.replace(/\D/g, "").slice(0, 11);
    let out = "";
    if(digits.length > 0) out += "(" + digits.slice(0, 2);
    if(digits.length >= 2) out += ") ";
    if(digits.length > 2){
      const rest = digits.slice(2);
      const split = digits.length <= 10 ? 4 : 5;
      out += rest.length <= split ? rest : `${rest.slice(0, split)}-${rest.slice(split)}`;
    }
    return out;
  }

  function isValidCpfBR(value){
    const v = value.replace(/\D/g, "");
    if(!/^\d{11}$/.test(v)) return false;
    if(/^(\d)\1{10}$/.test(v)) return false;
    const digits = v.split("").map(Number);
    const checkDigit = base => {
      let sum = 0;
      for(let i = 0; i < base.length; i++) sum += base[i] * (base.length + 1 - i);
      const rest = (sum * 10) % 11;
      return rest === 10 ? 0 : rest;
    };
    if(checkDigit(digits.slice(0, 9)) !== digits[9]) return false;
    if(checkDigit(digits.slice(0, 10)) !== digits[10]) return false;
    return true;
  }

  function maskCpf(value){
    const digits = value.replace(/\D/g, "").slice(0, 11);
    if(digits.length > 9) return `${digits.slice(0,3)}.${digits.slice(3,6)}.${digits.slice(6,9)}-${digits.slice(9)}`;
    if(digits.length > 6) return `${digits.slice(0,3)}.${digits.slice(3,6)}.${digits.slice(6)}`;
    if(digits.length > 3) return `${digits.slice(0,3)}.${digits.slice(3)}`;
    return digits;
  }

  const ADDRESS_FIELD_RULES = {
    nome: { label: "Nome", validate: v => !v ? "Digite seu nome completo" : (v.length < 3 ? "Nome muito curto — digite o nome completo" : null) },
    telefone: { label: "Telefone", validate: v => !v ? "Digite seu telefone" : (!isValidPhoneBR(v) ? "Faltam números no telefone. Confira o DDD." : null) },
    cpf: { label: "CPF", validate: v => !v ? "Digite o CPF do destinatário" : (!isValidCpfBR(v) ? "CPF inválido — confira os números." : null) },
    rua: { label: "Rua", validate: v => v ? null : "Digite o nome da rua" },
    numero: { label: "Número", validate: v => v ? null : "Digite o número do endereço" },
    bairro: { label: "Bairro", validate: v => v ? null : "Digite o bairro" },
    cidade: { label: "Cidade", validate: v => v ? null : "Digite a cidade" },
    uf: { label: "Estado", validate: v => v ? null : "Selecione o estado" },
  };

  function validateAddressFields(){
    const a = getAddress();
    return Object.keys(ADDRESS_FIELD_RULES)
      .map(key => ({ key, message: ADDRESS_FIELD_RULES[key].validate(a[key]) }))
      .filter(r => r.message);
  }

  function missingAddressFields(){
    return validateAddressFields().map(r => ADDRESS_FIELD_RULES[r.key].label);
  }

  function isAddressComplete(){
    return validateAddressFields().length === 0;
  }

  let addressValidationAttempted = false;

  function renderAddressErrors(){
    if(!addressValidationAttempted) return;
    const errorByKey = Object.fromEntries(validateAddressFields().map(e => [e.key, e.message]));
    Object.keys(ADDRESS_FIELD_RULES).forEach(key => {
      const el = addrInputs[key];
      const msg = errorByKey[key] || "";
      el.classList.toggle("is-invalid", !!msg);
      el.setAttribute("aria-invalid", msg ? "true" : "false");
      const errorEl = document.getElementById(`addr${key[0].toUpperCase()}${key.slice(1)}-error`);
      if(errorEl) errorEl.textContent = msg;
    });
  }

  function focusFirstInvalidAddressField(){
    const errors = validateAddressFields();
    if(errors.length === 0) return;
    const el = addrInputs[errors[0].key];
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.focus({ preventScroll: true });
    el.classList.remove("is-shaking");
    void el.offsetWidth;
    el.classList.add("is-shaking");
  }

  function fillCep(digits){
    if(!digits || cepInput.value.trim()) return;
    const d = String(digits).replace(/\D/g, "").slice(0, 8);
    cepInput.value = d.length > 5 ? `${d.slice(0,5)}-${d.slice(5)}` : d;
  }

  async function prefillFromAccount(){
    if(!currentUser) return;
    if(currentUser.name && !addrInputs.nome.value.trim()){
      addrInputs.nome.value = currentUser.name;
    }
    if(currentUser.cpf && !addrInputs.cpf.value.trim()){
      addrInputs.cpf.value = maskCpf(currentUser.cpf);
    }
    fillCep(currentUser.cep);

    try{
      const res = await fetch("/api/auth/address");
      if(!res.ok) return;
      const { address } = await res.json();
      if(!address) return;
      if(!addrInputs.nome.value) addrInputs.nome.value = address.nome || "";
      if(!addrInputs.telefone.value) addrInputs.telefone.value = maskPhoneBR(address.telefone || "");
      if(!addrInputs.cpf.value) addrInputs.cpf.value = maskCpf(address.cpf || "");
      if(!addrInputs.rua.value) addrInputs.rua.value = address.rua || "";
      if(!addrInputs.numero.value) addrInputs.numero.value = address.numero || "";
      if(!addrInputs.complemento.value) addrInputs.complemento.value = address.complemento || "";
      if(!addrInputs.bairro.value) addrInputs.bairro.value = address.bairro || "";
      if(!addrInputs.cidade.value) addrInputs.cidade.value = address.cidade || "";
      if(!addrInputs.uf.value) addrInputs.uf.value = address.uf || "";
      fillCep(address.cep);
    }catch(err){
      console.warn("Não foi possível pré-preencher o endereço salvo:", err);
    }
  }

  async function autofillAddress(cep){
    try{
      const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
      const data = await res.json();
      if(data.erro) return;
      if(!addrInputs.rua.value) addrInputs.rua.value = data.logradouro || "";
      if(!addrInputs.bairro.value) addrInputs.bairro.value = data.bairro || "";
      if(!addrInputs.cidade.value) addrInputs.cidade.value = data.localidade || "";
      if(!addrInputs.uf.value) addrInputs.uf.value = data.uf || "";
    }catch(err){
      console.warn("Não foi possível autopreencher o endereço:", err);
    }
  }

  addrInputs.telefone.addEventListener("input", () => {
    addrInputs.telefone.value = maskPhoneBR(addrInputs.telefone.value);
  });
  addrInputs.cpf.addEventListener("input", () => {
    addrInputs.cpf.value = maskCpf(addrInputs.cpf.value);
  });

  Object.values(addrInputs).forEach(el => el.addEventListener("input", () => {
    updateTotals();
    renderAddressErrors();
  }));

  cepInput.addEventListener("input", () => {

    let v = cepInput.value.replace(/\D/g, "").slice(0, 8);
    if(v.length > 5) v = v.slice(0,5) + "-" + v.slice(5);
    cepInput.value = v;
  });

  function isValidCep(v){
    return /^\d{5}-?\d{3}$/.test(v);
  }

  async function calcShipping(){
    const cep = cepInput.value.trim();
    if(!isValidCep(cep)){
      shippingMsgEl.textContent = "Digite um CEP válido (8 dígitos).";
      return;
    }
    if(cart.length === 0) return;

    calcShippingBtn.disabled = true;
    shippingOptionsEl.innerHTML = "";
    shippingMsgEl.textContent = "Calculando opções de entrega...";
    shipping = null;
    updateTotals();

    try{
      const res = await fetchWithTimeout("/api/calculate-shipping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cep: cep.replace("-", ""),
          items: cart.map(i => ({ id: i.id, qty: i.qty }))
        })
      });
      const data = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(data.error || `Erro inesperado (HTTP ${res.status}).`);
      if(!Array.isArray(data.options) || data.options.length === 0){
        shippingMsgEl.textContent = "Nenhuma opção de entrega encontrada para esse CEP.";
        return;
      }
      shippingMsgEl.textContent = "Escolha uma opção de entrega:";
      shippingOptionsEl.innerHTML = data.options.map((opt, i) => `
        <label class="shipping-option" data-index="${i}">
          <input type="radio" name="shippingOption" value="${i}">
          <span>
            <span class="so-name d-block">${escapeHTML(opt.name)}</span>
            <span class="so-days">${escapeHTML(opt.delivery_time)}</span>
          </span>
          <span class="so-price">${formatMoney(opt.price)}</span>
        </label>
      `).join("") + `<p class="so-nota"><i class="bi bi-truck me-1" aria-hidden="true"></i>Prazo da transportadora, contado a partir da postagem.</p>`;

      shippingOptionsEl.querySelectorAll(".shipping-option").forEach(label => {
        label.addEventListener("click", () => {
          const idx = Number(label.dataset.index);
          const opt = data.options[idx];
          shipping = opt;
          shippingOptionsEl.querySelectorAll(".shipping-option").forEach(l => l.classList.remove("selected"));
          label.classList.add("selected");
          label.querySelector("input").checked = true;
          renderChosenShipping();
          updateTotals();
        });
      });

      autofillAddress(cep.replace("-", ""));
    } catch(err){
      console.error("Falha ao calcular frete:", err);
      shippingMsgEl.textContent = err.name === "AbortError"
        ? "A busca por opções de frete demorou demais. Tente novamente."
        : (err.message || "Não foi possível calcular o frete agora. Tente novamente em instantes.");
    } finally {
      calcShippingBtn.disabled = false;
    }
  }
  calcShippingBtn.addEventListener("click", calcShipping);
  cepInput.addEventListener("keydown", e => { if(e.key === "Enter"){ e.preventDefault(); calcShipping(); } });

  async function applyCoupon(){
    const code = couponInput.value.trim();
    if(!code){
      if(coupon){ resetCoupon(); updateTotals(); }
      return;
    }
    if(cart.length === 0) return;

    couponApplyBtn.disabled = true;
    couponMsgEl.style.color = "var(--ink-soft)";
    couponMsgEl.textContent = "Verificando cupom...";
    try{
      const res = await fetch("/api/validate-coupon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, items: cart.map(i => ({ id: i.id, qty: i.qty })) })
      });
      const data = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(data.error || "Cupom inválido.");
      coupon = { code: data.code, percentOff: data.percentOff };
      couponMsgEl.style.color = "var(--blush-700)";
      couponMsgEl.textContent = `Cupom ${data.code} aplicado: ${data.percentOff}% de desconto.`;
      updateTotals();
    }catch(err){
      coupon = null;
      couponMsgEl.style.color = "#B3261E";
      couponMsgEl.textContent = err.message;
      updateTotals();
    }finally{
      couponApplyBtn.disabled = false;
    }
  }
  couponApplyBtn.addEventListener("click", applyCoupon);
  couponInput.addEventListener("keydown", e => { if(e.key === "Enter"){ e.preventDefault(); applyCoupon(); } });

  renderCart(); 

  function acaoDoBotaoPrincipal(){
    if(cartStep === 1){
      if(!shipping){
        showCheckoutHintToast("Informe seu CEP e escolha a entrega para continuar.");
        cepInput.focus();
        return;
      }
      irParaPasso(2);
      return;
    }
    goToCheckout();
  }

  async function goToCheckout(){

    if(!currentUser){
      window.location.href = "/conta.html?retorno=carrinho";
      return;
    }
    if(cart.length === 0) return;
    const pendente = checkoutBlockInfo();
    if(pendente){
      if(shipping){
        irParaPasso(2);
        addressValidationAttempted = true;
        renderAddressErrors();
        focusFirstInvalidAddressField();
      }
      showCheckoutHintToast(pendente.text);
      return;
    }
    checkoutBtn.disabled = true;
    checkoutMsg.classList.add("show");
    checkoutMsg.innerHTML = `<i class="bi bi-hourglass-split"></i><span>Preparando pagamento...</span>`;

    const rota = paymentMethod === "pix" ? "/api/create-pix-payment" : "/api/create-preference";

    let res;
    try{
      res = await fetchWithTimeout(rota, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: cart.map(i => ({ id: i.id, qty: i.qty })),
          cep: cepInput.value.replace("-", ""),
          shipping_service_id: shipping.service_id,
          address: getAddress(),
          saveAddress: saveAddressCheck ? saveAddressCheck.checked : true,
          coupon: coupon ? coupon.code : undefined,
          paymentMethod,
        })
      });
    } catch(networkErr){
      console.error("Falha de rede ao iniciar checkout:", networkErr);
      checkoutMsg.innerHTML = `<i class="bi bi-exclamation-triangle"></i><span>Não conseguimos abrir o pagamento agora (sem conexão com o servidor). Tente novamente em instantes ou <a href="https://wa.me/5561982749808" target="_blank" rel="noopener noreferrer">finalize pelo WhatsApp</a>.</span>`;
      checkoutBtn.disabled = false;
      return;
    }

    try{
      const data = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(data.error || `Erro inesperado (HTTP ${res.status}).`);

      if(paymentMethod === "pix"){
        if(!data.qrCode) throw new Error("O servidor não devolveu o código Pix. Tente novamente.");

        sessionStorage.setItem("plc_pix_pendente", JSON.stringify(data));

        window.location.href = "pagamento-pix.html";
        return;
      }

      if(!data.init_point) throw new Error("O servidor não devolveu o link de pagamento. Tente novamente.");
      window.location.href = data.init_point;
    } catch(err){
      console.error("Falha ao iniciar checkout:", err);
      checkoutMsg.innerHTML = `<i class="bi bi-exclamation-triangle"></i><span>${escapeHTML(err.message)}</span>`;
      checkoutBtn.disabled = false;
    }
  }
  checkoutBtn.addEventListener("click", acaoDoBotaoPrincipal);
  cartBackBtn.addEventListener("click", (e) => {
    if(cartStep !== 2) return;
    e.preventDefault();
    e.stopPropagation();
    irParaPasso(1);
  });
  couponToggle.addEventListener("click", () => {
    const aberto = couponFields.classList.toggle("d-none");
    couponToggle.setAttribute("aria-expanded", String(!aberto));
    if(!aberto) couponInput.focus();
  });
  document.getElementById("cartOffcanvas").addEventListener("hidden.bs.offcanvas", () => irParaPasso(1));

  if(new URLSearchParams(location.search).get("carrinho") === "1"){
    bootstrap.Offcanvas.getOrCreateInstance(document.getElementById("cartOffcanvas")).show();
    history.replaceState(null, "", location.pathname);
  }

  let qvProductId = null, qvQty = 1;
  const qvModalEl = document.getElementById("quickViewModal");
  const qvModal = new bootstrap.Modal(qvModalEl);

  let qvHistoryPushed = false;
  let qvClosingFromPopstate = false;
  let aberturaPorEndereco = false;

  qvModalEl.addEventListener("hidden.bs.modal", () => {
    fecharZoomDaFoto();
    if(aberturaPorEndereco){
      aberturaPorEndereco = false;
      history.replaceState(null, "", "/");
      qvHistoryPushed = false;
      qvClosingFromPopstate = false;
      return;
    }
    if(qvHistoryPushed && !qvClosingFromPopstate){
      qvHistoryPushed = false;
      history.back();
    }
    qvClosingFromPopstate = false;
  });

  window.addEventListener("popstate", (e) => {
    if(e.state && e.state.quickView != null){
      qvHistoryPushed = true;
      openQuickView(e.state.quickView, { fromPopState: true });
    } else if(qvHistoryPushed){
      qvClosingFromPopstate = true;
      qvHistoryPushed = false;
      qvModal.hide();
    }
  });
  const qvQtyEl = document.getElementById("qvQty");
  const qvPriceEl = document.getElementById("qvPrice");
  const qvPixPriceEl = document.getElementById("qvPixPrice");
  const qvPixNoteEl = document.getElementById("qvPixNote");
  const qvInstallmentEl = document.getElementById("qvInstallment");
  const qvSoldOutMsgEl = document.getElementById("qvSoldOutMsg");
  const qvAddBtnEl = document.getElementById("qvAddBtn");

  let qvPhotos = [], qvPhotoIndex = 0;
  const qvGalleryPrevEl = document.getElementById("qvGalleryPrev");
  const qvGalleryNextEl = document.getElementById("qvGalleryNext");
  const qvGalleryThumbsEl = document.getElementById("qvGalleryThumbs");

  function renderQvGallery(){
    const hasGallery = qvPhotos.length > 1;
    qvGalleryPrevEl.classList.toggle("d-none", !hasGallery);
    qvGalleryNextEl.classList.toggle("d-none", !hasGallery);
    qvGalleryThumbsEl.classList.toggle("d-none", !hasGallery);
    if(!hasGallery){ qvGalleryThumbsEl.innerHTML = ""; return; }
    qvGalleryThumbsEl.innerHTML = qvPhotos.map((url, i) => `
      <button type="button" class="qv-gallery-thumb${i === qvPhotoIndex ? " is-active" : ""}" data-index="${i}" aria-label="Foto ${i + 1} de ${qvPhotos.length}">
        <img src="${escapeHTML(urlDaFoto(url, 160))}" alt="" width="56" height="56" loading="lazy">
      </button>
    `).join("");
  }

  function setQvPhoto(index){
    if(!qvPhotos.length) return;
    qvPhotoIndex = Math.min(Math.max(index, 0), qvPhotos.length - 1);
    const thumb = document.getElementById("qvThumb");
    const img = document.getElementById("qvImage");
    img.classList.remove("is-loaded", "is-error");
    thumb.classList.add("is-loading");
    thumb.style.removeProperty("--qv-ratio");
    img.src = urlDaFoto(qvPhotos[qvPhotoIndex], 900);
    qvGalleryPrevEl.disabled = qvPhotoIndex === 0;
    qvGalleryNextEl.disabled = qvPhotoIndex === qvPhotos.length - 1;
    qvGalleryThumbsEl.querySelectorAll(".qv-gallery-thumb").forEach(btn => {
      btn.classList.toggle("is-active", Number(btn.dataset.index) === qvPhotoIndex);
    });
  }

  const qvZoomEl = document.getElementById("qvZoom");
  const qvZoomImgEl = document.getElementById("qvZoomImagem");
  const qvZoomVazio = qvZoomImgEl ? qvZoomImgEl.getAttribute("src") : "";

  function abrirZoomDaFoto(){
    if(!qvZoomEl || !qvPhotos.length) return;
    qvZoomImgEl.src = urlDaFoto(qvPhotos[qvPhotoIndex], 900);
    qvZoomImgEl.alt = document.getElementById("qvName").textContent || "";
    qvZoomEl.classList.remove("is-ampliado");
    qvZoomEl.hidden = false;
  }

  function fecharZoomDaFoto(){
    if(!qvZoomEl || qvZoomEl.hidden) return;
    qvZoomEl.hidden = true;
    qvZoomEl.classList.remove("is-ampliado");
    qvZoomImgEl.src = qvZoomVazio;
    document.getElementById("qvZoomBtn")?.focus({ preventScroll: true });
  }

  document.getElementById("qvZoomBtn")?.addEventListener("click", abrirZoomDaFoto);
  document.getElementById("qvImage")?.addEventListener("click", abrirZoomDaFoto);
  document.getElementById("qvZoomFechar")?.addEventListener("click", fecharZoomDaFoto);

  if(qvZoomEl){
    qvZoomEl.addEventListener("click", (e) => {
      if(e.target === qvZoomImgEl){
        const alvo = qvZoomImgEl.getBoundingClientRect();
        qvZoomImgEl.style.transformOrigin =
          `${((e.clientX - alvo.left) / alvo.width) * 100}% ${((e.clientY - alvo.top) / alvo.height) * 100}%`;
        qvZoomEl.classList.toggle("is-ampliado");
        return;
      }
      if(!e.target.closest(".qv-zoom-fechar")) fecharZoomDaFoto();
    });

    qvZoomImgEl.addEventListener("pointermove", (e) => {
      if(!qvZoomEl.classList.contains("is-ampliado")) return;
      const alvo = qvZoomImgEl.getBoundingClientRect();
      const x = Math.min(Math.max((e.clientX - alvo.left) / alvo.width, 0), 1);
      const y = Math.min(Math.max((e.clientY - alvo.top) / alvo.height, 0), 1);
      qvZoomImgEl.style.transformOrigin = `${x * 100}% ${y * 100}%`;
    });

    document.addEventListener("keydown", (e) => {
      if(e.key !== "Escape" || qvZoomEl.hidden) return;
      e.stopPropagation();
      fecharZoomDaFoto();
    }, true);
  }

  qvGalleryPrevEl.addEventListener("click", () => setQvPhoto(qvPhotoIndex - 1));
  qvGalleryNextEl.addEventListener("click", () => setQvPhoto(qvPhotoIndex + 1));
  qvGalleryThumbsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".qv-gallery-thumb");
    if(btn) setQvPhoto(Number(btn.dataset.index));
  });
  qvModalEl.addEventListener("keydown", (e) => {
    if(qvPhotos.length <= 1) return;
    if(e.key === "ArrowLeft"){ e.preventDefault(); setQvPhoto(qvPhotoIndex - 1); }
    else if(e.key === "ArrowRight"){ e.preventDefault(); setQvPhoto(qvPhotoIndex + 1); }
  });

  function renderQuickViewPayment(){
    const p = findProduct(qvProductId);
    if(!p) return;
    const total = pricing.round2(p.price * qvQty);
    const pay = pricing.paymentSummaryFor(total);

    qvQtyEl.textContent = qvQty;
    qvPriceEl.textContent = formatMoney(total);
    qvPixPriceEl.textContent = formatMoney(pay.pixPrice);
    qvPixNoteEl.textContent =
      `Economize ${formatMoney(pay.pixSavings)} (${pay.pixDiscountPercent}% de desconto à vista)`;

    qvInstallmentEl.textContent = pay.installment.count > 1
      ? `ou ${pay.installmentLabel}`
      : "à vista ou boleto";
  }

  const qvShareEls = [document.getElementById("qvShare"), document.getElementById("qvShareFab")].filter(Boolean);
  const qvShareFabEl = document.getElementById("qvShareFab");
  const qvShareFabBtn = document.getElementById("qvShareFabBtn");
  const qvShareFabLista = document.getElementById("qvShareFabLista");

  function atualizarCompartilharDoProduto(p){
    const endereco = location.origin + enderecoDoProduto(p);
    const texto = `Olha esse ${p.name} feito à mão 🎀`;
    qvShareEls.forEach(bloco => {
      bloco.dataset.shareUrl = endereco;
      bloco.dataset.shareText = texto;
      if(window.PLCCompartilhar) window.PLCCompartilhar.ligar(bloco);
    });
    fecharCompartilharFlutuante();
  }

  function fecharCompartilharFlutuante(){
    if(!qvShareFabLista || qvShareFabLista.hidden) return;
    qvShareFabLista.hidden = true;
    qvShareFabBtn.setAttribute("aria-expanded", "false");
  }

  if(qvShareFabBtn){
    qvShareFabBtn.addEventListener("click", () => {
      const abrindo = qvShareFabLista.hidden;
      qvShareFabLista.hidden = !abrindo;
      qvShareFabBtn.setAttribute("aria-expanded", String(abrindo));
    });
    document.addEventListener("click", (e) => {
      if(!qvShareFabEl.contains(e.target)) fecharCompartilharFlutuante();
    });
  }

  function openQuickView(id, opts){
    opts = opts || {};
    const p = findProduct(id);
    if(!p) return;
    qvProductId = p.id; qvQty = 1;

    qvSoldOutMsgEl.classList.toggle("d-none", !p.soldOut);
    qvAddBtnEl.disabled = Boolean(p.soldOut);
    qvAddBtnEl.textContent = p.soldOut ? "Esgotado" : "Adicionar ao carrinho";

    document.getElementById("qvName").textContent = p.name;
    document.getElementById("qvDesc").textContent = p.desc;

    const tagsEl = document.getElementById("qvTags");
    if(tagsEl){
      const tags = [];
      if(p.catLabel) tags.push(`<span class="qv-tag is-cat">${escapeHTML(p.catLabel)}</span>`);
      (p.badges || []).forEach(b => tags.push(`<span class="qv-tag is-badge">${escapeHTML(b)}</span>`));
      tagsEl.innerHTML = tags.join("");
      tagsEl.classList.toggle("d-none", tags.length === 0);
    }

    const thumb = document.getElementById("qvThumb");
    const img = document.getElementById("qvImage");
    img.alt = p.name;

    qvPhotos = photosFor(p);
    qvPhotoIndex = 0;
    renderQvGallery();
    if(qvPhotos.length){
      setQvPhoto(0);
    } else {
      img.classList.remove("is-loaded", "is-error");
      thumb.classList.remove("is-loading");
      img.removeAttribute("src");
    }

    renderQuickViewPayment();
    atualizarCompartilharDoProduto(p);
    qvModal.show();
    if(!opts.fromPopState){
      history.pushState({ quickView: id }, "", enderecoDoProduto(p) + location.search);
      qvHistoryPushed = true;
    }
  }
  wireImage(document.getElementById("qvImage"));

  (() => {
    const qvImg = document.getElementById("qvImage");
    if(!qvImg) return;
    qvImg.addEventListener("load", () => {
      if(!qvImg.naturalWidth || !qvImg.naturalHeight) return;
      document.getElementById("qvThumb")
        ?.style.setProperty("--qv-ratio", `${qvImg.naturalWidth} / ${qvImg.naturalHeight}`);
    });
  })();

  grid.addEventListener("click", function(e){
    const addBtn = e.target.closest(".btn-add");
    if(addBtn){
      const id = Number(addBtn.dataset.id);
      const p = findProduct(id);
      if(p?.soldOut){
        showCheckoutHintToast(`${p.name} está esgotado no momento.`);
        return;
      }
      addToCart(id, 1);
      celebrateAddToCart(addBtn, p?.color);
      pulseAddButton(addBtn);
      return;
    }

    const card = e.target.closest(".product-card");
    if(!card) return;
    if(e.target.closest(".product-name-link")) e.preventDefault();
    openQuickView(Number(card.dataset.id));
  });

  grid.addEventListener("keydown", function(e){
    if(e.key !== "Enter" && e.key !== " ") return;
    if(!e.target.classList.contains("product-card")) return;
    e.preventDefault();
    openQuickView(Number(e.target.dataset.id));
  });

  document.getElementById("qvMinus").addEventListener("click", () => {
    qvQty = Math.max(1, qvQty - 1);
    renderQuickViewPayment();
  });
  document.getElementById("qvPlus").addEventListener("click", () => {
    qvQty = Math.min(10, qvQty + 1);
    renderQuickViewPayment();
  });
  document.getElementById("qvAddBtn").addEventListener("click", () => {
    if(qvProductId != null){
      addToCart(qvProductId, qvQty);
      celebrateAddToCart(document.getElementById("qvAddBtn"), findProduct(qvProductId)?.color);
    }
    qvModal.hide();
  });

  const navOffcanvasEl = document.getElementById("navOffcanvas");
  navOffcanvasEl?.addEventListener("click", (e) => {
    if(e.target.closest("a, button")){
      bootstrap.Offcanvas.getInstance(navOffcanvasEl)?.hide();
    }
  });

  document.getElementById("cartContinueLink")?.addEventListener("click", () => {
    bootstrap.Offcanvas.getInstance(document.getElementById("cartOffcanvas"))?.hide();
  });

  document.addEventListener("click", (e) => {
    const link = e.target.closest('a[href^="#"]');
    if(!link) return;
    const id = link.getAttribute("href").slice(1);
    if(!id) return;
    const target = document.getElementById(id);
    if(!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    history.replaceState(null, "", location.pathname + location.search);
  });

  const nav = document.getElementById("mainNav");
  const btnTop = document.getElementById("btnTop");

  const navLinks = [...document.querySelectorAll("#mainNav .plc-nav-link, #mainNav .nav-cta")]
    .filter(a => a.getAttribute("href")?.startsWith("#"));
  const navTargets = navLinks
    .map(a => ({ link:a, section: document.getElementById(a.getAttribute("href").slice(1)) }))
    .filter(t => t.section);
  let activeLink = null;

  function updateActiveSection(){
    if(!navTargets.length) return;
    const line = nav.getBoundingClientRect().bottom + 24;
    let current = null;
    for(const t of navTargets){
      if(t.section.getBoundingClientRect().top <= line) current = t.link;
    }

    if(window.innerHeight + window.scrollY >= document.body.scrollHeight - 2){
      current = navTargets[navTargets.length - 1].link;
    }
    if(current === activeLink) return;
    activeLink?.classList.remove("is-active");
    activeLink?.removeAttribute("aria-current");
    activeLink = current;
    if(activeLink){
      activeLink.classList.add("is-active");
      activeLink.setAttribute("aria-current", "true");
    }
  }

  let scrollTicking = false;
  window.addEventListener("scroll", () => {
    if(scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(() => {
      nav.classList.toggle("is-scrolled", window.scrollY > 40);
      btnTop.classList.toggle("show", window.scrollY > 500);
      updateActiveSection();
      scrollTicking = false;
    });
  }, { passive:true });
  updateActiveSection();

  btnTop.addEventListener("click", () => {
    window.scrollTo({ top:0, behavior:"smooth" });
  });

  async function postForm(url, body){
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if(!res.ok) throw new Error(data.error || "Não foi possível enviar agora. Tente novamente em instantes.");
    return data;
  }

  const contactForm = document.getElementById("contactForm");
  contactForm.addEventListener("submit", async function(e){
    e.preventDefault();
    e.stopPropagation();
    if(!this.checkValidity()){
      this.classList.add("was-validated");
      return;
    }
    const msgEl = document.getElementById("contactMsg");
    const btn = this.querySelector("button[type=submit]");
    btn.disabled = true;
    msgEl.textContent = "Enviando...";
    try{
      await postForm("/api/contact", {
        nome: document.getElementById("contactNome").value.trim(),
        telefone: document.getElementById("contactTelefone").value.trim(),
        ocasiao: document.getElementById("contactOcasiao").value,
        mensagem: document.getElementById("contactMensagem").value.trim(),
      });
      msgEl.textContent = "Mensagem enviada! Responderemos em breve. 🎀";
      this.reset();
      this.classList.remove("was-validated");
    }catch(err){
      console.error("Falha ao enviar contato:", err);
      msgEl.textContent = err.name === "AbortError"
        ? "O envio demorou demais. Tente novamente."
        : err.message;
    }finally{
      btn.disabled = false;
    }
  });

  const payBadgePixEl = document.getElementById("payBadgePix");
  const payBadgeInstallmentsEl = document.getElementById("payBadgeInstallments");
  if(payBadgePixEl){
    payBadgePixEl.textContent = `Pix com ${pricing.PAYMENT_RULES.pixDiscountPercent}% de desconto`;
  }
  if(payBadgeInstallmentsEl){
    const { maxInstallments, interestFreeInstallments, monthlyInterestRate } = pricing.PAYMENT_RULES;
    const semJuros = Math.min(maxInstallments, interestFreeInstallments);
    payBadgeInstallmentsEl.textContent = (monthlyInterestRate > 0 && maxInstallments > semJuros)
      ? `Até ${maxInstallments}x (${semJuros}x sem juros)`
      : `Até ${semJuros}x sem juros`;
  }

  const fabEl = document.querySelector("a.fab:not(.fab-top)");
  const heroAcoesEl = document.querySelector(".hero-acoes");
  if(fabEl && heroAcoesEl && "IntersectionObserver" in window){
    new IntersectionObserver(([entrada]) => {
      fabEl.classList.toggle("is-oculto", entrada.isIntersecting);
    }, { threshold: 0 }).observe(heroAcoesEl);
  }

})();