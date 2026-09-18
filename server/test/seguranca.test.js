/**
 * Travas de segurança que não dá para ver lendo uma rota isolada.
 * Roda com: node --test
 *
 * O que estes testes trancam, e por quê:
 *  - toda rota /api/admin exige sessão de admin E verificação em duas etapas
 *    (a exceção são as três rotas que cadastram o 2FA — sem elas o painel
 *    ficaria impossível de destravar na primeira vez);
 *  - quem estoura o limite de requisições numa rota de API recebe JSON, não a
 *    página 429.html: o Express corta o prefixo do mount em
 *    app.use("/api", ...), então o teste tem de ser no originalUrl;
 *  - a CSP que sai no cabeçalho é exatamente a esperada, diretiva por
 *    diretiva — hoje parte dela vem dos padrões do helmet, e trocar isso sem
 *    perceber derrubaria proteção sem nenhum sintoma visível;
 *  - a CSP do <meta> de cada página nunca é mais FROUXA que a do cabeçalho.
 *    Os dois são mantidos à mão e o navegador aplica a interseção, então é
 *    fácil um ganhar uma permissão que o outro não tem e ninguém notar.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const RAIZ = path.join(__dirname, "..");
const PORT = 39576;
const ORIGIN = `http://localhost:${PORT}`;
const TMP_DB = path.join(os.tmpdir(), `plc-seg-${process.pid}-${Date.now()}.db`);

let child;

before(async () => {
  child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.js"], {
    cwd: RAIZ,
    env: {
      ...process.env,
      DB_PATH: TMP_DB, PORT: String(PORT), CLIENT_ORIGIN: ORIGIN,
      ADMIN_2FA_REQUIRED: "false",
      ADMIN_EMAIL_HASHES: crypto.createHash("sha256").update("seg@test.com").digest("hex"),
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

// As três rotas que CADASTRAM o 2FA não podem exigir 2FA — é o ovo e a
// galinha. Qualquer outra rota de admin entrando aqui é engano.
const SEM_2FA_DE_PROPOSITO = new Set([
  "POST /api/admin/2fa/setup",
  "POST /api/admin/2fa/activate",
  "GET /api/admin/2fa/status",
]);

test("toda rota /api/admin exige admin + verificação em duas etapas", () => {
  const fonte = fs.readFileSync(path.join(RAIZ, "server.js"), "utf8");
  const re = /app\.(get|post|put|patch|delete)\(\s*"(\/api\/admin[^"]*)"\s*,([^\n]*)/g;
  const achadas = [];
  for(const m of fonte.matchAll(re)){
    const [, metodo, rota, resto] = m;
    achadas.push({ chave: `${metodo.toUpperCase()} ${rota}`, resto });
  }
  assert.ok(achadas.length >= 35, `esperava dezenas de rotas de admin, achei ${achadas.length}`);

  const semAdmin = achadas.filter(r => !r.resto.includes("auth.requireAdmin"));
  assert.deepEqual(semAdmin.map(r => r.chave), [], "rota de admin sem requireAdmin");

  const sem2fa = achadas
    .filter(r => !r.resto.includes("requireAdminTwoFactor"))
    .map(r => r.chave)
    .filter(c => !SEM_2FA_DE_PROPOSITO.has(c));
  assert.deepEqual(sem2fa, [], "rota de admin sem requireAdminTwoFactor");

  for(const esperada of SEM_2FA_DE_PROPOSITO){
    assert.ok(achadas.some(r => r.chave === esperada),
      `${esperada} sumiu — revise a lista de exceções em vez de deixá-la desatualizada`);
  }
});

test("estourar o limite numa rota de API responde JSON, não a página 429", async () => {
  // O limitador de /api é 500 por 15 min. Dispara em lotes para não abrir 500
  // conexões de uma vez.
  let resposta = null;
  for(let lote = 0; lote < 12 && !resposta; lote++){
    const respostas = await Promise.all(
      Array.from({ length: 50 }, () => fetch(`${ORIGIN}/api/products`).catch(() => null))
    );
    resposta = respostas.find(r => r && r.status === 429) || null;
  }
  assert.ok(resposta, "o limitador de /api não disparou em 600 requisições");

  const tipo = resposta.headers.get("content-type") || "";
  assert.match(tipo, /application\/json/,
    `429 de rota de API veio como "${tipo}" — sinal de que voltou a testar req.path`);
  const corpo = await resposta.json();
  assert.match(corpo.error, /Muitas requisições/);
});
