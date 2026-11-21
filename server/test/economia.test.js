/**
 * Economia de recursos sem mudar o que a cliente vê. Roda com: node --test
 *
 * O que está trancado aqui:
 *  - o catálogo guardado em cache se renova assim que um produto muda
 *    (nada de vitrine velha depois de editar no painel);
 *  - foto do topo com cache de 1h responde 304 quando o navegador já tem a
 *    mesma, e manda a foto de novo quando ela muda;
 *  - CSS, JS e fotos não consultam a sessão, mas as páginas e a API sim.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const PORT = 39652;
const ORIGIN = `http://localhost:${PORT}`;
const TMP_DB = path.join(os.tmpdir(), `plc-economia-${process.pid}-${Date.now()}.db`);

process.env.DB_PATH = TMP_DB;
const db = require("../lib/db.js");
const sharp = require("sharp");

let child;

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
  for(const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
});

test("catálogo em cache se renova quando um produto muda", async () => {
  const antes = await (await fetch(`${ORIGIN}/api/products`)).json();
  const id = antes.products[0].id;
  await new Promise(r => setTimeout(r, 5));
  db.upsertProductOverride(id, { name: "Nome Novo Do Teste" });
  const depois = await (await fetch(`${ORIGIN}/api/products`)).json();
  assert.equal(depois.products.find(p => p.id === id).name, "Nome Novo Do Teste");
  const home = await (await fetch(`${ORIGIN}/`)).text();
  assert.match(home, /Nome Novo Do Teste/, "a vitrine da home também usa o catálogo novo");
});

test("foto do topo: 304 quando não mudou, foto nova quando mudou", async () => {
  const id = crypto.randomUUID();
  const original = await sharp({ create: { width: 800, height: 1000, channels: 3, background: "#ff8fbe" } }).jpeg().toBuffer();
  db.insertHeroPhoto(id, "alt", "legenda", "center", "image/jpeg", original);
  const url = `${ORIGIN}/api/hero/fotos/${id}?w=480`;
  const primeira = await fetch(url, { headers: { accept: "image/webp" } });
  assert.equal(primeira.status, 200);
  const etag = primeira.headers.get("etag");
  assert.ok(etag, "precisa de ETag para o navegador revalidar");
  assert.ok((await primeira.arrayBuffer()).byteLength > 0);
  // node:http e não fetch: o fetch do Node marca a revalidação manual como
  // sem cache, e o Express então nunca responde 304 (navegador real responde).
  const status = (cabecalhos) => new Promise((ok, falha) => {
    require("node:http").get(url, { headers: cabecalhos }, r => { r.resume(); ok(r.statusCode); }).on("error", falha);
  });
  assert.equal(await status({ accept: "image/webp", "if-none-match": etag }), 304);
  assert.equal(await status({ accept: "image/webp", "if-none-match": 'W/"outra"' }), 200, "ETag diferente recebe a foto inteira");
});

test("arquivos estáticos não consultam a sessão; a API consulta", async () => {
  const fonte = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const m = /const SEM_SESSAO = (\/.*\/);/.exec(fonte);
  assert.ok(m, "regra SEM_SESSAO sumiu");
  const SEM_SESSAO = eval(m[1]);
  for(const p of ["/css/style.css", "/js/main.js", "/img/logo.webp", "/api/products/photos/x", "/api/hero/fotos/x", "/api/avaliacoes/fotos/x", "/api/depoimentos/fotos/x"]){
    assert.ok(SEM_SESSAO.test(p), `${p} devia pular a sessão`);
  }
  for(const p of ["/", "/admin.html", "/conta.html", "/api/products", "/api/me", "/api/admin/products", "/api/orders"]){
    assert.ok(!SEM_SESSAO.test(p), `${p} precisa da sessão`);
  }
});

test("frete grátis não altera a cotação guardada em cache", () => {
  const pricing = require("../js/pricing.js");
  const cotacao = [{ service_id: 1, name: "PAC", price: 20 }, { service_id: 2, name: "SEDEX", price: 30 }];
  const copia = JSON.parse(JSON.stringify(cotacao));
  pricing.aplicarFreteGratis(cotacao, [{ id: 1, qty: 4, price: 32 }], new Date("2026-11-21T12:00:00-03:00"));
  assert.deepEqual(cotacao, copia, "a promoção precisa devolver objetos novos, sem mexer no que fica no cache");
});
