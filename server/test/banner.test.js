/**
 * Banner do topo da home (blocoBanner em server.js):
 *  - um slide por categoria com produto visível que tem foto, com botão que
 *    abre a categoria na vitrine;
 *  - só o primeiro slide fica fora do <template>, com fetchpriority="high";
 *  - produto escondido não vira slide;
 *  - catálogo sem foto nenhuma cai no slide genérico com img/hero-*;
 *  - nome de produto entra escapado.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const PORT = 39581;
const ORIGIN = `http://localhost:${PORT}`;
const TMP_DB = path.join(os.tmpdir(), `plc-banner-${process.pid}-${Date.now()}.db`);

process.env.DB_PATH = TMP_DB;
const db = require("../lib/db.js");

let child;

before(async () => {
  child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, DB_PATH: TMP_DB, PORT: String(PORT), CLIENT_ORIGIN: ORIGIN, MP_ACCESS_TOKEN: "TEST-fake", NODE_ENV: "test" },
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
  for(const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
});

const home = async () => (await fetch(ORIGIN + "/")).text();
const foto = (n) => `/api/products/photos/${String(n).repeat(32).slice(0, 32)}`;

test("sem produto com foto, entra o slide genérico com a foto fixa", async () => {
  const html = await home();
  assert.match(html, /class="hero-slide banner-slide banner-tema-leque is-ativa is-inicial"/);
  assert.match(html.replace(/<span class="pal"[^>]*>|<\/span>/g, ""), /Laços feitos à mão/);
  assert.match(html, /data-abrir-cat="todos"/);
  assert.match(html, /img\/hero-laco-bailarina-960\.webp/);
});

test("um slide por categoria com foto; só o primeiro fora do <template>", async () => {
  db.upsertProductOverride(1, { photos: [foto(1)] });
  db.upsertProductOverride(7, { photos: [foto(7)] });
  db.upsertProductOverride(6, { photos: [foto(6)] });
  const html = await home();
  const extras = html.indexOf('id="heroSlidesExtras"');
  const antes = html.slice(0, extras);
  const depois = html.slice(extras);
  assert.equal((antes.match(/banner-slide banner-tema-\w+ is-ativa/g) || []).length, 1);
  assert.match(antes, /data-abrir-cat="laco-unico"/);
  assert.match(antes, /fetchpriority="high"/);
  assert.match(antes, new RegExp(`${foto(1)}\\?w=400 400w`));
  assert.ok(!depois.includes('fetchpriority="high"'));
  assert.match(depois, /data-abrir-cat="tiara"/);
  assert.match(depois, /data-abrir-cat="kit"/);
  assert.ok(!html.includes('data-abrir-cat="bolsa"'), "categoria sem produto com foto não vira slide");
});

test("produto escondido não vira slide", async () => {
  db.upsertProductOverride(7, { hidden: true });
  const html = await home();
  assert.ok(!html.includes('data-abrir-cat="tiara"'));
  db.upsertProductOverride(7, { hidden: false });
});

test("nome do produto entra escapado no banner", async () => {
  db.upsertProductOverride(6, { name: "<script>alert(1)</script>" });
  const html = await home();
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("cada categoria tem tema próprio, preço real e número de modelos", async () => {
  db.upsertProductOverride(2, { photos: [foto(2)] });
  const html = await home();
  assert.match(html, /banner-tema-leque[\s\S]*?data-abrir-cat="laco-unico"/);
  assert.match(html, /banner-tema-coroa[\s\S]*?data-abrir-cat="tiara"/);
  assert.match(html, /banner-tema-presente[\s\S]*?data-abrir-cat="kit"/);
  assert.match(html, /a partir de<\/span> <strong>R\$ 29,90<\/strong>/, "menor preço do laço único");
  assert.match(html, /Ver os 6 modelos/, "seis laços únicos visíveis no catálogo fixo");
  assert.match(html, /banner-arte fotos-2/, "leque com duas fotos quando há duas");
  assert.match(html, /banner-mais-vendido/, "Laço Duquesa tem o selo Mais vendido");
});

test("todo slide traz as faíscas; só alguns temas trazem a fita de cetim", async () => {
  const html = await home();
  const slides = html.match(/class="hero-slide banner-slide/g).length;
  assert.equal((html.match(/class="banner-faiscas" aria-hidden="true"/g) || []).length, slides);
  assert.match(html, /banner-tema-leque[\s\S]*?banner-fita-cetim[\s\S]*?banner-foto f1/);
  const coroa = html.slice(html.indexOf("banner-tema-coroa"));
  assert.ok(!coroa.slice(0, coroa.indexOf("banner-foto f1")).includes("banner-fita-cetim"), "coroa tem a coroa como enfeite, sem fita");
});

const fatias = html => html.split('class="hero-slide banner-slide').slice(1);

test("miniaturas das outras fotos da categoria; sem foto analisada, sem bolinhas", async () => {
  for(const id of [3, 4, 5, 8]) db.upsertProductOverride(id, { photos: [foto(id)] });
  const html = await home();
  const leque = fatias(html).find(s => s.startsWith(" banner-tema-leque"));
  assert.match(leque, /class="banner-minis" aria-hidden="true"/);
  assert.equal((leque.match(/\?w=160" alt="" width="40"/g) || []).length, 3, "três fotos que sobraram viram miniatura");
  assert.ok(!leque.includes("e mais"), "sem modelos além das miniaturas, sem 'e mais'");
  assert.ok(!leque.includes("banner-cores"), "foto que não existe no banco não gera cor");
  const kit = fatias(html).find(s => s.startsWith(" banner-tema-presente"));
  assert.ok(!kit.includes("banner-minis"), "categoria sem foto sobrando não traz miniaturas");
});

test("as bolinhas de cor vêm das cores que aparecem nas fotos dos produtos", async () => {
  const sharp = require("sharp");
  const fotoReal = async (esq, dir) => {
    const id = require("node:crypto").randomUUID();
    const meia = (c) => sharp({ create: { width: 32, height: 64, channels: 3, background: c } }).png().toBuffer();
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: esq } })
      .composite([{ input: await meia(dir), left: 32, top: 0 }]).png().toBuffer();
    db.insertProductPhoto(id, "image/png", png);
    return `/api/products/photos/${id}`;
  };
  db.upsertProductOverride(1, { photos: [await fotoReal("#F08CB4", "#5B8FD9")] });
  await home();
  await new Promise(r => setTimeout(r, 1000));
  const html = await home();
  const leque = fatias(html).find(s => s.startsWith(" banner-tema-leque"));
  const cores = leque.match(/<i style="--c:(#[0-9A-F]{6})">/g) || [];
  assert.equal(cores.length, 2, "rosa e azul da foto");
  assert.match(leque, /--c:#(EF|F0)[0-9A-F]{4}"/);
  assert.match(leque, />2 cores</);
});

test("todo slide traz o enfeite do cartão do texto, só decorativo", async () => {
  const html = await home();
  const slides = html.match(/class="hero-slide banner-slide/g).length;
  assert.equal((html.match(/class="banner-texto-enfeite" aria-hidden="true"/g) || []).length, slides);
});

test("o título vem em palavras e não há mais a fita que cobria a troca", async () => {
  const html = await home();
  assert.ok(!html.includes("banner-puxada"));
  assert.match(html, /<p class="banner-titulo"><span class="pal" style="--i:0">/);
});

test("tema de foto única traz até duas fotos de apoio e a caixa de presente nos Kits", async () => {
  let html = await home();
  let kit = fatias(html).find(s => s.startsWith(" banner-tema-presente"));
  assert.ok(!kit.includes("banner-foto apoio"), "categoria com uma foto só não traz apoio");
  assert.match(kit, /class="banner-caixa"/);
  db.upsertProductOverride(4, { category: "kit" });
  db.upsertProductOverride(5, { category: "kit" });
  html = await home();
  kit = fatias(html).find(s => s.startsWith(" banner-tema-presente"));
  assert.equal((kit.match(/class="banner-foto apoio a\d"/g) || []).length, 2);
  assert.ok(!/class="banner-foto apoio[^>]*><img[^>]*alt="[^"]+"/.test(kit), "apoio é decorativo, sem alt");
  const leque = fatias(html).find(s => s.startsWith(" banner-tema-leque"));
  assert.ok(!leque.includes("banner-foto apoio"), "leque já usa várias fotos principais");
});

test("só o primeiro slide nasce montado (is-inicial), os outros mantêm a entrada animada", async () => {
  const html = await home();
  assert.equal((html.match(/class="hero-slide [^"]*is-inicial/g) || []).length, 1);
  assert.match(html, /class="hero-slide banner-slide banner-tema-\w+ is-ativa is-inicial"/);
});

test("a home já traz o catálogo em JSON para a vitrine não esperar a API", async () => {
  const html = await home();
  const m = html.match(/<script type="application\/json" id="produtosIniciais">([\s\S]*?)<\/script>/);
  assert.ok(m, "bloco produtosIniciais na home");
  const dados = JSON.parse(m[1]);
  assert.ok(Array.isArray(dados.products) && dados.products.length > 0);
  assert.ok(Array.isArray(dados.categories));
  assert.ok(!m[1].includes("<"), "nenhum < cru dentro do JSON");
});

test("CSS crítico: depois de calculado, vai no <head> e os CSS grandes descem para o fim do <body>", async () => {
  await home();
  let html = "";
  for(let i = 0; i < 40; i++){
    html = await home();
    if(!/<link rel="stylesheet" href="\/css\/style\.css[^"]*">[\s\S]*<\/head>/.test(html)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const cabeca = html.slice(0, html.indexOf("</head>"));
  assert.ok(!cabeca.includes('href="/css/style.css'), "style.css não bloqueia mais no <head>");
  assert.match(cabeca, /<style>[^<]*\.banner-slide[^<]*<\/style>/, "crítico tem o banner");
  assert.match(cabeca, /<style>[^<]*\.product-card[^<]*<\/style>/, "crítico tem os cartões da vitrine criados pelo JS");
  const corpoFim = html.slice(html.lastIndexOf("</footer>"));
  assert.match(corpoFim, /<link media="print" data-css-tardio rel="stylesheet" href="\/css\/vendor\/bootstrap\.purged\.css[^"]*">\s*<link media="print" data-css-tardio rel="stylesheet" href="\/css\/style\.css[^"]*">\s*<script src="\/js\/css-tardio\.js" async><\/script>\s*<noscript>/,
    "os dois CSS no fim do <body>, na mesma ordem, sem bloquear e com o script que os liga");
});
