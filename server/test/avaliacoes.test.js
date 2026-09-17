/**
 * Avaliações de produto e confirmação de recebimento (avaliar.html).
 * Sobe o server.js num processo à parte, com porta e banco ISOLADOS, igual
 * a api.test.js. Roda com: node --test
 *
 * O que estes testes trancam, e por quê:
 *  - o link sem login só funciona com o token certo, e token errado responde
 *    igual a pedido inexistente (não dá para sondar números de pedido);
 *  - a confirmação da cliente convive com a automática — só avança de
 *    "postado" para "entregue", e repetir não quebra;
 *  - nada aparece no site sem a lojista publicar, INCLUSIVE a foto;
 *  - foto de criança não carrega a localização GPS do celular;
 *  - texto de cliente nunca vira HTML na home;
 *  - o cron manda cada e-mail uma vez só e não dispara para pedido antigo.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const sharp = require("sharp");

const PORT = 39571;
const ORIGIN = `http://localhost:${PORT}`;
const ADMIN_EMAIL = "admin-avaliacoes@test.com";
const ADMIN_HASH = crypto.createHash("sha256").update(ADMIN_EMAIL).digest("hex");
const TMP_DB = path.join(os.tmpdir(), `plc-avaliacoes-${process.pid}-${Date.now()}.db`);

process.env.DB_PATH = TMP_DB;
const db = require("../lib/db.js");
const auth = require("../lib/auth.js");

let child;
let adminCookie;
const DIA = 24 * 60 * 60 * 1000;

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
  db.createSession({ tokenHash: crypto.createHash("sha256").update(token).digest("hex"), userId: admin.id, expiresAt: Date.now() + DIA });
  adminCookie = `plc_session=${token}`;
});

after(() => {
  if(child) child.kill();
  limpar();
});

let contador = 0;
function criarPedido({ entregue = false, postado = true, email = "cliente@exemplo.com", items, shipping } = {}){
  const ref = `AVAL-${Date.now()}-${++contador}`;
  const cliente = db.createUser({ name: "Maria", email: `maria${contador}-${Date.now()}@t.com`, passwordHash: "x", cpf: null });
  db.createOrder({
    externalReference: ref, userId: cliente.id, status: "pago",
    items: items || [{ id: 1, qty: 1, price: 30, color: "#F4B4CC" }, { id: 2, qty: 2, price: 25, color: "#FFFFFF" }],
    address: { nome: "Maria Clara Souza", cidade: "Brasília", uf: "df", cpf: "11144477735", rua: "Rua X" },
    shipping: shipping || { service_id: "1", name: "SEDEX", price: 20, delivery_time: 3 },
    subtotal: 80, shippingPrice: 20, total: 100, customerPhone: "61999999999", customerEmail: email,
  });
  if(postado) db.updateOrderTracking(ref, "ME123456789BR");
  if(entregue) db.markOrderDelivered(ref);
  return { ref, token: db.garantirTokenDeAvaliacao(ref) };
}

function chamar(metodo, url, { token, body, cookie, form } = {}){
  const headers = { Origin: ORIGIN };
  if(token !== undefined) headers["X-Avaliar-Token"] = token;
  if(cookie) headers.Cookie = cookie;
  let corpo;
  if(form){ corpo = form; }
  else if(body !== undefined){ headers["Content-Type"] = "application/json"; corpo = JSON.stringify(body); }
  return fetch(ORIGIN + url, { method: metodo, headers, body: corpo });
}

function formDeAvaliacao(avaliacoes, fotos = {}){
  const form = new FormData();
  form.append("avaliacoes", JSON.stringify(avaliacoes));
  for(const [produto, buffer] of Object.entries(fotos)){
    form.append(`foto-${produto}`, new Blob([buffer], { type: "image/jpeg" }), "foto.jpg");
  }
  return form;
}

async function fotoComGps(){
  return sharp({ create: { width: 600, height: 400, channels: 3, background: "#f4b4cc" } })
    .jpeg()
    .withExif({ IFD0: { Make: "iPhone" }, IFD3: { GPSLatitudeRef: "S", GPSLatitude: "15/1 47/1 0/1" } })
    .toBuffer();
}

test("sem nenhuma avaliação publicada, a home não mostra nota nem seção — nada de número inventado", async () => {
  const home = await (await fetch(ORIGIN + "/")).text();
  assert.ok(!home.includes("O que dizem as clientes"));
  assert.ok(!home.includes("avaliação média"), "o 4,9 fixo antigo não pode voltar");
  assert.ok(home.includes("envio para todo o Brasil"), "sem avaliações, o terceiro número é uma informação real, não some");
  assert.ok(!/de \d+ avaliaç/.test(home));
  assert.ok(!home.includes("<!--#NOTA-MEDIA#-->") && !home.includes("<!--#AVALIACOES#-->"), "marcador não pode vazar cru");
});

test("token errado responde igual a pedido inexistente", async () => {
  const { ref, token } = criarPedido({ entregue: true });

  const certo = await chamar("GET", `/api/avaliar/${ref}`, { token });
  assert.equal(certo.status, 200);

  const errado = await chamar("GET", `/api/avaliar/${ref}`, { token: "0".repeat(64) });
  const semToken = await chamar("GET", `/api/avaliar/${ref}`, {});
  const inexistente = await chamar("GET", `/api/avaliar/NAO-EXISTE`, { token });
  for(const res of [errado, semToken, inexistente]){
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Link inválido ou expirado." });
  }
});

test("a página recebe só o necessário — nada de CPF, endereço ou valores", async () => {
  const { ref, token } = criarPedido({ entregue: true });
  const corpo = await (await chamar("GET", `/api/avaliar/${ref}`, { token })).json();
  const texto = JSON.stringify(corpo);
  assert.ok(!texto.includes("11144477735"), "CPF não pode sair nesta rota sem login");
  assert.ok(!texto.includes("Rua X"));
  assert.ok(!texto.includes("total"));
  assert.equal(corpo.produtos.length, 2, "cada produto aparece uma vez");
});

test("confirmar recebimento pelo link só vale de postado para entregue, e repetir não quebra", async () => {
  const naoPostado = criarPedido({ postado: false });
  const cedo = await chamar("POST", `/api/avaliar/${naoPostado.ref}/recebi`, { token: naoPostado.token });
  assert.equal(cedo.status, 409);

  const { ref, token } = criarPedido();
  const primeira = await chamar("POST", `/api/avaliar/${ref}/recebi`, { token });
  assert.equal(primeira.status, 200);
  assert.equal(db.getOrderByExternalReference(ref).fulfillment_status, "entregue");

  const repetida = await chamar("POST", `/api/avaliar/${ref}/recebi`, { token });
  assert.equal(repetida.status, 200);
  assert.equal((await repetida.json()).jaEstava, true);
});

test("pedido entregue pela verificação automática continua aceitando o link da cliente", async () => {
  const { ref, token } = criarPedido();
  db.markOrderDelivered(ref);
  const res = await chamar("POST", `/api/avaliar/${ref}/recebi`, { token });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).jaEstava, true);
});

test("não dá para avaliar antes de confirmar que recebeu", async () => {
  const { ref, token } = criarPedido();
  const res = await chamar("POST", `/api/avaliar/${ref}`, { token, form: formDeAvaliacao([{ productId: 1, rating: 5 }]) });
  assert.equal(res.status, 409);
});

test("avaliação nasce pendente e a foto pendente não é acessível publicamente", async () => {
  const { ref, token } = criarPedido({ entregue: true });
  const res = await chamar("POST", `/api/avaliar/${ref}`, {
    token,
    form: formDeAvaliacao([{ productId: 1, rating: 5, comment: "Amei!", autorizaFoto: true }], { 1: await fotoComGps() }),
  });
  assert.equal(res.status, 200);

  const salva = db.avaliacoesDoPedido(ref)[0];
  assert.equal(salva.status, "pendente");
  assert.ok(salva.photo_id);

  const publica = await fetch(`${ORIGIN}/api/avaliacoes/fotos/${salva.photo_id}`);
  assert.equal(publica.status, 404, "foto não pode sair antes de a lojista publicar");
  for(const w of [160, 640]){
    const variante = await fetch(`${ORIGIN}/api/avaliacoes/fotos/${salva.photo_id}?w=${w}`);
    assert.equal(variante.status, 404, `miniatura ?w=${w} também não pode sair antes de publicar`);
  }

  const home = await (await fetch(ORIGIN + "/")).text();
  assert.ok(!home.includes("Amei!"), "pendente não aparece na home");
});

test("foto enviada pela cliente perde a localização GPS e todos os metadados", async () => {
  const original = await fotoComGps();
  assert.ok((await sharp(original).metadata()).exif, "a foto de teste precisa começar COM exif");

  const { ref, token } = criarPedido({ entregue: true });
  await chamar("POST", `/api/avaliar/${ref}`, {
    token,
    form: formDeAvaliacao([{ productId: 2, rating: 4, autorizaFoto: true }], { 2: original }),
  });
  const photoId = db.avaliacoesDoPedido(ref)[0].photo_id;
  const gravada = db.getReviewPhoto(photoId);
  const meta = await sharp(Buffer.from(gravada.data)).metadata();
  assert.equal(meta.exif, undefined, "metadados (inclusive GPS) precisam sair no reencode");
});

test("foto sem autorização de uso é recusada e nada é gravado pela metade", async () => {
  const { ref, token } = criarPedido({ entregue: true });
  const res = await chamar("POST", `/api/avaliar/${ref}`, {
    token,
    form: formDeAvaliacao(
      [{ productId: 1, rating: 5, comment: "primeira" }, { productId: 2, rating: 3, autorizaFoto: false }],
      { 2: await fotoComGps() }
    ),
  });
  assert.equal(res.status, 400);
  assert.equal(db.avaliacoesDoPedido(ref).length, 0, "a primeira avaliação não pode ter ficado gravada");
});

test("produto que não está no pedido e nota fora de 1-5 são ignorados", async () => {
  const { ref, token } = criarPedido({ entregue: true });
  const res = await chamar("POST", `/api/avaliar/${ref}`, {
    token,
    form: formDeAvaliacao([{ productId: 999, rating: 5 }, { productId: 1, rating: 9 }, { productId: 1, rating: 0 }]),
  });
  assert.equal(res.status, 400);
  assert.equal(db.avaliacoesDoPedido(ref).length, 0);
});

test("publicar pelo painel mostra na home com texto escapado, média real e foto liberada", async () => {
  const { ref, token } = criarPedido({ entregue: true });
  const perigoso = `<script>alert(1)</script> $& lindo`;
  await chamar("POST", `/api/avaliar/${ref}`, {
    token,
    form: formDeAvaliacao([{ productId: 1, rating: 4, comment: perigoso, autorizaFoto: true }], { 1: await fotoComGps() }),
  });
  const avaliacao = db.listarAvaliacoesPainel().find(r => r.order_reference === ref);

  const semLogin = await chamar("POST", `/api/admin/avaliacoes/${avaliacao.id}/publicar`, { body: {} });
  assert.equal(semLogin.status, 401);

  const publicar = await chamar("POST", `/api/admin/avaliacoes/${avaliacao.id}/publicar`, { body: {}, cookie: adminCookie });
  assert.equal(publicar.status, 200);

  const home = await (await fetch(ORIGIN + "/")).text();
  assert.ok(home.includes("O que dizem as clientes"));
  assert.ok(!home.includes("<script>alert(1)</script>"), "comentário não pode virar HTML");
  assert.ok(home.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!home.includes("<!--#AVALIACOES#-->") && !home.includes("<!--#NOTA-MEDIA#-->"), "o \"$&\" não pode reinjetar o marcador");
  assert.ok(home.includes("Maria · Brasília/DF"), "só primeiro nome e cidade");
  assert.ok(!home.includes("Souza"), "sobrenome nunca aparece");
  assert.match(home, /avaliação|avaliações/);

  assert.ok(home.includes("Compra verificada"), "selo de compra verificada no card");
  assert.ok(home.includes(`/api/avaliacoes/fotos/${avaliacao.photo_id}?w=160`), "card usa a miniatura, não a foto inteira");
  assert.ok(home.includes(`/api/avaliacoes/fotos/${avaliacao.photo_id}?w=640`), "ampliação usa a variante de 640");

  const foto = await fetch(`${ORIGIN}/api/avaliacoes/fotos/${avaliacao.photo_id}`);
  assert.equal(foto.status, 200);

  const miniatura = await fetch(`${ORIGIN}/api/avaliacoes/fotos/${avaliacao.photo_id}?w=160`, { headers: { accept: "image/webp" } });
  assert.equal(miniatura.status, 200);
  assert.equal(miniatura.headers.get("content-type"), "image/webp");
  const metaMiniatura = await sharp(Buffer.from(await miniatura.arrayBuffer())).metadata();
  assert.ok(metaMiniatura.width <= 160);
  assert.equal(metaMiniatura.exif, undefined, "miniatura também sai sem metadados");
  const emCache = await fetch(`${ORIGIN}/api/avaliacoes/fotos/${avaliacao.photo_id}?w=160`, { headers: { accept: "image/webp" } });
  assert.equal(emCache.status, 200);

  const ocultar = await chamar("POST", `/api/admin/avaliacoes/${avaliacao.id}/ocultar`, { body: {}, cookie: adminCookie });
  assert.equal(ocultar.status, 200);
  assert.equal((await fetch(`${ORIGIN}/api/avaliacoes/fotos/${avaliacao.photo_id}`)).status, 404, "ocultou, a foto sai de circulação");
  assert.equal(
    (await fetch(`${ORIGIN}/api/avaliacoes/fotos/${avaliacao.photo_id}?w=160`, { headers: { accept: "image/webp" } })).status,
    404,
    "miniatura já guardada não pode continuar saindo depois de ocultar"
  );
});

test("avaliação já publicada não é reescrita pelo mesmo link", async () => {
  const { ref, token } = criarPedido({ entregue: true });
  await chamar("POST", `/api/avaliar/${ref}`, { token, form: formDeAvaliacao([{ productId: 1, rating: 5, comment: "aprovado" }]) });
  const id = db.listarAvaliacoesPainel().find(r => r.order_reference === ref).id;
  db.mudarStatusAvaliacao(id, "publicada");

  const troca = await chamar("POST", `/api/avaliar/${ref}`, { token, form: formDeAvaliacao([{ productId: 1, rating: 1, comment: "trocado" }]) });
  assert.equal(troca.status, 409);
  assert.equal(db.avaliacoesDoPedido(ref)[0].comment, "aprovado");
});

test("publicar sem a foto apaga os bytes da foto de verdade", async () => {
  const { ref, token } = criarPedido({ entregue: true });
  await chamar("POST", `/api/avaliar/${ref}`, {
    token, form: formDeAvaliacao([{ productId: 2, rating: 5, autorizaFoto: true }], { 2: await fotoComGps() }),
  });
  const r = db.listarAvaliacoesPainel().find(x => x.order_reference === ref);
  const res = await chamar("POST", `/api/admin/avaliacoes/${r.id}/publicar`, { body: { semFoto: true }, cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.equal(db.getReviewPhoto(r.photo_id), null, "foto recusada não fica guardada no banco");
});

test("média só conta publicadas", () => {
  const antes = db.notaMedia();
  const { ref } = criarPedido({ entregue: true });
  db.salvarAvaliacao({ orderReference: ref, productId: 1, rating: 1, comment: "pendente" });
  assert.deepEqual(db.notaMedia(), antes, "pendente não mexe na média");
});

test("cron: \"seu pedido chegou?\" só depois do prazo, uma vez só, e nunca para pedido antigo", () => {
  const agora = Date.now();
  const { ref } = criarPedido();
  const tarefas = require("../scripts/tarefas-periodicas.js");

  assert.ok(!db.pedidosParaConfirmarRecebimento(agora).some(p => p.external_reference === ref), "no prazo, não pergunta");

  const depoisDoPrazo = agora + 7 * DIA;
  assert.ok(db.pedidosParaConfirmarRecebimento(depoisDoPrazo).some(p => p.external_reference === ref));

  const primeira = tarefas.enfileirarConfirmacoesDeRecebimento(depoisDoPrazo);
  const segunda = tarefas.enfileirarConfirmacoesDeRecebimento(depoisDoPrazo);
  assert.ok(primeira >= 1);
  assert.equal(segunda, 0, "índice único da fila: cada pedido recebe uma vez");
  const fila = db.getOutboxEntry("confirmar_recebimento", ref);
  assert.ok(fila.html_body.includes("#t="), "link leva o token depois do #");

  const muitoDepois = agora + 60 * DIA;
  assert.ok(!db.pedidosParaConfirmarRecebimento(muitoDepois).some(p => p.external_reference === ref),
    "pedido postado há mais de 45 dias não recebe e-mail do nada");
});

test("cron: prazo gravado como texto (pedidos reais) é respeitado, não cai nos 7 dias padrão", () => {
  const agora = Date.now();
  const { ref } = criarPedido({ shipping: { service_id: "2", name: "Correios · SEDEX", price: 20, delivery_time: "2 dia(s) útil(eis)" } });
  const pergunta = (dias) => db.pedidosParaConfirmarRecebimento(agora + dias * DIA).some(p => p.external_reference === ref);
  assert.equal(pergunta(4.9), false, "prazo 2 + folga 3: ainda não");
  assert.equal(pergunta(5.1), true, "passou de 2 + 3 dias: pergunta — antes esperava 10");
});

test("cron: pedido de avaliação 2 dias após a entrega, só para quem não avaliou, janela de 30 dias", () => {
  const agora = Date.now();
  const tarefas = require("../scripts/tarefas-periodicas.js");
  const semAvaliar = criarPedido({ entregue: true });
  const jaAvaliou = criarPedido({ entregue: true });
  db.salvarAvaliacao({ orderReference: jaAvaliou.ref, productId: 1, rating: 5 });

  assert.ok(!db.pedidosParaPedirAvaliacao(agora).some(p => p.external_reference === semAvaliar.ref), "acabou de receber: espera");

  const doisDiasDepois = agora + 2 * DIA + 1000;
  const escolhidos = db.pedidosParaPedirAvaliacao(doisDiasDepois).map(p => p.external_reference);
  assert.ok(escolhidos.includes(semAvaliar.ref));
  assert.ok(!escolhidos.includes(jaAvaliou.ref), "quem já avaliou não recebe pedido de avaliação");

  tarefas.enfileirarPedidosDeAvaliacao(doisDiasDepois);
  assert.equal(tarefas.enfileirarPedidosDeAvaliacao(doisDiasDepois), 0);

  assert.ok(!db.pedidosParaPedirAvaliacao(agora + 40 * DIA).some(p => p.external_reference === semAvaliar.ref),
    "entregue há mais de 30 dias fica de fora");
});

test("dona do pedido recebe o link de avaliar na API de acompanhamento", async () => {
  const cliente = db.createUser({ name: "Dona", email: `dona-${Date.now()}@t.com`, passwordHash: "x", cpf: null });
  const token = crypto.randomBytes(32).toString("hex");
  db.createSession({ tokenHash: crypto.createHash("sha256").update(token).digest("hex"), userId: cliente.id, expiresAt: Date.now() + DIA });
  const ref = `AVAL-DONA-${Date.now()}`;
  db.createOrder({
    externalReference: ref, userId: cliente.id, status: "pago",
    items: [{ id: 1, qty: 1, price: 30 }], address: { nome: "Dona" },
    shipping: { name: "PAC", price: 10 }, subtotal: 30, shippingPrice: 10, total: 40,
  });
  db.updateOrderTracking(ref, "ME1");
  db.markOrderDelivered(ref);

  const lista = await (await fetch(`${ORIGIN}/api/orders`, { headers: { Cookie: `plc_session=${token}` } })).json();
  const pedido = lista.orders.find(o => o.reference === ref);
  assert.match(pedido.avaliarUrl, new RegExp(`^avaliar\\.html\\?pedido=${ref}#t=[0-9a-f]{64}$`));
  assert.deepEqual(pedido.avaliacao, { produtos: 1, feitas: 0, pendentes: 0, completa: false });
});

test("reenviar pelo mesmo link sem foto mantém a foto; trocar ou remover apaga a antiga do banco", async () => {
  const { ref, token } = criarPedido({ entregue: true });
  const fotoDoProduto = () => db.avaliacoesDoPedido(ref).find(r => r.product_id === 1)?.photo_id || null;
  const existe = (id) => Boolean(db.getReviewPhoto(id));

  await chamar("POST", `/api/avaliar/${ref}`, {
    token, form: formDeAvaliacao([{ productId: 1, rating: 5, comment: "primeira", autorizaFoto: true }], { 1: await fotoComGps() }),
  });
  const primeira = fotoDoProduto();
  assert.ok(primeira);

  const propria = await fetch(`${ORIGIN}/api/avaliar/${ref}/foto/1`, { headers: { "X-Avaliar-Token": token } });
  assert.equal(propria.status, 200, "a cliente vê a própria foto pendente pelo link");
  assert.equal((await fetch(`${ORIGIN}/api/avaliar/${ref}/foto/1`)).status, 404, "sem token, nada");

  const ajuste = await chamar("POST", `/api/avaliar/${ref}`, {
    token, form: formDeAvaliacao([{ productId: 1, rating: 4, comment: "ajustei o texto" }]),
  });
  assert.equal(ajuste.status, 200);
  assert.equal(fotoDoProduto(), primeira, "ajustar só o texto não pode tirar a foto");
  assert.equal(db.avaliacoesDoPedido(ref)[0].comment, "ajustei o texto");

  await chamar("POST", `/api/avaliar/${ref}`, {
    token, form: formDeAvaliacao([{ productId: 1, rating: 4, autorizaFoto: true }], { 1: await fotoComGps() }),
  });
  const segunda = fotoDoProduto();
  assert.ok(segunda && segunda !== primeira);
  assert.equal(existe(primeira), false, "foto trocada é apagada, não fica órfã");

  await chamar("POST", `/api/avaliar/${ref}`, {
    token, form: formDeAvaliacao([{ productId: 1, rating: 4, removerFoto: true }]),
  });
  assert.equal(fotoDoProduto(), null);
  assert.equal(existe(segunda), false, "foto removida pela cliente é apagada do banco");
});

test("pedido com uma peça avaliada de duas ainda mostra que falta avaliar", async () => {
  const cliente = db.createUser({ name: "Duas", email: `duas-${Date.now()}@t.com`, passwordHash: "x", cpf: null });
  const sessao = crypto.randomBytes(32).toString("hex");
  db.createSession({ tokenHash: crypto.createHash("sha256").update(sessao).digest("hex"), userId: cliente.id, expiresAt: Date.now() + DIA });
  const ref = `AVAL-DUAS-${Date.now()}`;
  db.createOrder({
    externalReference: ref, userId: cliente.id, status: "pago",
    items: [{ id: 1, qty: 1, price: 30 }, { id: 2, qty: 1, price: 30 }], address: { nome: "Duas" },
    shipping: { name: "PAC", price: 10 }, subtotal: 60, shippingPrice: 10, total: 70,
  });
  db.updateOrderTracking(ref, "ME2");
  db.markOrderDelivered(ref);
  const token = db.garantirTokenDeAvaliacao(ref);
  await chamar("POST", `/api/avaliar/${ref}`, { token, form: formDeAvaliacao([{ productId: 1, rating: 5 }]) });

  const lista = await (await fetch(`${ORIGIN}/api/orders`, { headers: { Cookie: `plc_session=${sessao}` } })).json();
  const pedido = lista.orders.find(o => o.reference === ref);
  assert.deepEqual(pedido.avaliacao, { produtos: 2, feitas: 1, pendentes: 1, completa: false });
});
