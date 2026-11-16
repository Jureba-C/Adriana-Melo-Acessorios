/**
 * Black Friday: slide do banner e faixa do topo só enquanto a promoção de
 * frete grátis vale; depois da data, a home volta ao que era.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const ORIGIN_DE = (porta) => `http://localhost:${porta}`;
const subir = async (porta, ate) => {
  const db = path.join(os.tmpdir(), `plc-bf-${process.pid}-${porta}-${Date.now()}.db`);
  const filho = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, DB_PATH: db, PORT: String(porta), CLIENT_ORIGIN: ORIGIN_DE(porta), MP_ACCESS_TOKEN: "TEST-fake", NODE_ENV: "test", FRETE_GRATIS_ATE: ate },
    stdio: "ignore",
  });
  const limite = Date.now() + 10000;
  for(;;){
    try { if((await fetch(ORIGIN_DE(porta) + "/")).ok) break; } catch {}
    if(Date.now() > limite) throw new Error("servidor de teste não subiu");
    await new Promise(r => setTimeout(r, 200));
  }
  return { filho, db };
};

const ligado = { porta: 39641, ate: "2099-01-01T00:00:00-03:00" };
const desligado = { porta: 39642, ate: "2000-01-01T00:00:00-03:00" };
let a, b;

before(async () => {
  a = await subir(ligado.porta, ligado.ate);
  b = await subir(desligado.porta, desligado.ate);
  process.env.DB_PATH = a.db;
  const db = require("../lib/db.js");
  db.upsertProductOverride(1, { photos: ["/api/products/photos/11111111111111111111111111111111"] });
});

after(() => {
  for(const x of [a, b]){
    if(!x) continue;
    x.filho.kill();
    for(const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(x.db + s); } catch {} }
  }
});

test("com a promoção valendo, o 1º slide é a Black Friday e a faixa do topo anuncia o frete grátis", async () => {
  let html = "";
  for(let i = 0; i < 30; i++){
    html = await (await fetch(ORIGIN_DE(ligado.porta) + "/")).text();
    if(html.includes("banner-bf")) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.match(html, /id="faixaPromoBF"/);
  assert.match(html, /class="hero-slide banner-slide banner-tema-leque banner-bf is-ativa is-inicial"/);
  assert.match(html, /Frete grátis/);
  assert.match(html, /a partir de R\$ 89,99/);
  assert.match(html, /até 30\/11, na opção de frete mais econômica/);
  assert.match(html, /data-abrir-cat="todos"/);
});

test("depois da data, nenhum sinal da promoção na home", async () => {
  const html = await (await fetch(ORIGIN_DE(desligado.porta) + "/")).text();
  assert.ok(!html.includes("banner-bf"));
  assert.ok(!html.includes("Frete grátis"));
});
