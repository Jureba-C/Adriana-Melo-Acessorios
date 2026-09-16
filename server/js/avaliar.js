(function(){
  "use strict";

  const LADO_MAXIMO_FOTO = 1600;
  const ROTULOS_NOTA = ["", "Não gostei", "Poderia ser melhor", "Gostei", "Gostei muito", "Amei!"];

  const params = new URLSearchParams(location.search);
  const referencia = params.get("pedido") || "";
  const token = new URLSearchParams(location.hash.slice(1)).get("t") || "";

  const el = {
    titulo: document.getElementById("avaliarTitulo"),
    carregando: document.getElementById("avaliarCarregando"),
    invalido: document.getElementById("avaliarInvalido"),
    confirmar: document.getElementById("avaliarConfirmar"),
    recebiBtn: document.getElementById("avaliarRecebiBtn"),
    recebiErro: document.getElementById("avaliarRecebiErro"),
    form: document.getElementById("avaliarForm"),
    produtos: document.getElementById("avaliarProdutos"),
    erro: document.getElementById("avaliarErro"),
    enviarBtn: document.getElementById("avaliarEnviarBtn"),
    obrigado: document.getElementById("avaliarObrigado"),
    obrigadoTexto: document.getElementById("avaliarObrigadoTexto"),
  };

  const estado = new Map();

  function mostrar(qual){
    for(const chave of ["carregando", "invalido", "confirmar", "form", "obrigado"]){
      el[chave].classList.toggle("d-none", chave !== qual);
    }
  }

  function escapeHTML(texto){
    return String(texto ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  }

  function cabecalhos(){
    return { "X-Avaliar-Token": token };
  }

  async function lerJson(res){
    try{ return await res.json(); }catch{ return {}; }
  }

  async function carregar(){
    if(!referencia || !token){ mostrar("invalido"); return; }
    mostrar("carregando");
    try{
      const res = await fetch(`/api/avaliar/${encodeURIComponent(referencia)}`, { headers: cabecalhos() });
      if(res.status === 404){ mostrar("invalido"); return; }
      if(!res.ok) throw new Error();
      render(await res.json());
    }catch{
      el.invalido.querySelector("p").textContent = "Não conseguimos carregar seu pedido agora. Tente de novo em alguns minutos.";
      mostrar("invalido");
    }
  }

  function render(pedido){
    el.titulo.textContent = `Pedido #${pedido.reference.slice(0, 8)}`;
    if(pedido.fulfillmentStatus === "postado"){ mostrar("confirmar"); return; }
    if(pedido.fulfillmentStatus !== "entregue"){
      el.invalido.querySelector("p").textContent = "Seu pedido ainda está sendo preparado. Assim que ele chegar, você poderá avaliar por aqui.";
      mostrar("invalido");
      return;
    }

    const jaFeitas = new Map(pedido.avaliacoes.map(a => [a.productId, a]));
    const abertos = pedido.produtos.filter(p => {
      const feita = jaFeitas.get(p.id);
      return !feita || feita.status === "pendente";
    });
    if(abertos.length === 0){
      el.obrigadoTexto.textContent = "Você já avaliou este pedido. A gente lê cada avaliação com carinho.";
      mostrar("obrigado");
      return;
    }

    estado.clear();
    el.produtos.innerHTML = abertos.map(p => {
      const feita = jaFeitas.get(p.id);
      estado.set(p.id, { nota: feita?.rating || 0, foto: null });
      return cartaoProduto(p, feita);
    }).join("");
    for(const p of abertos) pintarEstrelas(p.id);
    mostrar("form");
  }

  function miniatura(url){
    if(!url) return `<div class="avaliar-thumb avaliar-thumb-vazia" aria-hidden="true"><i class="bi bi-heart-fill"></i></div>`;
    const src = url.startsWith("/api/products/photos/") ? `${url}?w=160` : url;
    return `<img class="avaliar-thumb" src="${escapeHTML(src)}" alt="" width="64" height="64" loading="lazy">`;
  }

  function cartaoProduto(p, feita){
    const id = p.id;
    const estrelas = [1, 2, 3, 4, 5].map(n => `
      <button type="button" class="avaliar-estrela" data-produto="${id}" data-nota="${n}"
              role="radio" aria-checked="false" aria-label="${n} ${n === 1 ? "estrela" : "estrelas"}">
        <i class="bi bi-star-fill" aria-hidden="true"></i>
      </button>`).join("");
    return `
      <section class="avaliar-produto" data-produto="${id}">
        <div class="avaliar-produto-topo">
          ${miniatura(p.photoUrl)}
          <div>
            <h2 class="avaliar-produto-nome">${escapeHTML(p.name)}</h2>
            ${feita ? `<span class="small avaliar-ja-enviada">Você já enviou — pode ajustar antes de publicarmos.</span>` : ""}
          </div>
        </div>
        <div class="avaliar-estrelas" role="radiogroup" aria-label="Sua nota para ${escapeHTML(p.name)}">${estrelas}</div>
        <p class="small avaliar-rotulo-nota" id="rotulo-${id}" aria-live="polite"></p>
        <label class="visually-hidden" for="comentario-${id}">Comentário sobre ${escapeHTML(p.name)}</label>
        <textarea class="form-control avaliar-comentario" id="comentario-${id}" rows="3" maxlength="1000"
                  placeholder="Conte o que achou (opcional)">${escapeHTML(feita?.comment || "")}</textarea>

        <div class="avaliar-foto">
          <input type="file" accept="image/jpeg,image/png,image/webp" id="foto-${id}" class="visually-hidden avaliar-foto-input" data-produto="${id}">
          <label for="foto-${id}" class="btn-outline-blush btn-sm-blush avaliar-foto-botao"><i class="bi bi-image me-1"></i>Adicionar foto (opcional)</label>
          <div class="avaliar-foto-previa d-none" id="previa-${id}">
            <img alt="Prévia da foto escolhida" id="previa-img-${id}">
            <button type="button" class="avaliar-foto-remover" data-produto="${id}">Remover foto</button>
          </div>
          <div class="form-check consent-check avaliar-consentimento d-none" id="consent-wrap-${id}">
            <input class="form-check-input" type="checkbox" id="consent-${id}">
            <label class="form-check-label small" for="consent-${id}">
              Autorizo publicar esta foto no site da Adriana Melo Acessórios. Se aparece uma criança, sou responsável por ela.
            </label>
          </div>
        </div>
      </section>`;
  }

  function pintarEstrelas(id){
    const nota = estado.get(id)?.nota || 0;
    el.produtos.querySelectorAll(`.avaliar-estrela[data-produto="${id}"]`).forEach(botao => {
      const n = Number(botao.dataset.nota);
      botao.classList.toggle("is-acesa", n <= nota);
      botao.setAttribute("aria-checked", String(n === nota));
    });
    const rotulo = document.getElementById(`rotulo-${id}`);
    if(rotulo) rotulo.textContent = ROTULOS_NOTA[nota] || "";
  }

  async function reduzirFoto(arquivo){
    let bitmap;
    try{
      bitmap = await createImageBitmap(arquivo, { imageOrientation: "from-image" });
    }catch{
      bitmap = await new Promise((resolve, reject) => {
        const leitor = new FileReader();
        leitor.onload = () => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = leitor.result;
        };
        leitor.onerror = reject;
        leitor.readAsDataURL(arquivo);
      });
    }
    const escala = Math.min(1, LADO_MAXIMO_FOTO / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * escala);
    canvas.height = Math.round(bitmap.height * escala);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return { blob, previa: canvas.toDataURL("image/jpeg", 0.6) };
  }

  el.produtos.addEventListener("click", (e) => {
    const estrela = e.target.closest(".avaliar-estrela");
    if(estrela){
      const id = Number(estrela.dataset.produto);
      estado.get(id).nota = Number(estrela.dataset.nota);
      pintarEstrelas(id);
      esconderErro();
      return;
    }
    const remover = e.target.closest(".avaliar-foto-remover");
    if(remover){
      const id = Number(remover.dataset.produto);
      estado.get(id).foto = null;
      document.getElementById(`foto-${id}`).value = "";
      document.getElementById(`previa-${id}`).classList.add("d-none");
      document.getElementById(`consent-wrap-${id}`).classList.add("d-none");
      document.getElementById(`consent-${id}`).checked = false;
    }
  });

  el.produtos.addEventListener("change", async (e) => {
    const input = e.target.closest(".avaliar-foto-input");
    if(!input || !input.files?.[0]) return;
    const id = Number(input.dataset.produto);
    esconderErro();
    try{
      const { blob, previa } = await reduzirFoto(input.files[0]);
      if(!blob) throw new Error();
      estado.get(id).foto = blob;
      document.getElementById(`previa-img-${id}`).src = previa;
      document.getElementById(`previa-${id}`).classList.remove("d-none");
      document.getElementById(`consent-wrap-${id}`).classList.remove("d-none");
    }catch{
      input.value = "";
      mostrarErro("Não conseguimos abrir essa foto. Tente outra imagem (JPG ou PNG).");
    }
  });

  function mostrarErro(msg){
    el.erro.textContent = msg;
    el.erro.classList.remove("d-none");
  }
  function esconderErro(){ el.erro.classList.add("d-none"); }

  el.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    esconderErro();

    const avaliacoes = [];
    const dados = new FormData();
    for(const [id, item] of estado){
      if(!item.nota) continue;
      const autorizaFoto = document.getElementById(`consent-${id}`)?.checked === true;
      if(item.foto && !autorizaFoto){
        mostrarErro("Para enviar a foto, marque a autorização logo abaixo dela — ou toque em \"Remover foto\".");
        document.getElementById(`consent-${id}`)?.focus();
        return;
      }
      avaliacoes.push({
        productId: id,
        rating: item.nota,
        comment: document.getElementById(`comentario-${id}`)?.value || "",
        autorizaFoto,
      });
      if(item.foto) dados.append(`foto-${id}`, item.foto, `foto-${id}.jpg`);
    }
    if(avaliacoes.length === 0){
      mostrarErro("Escolha as estrelas de pelo menos uma peça.");
      return;
    }
    dados.append("avaliacoes", JSON.stringify(avaliacoes));

    const rotulo = el.enviarBtn.innerHTML;
    el.enviarBtn.disabled = true;
    el.enviarBtn.textContent = "Enviando...";
    try{
      const res = await fetch(`/api/avaliar/${encodeURIComponent(referencia)}`, {
        method: "POST", headers: cabecalhos(), body: dados,
      });
      const corpo = await lerJson(res);
      if(!res.ok) throw new Error(corpo.error || "Não foi possível enviar agora. Tente de novo.");
      el.obrigadoTexto.textContent = "Sua avaliação chegou na loja. Depois que a gente ler, ela aparece no site.";
      mostrar("obrigado");
      window.scrollTo({ top: 0, behavior: "smooth" });
    }catch(err){
      mostrarErro(err.message || "Não foi possível enviar agora. Tente de novo.");
    }finally{
      el.enviarBtn.disabled = false;
      el.enviarBtn.innerHTML = rotulo;
    }
  });

  el.recebiBtn.addEventListener("click", async () => {
    el.recebiBtn.disabled = true;
    el.recebiErro.classList.add("d-none");
    try{
      const res = await fetch(`/api/avaliar/${encodeURIComponent(referencia)}/recebi`, {
        method: "POST", headers: cabecalhos(),
      });
      const corpo = await lerJson(res);
      if(!res.ok) throw new Error(corpo.error || "Não foi possível confirmar agora.");
      await carregar();
    }catch(err){
      el.recebiErro.textContent = err.message || "Não foi possível confirmar agora. Tente de novo.";
      el.recebiErro.classList.remove("d-none");
    }finally{
      el.recebiBtn.disabled = false;
    }
  });

  carregar();
})();
