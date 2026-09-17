/**
 * "Minha conta": perfil, troca de e-mail/senha, sair dos outros aparelhos e
 * cupom de aniversário. Sobe o servidor de verdade num banco temporário.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const PORT = 39583;
const ORIGIN = `http://localhost:${PORT}`;
const ADMIN_EMAIL = "admin-conta@test.com";
const ADMIN_HASH = crypto.createHash("sha256").update(ADMIN_EMAIL).digest("hex");
const TMP_DB = path.join(os.tmpdir(), `plc-conta-${process.pid}-${Date.now()}.db`);

process.env.DB_PATH = TMP_DB;
process.env.ADMIN_EMAIL_HASHES = ADMIN_HASH;
const db = require("../lib/db.js");
const auth = require("../lib/auth.js");

let child;
const DIA = 24 * 60 * 60 * 1000;
const SENHA = "Senha-segura-1";

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
});

after(() => {
  if(child) child.kill();
  for(const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
});

let n = 0;
async function novaConta(extra = {}){
  const email = `cliente${++n}-${Date.now()}@t.com`;
  const user = db.createUser({ name: "Ana Paula", email, passwordHash: await auth.hashPassword(SENHA), cpf: "11144477735", ...extra });
  return { user, email, cookie: sessao(user.id) };
}
function sessao(userId){
  const token = crypto.randomBytes(32).toString("hex");
  db.createSession({ tokenHash: crypto.createHash("sha256").update(token).digest("hex"), userId, expiresAt: Date.now() + DIA });
  return `plc_session=${token}`;
}
function chamar(metodo, url, { cookie, body } = {}){
  const headers = { Origin: ORIGIN };
  if(cookie) headers.Cookie = cookie;
  if(body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(ORIGIN + url, { method: metodo, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

test("perfil: sem login 401; mostra CPF mascarado; salva nome, WhatsApp e nascimento validados", async () => {
  assert.equal((await chamar("GET", "/api/auth/perfil")).status, 401);
  const { cookie, email } = await novaConta();

  const inicial = await (await chamar("GET", "/api/auth/perfil", { cookie })).json();
  assert.equal(inicial.email, email);
  assert.equal(inicial.cpfMascarado, "***.444.777-**");
  assert.ok(!JSON.stringify(inicial).includes("11144477735"), "CPF completo nunca sai");

  const ruim = await chamar("PUT", "/api/auth/perfil", { cookie, body: { name: "Ana", telefone: "123", nascimento: "" } });
  assert.equal(ruim.status, 400);
  assert.equal((await chamar("PUT", "/api/auth/perfil", { cookie, body: { name: "Ana", telefone: "", nascimento: "2001-02-30" } })).status, 400, "data que não existe");
  assert.equal((await chamar("PUT", "/api/auth/perfil", { cookie, body: { name: "Ana", telefone: "", nascimento: "2020-01-01" } })).status, 400, "menos de 13 anos");

  const ok = await chamar("PUT", "/api/auth/perfil", { cookie, body: { name: "  Ana   Paula Souza ", telefone: "(61) 99876-5432", nascimento: "1990-03-15" } });
  assert.equal(ok.status, 200);
  const salvo = await ok.json();
  assert.equal(salvo.name, "Ana Paula Souza");
  assert.equal(salvo.telefone, "61998765432");
  assert.equal(salvo.nascimento, "1990-03-15");
});

test("trocar e-mail exige a senha, recusa e-mail em uso e e-mail de administradora", async () => {
  const { cookie, user } = await novaConta();
  const outra = await novaConta();

  assert.equal((await chamar("PUT", "/api/auth/email", { cookie, body: { email: "novo@t.com", senhaAtual: "errada" } })).status, 401);
  assert.equal((await chamar("PUT", "/api/auth/email", { cookie, body: { email: outra.email, senhaAtual: SENHA } })).status, 409);
  assert.equal((await chamar("PUT", "/api/auth/email", { cookie, body: { email: ADMIN_EMAIL, senhaAtual: SENHA } })).status, 409,
    "virar admin trocando o e-mail não pode");

  const novo = `trocado-${Date.now()}@t.com`;
  const ok = await chamar("PUT", "/api/auth/email", { cookie, body: { email: novo.toUpperCase(), senhaAtual: SENHA } });
  assert.equal(ok.status, 200);
  assert.equal(db.getUserById(user.id).email, novo);
});

test("trocar senha derruba os outros aparelhos e mantém este; sair-outros faz o mesmo", async () => {
  const { user, cookie } = await novaConta();
  const celular = sessao(user.id);
  const tablet = sessao(user.id);

  assert.equal((await chamar("PUT", "/api/auth/senha", { cookie, body: { senhaAtual: SENHA, novaSenha: "curta" } })).status, 400);
  const troca = await chamar("PUT", "/api/auth/senha", { cookie, body: { senhaAtual: SENHA, novaSenha: "Nova-senha-123" } });
  assert.equal(troca.status, 200);
  assert.equal((await troca.json()).sessoesEncerradas, 2);
  assert.equal((await chamar("GET", "/api/auth/perfil", { cookie })).status, 200, "quem trocou continua dentro");
  assert.equal((await chamar("GET", "/api/auth/perfil", { cookie: celular })).status, 401);
  assert.ok(await auth.verifyPassword("Nova-senha-123", db.getUserById(user.id).password_hash));

  sessao(user.id);
  const sair = await (await chamar("POST", "/api/auth/sair-outros", { cookie })).json();
  assert.equal(sair.sessoesEncerradas, 1);
  assert.equal((await chamar("GET", "/api/auth/perfil", { cookie: tablet })).status, 401);
  assert.equal((await chamar("GET", "/api/auth/perfil", { cookie })).status, 200);
});

test("cupom de aniversário: só a aniversariante logada, dentro de 30 dias", async () => {
  const cupom = { code: db.CUPOM_ANIVERSARIO, items: [{ id: 1, qty: 1 }] };
  assert.ok(db.getCoupon(db.CUPOM_ANIVERSARIO), "cupom semeado");

  assert.equal((await chamar("POST", "/api/validate-coupon", { body: cupom })).status, 409, "sem login não vale");

  const semData = await novaConta();
  assert.equal((await chamar("POST", "/api/validate-coupon", { cookie: semData.cookie, body: cupom })).status, 409);

  const hoje = new Date(Date.now() - 3 * DIA);
  const aniversario = `1990-${String(hoje.getUTCMonth() + 1).padStart(2, "0")}-${String(hoje.getUTCDate()).padStart(2, "0")}`;
  const aniversariante = await novaConta();
  db.updatePerfil(aniversariante.user.id, { name: "Ana", phone: null, birthDate: aniversario });
  const vale = await chamar("POST", "/api/validate-coupon", { cookie: aniversariante.cookie, body: cupom });
  assert.equal(vale.status, 200, "3 dias depois do aniversário vale");

  const longe = new Date(Date.now() - 60 * DIA);
  const outra = await novaConta();
  db.updatePerfil(outra.user.id, { name: "Bia", phone: null, birthDate: `1990-${String(longe.getUTCMonth() + 1).padStart(2, "0")}-${String(longe.getUTCDate()).padStart(2, "0")}` });
  assert.equal((await chamar("POST", "/api/validate-coupon", { cookie: outra.cookie, body: cupom })).status, 409, "60 dias depois não vale");
});

test("cron de aniversário: um e-mail por ano, e some da fila se a conta for apagada", async () => {
  const tarefas = require("../scripts/tarefas-periodicas.js");
  const quando = Date.UTC(2031, 6, 20, 15, 0);
  const { user } = await novaConta();
  db.updatePerfil(user.id, { name: "Carla", phone: null, birthDate: "1988-07-20" });

  assert.equal(tarefas.enfileirarCuponsDeAniversario(Date.UTC(2031, 6, 20, 10, 0)), 0, "antes das 9h de Brasília, não");
  assert.ok(tarefas.enfileirarCuponsDeAniversario(quando) >= 1);
  assert.equal(tarefas.enfileirarCuponsDeAniversario(quando), 0, "mesmo ano, não repete");
  const fila = db.getOutboxEntry("aniversario", `aniversario:${user.id}:2031`);
  assert.ok(fila && fila.html_body.includes(db.CUPOM_ANIVERSARIO));

  db.deleteUserAccount(user.id);
  assert.equal(db.getOutboxEntry("aniversario", `aniversario:${user.id}:2031`), null);
});
