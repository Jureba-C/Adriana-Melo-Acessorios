/**
 * Depoimentos: elogios que a cliente mandou POR FORA do site (WhatsApp,
 * Instagram) e autorizou publicar. Roda com: node --test
 *
 * O que estes testes trancam, e por quê:
 *  - depoimento NUNCA leva "Compra verificada". Esse selo é afirmação de fato
 *    e, para quem não passou por um pedido no site, seria falsa;
 *  - depoimento NUNCA vira nota. Mensagem de WhatsApp não tem estrela, e
 *    inventar uma é exatamente o que separar as duas tabelas evita;
 *  - avaliação de quem comprou entra NA FRENTE, e empurra o depoimento para
 *    fora sozinha conforme elas chegam;
 *  - sem confirmar que a cliente autorizou, a rota recusa — é a linha entre
 *    publicar elogio real e inventar elogio;
 *  - texto de terceiro nunca vira HTML na home.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const RAIZ = path.join(__dirname, "..");
const PORT = 39580;
const ORIGIN = `http://localhost:${PORT}`;
const ADMIN_EMAIL = "admin-dep@test.com";
const ADMIN_HASH = crypto.createHash("sha256").update(ADMIN_EMAIL).digest("hex");
const TMP_DB = path.join(os.tmpdir(), `plc-dep-${process.pid}-${Date.now()}.db`);

process.env.DB_PATH = TMP_DB;
const db = require("../lib/db.js");
const auth = require("../lib/auth.js");

let child;
let adminCookie;

before(async () => {
  child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.js"], {
    cwd: RAIZ,
    env: {
      ...process.env,
      DB_PATH: TMP_DB, PORT: String(PORT), CLIENT_ORIGIN: ORIGIN,
      ADMIN_2FA_REQUIRED: "false", ADMIN_EMAIL_HASHES: ADMIN_HASH,
      MP_ACCESS_TOKEN: "TEST-fake", NODE_ENV: "test",
    },
    stdio: "ignore",
  });
  const limite = Date.now() + 10000;
  for(;;){
    try { if((await fetch(ORIGIN + "/")).ok) break; } catch {}
    if(Date.now() > limite) throw new Error("servidor de teste não subiu");
    await new Promise(r => setTimeout(r, 200));
  }
  const admin = db.createUser({ name: "Admin", email: ADMIN_EMAIL, passwordHash: await auth.hashPassword("x-123456"), cpf: null });
  const token = crypto.randomBytes(32).toString("hex");
  db.createSession({
    tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
    userId: admin.id, expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  });
  adminCookie = `plc_session=${token}`;
});

after(() => {
  if(child) child.kill();
  for(const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
});

function enviar(campos = {}, cookie){
  const form = new FormData();
  const cheio = {
    texto: "mensagem de teste da cliente", nome: "Teste", cidade: "Brasília/DF",
    origem: "whatsapp", consentimento: "true", ...campos,
  };
  for(const [k, v] of Object.entries(cheio)) if(v !== undefined) form.append(k, v);
  return fetch(`${ORIGIN}/api/admin/depoimentos`, {
    method: "POST",
    headers: { Origin: ORIGIN, Cookie: cookie === undefined ? adminCookie : cookie },
    body: form,
  });
}

async function limpar(){
  const { depoimentos } = await (await fetch(`${ORIGIN}/api/admin/depoimentos`, { headers: { Cookie: adminCookie } })).json();
  for(const d of depoimentos){
    await fetch(`${ORIGIN}/api/admin/depoimentos/${d.id}`, { method: "DELETE", headers: { Origin: ORIGIN, Cookie: adminCookie } });
  }
  for(const r of db.listarAvaliacoesPainel()) db.excluirAvaliacao(r.id);
}

function publicarAvaliacao(ref, productId, comment){
  db.salvarAvaliacao({ orderReference: ref, productId, rating: 5, comment, firstName: "Cliente", city: "Cidade/UF" });
  const linha = db.listarAvaliacoesPainel().find(r => r.order_reference === ref);
  db.mudarStatusAvaliacao(linha.id, "publicada");
}

test("depoimento aparece na home, mas nunca como compra verificada", async () => {
  await limpar();
  assert.equal((await enviar({ texto: "amei demais o laço" })).status, 201);

  const home = await (await fetch(ORIGIN + "/")).text();
  assert.match(home, /amei demais o laço/);
  assert.match(home, /Enviado por WhatsApp/);
  assert.ok(!home.includes("Compra verificada"),
    "depoimento não passou por pedido no site — o selo seria uma afirmação falsa");
});

test("depoimento não vira nota em lugar nenhum", async () => {
  await limpar();
  await enviar({ texto: "chegou lindo" });
  const home = await (await fetch(ORIGIN + "/")).text();

  assert.equal(db.notaMedia().total, 0, "depoimento não pode entrar na média");
  assert.ok(!home.includes("hero-stat-nota"), "sem avaliação real, nenhuma nota no topo");
  assert.ok(home.includes("envio com rastreio"), "a etiqueta do topo segue mostrando um fato real");
  assert.ok(!/\d+ avaliações? verificadas?/.test(home),
    "o resumo com a nota não pode aparecer quando só há depoimento");
});

test("avaliação de quem comprou entra na frente do depoimento", async () => {
  await limpar();
  await enviar({ texto: "depoimento que veio do whatsapp" });
  publicarAvaliacao("DEP-1", 1, "avaliacao de quem comprou");

  const home = await (await fetch(ORIGIN + "/")).text();
  assert.ok(home.indexOf("avaliacao de quem comprou") < home.indexOf("depoimento que veio do whatsapp"),
    "a avaliação verificada tem de vir primeiro");
  assert.match(home, /1 avaliação verificada/);
  assert.match(home, /hero-stat-nota/);
});

test("com 6 avaliações reais, os depoimentos saem sozinhos", async () => {
  await limpar();
  await enviar({ texto: "depoimento que deve sumir" });
  for(let i = 1; i <= 6; i++) publicarAvaliacao(`DEP-CHEIO-${i}`, i, `real ${i}`);

  const home = await (await fetch(ORIGIN + "/")).text();
  assert.ok(!home.includes("depoimento que deve sumir"),
    "a seção só tem 6 lugares: avaliação real empurra o depoimento para fora");
  assert.equal((home.match(/Compra verificada/g) || []).length, 6);
  // Continua cadastrado — só não está sendo exibido. Volta se uma avaliação sair.
  assert.equal(db.contarDepoimentosPublicados(), 1);
});

test("sem confirmar a autorização da cliente, a rota recusa", async () => {
  await limpar();
  const res = await enviar({ consentimento: undefined });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /autorizou/);
  assert.equal((await enviar({ consentimento: "false" })).status, 400);
});

test("texto de depoimento não vira HTML na home", async () => {
  await limpar();
  await enviar({ texto: '"><script>alert(1)</script>', nome: 'x" onload="alert(2)' });
  const home = await (await fetch(ORIGIN + "/")).text();
  assert.ok(!home.includes("<script>alert(1)</script>"));
  assert.ok(!home.includes('onload="alert(2)'));
  assert.match(home, /&lt;script&gt;/);
});

test("sem avaliação e sem depoimento, a home convida em vez de sumir", async () => {
  await limpar();
  const home = await (await fetch(ORIGIN + "/")).text();
  assert.match(home, /Seja a primeira a contar/);
  // A trava histórica continua: nenhuma nota inventada, nenhum resumo.
  assert.ok(!home.includes("O que dizem as clientes"));
  assert.ok(!home.includes("hero-stat-nota"));
  assert.ok(home.includes("envio com rastreio"));
});

test("campos obrigatórios e limites", async () => {
  await limpar();
  assert.equal((await enviar({ texto: "   " })).status, 400);
  assert.equal((await enviar({ nome: "" })).status, 400);
  assert.equal((await enviar({ origem: "tiktok" })).status, 400);
  assert.equal((await enviar({ texto: "x".repeat(601) })).status, 400);
});

test("passa do teto de 6 e o cadastro é recusado", async () => {
  await limpar();
  for(let i = 0; i < 6; i++) assert.equal((await enviar({ texto: `depoimento ${i}` })).status, 201);
  assert.equal((await enviar({ texto: "o sétimo" })).status, 409);
  await limpar();
});

test("editar e reordenar mudam o que sai na home", async () => {
  await limpar();
  const a = (await (await enviar({ texto: "primeiro depoimento" })).json()).id;
  const b = (await (await enviar({ texto: "segundo depoimento" })).json()).id;

  let home = await (await fetch(ORIGIN + "/")).text();
  assert.ok(home.indexOf("primeiro depoimento") < home.indexOf("segundo depoimento"));

  const ordem = await fetch(`${ORIGIN}/api/admin/depoimentos/ordem`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: adminCookie },
    body: JSON.stringify({ ids: [b, a] }),
  });
  assert.equal(ordem.status, 200);
  home = await (await fetch(ORIGIN + "/")).text();
  assert.ok(home.indexOf("segundo depoimento") < home.indexOf("primeiro depoimento"));

  const patch = await fetch(`${ORIGIN}/api/admin/depoimentos/${a}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: adminCookie },
    body: JSON.stringify({ texto: "texto editado", nome: "Teste", cidade: null, origem: "instagram", status: "oculto" }),
  });
  assert.equal(patch.status, 200);
  home = await (await fetch(ORIGIN + "/")).text();
  assert.ok(!home.includes("primeiro depoimento") && !home.includes("texto editado"),
    "depoimento oculto não pode aparecer na home");
});

test("ordem incompleta é recusada", async () => {
  await limpar();
  const a = (await (await enviar({ texto: "um" })).json()).id;
  await enviar({ texto: "dois" });
  const res = await fetch(`${ORIGIN}/api/admin/depoimentos/ordem`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: adminCookie },
    body: JSON.stringify({ ids: [a] }),
  });
  assert.equal(res.status, 409);
});

test("quem não é admin não mexe nos depoimentos", async () => {
  await limpar();
  const id = (await (await enviar({ texto: "para testar acesso" })).json()).id;
  assert.equal((await enviar({}, "")).status, 401);
  for(const [metodo, url] of [
    ["GET", "/api/admin/depoimentos"],
    ["PATCH", `/api/admin/depoimentos/${id}`],
    ["DELETE", `/api/admin/depoimentos/${id}`],
    ["PUT", "/api/admin/depoimentos/ordem"],
  ]){
    const res = await fetch(ORIGIN + url, {
      method: metodo,
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: metodo === "GET" || metodo === "DELETE" ? undefined : JSON.stringify({ ids: [] }),
    });
    assert.equal(res.status, 401, `${metodo} ${url} devia exigir admin`);
  }
  await limpar();
});

test("o JSON-LD continua sem nota agregada", async () => {
  await limpar();
  await enviar({ texto: "depoimento qualquer" });
  publicarAvaliacao("DEP-LD", 1, "avaliacao real");
  const home = await (await fetch(ORIGIN + "/")).text();
  const ld = home.slice(home.indexOf("application/ld+json"), home.indexOf("</script>", home.indexOf("application/ld+json")));
  assert.ok(!ld.includes("aggregateRating"),
    "nota agregada em dados estruturados sem lastro é ação manual do Google");
  assert.ok(!ld.includes('"review"'));
});
