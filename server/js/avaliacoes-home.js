(function(){
  "use strict";

  const modalEl = document.getElementById("avaliacaoFotoModal");
  if(modalEl && window.bootstrap){
    const imagem = document.getElementById("avaliacaoFotoImagem");
    const legenda = document.getElementById("avaliacaoFotoLegenda");
    const vazio = imagem.getAttribute("src");
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    let origem = null;

    document.addEventListener("click", (e) => {
      const botao = e.target.closest(".avaliacao-foto-botao");
      if(!botao) return;
      imagem.src = botao.dataset.foto;
      imagem.alt = botao.dataset.legenda || "Foto enviada pela cliente";
      legenda.textContent = botao.dataset.legenda || "";
      origem = botao;
      modal.show();
    });

    modalEl.addEventListener("click", (e) => {
      if(e.target.closest(".modal-content") && !e.target.closest(".avaliacao-foto-ampliada, .avaliacao-foto-fechar")) modal.hide();
    });

    let inicioY = 0;
    modalEl.addEventListener("touchstart", (e) => { inicioY = e.touches[0].clientY; }, { passive: true });
    modalEl.addEventListener("touchend", (e) => {
      if(e.changedTouches[0].clientY - inicioY > 70) modal.hide();
    }, { passive: true });

    modalEl.addEventListener("hidden.bs.modal", () => {
      imagem.src = vazio;
      legenda.textContent = "";
      if(origem && origem.isConnected) origem.focus({ preventScroll: true });
      origem = null;
    });
  }

  const grade = document.querySelector(".avaliacoes-grade");
  const pontos = [...document.querySelectorAll(".avaliacoes-ponto")];
  if(!grade || pontos.length < 2) return;

  const cards = [...grade.children];
  let agendado = false;

  function atualizar(){
    agendado = false;
    const inicio = grade.getBoundingClientRect().left;
    let atual = 0;
    let menor = Infinity;
    cards.forEach((card, i) => {
      const distancia = Math.abs(card.getBoundingClientRect().left - inicio);
      if(distancia < menor){ menor = distancia; atual = i; }
    });
    if(grade.scrollLeft + grade.clientWidth >= grade.scrollWidth - 4) atual = cards.length - 1;
    pontos.forEach((ponto, i) => ponto.classList.toggle("is-ativo", i === atual));
  }

  grade.addEventListener("scroll", () => {
    if(agendado) return;
    agendado = true;
    requestAnimationFrame(atualizar);
  }, { passive: true });
})();
