(function(){
  "use strict";

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
