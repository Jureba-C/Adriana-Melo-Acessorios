/**
 * "Entrar com o Google" (lib/googleAuth.js + rotas /api/auth/google*).
 * Sobe o server.js num processo à parte, com porta e banco ISOLADOS, e um
 * Google FALSO local: GOOGLE_TOKENINFO_URL aponta para um servidor de teste
 * que devolve o que cada caso precisa. Não existe desvio de verificação no
 * código que vai para produção — só o endereço é configurável.
 *
 * O que estes testes trancam, e por quê:
 *  - o token é conferido de verdade: aud, iss, validade e e-mail verificado.
 *    Aceitar qualquer um deles errado é deixar qualquer pessoa entrar como
 *    qualquer outra;
 *  - o /tokeninfo do Google devolve TODO claim como TEXTO ("true", "17900...").
 *    O stub responde assim de propósito: comparar com true/number quebraria
 *    100% dos logins e o teste tem de pegar isso;
 *  - e-mail já cadastrado NÃO vincula sozinho. O site não confirma endereço
 *    de e-mail em lugar nenhum, então vincular pelo e-mail deixaria alguém
 *    cadastrar o endereço de outra pessoa e esperar ela entrar pelo Google;
 *  - admin e quem tem 2FA são recusados: requireAdminTwoFactor só confere se
 *    o 2FA está ativado, não se ESTA sessão passou pelo código;
 *  - falha do Google (fora do ar, resposta estranha) nega o login. Nunca o
 *    contrário.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const PORT = 39590;
const PORT_GOOGLE = 39591;
const ORIGIN = `http://localhost:${PORT}`;
const CLIENT_ID = "cliente-de-teste.apps.googleusercontent.com";
const ADMIN_EMAIL = "dona-google@test.com";
const ADMIN_HASH = crypto.createHash("sha256").update(ADMIN_EMAIL).digest("hex");
const TMP_DB = path.join(os.tmpdir(), `plc-google-${process.pid}-${Date.now()}.db`);

process.env.DB_PATH = TMP_DB;
const db = require("../lib/db.js");
const auth = require("../lib/auth.js");

const TOKEN_OK = "aaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc";

let child;
let googleFake;
let respostaDoGoogle;
let chamadasNoGoogle = 0;

function tokenInfoPadrao(extra){
  return {
    aud: CLIENT_ID,
    iss: "https://accounts.google.com",
    // Textos, como o Google devolve de verdade.
    exp: String(Math.floor(Date.now() / 1000) + 3600),
    email_verified: "true",
    email: "cliente@gmail.com",
    sub: "google-sub-1",
    name: "Ana Paula",
    ...extra,
  };
}

function limpar(){
  for(const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
}

async function chamar(caminho, { body, cookie, method = "POST" } = {}){
  const res = await fetch(ORIGIN + caminho, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, corpo: await res.json().catch(() => ({})), cookies: res.headers.getSetCookie?.() || [] };
}

before(async () => {
  googleFake = http.createServer((req, res) => {
    chamadasNoGoogle++;
    const { status = 200, corpo = tokenInfoPadrao() } = respostaDoGoogle || {};
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(corpo));
  });
  await new Promise(r => googleFake.listen(PORT_GOOGLE, r));

  child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      DB_PATH: TMP_DB, PORT: String(PORT), CLIENT_ORIGIN: ORIGIN,
      ADMIN_2FA_REQUIRED: "false", ADMIN_EMAIL_HASHES: ADMIN_HASH,
      GOOGLE_CLIENT_ID: CLIENT_ID, AUTH_RATE_LIMIT_MAX: "200",
      GOOGLE_TOKENINFO_URL: `http://localhost:${PORT_GOOGLE}/tokeninfo`,
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

after(async () => {
  if(child) child.kill();
  if(googleFake) await new Promise(r => googleFake.close(r));
  limpar();
});

test("token válido cria a conta, entra e guarda o vínculo com o Google", async () => {
  respostaDoGoogle = null;
  const res = await chamar("/api/auth/google", { body: { credential: TOKEN_OK } });
  assert.equal(res.status, 201);
  assert.equal(res.corpo.email, "cliente@gmail.com");
  assert.ok(res.cookies.some(c => c.startsWith("plc_session=")), "entrou de verdade");

  const user = db.getUserByEmail("cliente@gmail.com");
  assert.equal(user.google_id, "google-sub-1");
  assert.equal(user.sem_senha, 1);
  assert.ok(user.password_hash && user.password_hash.length > 20, "senha impossível, nunca vazia");
});

test("entrar de novo reaproveita a mesma conta, sem duplicar", async () => {
  respostaDoGoogle = null;
  const res = await chamar("/api/auth/google", { body: { credential: TOKEN_OK } });
  assert.equal(res.status, 200);
  assert.equal(db.listAccountsForAdmin().filter(c => c.email === "cliente@gmail.com").length, 1);
});

test("e-mail não verificado no Google não entra", async () => {
  respostaDoGoogle = { corpo: tokenInfoPadrao({ email_verified: "false", email: "naoverificado@gmail.com", sub: "sub-nv" }) };
  const res = await chamar("/api/auth/google", { body: { credential: TOKEN_OK } });
  assert.equal(res.status, 401);
  assert.equal(db.getUserByEmail("naoverificado@gmail.com"), null);
});

test("token vencido não entra (mesmo o exp vindo como texto)", async () => {
  respostaDoGoogle = { corpo: tokenInfoPadrao({ exp: String(Math.floor(Date.now() / 1000) - 60), email: "vencido@gmail.com", sub: "sub-v" }) };
  const res = await chamar("/api/auth/google", { body: { credential: TOKEN_OK } });
  assert.equal(res.status, 401);
});

test("token de outro aplicativo não entra", async () => {
  respostaDoGoogle = { corpo: tokenInfoPadrao({ aud: "outro-site.apps.googleusercontent.com", email: "outroaud@gmail.com", sub: "sub-a" }) };
  assert.equal((await chamar("/api/auth/google", { body: { credential: TOKEN_OK } })).status, 401);
});

test("emissor diferente do Google não entra", async () => {
  respostaDoGoogle = { corpo: tokenInfoPadrao({ iss: "https://accounts.exemplo.com", email: "iss@gmail.com", sub: "sub-i" }) };
  assert.equal((await chamar("/api/auth/google", { body: { credential: TOKEN_OK } })).status, 401);
});

test("Google fora do ar nega o login em vez de deixar passar", async () => {
  respostaDoGoogle = { status: 500, corpo: { error: "boom" } };
  const res = await chamar("/api/auth/google", { body: { credential: TOKEN_OK } });
  assert.equal(res.status, 401);
  assert.ok(!res.cookies.some(c => c.startsWith("plc_session=")));
});

test("token malformado é recusado sem nem chamar o Google", async () => {
  respostaDoGoogle = null;
  const antes = chamadasNoGoogle;
  const res = await chamar("/api/auth/google", { body: { credential: "nao-e-um-jwt&id_token=outro" } });
  assert.equal(res.status, 400);
  assert.equal(chamadasNoGoogle, antes, "não pode montar URL com o que veio do navegador");
});

test("e-mail já cadastrado não vincula sozinho", async () => {
  const email = "jatinha@gmail.com";
  db.createUser({ name: "Já Tinha", email, passwordHash: await auth.hashPassword("senha-123456"), cpf: null });
  respostaDoGoogle = { corpo: tokenInfoPadrao({ email, sub: "sub-ja" }) };

  const res = await chamar("/api/auth/google", { body: { credential: TOKEN_OK } });
  assert.equal(res.status, 409);
  assert.equal(res.corpo.contaExistente, true);
  assert.equal(db.getUserByEmail(email).google_id, null, "o vínculo não pode acontecer por fora da conta");
  assert.ok(!res.cookies.some(c => c.startsWith("plc_session=")));
});

test("admin não entra pelo Google (o 2FA do painel ficaria de fora)", async () => {
  db.createUser({ name: "Dona", email: ADMIN_EMAIL, passwordHash: await auth.hashPassword("senha-123456"), cpf: null });
  respostaDoGoogle = { corpo: tokenInfoPadrao({ email: ADMIN_EMAIL, sub: "sub-admin" }) };
  const res = await chamar("/api/auth/google", { body: { credential: TOKEN_OK } });
  assert.equal(res.status, 409);
  assert.ok(!res.cookies.some(c => c.startsWith("plc_session=")));
});

test("conta com verificação em duas etapas não entra pelo Google", async () => {
  const email = "com2fa@gmail.com";
  const user = db.createUser({ name: "Com 2FA", email, passwordHash: await auth.hashPassword("senha-123456"), cpf: null });
  db.setUserTotp(user.id, { secret: "ABCDEFGHIJKLMNOP", recovery: [] });
  respostaDoGoogle = { corpo: tokenInfoPadrao({ email, sub: "sub-2fa" }) };
  assert.equal((await chamar("/api/auth/google", { body: { credential: TOKEN_OK } })).status, 409);
});

test("vincular exige estar logada e o mesmo e-mail", async () => {
  respostaDoGoogle = { corpo: tokenInfoPadrao({ email: "outra@gmail.com", sub: "sub-outra" }) };
  assert.equal((await chamar("/api/auth/google/vincular", { body: { credential: TOKEN_OK } })).status, 401);

  const email = "vincular@gmail.com";
  const user = db.createUser({ name: "Vincular", email, passwordHash: await auth.hashPassword("senha-123456"), cpf: null });
  const token = crypto.randomBytes(32).toString("hex");
  db.createSession({
    tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
    userId: user.id, expiresAt: Date.now() + 3600_000,
  });
  const cookie = `plc_session=${token}`;

  const outroEmail = await chamar("/api/auth/google/vincular", { body: { credential: TOKEN_OK }, cookie });
  assert.equal(outroEmail.status, 403, "conta Google de outro e-mail não pode ser vinculada");

  respostaDoGoogle = { corpo: tokenInfoPadrao({ email, sub: "sub-vincular" }) };
  const ok = await chamar("/api/auth/google/vincular", { body: { credential: TOKEN_OK }, cookie });
  assert.equal(ok.status, 200);
  assert.equal(db.getUserByEmail(email).google_id, "sub-vincular");
});

test("quem entrou pelo Google consegue excluir a conta sem ter senha", async () => {
  const email = "apagar@gmail.com";
  respostaDoGoogle = { corpo: tokenInfoPadrao({ email, sub: "sub-apagar" }) };
  const entrada = await chamar("/api/auth/google", { body: { credential: TOKEN_OK } });
  assert.equal(entrada.status, 201);
  const cookie = entrada.cookies.find(c => c.startsWith("plc_session=")).split(";")[0];

  const semProva = await chamar("/api/auth/account", { method: "DELETE", body: { password: "chute-qualquer" }, cookie });
  assert.equal(semProva.status, 401);

  const comGoogle = await chamar("/api/auth/account", { method: "DELETE", body: { credential: TOKEN_OK }, cookie });
  assert.equal(comGoogle.status, 200);
  assert.equal(db.getUserByEmail(email), null);
});

test("sem GOOGLE_CLIENT_ID o site não oferece nem anuncia o botão", async () => {
  const res = await fetch(`${ORIGIN}/api/auth/google/config`);
  const dados = await res.json();
  assert.equal(dados.enabled, true, "neste teste está configurado");
  assert.equal(dados.clientId, CLIENT_ID);
  // O caso "não configurado" é o padrão em produção até a lojista criar a
  // credencial; lib/googleAuth.js devolve 503 e a página esconde o bloco.
  const semConfig = require("../lib/googleAuth.js");
  const guardado = process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_ID;
  assert.equal(semConfig.estaConfigurado(), false);
  process.env.GOOGLE_CLIENT_ID = guardado;
});
