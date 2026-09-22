/**
 * Endereço próprio de cada produto (/laco/<id>-<apelido>).
 * Sobe o server.js num processo à parte, com porta e banco ISOLADOS, igual
 * a hero-fotos.test.js. Roda com: node --test
 *
 * O que estes testes trancam, e por quê:
 *  - o link chega mesmo: "laco" precisa estar na allowlist PUBLIC_TOP_LEVEL,
 *    que roda ~850 linhas antes da rota existir (sem isso, 404 silencioso);
 *  - renomear o produto no painel NÃO pode quebrar link que já circula no
 *    WhatsApp — o apelido velho responde 301 para o canônico, com a query
 *    (utm_source) intacta, senão a origem da visita some;
 *  - endereço que nunca existiu é 404 de verdade, não "soft 404" para a
 *    vitrine, que o Google penaliza e o robô repete para sempre;
 *  - a prévia do WhatsApp é o og: do PRODUTO, e a home continua com o og:
 *    dela (é a mesma página, trocada depois do cache de HTML);
 *  - data-produto sai no <body>: é o que faz a espiada rápida abrir sozinha.
 *    Depende de o <body> ter atributo depois da tag; se alguém mexer no
 *    index.html e isso sumir, o teste tem de gritar.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const PORT = 39585;
const ORIGIN = `http://localhost:${PORT}`;
const TMP_DB = path.join(os.tmpdir(), `plc-laco-${process.pid}-${Date.now()}.db`);

process.env.DB_PATH = TMP_DB;
const db = require("../lib/db.js");

let child;

function limpar(){
  for(const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
}

before(async () => {
  child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      DB_PATH: TMP_DB, PORT: String(PORT), CLIENT_ORIGIN: ORIGIN,
      ADMIN_2FA_REQUIRED: "false", MP_ACCESS_TOKEN: "TEST-fake", NODE_ENV: "test",
    },
    stdio: "ignore",
  });
  const limite = Date.now() + 10000;
  for(;;){
    try { if((await fetch(ORIGIN + "/")).ok) break; } catch {}
    if(Date.now() > limite) throw new Error("servidor de teste não subiu");
    await new Promise(r => setTimeout(r, 200));
  }
});

after(() => {
  if(child) child.kill();
  limpar();
});

test("o link canônico do produto responde 200 com a prévia daquele laço", async () => {
  const res = await fetch(`${ORIGIN}/laco/2-laco-duquesa`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<meta property="og:title" content="Laço Duquesa — Adriana Melo Acessórios">/);
  assert.match(html, /<meta property="og:url" content="[^"]*\/laco\/2-laco-duquesa">/);
  assert.match(html, /<link rel="canonical" href="[^"]*\/laco\/2-laco-duquesa">/);
  assert.match(html, /<meta property="product:price:amount" content="49\.90">/);
  assert.match(html, /<title>Laço Duquesa — Adriana Melo Acessórios<\/title>/);
});

test("a espiada rápida abre sozinha: data-produto sai no body", async () => {
  const html = await (await fetch(`${ORIGIN}/laco/2-laco-duquesa`)).text();
  assert.match(html, /<body data-produto="2"/);
});

test("a home continua com a prévia da loja, não a de um produto", async () => {
  const html = await (await fetch(`${ORIGIN}/`)).text();
  assert.match(html, /<meta property="og:type" content="website">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/adrianameloacessorios\.com\/">/);
  assert.doesNotMatch(html, /data-produto=/);
  assert.doesNotMatch(html, /<!--#META-SOCIAL#-->/);
});

test("produto renomeado: o link velho leva ao produto, com a query intacta", async () => {
  db.upsertProductOverride(2, { name: "Laço Duquesa Luxo" });
  const res = await fetch(`${ORIGIN}/laco/2-laco-duquesa?utm_source=whatsapp`, { redirect: "manual" });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "/laco/2-laco-duquesa-luxo?utm_source=whatsapp");

  const seguido = await fetch(`${ORIGIN}/laco/2-laco-duquesa?utm_source=whatsapp`);
  assert.equal(seguido.status, 200);
  assert.match(await seguido.text(), /og:title" content="Laço Duquesa Luxo/);
  db.upsertProductOverride(2, { name: "Laço Duquesa" });
});

test("endereço que não existe é 404, não desvio para a vitrine", async () => {
  for(const caminho of ["/laco/999999-nao-existe", "/laco/sem-id", "/laco/0-zero"]){
    const res = await fetch(ORIGIN + caminho, { redirect: "manual" });
    assert.equal(res.status, 404, caminho);
  }
});

test("produto escondido pelo painel leva à vitrine, porque pode voltar", async () => {
  db.upsertProductOverride(3, { hidden: true });
  const res = await fetch(`${ORIGIN}/laco/3-laco-recem-nascida`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/#colecoes");
  db.upsertProductOverride(3, { hidden: false });
});

test("nome de produto com aspas ou HTML não escapa para dentro da tag", async () => {
  db.upsertProductOverride(4, { name: 'Laço "Pérola" <script>alert(1)</script>' });
  const html = await (await fetch(`${ORIGIN}/laco/4-laco-perola-script-alert-1-script`)).text();
  assert.doesNotMatch(html, /<meta property="og:title" content="[^"]*<script>/);
  assert.match(html, /&quot;Pérola&quot;/);
  db.upsertProductOverride(4, { name: "Laço Pérola" });
});

test("esgotado continua com página, só muda a disponibilidade anunciada", async () => {
  db.upsertProductOverride(5, { soldOut: true });
  const html = await (await fetch(`${ORIGIN}/laco/5-laco-borboleta`)).text();
  assert.match(html, /<meta property="product:availability" content="out of stock">/);
  db.upsertProductOverride(5, { soldOut: false });
});

test("o sitemap lista cada laço visível e some com o escondido", async () => {
  const xml = await (await fetch(`${ORIGIN}/sitemap.xml`)).text();
  assert.match(xml, /<loc>https:\/\/adrianameloacessorios\.com\/<\/loc>/);
  assert.match(xml, /<loc>[^<]*\/laco\/2-laco-duquesa<\/loc>/);

  db.upsertProductOverride(7, { hidden: true });
  const depois = await (await fetch(`${ORIGIN}/sitemap.xml`)).text();
  assert.doesNotMatch(depois, /\/laco\/7-/);
  db.upsertProductOverride(7, { hidden: false });
});

test("a página do laço tem dados estruturados de produto, sem nota inventada", async () => {
  const html = await (await fetch(`${ORIGIN}/laco/2-laco-duquesa`)).text();
  const blocos = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(m => JSON.parse(m[1].replace(/\\u003c/g, "<")));
  const produto = blocos.find(b => b["@type"] === "Product");
  assert.ok(produto, "faltou o bloco Product");
  assert.equal(produto.name, "Laço Duquesa");
  assert.equal(produto.offers.price, "49.90");
  assert.equal(produto.offers.availability, "https://schema.org/InStock");
  assert.match(produto.url, /\/laco\/2-laco-duquesa$/);
  assert.doesNotMatch(html, /aggregateRating/);
});

test("a home não carrega dados de um produto só", async () => {
  const html = await (await fetch(`${ORIGIN}/`)).text();
  assert.doesNotMatch(html, /<!--#DADOS-PRODUTO#-->/);
  const blocos = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(blocos.length, 1);
});

test("oferta do catálogo aponta para o endereço do laço, não para a vitrine", async () => {
  const html = await (await fetch(`${ORIGIN}/`)).text();
  const grafo = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1].replace(/\\u003c/g, "<"));
  const lista = grafo["@graph"].find(n => n["@type"] === "ItemList");
  assert.match(lista.itemListElement[0].item.offers.url, /\/laco\/\d+-/);
  assert.deepEqual(lista.itemListElement.map(l => l.position), lista.itemListElement.map((_, i) => i + 1));
});
