"use strict";

/* =========================================================================
   Cache de CSS/JS comprimidos em brotli 11
   -------------------------------------------------------------------------
   O compression() do server.js comprime toda resposta na hora, então tem de
   usar uma qualidade barata (6, ver o comentário lá). Para os arquivos
   estáticos isso é desperdício: eles só mudam quando alguém edita o
   repositório, então dá para pagar o brotli caro UMA vez e guardar o
   resultado. Medido nos arquivos reais da home:

     css/style.css  q6: 32.253 B / 2 ms   →  q11: 28.349 B / 127 ms
     js/main.js     q6: 16.356 B / 1 ms   →  q11: 14.983 B /  44 ms

   ⚠️ Por que o cache é preenchido DEPOIS de responder, e não na subida nem no
   primeiro pedido: 127 ms de brotli é bloqueio de event loop. Fazer isso no
   boot somaria ~500 ms a toda partida — e o Passenger hiberna o processo
   quando o site fica sem visita, então essa conta cairia justamente em quem
   acordasse o site. Fazer no primeiro pedido travaria a primeira visitante.
   Assim o primeiro pedido de cada arquivo sai pelo caminho normal (q6, já
   bom) e os seguintes pegam o q11 pronto.

   A chave de invalidação é "mtimeMs:size", a mesma de versaoDoAsset no
   server.js: editar o arquivo troca a assinatura e a entrada velha é
   descartada sozinha.
========================================================================= */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const etag = require("etag");

const QUALIDADE = 11;
// Teto por arquivo. Não é para poupar memória (o conjunto todo dá ~155 KB),
// é para um arquivo gigante entrando por engano em css/ ou js/ não virar um
// brotli 11 de vários segundos segurando um thread do pool.
const TAMANHO_MAXIMO = 2 * 1024 * 1024;

// Escrito exatamente como o express.static escreve (minúsculo): é o mesmo
// arquivo saindo por dois caminhos, e um Content-Type diferente entre eles é
// ruído que aparece em qualquer comparação e faz perder tempo à toa.
const TIPOS = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

function criarPrecompressor(raiz, { revalidarSempre }){
  const cache = new Map();
  const emAndamento = new Set();

  function assinaturaDe(st){
    return `${st.mtimeMs}:${st.size}`;
  }

  function preencher(absoluto, assinatura){
    if(emAndamento.has(absoluto)) return;
    emAndamento.add(absoluto);
    fs.readFile(absoluto, (erroLeitura, bruto) => {
      if(erroLeitura){ emAndamento.delete(absoluto); return; }
      zlib.brotliCompress(bruto, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: QUALIDADE,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: bruto.length,
        },
      }, (erro, comprimido) => {
        emAndamento.delete(absoluto);
        // Só vale guardar se realmente ficou menor que o original; um arquivo
        // já comprimido (ou minúsculo) pode crescer.
        if(!erro && comprimido.length < bruto.length){
          cache.set(absoluto, { assinatura, br: comprimido });
        }
      });
    });
  }

  return function precompressor(req, res, next){
    if(req.method !== "GET" && req.method !== "HEAD") return next();
    // Range pede um pedaço do corpo; servir o arquivo comprimido inteiro no
    // lugar entregaria bytes errados.
    if(req.headers.range) return next();

    const rota = req.path;
    if(!rota.startsWith("/css/") && !rota.startsWith("/js/")) return next();
    const tipo = TIPOS[path.extname(rota).toLowerCase()];
    if(!tipo) return next();
    if(!req.acceptsEncodings("br")) return next();

    const absoluto = path.join(raiz, rota);
    if(!absoluto.startsWith(raiz + path.sep)) return next();

    let st;
    try { st = fs.statSync(absoluto); } catch { return next(); }
    if(!st.isFile() || st.size > TAMANHO_MAXIMO) return next();

    const assinatura = assinaturaDe(st);
    const guardado = cache.get(absoluto);
    if(!guardado || guardado.assinatura !== assinatura){
      preencher(absoluto, assinatura);
      return next();
    }

    // O ETag sai do stat pelo MESMO pacote e no MESMO formato (fraco) que o
    // express.static usa, e não do corpo comprimido: assim o identificador de um
    // arquivo é o mesmo tenha ele saído daqui ou do caminho normal. Com um ETag
    // diferente por caminho, quem voltasse ao site baixaria tudo de novo à toa.
    const marca = etag(st);
    res.setHeader("ETag", marca);
    res.setHeader("Last-Modified", st.mtime.toUTCString());
    res.setHeader("Content-Type", tipo);
    res.setHeader("Content-Encoding", "br");
    res.vary("Accept-Encoding");
    res.setHeader("Cache-Control", cacheControlPara(rota, req, revalidarSempre));

    // Mesma regra do express.static: se o navegador já tem esta versão,
    // 304 sem corpo.
    const seNaoBater = req.headers["if-none-match"];
    // Comparação fraca (o "W/" na frente é ignorado), que é o que a especificação
    // manda para If-None-Match — e o etag do express.static é fraco.
    const semPrefixo = (v) => v.trim().replace(/^W\//, "");
    if(seNaoBater && seNaoBater.split(",").some(v => semPrefixo(v) === semPrefixo(marca))){
      res.removeHeader("Content-Encoding");
      res.removeHeader("Content-Type");
      return res.status(304).end();
    }

    res.setHeader("Content-Length", guardado.br.length);
    if(req.method === "HEAD") return res.status(200).end();
    return res.status(200).end(guardado.br);
  };
}

/* Copia a decisão do setHeaders do express.static (server.js). Se as duas
   discordarem, o mesmo arquivo passa a ter validade diferente conforme o
   navegador aceite brotli ou não. */
function cacheControlPara(rota, req, revalidarSempre){
  if(!revalidarSempre.test(rota)) return "public, max-age=31536000";
  return req.query && req.query.v
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

module.exports = { criarPrecompressor };
