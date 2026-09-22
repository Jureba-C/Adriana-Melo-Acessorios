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

/* O login pelo Google NÃO pode servir de porta dos fundos para o painel:
   requireAdminTwoFactor só confere se o 2FA está ATIVADO, não se esta sessão
   passou pelo código. Se a recusa sumir da rota, o painel passa a ser
   acessível com um toque no botão do Google — sem código nenhum. */
test("entrar com o Google recusa admin e quem tem verificação em duas etapas", () => {
  const fonte = fs.readFileSync(path.join(RAIZ, "server.js"), "utf8");
  const inicio = fonte.indexOf('app.post("/api/auth/google"');
  assert.ok(inicio > 0, "rota de login com o Google sumiu");
  const trecho = fonte.slice(inicio, inicio + 3000);
  assert.ok(/recusaGoogleParaContaProtegida/.test(trecho), "a recusa saiu da rota");

  const guarda = fonte.slice(fonte.indexOf("function recusaGoogleParaContaProtegida"));
  assert.ok(/isAdminEmail/.test(guarda.slice(0, 400)), "deixou de recusar e-mail de admin");
  assert.ok(/totp_secret/.test(guarda.slice(0, 400)), "deixou de recusar conta com 2FA");
});

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

// A CSP que o servidor devolve hoje, diretiva por diretiva. Serve de padrão-
// ouro: qualquer mudança aqui tem de ser deliberada e aparecer no diff deste
// arquivo, em vez de acontecer sozinha quando o helmet muda os padrões dele.
// (upgrade-insecure-requests fica de fora porque só entra quando o
// CLIENT_ORIGIN é https — em teste é http://localhost.)
const CSP_ESPERADA = {
  "default-src": "'self'",
  "base-uri": "'self'",
  "font-src": "'self'",
  "form-action": "'self'",
  "frame-ancestors": "'self'",
  "img-src": "'self' https: data: blob:",
  "object-src": "'none'",
  "script-src": "'self' https://sdk.mercadopago.com https://accounts.google.com",
  "script-src-attr": "'none'",
  "style-src": "'self' 'unsafe-inline' https://accounts.google.com",
  "connect-src": "'self' https://api.mercadopago.com https://viacep.com.br https://accounts.google.com",
  "frame-src": "https://www.mercadopago.com https://www.mercadopago.com.br https://accounts.google.com",
};

function lerCsp(texto){
  const mapa = {};
  for(const parte of texto.split(";")){
    const limpo = parte.trim();
    if(!limpo) continue;
    const espaco = limpo.indexOf(" ");
    if(espaco === -1) mapa[limpo] = "";
    else mapa[limpo.slice(0, espaco)] = limpo.slice(espaco + 1).trim();
  }
  return mapa;
}

test("a CSP do cabeçalho é exatamente a esperada", async () => {
  const res = await fetch(ORIGIN + "/");
  const bruta = res.headers.get("content-security-policy");
  assert.ok(bruta, "nenhuma CSP no cabeçalho");
  const atual = lerCsp(bruta);
  delete atual["upgrade-insecure-requests"];
  assert.deepEqual(atual, CSP_ESPERADA);
});

// Cada página HTML repete a CSP num <meta>, e o navegador aplica a INTERSEÇÃO
// das duas. Manter os dois à mão é um gerador de divergência, e ela já existe:
// blob: está no cabeçalho e falta no <meta> de todas as páginas menos o
// painel. Isso deixa as outras páginas MAIS restritas que o cabeçalho, que é o
// lado seguro de errar (foi o que fez o recorte de foto com object URL não
// funcionar fora do painel — resolvido lendo o arquivo como data: URI).
//
// Os dois testes abaixo separam as duas perguntas que essa duplicação levanta:
// "alguma página está pedindo mais do que o cabeçalho deixa?" (risco real) e
// "alguma página começou a divergir das outras sem ninguém registrar?" (deriva).

function fontes(valor){
  return new Set(String(valor).split(/\s+/).filter(Boolean));
}

function metaDaPagina(pagina){
  const html = fs.readFileSync(path.join(RAIZ, pagina), "utf8");
  const m = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/);
  return m ? lerCsp(m[1]) : null;
}

function paginasHtml(){
  const paginas = fs.readdirSync(RAIZ).filter(f => f.endsWith(".html")).sort();
  assert.ok(paginas.length >= 13, `esperava as páginas do site, achei ${paginas.length}`);
  return paginas;
}

test("nenhuma página pede no <meta> mais do que o cabeçalho permite", async () => {
  const res = await fetch(ORIGIN + "/");
  const cabecalho = lerCsp(res.headers.get("content-security-policy"));
  const excesso = [];

  for(const pagina of paginasHtml()){
    const meta = metaDaPagina(pagina);
    if(!meta) continue;
    for(const [diretiva, valor] of Object.entries(meta)){
      // Sem a diretiva no cabeçalho, o navegador cai no default-src dele.
      const permitido = fontes(cabecalho[diretiva] ?? cabecalho["default-src"]);
      for(const fonte of fontes(valor)){
        if(!permitido.has(fonte)) excesso.push(`${pagina} ${diretiva}: ${fonte}`);
      }
    }
  }
  // Uma permissão que só existe no <meta> não vale nada — o cabeçalho barra do
  // mesmo jeito — e dá a impressão de estar liberada. É erro dos dois lados.
  assert.deepEqual(excesso, [], "o <meta> concede o que o cabeçalho barra");
});

// A CSP que a maioria das páginas usa. As exceções abaixo são deliberadas;
// qualquer página nova divergindo derruba o teste, para a decisão ficar escrita
// aqui em vez de ser descoberta meses depois.
const AUSENTE = "(diretiva ausente)";
const DIVERGENCIAS_ACEITAS = {
  // Única página que faz recorte de foto com object URL (js/admin.js).
  "admin.html": { "img-src": "'self' https: data: blob:" },
  // Quem entra veio de um link do e-mail, sem login: não carrega o SDK do
  // Mercado Pago, não fala com a API deles e não abre iframe nenhum. Menos
  // permissão que as outras páginas, de propósito.
  "avaliar.html": { "script-src": "'self'", "connect-src": "'self'", "frame-src": AUSENTE },
  // Única página com "Entrar com o Google": só ela precisa falar com o
  // accounts.google.com. As outras 12 ficam sem essa permissão de propósito —
  // o cabeçalho do servidor é um só, mas a <meta> de cada página pode (e
  // deve) ser mais restrita que ele.
  "conta.html": {
    "script-src": "'self' https://sdk.mercadopago.com https://accounts.google.com",
    "style-src": "'self' 'unsafe-inline' https://accounts.google.com",
    "connect-src": "'self' https://api.mercadopago.com https://viacep.com.br https://accounts.google.com",
    "frame-src": "https://www.mercadopago.com https://www.mercadopago.com.br https://accounts.google.com",
  },
};

// Servida pelo nginx/Apache quando o Node está fora do ar, então não passa por
// este servidor nem herda o cabeçalho.
const SEM_META_DE_PROPOSITO = ["manutencao.html"];

test("nenhuma página começou a divergir da CSP padrão sem registro", () => {
  const base = metaDaPagina("index.html");
  assert.ok(base, "index.html perdeu o <meta> de CSP");

  const semMeta = [];
  for(const pagina of paginasHtml()){
    const meta = metaDaPagina(pagina);
    if(!meta){ semMeta.push(pagina); continue; }

    const divergentes = {};
    for(const diretiva of new Set([...Object.keys(base), ...Object.keys(meta)])){
      if(base[diretiva] !== meta[diretiva]) divergentes[diretiva] = meta[diretiva] ?? AUSENTE;
    }
    assert.deepEqual(divergentes, DIVERGENCIAS_ACEITAS[pagina] || {},
      `${pagina}: CSP do <meta> diverge das demais de um jeito não registrado`);
  }

  assert.deepEqual(semMeta, SEM_META_DE_PROPOSITO,
    "página HTML sem <meta> de CSP — ou foi esquecida, ou precisa entrar na lista");
});
