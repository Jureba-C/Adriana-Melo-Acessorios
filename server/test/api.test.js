/**
 * Testes de integração HTTP: sobe o server.js num processo à parte, com porta
 * e banco ISOLADOS (nunca o data.db/porta reais), e exercita os fluxos
 * críticos — cadastro, login, controle de acesso (auth + admin), CSRF e
 * exclusão de conta. Roda com: node --test
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const net = require("node:net");
// Usado só para gerar um JPEG de verdade no teste de upload de foto —
// sharp() rejeita os bytes falsos que bastavam quando o upload só gravava
// em disco sem processar a imagem (ver server.js: rota de upload agora
// comprime com sharp antes de salvar no banco).
const sharp = require("sharp");

const PORT = 39557;
const ORIGIN = `http://localhost:${PORT}`;
const ADMIN_EMAIL = "admin@test.com";
const ADMIN_HASH = crypto.createHash("sha256").update(ADMIN_EMAIL).digest("hex");
const TMP_DB = path.join(os.tmpdir(), `plc-api-test-${process.pid}-${Date.now()}.db`);

// Aponta pro MESMO arquivo (WAL) que o processo filho do server.js abaixo —
// usado só para inserir pedidos "pago"/"pendente" diretamente (sem depender
// de credencial real do Mercado Pago/Melhor Envio) nos testes de
// "continuar pagamento". Precisa vir ANTES do require, igual db.test.js.
process.env.DB_PATH = TMP_DB;
const db = require("../lib/db.js");
const auth = require("../lib/auth.js");

let child;
// Cookie de admin reaproveitado entre testes (setado no primeiro login bem-
// sucedido, abaixo). authLimiter (server.js) capa em 10 requisições por IP
// a cada 15min nas rotas de auth — os testes já rodam bem perto desse teto
// só com os registros/logins que precisam de contas DIFERENTES; um login
// extra por teste que só precisa "ser admin" estoura o limite à toa.
let sharedAdminCookie = null;
// Mesma ideia de sharedAdminCookie: reaproveitado no lugar de registrar/
// logar uma conta de cliente nova a cada teste que só precisa "ser uma
// cliente logada" (setado no teste de estoque por cor, abaixo).
let sharedClienteCookie = null;

function cleanupDb() {
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
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
  // Espera o servidor responder (até ~10s).
  const deadline = Date.now() + 10000;
  for (;;) {
    try { if ((await fetch(ORIGIN + "/")).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error("servidor de teste não subiu");
    await new Promise(r => setTimeout(r, 200));
  }
});

after(() => {
  if (child) child.kill();
  cleanupDb();
});

// Helpers ---------------------------------------------------------------
function post(url, body, cookie) {
  return fetch(ORIGIN + url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}
function put(url, body, cookie) {
  return fetch(ORIGIN + url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}
function patch(url, body, cookie) {
  return fetch(ORIGIN + url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}
function get(url, cookie) {
  return fetch(ORIGIN + url, {
    headers: cookie ? { Cookie: cookie } : {},
  });
}
// Cria usuário + sessão direto no banco (mesmo arquivo WAL do processo
// filho, ver DB_PATH acima) em vez de POST /api/auth/register — evita
// gastar do orçamento compartilhado do authLimiter (10 req/15min) num
// teste que não está testando cadastro, só precisa de "uma conta já
// logada". Replica hashToken (server/lib/auth.js, não exportada de
// propósito) porque é só SHA-256 do token, não um segredo de verdade.
async function seedLoggedInUser({ name, email, password, cpf }) {
  const user = db.createUser({ name, email, passwordHash: await auth.hashPassword(password), cpf });
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  db.createSession({ tokenHash, userId: user.id, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  return { user, cookie: `plc_session=${token}` };
}
function cookieFrom(res) {
  const raw = res.headers.get("set-cookie");
  return raw ? raw.split(";")[0] : null;
}

// Testes ----------------------------------------------------------------
test("cadastro define sessão e /api/auth/me responde ao dono", async () => {
  const res = await post("/api/auth/register", { name: "Cliente A", email: "a@test.com", password: "SenhaA12345!", cpf: "11144477735" });
  assert.equal(res.status, 201);
  const cookie = cookieFrom(res);
  assert.ok(cookie, "deve vir cookie de sessão");
  const me = await fetch(ORIGIN + "/api/auth/me", { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).email, "a@test.com");
});

test("login com senha errada é rejeitado", async () => {
  const res = await post("/api/auth/login", { email: "a@test.com", password: "errada" });
  assert.equal(res.status, 401);
});

// GET por SOCKET CRU: fetch()/curl normalizam "../" no cliente e nunca
// chegariam a mandar o caminho travesso pro servidor — o único jeito de
// testar a defesa é falar HTTP na mão.
function rawGet(caminho){
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(PORT, "127.0.0.1");
    let buf = "";
    sock.setTimeout(8000, () => { sock.destroy(); reject(new Error("timeout")); });
    sock.on("connect", () => sock.write(`GET ${caminho} HTTP/1.1\r\nHost: localhost:${PORT}\r\nConnection: close\r\n\r\n`));
    sock.on("data", (d) => { buf += d; if(buf.length > 300000) sock.destroy(); });
    sock.on("close", () => {
      const statusLine = buf.split("\r\n", 1)[0];
      const status = Number(statusLine.split(" ")[1]) || 0;
      resolve({ status, length: buf.length });
    });
    sock.on("error", reject);
  });
}

test("path traversal: '../' e formas escapadas nunca vazam arquivo de fora da pasta pública", async () => {
  // Cada um destes, ANTES da correção, servia um arquivo real de fora do
  // site (código-fonte, e o data.db com hashes de senha + segredo TOTP).
  const ataques = [
    "/js/../server.js",
    "/js/../data.db",
    "/js/../lib/auth.js",
    "/js/../admin.html",           // contorna o guarda de admin
    "/js/%2e%2e/server.js",        // ".." percent-encoded
    "/img/..%2fadmin.html",        // "/" percent-encoded
    "/js/../../server/data.db",
    "/js/./main.js",               // "." também não é caminho legítimo
  ];
  for(const a of ataques){
    const r = await rawGet(a);
    assert.notEqual(r.status, 200, `PATH TRAVERSAL VAZOU em ${a} (status 200)`);
    assert.ok(r.status === 404 || r.status === 301, `${a} devia ser 404/301, veio ${r.status}`);
  }

  // Sanidade: caminhos legítimos continuam funcionando.
  assert.equal((await rawGet("/js/main.js")).status, 200);
  assert.equal((await rawGet("/css/style.css")).status, 200);
  assert.equal((await rawGet("/index.html")).status, 200);
});

test("rotas protegidas exigem sessão (401 sem cookie)", async () => {
  assert.equal((await fetch(ORIGIN + "/api/orders")).status, 401);
  assert.equal((await fetch(ORIGIN + "/api/admin/orders")).status, 401);
});

test("GET /api/instagram/feed sem token configurado devolve available:false (nunca 500)", async () => {
  const res = await fetch(ORIGIN + "/api/instagram/feed");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, false);
});

test("CSRF: POST sem Origin correto é bloqueado", async () => {
  const res = await fetch(ORIGIN + "/api/newsletter", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://site-malicioso.com" },
    body: JSON.stringify({ email: "x@test.com" }),
  });
  assert.equal(res.status, 403);
});

test("controle de acesso admin: cliente comum não entra, admin entra", async () => {
  // Cliente comum
  const rc = await post("/api/auth/register", { name: "Comum", email: "comum@test.com", password: "SenhaC12345!", cpf: "11144477735" });
  const comumCookie = cookieFrom(rc);
  const asComum = await fetch(ORIGIN + "/api/admin/orders", { headers: { Cookie: comumCookie } });
  assert.equal(asComum.status, 403, "cliente comum -> 403");

  // Admin (e-mail com hash em ADMIN_EMAIL_HASHES; 2FA desligado no teste)
  const ra = await post("/api/auth/register", { name: "Admin", email: ADMIN_EMAIL, password: "SenhaADM12345!", cpf: "11144477735" });
  const adminCookie = cookieFrom(ra);
  assert.equal((await ra.json()).isAdmin, true);
  const asAdmin = await fetch(ORIGIN + "/api/admin/orders", { headers: { Cookie: adminCookie } });
  assert.equal(asAdmin.status, 200, "admin -> 200");
});

test("GET/PUT /api/auth/address — sem sessão, endereço em branco, salva/atualiza, isolado entre clientes", async () => {
  assert.equal((await fetch(ORIGIN + "/api/auth/address")).status, 401);

  const regA = await post("/api/auth/register", { name: "End A", email: "enda@test.com", password: "SenhaA12345!", cpf: "11144477735" });
  const cookieA = cookieFrom(regA);

  // Primeira compra: nada salvo ainda.
  const initial = await fetch(ORIGIN + "/api/auth/address", { headers: { Cookie: cookieA } });
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).address, null);

  const endereco = { nome: "End A", telefone: "(61) 91111-2222", cpf: "11144477735", rua: "Rua das Flores", numero: "10", bairro: "Centro", cidade: "Brasília", uf: "DF", cep: "70040-020" };

  // Endereço incompleto -> 400, nada é salvo.
  const incompleto = await put("/api/auth/address", { address: { ...endereco, numero: "" } }, cookieA);
  assert.equal(incompleto.status, 400);

  // Endereço completo -> 200, e volta pré-preenchido igual ao que foi salvo.
  const saved = await put("/api/auth/address", { address: endereco }, cookieA);
  assert.equal(saved.status, 200);
  const fetched = await (await fetch(ORIGIN + "/api/auth/address", { headers: { Cookie: cookieA } })).json();
  assert.equal(fetched.address.rua, "Rua das Flores");
  assert.equal(fetched.address.cep, "70040020", "cep salvo só com dígitos");

  // Segunda compra, endereço mudou -> PUT sobrescreve o anterior.
  const atualizado = await put("/api/auth/address", { address: { ...endereco, rua: "Rua Nova", numero: "20" } }, cookieA);
  assert.equal(atualizado.status, 200);
  const refetched = await (await fetch(ORIGIN + "/api/auth/address", { headers: { Cookie: cookieA } })).json();
  assert.equal(refetched.address.rua, "Rua Nova");

  // Endereço de A nunca aparece para B, mesmo autenticado.
  const regB = await post("/api/auth/register", { name: "End B", email: "endb@test.com", password: "SenhaB12345!", cpf: "11144477735" });
  const cookieB = cookieFrom(regB);
  const asB = await (await fetch(ORIGIN + "/api/auth/address", { headers: { Cookie: cookieB } })).json();
  assert.equal(asB.address, null, "endereço de outra conta não vaza");
});

test("esgotado: PATCH admin reflete no catálogo e bloqueia o checkout (incl. a corrida)", async () => {
  const endereco = {
    nome: "Cliente Esgotado", telefone: "61982749808", cpf: "11144477735", rua: "Rua das Flores",
    numero: "100", bairro: "Centro", cidade: "Brasília", uf: "DF",
  };
  const checkoutBody = () => ({
    items: [{ id: 1, qty: 1 }],
    cep: "70040020",
    shipping_service_id: "1",
    address: endereco,
    paymentMethod: "card",
  });

  // Reaproveita a conta admin já criada no teste de controle de acesso
  // (mesmo ADMIN_EMAIL/senha; registrar de novo daria 409, sem cookie).
  const ra = await post("/api/auth/login", { email: ADMIN_EMAIL, password: "SenhaADM12345!" });
  const adminCookie = cookieFrom(ra);
  assert.ok(adminCookie, "login admin precisa devolver cookie de sessão");
  sharedAdminCookie = adminCookie;

  // Cliente comum faz login para testar o checkout.
  const rc = await post("/api/auth/register", { name: "Cliente Esgotado", email: "clientecor@test.com", password: "SenhaC12345!", cpf: "11144477735" });
  const clienteCookie = cookieFrom(rc);
  sharedClienteCookie = clienteCookie;

  // Disponível: passa da validação de itens (o que sobrar de erro daqui pra
  // frente é só a cotação de frete, que este ambiente não tem credencial
  // real pra completar — por isso checamos "não é 400/409", não um 200).
  const disponivel = await post("/api/create-preference", checkoutBody(), clienteCookie);
  assert.notEqual(disponivel.status, 400);
  assert.notEqual(disponivel.status, 409);

  // A lojista marca como esgotado.
  const patched = await patch("/api/admin/products/1", { soldOut: true }, adminCookie);
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).soldOut, true);

  // O catálogo público e o do admin refletem o estado.
  const pub = await (await fetch(ORIGIN + "/api/products")).json();
  assert.equal(pub.products.find(p => p.id === 1).soldOut, true);
  const adminList = await (await fetch(ORIGIN + "/api/admin/products", { headers: { Cookie: adminCookie } })).json();
  assert.equal(adminList.products.find(p => p.id === 1).soldOut, true);

  // A CONDIÇÃO DE CORRIDA: a cliente já tinha o item no carrinho quando a
  // lojista marcou como esgotado — o checkout revalida e rejeita com 409
  // nomeando o produto, em vez de aceitar um pedido que a loja não atende.
  const corrida = await post("/api/create-preference", checkoutBody(), clienteCookie);
  assert.equal(corrida.status, 409, "produto esgotado entre a escolha e o checkout é rejeitado");
  assert.match((await corrida.json()).error, /Bailarina/);

  // Volta a ficar disponível.
  const voltou = await patch("/api/admin/products/1", { soldOut: false }, adminCookie);
  assert.equal(voltou.status, 200);
  assert.equal((await voltou.json()).soldOut, false);
});

test("galeria de fotos: PATCH admin reflete no catálogo (a 1ª é a capa) e valida limites", async () => {
  // Reaproveita o cookie de admin do teste de estoque por cor, acima — ver
  // comentário em sharedAdminCookie sobre o teto do authLimiter.
  const adminCookie = sharedAdminCookie;
  assert.ok(adminCookie, "precisa de um cookie de admin já autenticado");

  const fotoA = "https://exemplo.test/foto-a.jpg";
  const fotoB = "https://exemplo.test/foto-b.jpg";

  const salvo = await patch("/api/admin/products/2", { photos: [fotoA, fotoB] }, adminCookie);
  assert.equal(salvo.status, 200);
  const salvoBody = await salvo.json();
  assert.deepEqual(salvoBody.photos, [fotoA, fotoB]);
  assert.equal(salvoBody.photoUrl, fotoA, "a 1ª foto da lista é a capa (photoUrl derivado)");

  // Catálogo público e do admin refletem a galeria e a capa.
  const pub = await (await fetch(ORIGIN + "/api/products")).json();
  const p2 = pub.products.find(p => p.id === 2);
  assert.deepEqual(p2.photos, [fotoA, fotoB]);
  assert.equal(p2.photoUrl, fotoA);

  // Só reordenar (sem adicionar/remover nada) já muda a capa.
  const reordenado = await patch("/api/admin/products/2", { photos: [fotoB, fotoA] }, adminCookie);
  assert.equal(reordenado.status, 200);
  assert.equal((await reordenado.json()).photoUrl, fotoB);

  // Mais de 8 fotos, URL duplicada e URL inválida são todas rejeitadas.
  const demais = await patch(
    "/api/admin/products/2",
    { photos: Array.from({ length: 9 }, (_, i) => `https://exemplo.test/foto-${i}.jpg`) },
    adminCookie
  );
  assert.equal(demais.status, 400);
  const duplicada = await patch("/api/admin/products/2", { photos: [fotoA, fotoA] }, adminCookie);
  assert.equal(duplicada.status, 400);
  const invalida = await patch("/api/admin/products/2", { photos: ["nao-e-uma-url"] }, adminCookie);
  assert.equal(invalida.status, 400);

  // Removeu todas as fotos: [] explícito é um estado real (produto sem
  // foto), não um erro — o servidor aceita e devolve photos: [].
  const semFotos = await patch("/api/admin/products/2", { photos: [] }, adminCookie);
  assert.equal(semFotos.status, 200);
  assert.deepEqual((await semFotos.json()).photos, []);
});

test("galeria de fotos: upload real grava no banco (product_photos) e remover a foto do PATCH apaga a linha", async () => {
  const adminCookie = sharedAdminCookie;
  assert.ok(adminCookie, "precisa de um cookie de admin já autenticado");

  // sharp() no servidor recusa bytes que não sejam uma imagem de verdade
  // (diferente do upload antigo, que só gravava em disco sem processar) —
  // por isso o teste precisa de um JPEG real, gerado aqui na hora.
  const jpegBuffer = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 120, b: 160 } },
  }).jpeg().toBuffer();

  const form = new FormData();
  form.append("photo", new Blob([jpegBuffer], { type: "image/jpeg" }), "foto.jpg");
  const up = await fetch(`${ORIGIN}/api/admin/products/3/photo`, {
    method: "POST",
    headers: { Origin: ORIGIN, Cookie: adminCookie },
    body: form,
  });
  assert.equal(up.status, 201);
  const { photoUrl } = await up.json();
  assert.match(photoUrl, /^\/api\/products\/photos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  const served = await fetch(ORIGIN + photoUrl);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/jpeg");
  const servedBuffer = Buffer.from(await served.arrayBuffer());
  const metadata = await sharp(servedBuffer).metadata();
  assert.equal(metadata.format, "jpeg", "bytes devolvidos precisam ser um JPEG decodificável");

  const salvo = await patch("/api/admin/products/3", { photos: [photoUrl] }, adminCookie);
  assert.equal(salvo.status, 200);
  assert.equal((await fetch(ORIGIN + photoUrl)).status, 200, "foto continua servida enquanto está na lista");

  // Remover a foto da lista (photos: []) apaga a linha em product_photos —
  // mesmo racional de deleteOldLocalPhoto ao trocar a foto única antiga.
  const removido = await patch("/api/admin/products/3", { photos: [] }, adminCookie);
  assert.equal(removido.status, 200);
  assert.equal((await fetch(ORIGIN + photoUrl)).status, 404, "foto devia deixar de existir depois de sair da lista");
});


test("?w= na foto: reduz, negocia WebP pelo Accept, ignora largura fora da lista e some junto com a foto", async () => {
  const adminCookie = sharedAdminCookie;
  assert.ok(adminCookie, "precisa de um cookie de admin já autenticado");

  // 1200px de largura para que reduzir para 400 seja mesmo uma redução — com
  // uma imagem de 4px, withoutEnlargement devolveria os 4px e o teste passaria
  // sem provar nada.
  const grande = await sharp({
    create: { width: 1200, height: 1600, channels: 3, background: { r: 210, g: 140, b: 175 } },
  }).jpeg().toBuffer();

  const form = new FormData();
  form.append("photo", new Blob([grande], { type: "image/jpeg" }), "grande.jpg");
  const up = await fetch(`${ORIGIN}/api/admin/products/5/photo`, {
    method: "POST",
    headers: { Origin: ORIGIN, Cookie: adminCookie },
    body: form,
  });
  assert.equal(up.status, 201);
  const { photoUrl } = await up.json();
  await patch("/api/admin/products/5", { photos: [photoUrl] }, adminCookie);

  const bytesDe = async (url, accept) => {
    const r = await fetch(ORIGIN + url, accept ? { headers: { Accept: accept } } : undefined);
    assert.equal(r.status, 200, `${url} devia responder 200`);
    return { r, buf: Buffer.from(await r.arrayBuffer()) };
  };

  // Sem ?w=: original intacto. É a URL gravada no banco e a que
  // lib/emailPhotos.js procura no HTML dos e-mails.
  const original = await bytesDe(photoUrl);
  const metaOriginal = await sharp(original.buf).metadata();
  assert.equal(metaOriginal.width, 1200, "sem ?w= a foto sai no tamanho gravado");
  assert.equal(original.r.headers.get("content-type"), "image/jpeg");

  // ?w=400 sem Accept de WebP: JPEG reduzido.
  const jpeg400 = await bytesDe(photoUrl + "?w=400", "image/jpeg,*/*");
  const metaJpeg = await sharp(jpeg400.buf).metadata();
  assert.equal(metaJpeg.format, "jpeg");
  assert.equal(metaJpeg.width, 400);
  assert.ok(jpeg400.buf.length < original.buf.length, "reduzida precisa pesar menos que o original");

  // Mesmo URL, Accept com WebP: outro formato, mesma largura.
  const webp400 = await bytesDe(photoUrl + "?w=400", "image/webp,image/jpeg,*/*");
  const metaWebp = await sharp(webp400.buf).metadata();
  assert.equal(metaWebp.format, "webp", "com image/webp no Accept a resposta devia ser WebP");
  assert.equal(metaWebp.width, 400);
  assert.equal(webp400.r.headers.get("content-type"), "image/webp");
  assert.match(webp400.r.headers.get("vary") || "", /Accept/i, "resposta que varia por Accept precisa dizer isso");

  // Segunda chamada vem do cache (product_photo_variants) — precisa ser
  // byte a byte o mesmo, senão o "immutable" do Cache-Control seria mentira.
  const webpDeNovo = await bytesDe(photoUrl + "?w=400", "image/webp,*/*");
  assert.ok(webp400.buf.equals(webpDeNovo.buf), "variante cacheada devia devolver exatamente os mesmos bytes");

  // ⚠️ Largura fora da lista é IGNORADA, não gera variante nova: é o que
  // impede alguém de encher o banco pedindo ?w=1,2,3...
  const forcada = await bytesDe(photoUrl + "?w=137", "image/webp,*/*");
  const metaForcada = await sharp(forcada.buf).metadata();
  assert.equal(metaForcada.width, 1200, "largura fora da lista devia cair no original");
  assert.equal(metaForcada.format, "jpeg", "sem largura válida não há negociação de formato");

  // Apagar a foto leva as variantes junto (ON DELETE CASCADE) — senão uma
  // foto trocada no painel continuaria aparecendo pelo ?w=.
  const removido = await patch("/api/admin/products/5", { photos: [] }, adminCookie);
  assert.equal(removido.status, 200);
  assert.equal((await fetch(ORIGIN + photoUrl + "?w=400")).status, 404,
    "variante não pode sobreviver à foto que a originou");
});


test("descrição do produto: PATCH edita, GET /api/products reflete, POST /api/admin/products aceita na criação", async () => {
  const adminCookie = sharedAdminCookie;
  assert.ok(adminCookie);

  // Produto 4 (Laço Pérola) — ainda não tocado pelos testes anteriores.
  const patched = await patch("/api/admin/products/4", { description: "Descrição escrita pela lojista." }, adminCookie);
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).description, "Descrição escrita pela lojista.");

  const pub = await (await fetch(ORIGIN + "/api/products")).json();
  assert.equal(pub.products.find(p => p.id === 4).description, "Descrição escrita pela lojista.");

  // Descrição muito longa é rejeitada.
  const longaDemais = await patch("/api/admin/products/4", { description: "x".repeat(501) }, adminCookie);
  assert.equal(longaDemais.status, 400);

  // String vazia limpa de volta pro padrão (null) — não é erro.
  const limpa = await patch("/api/admin/products/4", { description: "" }, adminCookie);
  assert.equal(limpa.status, 200);
  assert.equal((await limpa.json()).description, null);

  // Criar produto novo já com descrição.
  const created = await post("/api/admin/products", {
    name: "Produto Teste Descrição", description: "Feito sob encomenda.",
    price: 39.9, weight: 0.05, width: 16, height: 3, length: 11, badges: [],
  }, adminCookie);
  assert.equal(created.status, 201);
  assert.equal((await created.json()).description, "Feito sob encomenda.");
});

test("continuar pagamento: 404 se não existe/não é da cliente, 409 se já não está pendente", async () => {
  // Duas clientes novas, cada uma dona de um pedido — tudo inserido direto
  // no banco (db.createUser/createSession/createOrder), sem passar por
  // /api/auth/register nem /api/auth/login: essas rotas dividem o mesmo
  // authLimiter (10 req/15min por IP) com todos os testes deste arquivo, e
  // esta suíte já está perto do teto só com os cadastros que os testes
  // anteriores precisaram fazer. Sessão criada assim é idêntica, para fins
  // de auth.requireAuth, a uma sessão de login de verdade — só pula o
  // hash de senha e o rate limit, que não são o que este teste verifica.
  // Pedidos "pago"/"pendente" também são inseridos direto (db.createOrder):
  // este ambiente de teste não tem credencial real de Mercado Pago/Melhor
  // Envio para levar um pedido de verdade até existir (mesma limitação já
  // documentada nos testes de estoque por cor acima). Isso ainda cobre a
  // parte que É nossa (as travas de dono/status), sem depender de rede.
  function sessionCookieFor(userId){
    const token = crypto.randomBytes(32).toString("hex");
    db.createSession({
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      userId,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    return `plc_session=${token}`;
  }

  const dona = db.createUser({ name: "Dona Pedido", email: "donapedido@test.com", passwordHash: "x", cpf: "11144477735" });
  const donaCookie = sessionCookieFor(dona.id);
  const donaId = dona.id;

  const outra = db.createUser({ name: "Outra Cliente", email: "outracliente@test.com", passwordHash: "x", cpf: "11144477735" });
  const outraCookie = sessionCookieFor(outra.id);

  const pedidoBase = {
    items: [{ id: 1, qty: 1, price: 34.9, color: "#F4B4CC" }],
    address: { nome: "Dona Pedido", telefone: "61982749808", rua: "Rua X", numero: "1", bairro: "B", cidade: "Brasília", uf: "DF", cep: "70040020" },
    shipping: { service_id: "1", name: "PAC", price: 10 },
    subtotal: 34.9, shippingPrice: 10, total: 44.9, customerPhone: "61982749808",
  };

  const pago = db.createOrder({ ...pedidoBase, externalReference: "TEST-PAGO-1", userId: donaId, status: "pago" });
  const pendenteDaDona = db.createOrder({ ...pedidoBase, externalReference: "TEST-PENDENTE-1", userId: donaId, status: "pendente" });

  // Referência que não existe -> 404.
  const inexistente = await post("/api/orders/nao-existe-esta-referencia/resume-payment", {}, donaCookie);
  assert.equal(inexistente.status, 404);

  // Pedido é de outra cliente -> 404 (nunca revela que o pedido existe).
  const deOutra = await post(`/api/orders/${pendenteDaDona.external_reference}/resume-payment`, {}, outraCookie);
  assert.equal(deOutra.status, 404);

  // Pedido já pago -> 409, sem tentar gerar um pagamento novo.
  const jaPago = await post(`/api/orders/${pago.external_reference}/resume-payment`, {}, donaCookie);
  assert.equal(jaPago.status, 409);
});

test("GET /api/orders/:reference — detalhe só para a dona do pedido, com rastreio degradando para null sem Melhor Envio configurado", async () => {
  function sessionCookieFor(userId){
    const token = crypto.randomBytes(32).toString("hex");
    db.createSession({
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      userId,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    return `plc_session=${token}`;
  }

  const dona = db.createUser({ name: "Dona Rastreio", email: "donarastreio@test.com", passwordHash: "x", cpf: "11144477735" });
  const donaCookie = sessionCookieFor(dona.id);
  const outra = db.createUser({ name: "Outra Rastreio", email: "outrarastreio@test.com", passwordHash: "x", cpf: "11144477735" });
  const outraCookie = sessionCookieFor(outra.id);

  const pedido = db.createOrder({
    externalReference: "TEST-DETALHE-1", userId: dona.id, status: "pago",
    items: [{ id: 1, qty: 1, price: 34.9, color: "#F4B4CC" }],
    address: { nome: "Dona Rastreio", telefone: "61982749808", rua: "Rua X", numero: "1", bairro: "B", cidade: "Brasília", uf: "DF", cep: "70040020" },
    shipping: { service_id: "1", name: "PAC", price: 10 },
    subtotal: 34.9, shippingPrice: 10, total: 44.9, customerPhone: "61982749808",
  });
  db.markOrderInProduction(pedido.external_reference);
  db.updateOrderTracking(pedido.external_reference, "AA123456789BR");

  // Sem login -> 401.
  const semLogin = await get(`/api/orders/${pedido.external_reference}`);
  assert.equal(semLogin.status, 401);

  // Referência que não existe -> 404.
  const inexistente = await get("/api/orders/nao-existe-esta-referencia", donaCookie);
  assert.equal(inexistente.status, 404);

  // Pedido é de outra cliente -> 404 (nunca revela que o pedido existe).
  const deOutra = await get(`/api/orders/${pedido.external_reference}`, outraCookie);
  assert.equal(deOutra.status, 404);

  // Dona do pedido -> 200, com o formato esperado.
  const res = await get(`/api/orders/${pedido.external_reference}`, donaCookie);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.reference, pedido.external_reference);
  assert.equal(body.status, "pago");
  assert.equal(body.fulfillmentStatus, "postado");
  assert.equal(body.trackingCode, "AA123456789BR");
  assert.equal(body.carrierUrl, "https://rastreamento.correios.com.br/app/index.php?objetos=AA123456789BR");
  // MELHOR_ENVIO_TOKEN não está configurado neste ambiente de teste — a
  // consulta de rastreio ao vivo sempre degrada para null, nunca quebra.
  assert.equal(body.tracking, null);
});

test("ordem dos produtos: PUT reordena a vitrine, e rejeita lista incompleta/repetida", async () => {
  const adminCookie = sharedAdminCookie;
  assert.ok(adminCookie);

  const idsOriginais = (await (await fetch(ORIGIN + "/api/products")).json()).products.map(p => p.id);
  assert.ok(idsOriginais.length >= 3, "precisa de pelo menos 3 produtos pra testar a troca");

  // Inverter a lista inteira é o caso mais simples de conferir: se a ordem
  // valeu, o primeiro vira o último.
  const invertida = [...idsOriginais].reverse();
  const ok = await put("/api/admin/products/order", { ids: invertida }, adminCookie);
  assert.equal(ok.status, 200);

  const depois = (await (await fetch(ORIGIN + "/api/products")).json()).products.map(p => p.id);
  assert.deepEqual(depois, invertida, "a vitrine passa a seguir a ordem salva");

  // O painel enxerga a mesma ordem que a cliente — se divergirem, a lojista
  // arrasta um produto olhando para uma lista que não é a da loja.
  const noPainel = (await (await fetch(ORIGIN + "/api/admin/products", { headers: { Cookie: adminCookie } })).json()).products.map(p => p.id);
  assert.deepEqual(noPainel, invertida, "painel e vitrine na mesma ordem");

  // Lista sem todos os produtos -> 409 (a tela está velha; gravar deixaria
  // produto sem posição).
  const incompleta = await put("/api/admin/products/order", { ids: invertida.slice(1) }, adminCookie);
  assert.equal(incompleta.status, 409);

  // Id repetido -> 400, antes mesmo de comparar com o catálogo.
  const repetida = await put("/api/admin/products/order", { ids: [invertida[0], ...invertida] }, adminCookie);
  assert.equal(repetida.status, 400);

  // Lista vazia -> 400.
  assert.equal((await put("/api/admin/products/order", { ids: [] }, adminCookie)).status, 400);

  // Cliente comum não reordena a vitrine da loja.
  const comoCliente = await put("/api/admin/products/order", { ids: idsOriginais }, sharedClienteCookie);
  assert.equal(comoCliente.status, 403);

  // Devolve a ordem original pra não interferir em outros testes.
  await put("/api/admin/products/order", { ids: idsOriginais }, adminCookie);
});

test("ocultar produto: some de /api/products, continua em /api/admin/products, e volta ao desocultar", async () => {
  const adminCookie = sharedAdminCookie;
  assert.ok(adminCookie);

  const antes = await (await fetch(ORIGIN + "/api/products")).json();
  assert.ok(antes.products.some(p => p.id === 5), "produto 5 deve estar visível antes do teste");

  const ocultou = await patch("/api/admin/products/5", { hidden: true }, adminCookie);
  assert.equal(ocultou.status, 200);
  assert.equal((await ocultou.json()).hidden, true);

  const pubDepois = await (await fetch(ORIGIN + "/api/products")).json();
  assert.equal(pubDepois.products.some(p => p.id === 5), false, "produto oculto some da vitrine pública");

  const adminDepois = await (await fetch(ORIGIN + "/api/admin/products", { headers: { Cookie: adminCookie } })).json();
  const noPainel = adminDepois.products.find(p => p.id === 5);
  assert.ok(noPainel, "produto oculto continua aparecendo no painel");
  assert.equal(noPainel.hidden, true);

  // Não compra escondido nem chamando a API direto, pulando a vitrine —
  // /api/validate-coupon também passa pelos itens por buildValidatedItems.
  const bloqueado = await post("/api/validate-coupon", { code: "BEMVINDA10", items: [{ id: 5, qty: 1 }] });
  assert.equal(bloqueado.status, 409);
  assert.match((await bloqueado.json()).error, /não está mais disponível/);

  const desocultou = await patch("/api/admin/products/5", { hidden: false }, adminCookie);
  assert.equal(desocultou.status, 200);
  assert.equal((await desocultou.json()).hidden, false);
  const pubFinal = await (await fetch(ORIGIN + "/api/products")).json();
  assert.ok(pubFinal.products.some(p => p.id === 5), "produto volta a aparecer ao desocultar");
});

test("categorias: cria, renomeia (slug não muda), bloqueia excluir em uso, exclui depois de liberar", async () => {
  const adminCookie = sharedAdminCookie;
  assert.ok(adminCookie);

  const criada = await post("/api/admin/categories", { label: "Aniversário Teste" }, adminCookie);
  assert.equal(criada.status, 201);
  const categoria = await criada.json();
  assert.equal(categoria.builtin, false);
  const slug = categoria.slug;

  // Cliente comum não gerencia categorias.
  assert.equal((await post("/api/admin/categories", { label: "Outra" }, sharedClienteCookie)).status, 403);

  // Categoria fixa não pode ser renomeada nem excluída por aqui.
  assert.equal((await patch("/api/admin/categories/festa", { label: "Festa Nova" }, adminCookie)).status, 400);
  assert.equal((await fetch(ORIGIN + `/api/admin/categories/festa`, {
    method: "DELETE", headers: { Origin: ORIGIN, Cookie: adminCookie },
  })).status, 400);

  // Renomear: o slug (o que fica gravado no produto) não muda, só o rótulo.
  const renomeada = await patch(`/api/admin/categories/${slug}`, { label: "Aniversário Renomeado" }, adminCookie);
  assert.equal(renomeada.status, 200);
  const dadosRenomeada = await renomeada.json();
  assert.equal(dadosRenomeada.slug, slug);
  assert.equal(dadosRenomeada.label, "Aniversário Renomeado");
  const listaApósRenomear = (await (await fetch(ORIGIN + "/api/products")).json()).categories;
  assert.ok(listaApósRenomear.some(c => c.slug === slug && c.label === "Aniversário Renomeado"));

  // Atribui a categoria a um produto fixo (via override) — excluir agora
  // deve ser bloqueado, porque o slug do produto ficaria sem rótulo.
  const atribuiu = await patch("/api/admin/products/5", { category: slug }, adminCookie);
  assert.equal(atribuiu.status, 200);

  const bloqueada = await fetch(ORIGIN + `/api/admin/categories/${slug}`, {
    method: "DELETE", headers: { Origin: ORIGIN, Cookie: adminCookie },
  });
  assert.equal(bloqueada.status, 409);
  assert.match((await bloqueada.json()).error, /produto/);

  // Devolve o produto 5 para a categoria original e tenta excluir de novo —
  // agora sem nenhum produto usando o slug, a exclusão deve funcionar.
  await patch("/api/admin/products/5", { category: "festa" }, adminCookie);
  const excluida = await fetch(ORIGIN + `/api/admin/categories/${slug}`, {
    method: "DELETE", headers: { Origin: ORIGIN, Cookie: adminCookie },
  });
  assert.equal(excluida.status, 200);

  const listaFinal = (await (await fetch(ORIGIN + "/api/products")).json()).categories;
  assert.ok(!listaFinal.some(c => c.slug === slug), "categoria excluída não aparece mais na lista");
});

// DELETE /api/auth/account agora leva authLimiter (mesma proteção de
// login/2FA — antes a rota não tinha limitador dedicado, um oráculo de
// senha com 500 tentativas/15min em vez de 10). Pra não gastar do balde
// compartilhado (10/15min, já usado quase todo pelos testes de
// cadastro/login acima) à toa, a conta de teste é criada direto no banco
// (seedLoggedInUser) e a checagem final é uma leitura direta também — só
// as 2 chamadas de DELETE em si (o que este teste realmente testa) passam
// pelo authLimiter de verdade.
test("exclusão de conta: senha errada barra; senha certa apaga e invalida login", async () => {
  const { cookie } = await seedLoggedInUser({ name: "Del", email: "del@test.com", password: "SenhaDEL12345!", cpf: "11144477735" });

  // Senha errada -> 401, conta permanece.
  const bad = await fetch(ORIGIN + "/api/auth/account", {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
    body: JSON.stringify({ password: "errada" }),
  });
  assert.equal(bad.status, 401);
  assert.ok(db.getUserByEmail("del@test.com"), "conta continua existindo após senha errada");

  // Senha certa -> 200.
  const ok = await fetch(ORIGIN + "/api/auth/account", {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
    body: JSON.stringify({ password: "SenhaDEL12345!" }),
  });
  assert.equal(ok.status, 200);

  // Conta some de verdade (checagem direta no banco, sem gastar mais uma
  // chamada do authLimiter num login que já sabemos que vai falhar).
  assert.equal(db.getUserByEmail("del@test.com"), null, "conta apagada");
});
