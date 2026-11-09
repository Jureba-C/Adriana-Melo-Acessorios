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
  assert.match(html, /class="hero-slide banner-slide banner-tema-leque is-ativa"/);
  assert.match(html, /Laços feitos à mão/);
  assert.match(html, /data-abrir-cat="todos"/);
  assert.match(html, /img\/hero-laco-bailarina-960\.jpg/);
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
