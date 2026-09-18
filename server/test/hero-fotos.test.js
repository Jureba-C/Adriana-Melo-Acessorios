/**
 * Fotos do topo da home trocadas pelo painel (aba "Fotos do topo").
 * Sobe o server.js num processo à parte, com porta e banco ISOLADOS, igual
 * a avaliacoes.test.js. Roda com: node --test
 *
 * O que estes testes trancam, e por quê:
 *  - sem foto no painel a home continua com as fixas de img/hero-* (apagar
 *    tudo não pode deixar o topo do site em branco);
 *  - a primeira foto sai eager e com fetchpriority="high" e as outras dentro
 *    do <template> — é o que segura o LCP da home;
 *  - o que sai da rota pública é SEMPRE 4:5, em qualquer largura e formato:
 *    foto fora da proporção deixaria faixa branca dentro do quadro;
 *  - trocar o enquadramento invalida o recorte em cache (senão a lojista
 *    muda e continua vendo o corte velho);
 *  - texto escrito no painel nunca vira HTML na home;
 *  - as rotas de escrita exigem admin — o topo da home é a cara da loja.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const sharp = require("sharp");

const PORT = 39574;
const ORIGIN = `http://localhost:${PORT}`;
const ADMIN_EMAIL = "admin-hero@test.com";
const ADMIN_HASH = crypto.createHash("sha256").update(ADMIN_EMAIL).digest("hex");
const TMP_DB = path.join(os.tmpdir(), `plc-hero-${process.pid}-${Date.now()}.db`);

process.env.DB_PATH = TMP_DB;
const db = require("../lib/db.js");
const auth = require("../lib/auth.js");

let child;
let adminCookie;

function limpar(){
  for(const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
}

before(async () => {
  child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.js"], {
    cwd: path.join(__dirname, ".."),
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
  limpar();
});

// Retângulo deitado de propósito: é a forma mais direta de provar que o
// recorte 4:5 acontece, já que a foto de entrada tem a proporção errada.
async function fotoDeitada(){
  return sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 230, g: 120, b: 170 } } }).jpeg().toBuffer();
}

async function enviarFoto({ alt = "Descrição da foto de teste", legenda = "Legenda de teste", focus = "center", cookie } = {}){
  const form = new FormData();
  form.append("photo", new Blob([await fotoDeitada()], { type: "image/jpeg" }), "foto.jpg");
  form.append("alt", alt);
  form.append("legenda", legenda);
  form.append("focus", focus);
  return fetch(`${ORIGIN}/api/admin/hero/fotos`, {
    method: "POST",
    headers: { Origin: ORIGIN, Cookie: cookie === undefined ? adminCookie : cookie },
    body: form,
  });
}

async function apagarTodas(){
  const res = await fetch(`${ORIGIN}/api/admin/hero/fotos`, { headers: { Cookie: adminCookie } });
  const { fotos } = await res.json();
  for(const f of fotos){
    await fetch(`${ORIGIN}/api/admin/hero/fotos/${f.id}`, {
      method: "DELETE", headers: { Origin: ORIGIN, Cookie: adminCookie },
    });
  }
}

test("sem foto no painel, a home usa as fotos fixas de img/hero-*", async () => {
  await apagarTodas();
  const home = await (await fetch(ORIGIN + "/")).text();
  assert.match(home, /img\/hero-laco-bailarina-960\.jpg/);
  assert.ok(!home.includes("/api/hero/fotos/"), "não deve apontar para o banco sem foto cadastrada");
});

test("a primeira foto é eager com fetchpriority=high e as outras ficam no <template>", async () => {
  await apagarTodas();
  const home = await (await fetch(ORIGIN + "/")).text();
  const antesDoTemplate = home.slice(0, home.indexOf('id="heroSlidesExtras"'));
  assert.equal((antesDoTemplate.match(/class="hero-slide is-ativa"/g) || []).length, 1);
  assert.match(antesDoTemplate, /fetchpriority="high"/);
  // Nenhuma das demais pode ter prioridade alta: seriam quatro downloads
  // disputando banda com o LCP.
  const depois = home.slice(home.indexOf('id="heroSlidesExtras"'));
  assert.ok(!depois.includes('fetchpriority="high"'));
});

test("foto enviada pelo painel entra na home no lugar das fixas", async () => {
  await apagarTodas();
  const res = await enviarFoto({ legenda: "Laço de teste", alt: "Um laço rosa de teste" });
  assert.equal(res.status, 201);
  const { id } = await res.json();

  const home = await (await fetch(ORIGIN + "/")).text();
  assert.ok(home.includes(`/api/hero/fotos/${id}?w=960`), "a home deve apontar para a foto do banco");
  assert.ok(!home.includes("img/hero-laco-bailarina"), "as fixas devem sair de cena");
  assert.match(home, /data-legenda="Laço de teste"/);
  assert.match(home, /alt="Um laço rosa de teste"/);
});

test("a rota pública devolve 4:5 em toda largura e formato", async () => {
  await apagarTodas();
  const { id } = await (await enviarFoto()).json();

  for(const largura of [480, 960]){
    for(const [accept, esperado] of [["image/webp,*/*", "webp"], ["image/jpeg", "jpeg"]]){
      const res = await fetch(`${ORIGIN}/api/hero/fotos/${id}?w=${largura}`, { headers: { Accept: accept } });
      assert.equal(res.status, 200);
      const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
      assert.equal(meta.format, esperado);
      assert.equal(meta.width, largura);
      assert.equal(meta.height, largura * 1.25, `${largura}px em ${esperado} devia sair 4:5`);
    }
  }
});

test("largura fora da lista cai no padrão em vez de virar variante nova", async () => {
  await apagarTodas();
  const { id } = await (await enviarFoto()).json();
  const res = await fetch(`${ORIGIN}/api/hero/fotos/${id}?w=5000`, { headers: { Accept: "image/jpeg" } });
  const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
  assert.equal(meta.width, 960);
});

test("mudar o enquadramento joga fora o recorte em cache", async () => {
  await apagarTodas();
  const { id } = await (await enviarFoto({ focus: "top" })).json();
  await fetch(`${ORIGIN}/api/hero/fotos/${id}?w=480`, { headers: { Accept: "image/webp,*/*" } });
  assert.ok(db.getHeroPhotoVariant(id, 480, "webp"), "o primeiro acesso devia ter gravado a variante");

  const res = await fetch(`${ORIGIN}/api/admin/hero/fotos/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: adminCookie },
    body: JSON.stringify({ alt: "Outra descrição de teste", legenda: "Outra legenda", focus: "bottom" }),
  });
  assert.equal(res.status, 200);
  assert.equal(db.getHeroPhotoVariant(id, 480, "webp"), null, "o corte antigo não pode sobreviver");
});

test("texto escrito no painel não vira HTML na home", async () => {
  await apagarTodas();
  await enviarFoto({ legenda: '"><script>alert(1)</script>', alt: 'foto " onload="alert(2)' });
  const home = await (await fetch(ORIGIN + "/")).text();
  assert.ok(!home.includes("<script>alert(1)</script>"));
  assert.ok(!home.includes('onload="alert(2)'));
  assert.match(home, /&lt;script&gt;/);
});

test("a ordem do painel é a ordem do carrossel", async () => {
  await apagarTodas();
  const a = (await (await enviarFoto({ legenda: "Primeira" })).json()).id;
  const b = (await (await enviarFoto({ legenda: "Segunda" })).json()).id;

  let home = await (await fetch(ORIGIN + "/")).text();
  assert.ok(home.indexOf("Primeira") < home.indexOf("Segunda"));

  const res = await fetch(`${ORIGIN}/api/admin/hero/fotos/ordem`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: adminCookie },
    body: JSON.stringify({ ids: [b, a] }),
  });
  assert.equal(res.status, 200);

  home = await (await fetch(ORIGIN + "/")).text();
  assert.ok(home.indexOf("Segunda") < home.indexOf("Primeira"), "a nova ordem tem de aparecer na home");
});

test("ordem incompleta é recusada em vez de embaralhar o carrossel", async () => {
  await apagarTodas();
  const a = (await (await enviarFoto({ legenda: "Uma" })).json()).id;
  await enviarFoto({ legenda: "Outra" });

  const res = await fetch(`${ORIGIN}/api/admin/hero/fotos/ordem`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: adminCookie },
    body: JSON.stringify({ ids: [a] }),
  });
  assert.equal(res.status, 409);
});

test("apagar a última foto devolve o topo para as fixas", async () => {
  await apagarTodas();
  const { id } = await (await enviarFoto({ legenda: "Só esta" })).json();
  await fetch(`${ORIGIN}/api/admin/hero/fotos/${id}`, {
    method: "DELETE", headers: { Origin: ORIGIN, Cookie: adminCookie },
  });
  const home = await (await fetch(ORIGIN + "/")).text();
  assert.match(home, /img\/hero-laco-bailarina-960\.jpg/);
});

test("passa do teto de fotos e o envio é recusado", async () => {
  await apagarTodas();
  for(let i = 0; i < 6; i++){
    assert.equal((await enviarFoto({ legenda: `Foto ${i}` })).status, 201);
  }
  assert.equal((await enviarFoto({ legenda: "Sétima" })).status, 409);
  await apagarTodas();
});

test("legenda ou descrição em branco não passa", async () => {
  await apagarTodas();
  assert.equal((await enviarFoto({ legenda: "   " })).status, 400);
  assert.equal((await enviarFoto({ alt: "" })).status, 400);
});

test("quem não é admin não mexe nas fotos do topo", async () => {
  await apagarTodas();
  const { id } = await (await enviarFoto()).json();

  assert.equal((await enviarFoto({ cookie: "" })).status, 401);
  for(const [metodo, url] of [
    ["PATCH", `/api/admin/hero/fotos/${id}`],
    ["DELETE", `/api/admin/hero/fotos/${id}`],
    ["PUT", "/api/admin/hero/fotos/ordem"],
    ["GET", "/api/admin/hero/fotos"],
  ]){
    const res = await fetch(ORIGIN + url, {
      method: metodo,
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: metodo === "GET" || metodo === "DELETE" ? undefined : JSON.stringify({ ids: [] }),
    });
    assert.equal(res.status, 401, `${metodo} ${url} devia exigir admin`);
  }

  // A foto em si continua pública: é o topo da home, que qualquer visitante vê.
  assert.equal((await fetch(`${ORIGIN}/api/hero/fotos/${id}?w=480`)).status, 200);
});

test("id inventado responde 404, sem revelar se existe", async () => {
  const inexistente = await fetch(`${ORIGIN}/api/hero/fotos/00000000-0000-0000-0000-000000000000?w=480`);
  const invalido = await fetch(`${ORIGIN}/api/hero/fotos/nao-e-uuid?w=480`);
  assert.equal(inexistente.status, 404);
  assert.equal(invalido.status, 404);
});
