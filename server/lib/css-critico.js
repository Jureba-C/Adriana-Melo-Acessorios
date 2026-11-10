"use strict";

/* =========================================================================
   CSS crítico da home
   -------------------------------------------------------------------------
   bootstrap.purged.css + style.css (~280 KB) bloqueavam a primeira pintura.
   Aqui o beasties calcula, a partir do HTML da home, as regras que casam com
   algum elemento da página; elas vão num <style> no <head> e os dois <link>
   descem para o fim do <body> com media="print" (baixam sem bloquear a
   pintura). O js/css-tardio.js, async logo depois deles, troca para "all";
   a CSP não deixa fazer isso com onload inline. Sem JS, o <noscript> carrega
   os mesmos arquivos do jeito normal. Só descer para o body não basta: o
   Chrome trata <link> no body como bloqueante para o que vem depois.

   ⚠️ A cascata final é a mesma de antes: o style.css inteiro continua vindo
   por último, então qualquer regra repetida no crítico perde para a cópia
   dele, como era sem o crítico.

   ⚠️ O cálculo leva ~100 ms de CPU, então é feito em segundo plano (igual ao
   brotli do lib/precompress.js): o pedido que encontra o cache vazio recebe a
   home como sempre foi e dispara o cálculo para os próximos. A chave junta o
   mtime dos arquivos e os temas do banner presentes no HTML (são eles que
   mudam as classes da página), então editar o CSS ou o HTML recalcula
   sozinho. A versão do catálogo NÃO entra: ela muda a cada variante de foto
   gerada e deixaria o cache sempre frio.
========================================================================= */

const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

// O que o JS cria depois do HTML e já aparece na primeira tela: os cartões
// da vitrine e os pontinhos/pausa do banner. Sem isso eles piscariam sem
// estilo até o CSS do fim do <body> chegar.
const SEMPRE_INCLUIR = [/^\.(product-|hero-ponto|hero-pausa|col-|row)/];

const LINK_BLOQUEANTE = /<link rel="stylesheet" href="\/css\/(?:vendor\/bootstrap\.purged|style)\.css[^"]*">\n?/g;

function criarCssCritico(raiz){
  let pronto = null;
  let calculando = null;

  function chaveAtual(html){
    const m = (rel) => { try { return fs.statSync(path.join(raiz, rel)).mtimeMs; } catch { return 0; } };
    const temas = [...new Set(html.match(/banner-tema-[\w-]+/g) || [])].sort().join(",");
    return `${temas}:${m("css/style.css")}:${m("css/vendor/bootstrap.purged.css")}:${m("index.html")}`;
  }

  function calcular(html, chave){
    calculando = chave;
    const Beasties = require("beasties");
    const beasties = new Beasties({
      path: raiz, publicPath: "/", preload: "body", logLevel: "silent",
      reduceInlineStyles: false, pruneSource: false, keyframes: "critical",
      allowRules: SEMPRE_INCLUIR,
    });
    const semVersao = html.replace(/(\/css\/[^"?]+\.css)\?v=[^"]*/g, "$1");
    const antes = new Set(semVersao.match(/<style>[\s\S]*?<\/style>/g) || []);
    beasties.process(semVersao)
      .then(saida => {
        const novos = (saida.match(/<style>[\s\S]*?<\/style>/g) || []).filter(s => !antes.has(s));
        const css = novos.map(s => s.slice(7, -8)).join("\n");
        if(!css) throw new Error("beasties não devolveu CSS crítico");
        return esbuild.transform(css, { loader: "css", minify: true, legalComments: "none", charset: "utf8" });
      })
      .then(({ code }) => { pronto = { chave, css: code }; })
      .catch(err => console.error("CSS crítico não calculado:", err.message || err))
      .finally(() => { if(calculando === chave) calculando = null; });
  }

  return function aplicar(html){
    const links = html.match(LINK_BLOQUEANTE);
    if(!links || links.length !== 2) return html;
    const chave = chaveAtual(html);
    if(!pronto || pronto.chave !== chave){
      if(calculando !== chave) calcular(html, chave);
      return html;
    }
    let primeiro = true;
    const semLinks = html.replace(LINK_BLOQUEANTE, () => {
      if(!primeiro) return "";
      primeiro = false;
      return `<style>${pronto.css}</style>\n`;
    });
    const fim = semLinks.lastIndexOf("</body>");
    if(fim < 0) return html;
    const tardios = links.map(l => l.trim().replace("<link ", '<link media="print" data-css-tardio ')).join("\n");
    const semJs = `<noscript>${links.map(l => l.trim()).join("")}</noscript>`;
    return semLinks.slice(0, fim) + `${tardios}\n<script src="/js/css-tardio.js" async></script>\n${semJs}\n` + semLinks.slice(fim);
  };
}

module.exports = { criarCssCritico };
