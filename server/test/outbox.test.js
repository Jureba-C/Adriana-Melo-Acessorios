/**
 * Testes da fila de e-mail da cliente (email_outbox em lib/db.js), num banco
 * ISOLADO em tmp. Roda com: node --test
 *
 * Existe porque até então a cliente não recebia NENHUM e-mail — nem
 * confirmação, nem o código de rastreio que a home promete. Enviar direto,
 * dentro de um try/catch, faria uma falha de SMTP sumir sem deixar rastro:
 * ninguém saberia que o recibo não chegou. A fila troca "sumiu" por "está
 * gravado, com o erro, e será tentado de novo".
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

// Precisa vir ANTES de require("../lib/db.js"): o db.js lê DB_PATH no load.
const TMP_DB = path.join(os.tmpdir(), `plc-outbox-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = TMP_DB;
const db = require("../lib/db.js");
const email = require("../lib/email.js");
const emailPhotos = require("../lib/emailPhotos.js");
const sharp = require("sharp");

function limpar(){
  for(const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
}
before(limpar);
after(limpar);

function mensagem(extra = {}){
  return {
    kind: "pedido_confirmado",
    toEmail: "cliente@exemplo.com",
    subject: "Pedido confirmado",
    textBody: "texto",
    htmlBody: "<p>html</p>",
    orderReference: "AMK-TESTE-1",
    ...extra,
  };
}

test("enfileirar guarda a mensagem e ela aparece como pendente", () => {
  const id = db.enqueueEmail(mensagem());
  assert.ok(id, "enfileirar deve devolver o id da linha");
  const linha = db.getOutboxEmail(id);
  assert.equal(linha.to_email, "cliente@exemplo.com");
  assert.equal(linha.sent_at, null);
  assert.equal(linha.attempts, 0);
  assert.ok(db.pendingEmails().some(l => l.id === id));
});

/* O Mercado Pago reenvia a notificação de pagamento. Sem a trava, a cliente
   receberia o mesmo recibo duas, três vezes. */
test("webhook reenviado não gera recibo repetido", () => {
  const primeira = db.enqueueEmail(mensagem({ orderReference: "AMK-TESTE-2" }));
  const segunda = db.enqueueEmail(mensagem({ orderReference: "AMK-TESTE-2" }));
  assert.ok(primeira);
  assert.equal(segunda, null, "a segunda tentativa precisa ser barrada");
  const doPedido = db.pendingEmails(100).filter(l => l.order_reference === "AMK-TESTE-2");
  assert.equal(doPedido.length, 1);
});

/* A trava é por (tipo, pedido): o mesmo pedido tem DOIS e-mails ao longo da
   vida — o recibo e, depois, o aviso de postagem. */
test("o mesmo pedido ainda recebe o aviso de postagem além do recibo", () => {
  const ref = "AMK-TESTE-3";
  const recibo = db.enqueueEmail(mensagem({ orderReference: ref }));
  const postado = db.enqueueEmail(mensagem({ kind: "pedido_postado", orderReference: ref }));
  assert.ok(recibo);
  assert.ok(postado, "tipo diferente no mesmo pedido precisa passar");
  assert.notEqual(recibo, postado);
});

test("falha guarda o erro e adia a próxima tentativa em vez de perder o e-mail", () => {
  const id = db.enqueueEmail(mensagem({ orderReference: "AMK-TESTE-4" }));
  db.markEmailFailed(id, "SMTP fora do ar");

  const linha = db.getOutboxEmail(id);
  assert.equal(linha.attempts, 1);
  assert.equal(linha.last_error, "SMTP fora do ar");
  assert.equal(linha.sent_at, null, "falhar não pode marcar como enviado");
  assert.ok(linha.next_attempt_at > Date.now(), "a próxima tentativa fica no futuro");
  assert.ok(
    !db.pendingEmails(100).some(l => l.id === id),
    "durante a espera o e-mail não deve ser tentado de novo"
  );
});

test("a espera entre tentativas cresce a cada falha", () => {
  const id = db.enqueueEmail(mensagem({ orderReference: "AMK-TESTE-5" }));
  db.markEmailFailed(id, "erro 1");
  const primeiraEspera = db.getOutboxEmail(id).next_attempt_at - Date.now();
  db.markEmailFailed(id, "erro 2");
  const segundaEspera = db.getOutboxEmail(id).next_attempt_at - Date.now();
  assert.ok(segundaEspera > primeiraEspera * 2, "a segunda espera precisa ser bem maior que a primeira");
});

test("depois de 5 tentativas o e-mail para de ser tentado", () => {
  const id = db.enqueueEmail(mensagem({ orderReference: "AMK-TESTE-6" }));
  for(let i = 0; i < 5; i++) db.markEmailFailed(id, `erro ${i}`);
  assert.equal(db.getOutboxEmail(id).attempts, 5);
  assert.ok(
    !db.pendingEmails(100).some(l => l.id === id),
    "desistir evita insistir para sempre num endereço inválido"
  );
});

test("enviado sai da fila", () => {
  const id = db.enqueueEmail(mensagem({ orderReference: "AMK-TESTE-7" }));
  db.markEmailSent(id);
  const linha = db.getOutboxEmail(id);
  assert.ok(linha.sent_at, "sent_at precisa ficar preenchido");
  assert.equal(linha.last_error, null);
  assert.ok(!db.pendingEmails(100).some(l => l.id === id));
});

test("o pedido guarda o e-mail da cliente para o recibo ter destinatário", () => {
  const pedido = db.createOrder({
    externalReference: "AMK-TESTE-8",
    userId: null,
    items: [{ id: 1, qty: 1, price: 10 }],
    address: { nome: "Maria" },
    shipping: { price: 0 },
    subtotal: 10,
    shippingPrice: 0,
    total: 10,
    customerEmail: "maria@exemplo.com",
  });
  assert.equal(pedido.customer_email, "maria@exemplo.com");
});

/* Os dois e-mails são montados por funções puras — dá para conferir o
   conteúdo sem nenhum SMTP no meio. */
test("o recibo mostra os valores reais do pedido", () => {
  const r = email.formatOrderConfirmationEmail({
    externalReference: "AMK-9", items: [{ qty: 2, name: "Laço Borboleta", price: 39.9 }],
    subtotal: 79.8, discount: 8, pixDiscount: 3.59, shippingPrice: 0, total: 68.21,
    couponCode: "BEMVINDA10", address: { nome: "Maria Silva" }, paidAt: Date.now(),
    trackUrl: "https://exemplo/acompanhar-pedido.html?pedido=AMK-9",
  });
  assert.match(r.subject, /AMK-9/);
  assert.match(r.text, /2x Laço Borboleta/);
  assert.match(r.text, /BEMVINDA10/);
  assert.match(r.text, /Frete: grátis/);
  assert.match(r.text, /Total: R\$ 68,21/);
  assert.ok(r.html.includes("acompanhar-pedido.html"), "precisa levar ao acompanhamento");
});

test("o aviso de postagem leva o código de rastreio", () => {
  const r = email.formatTrackingEmail({
    externalReference: "AMK-9", trackingCode: "BR123456789BR",
    address: { nome: "Maria Silva" }, trackUrl: "https://exemplo/a",
  });
  assert.match(r.text, /BR123456789BR/);
  assert.ok(r.html.includes("BR123456789BR"));
});

/* A lojista digita o rastreio à mão. Se errar e corrigir, a cliente PRECISA
   receber o código certo — a trava de duplicata não pode transformar um erro
   de digitação em código errado para sempre. */
test("corrigir o código de rastreio permite avisar de novo", () => {
  const ref = "AMK-TESTE-10";
  const primeiro = db.enqueueEmail(mensagem({ kind: "pedido_postado", orderReference: ref }));
  assert.ok(primeiro);
  assert.equal(db.enqueueEmail(mensagem({ kind: "pedido_postado", orderReference: ref })), null,
    "sem apagar antes, o índice único barra");

  const apagados = db.deleteOutboxEntry("pedido_postado", ref);
  assert.equal(apagados, 1);

  const segundo = db.enqueueEmail(mensagem({ kind: "pedido_postado", orderReference: ref }));
  assert.ok(segundo, "depois de descartar o aviso antigo, o novo passa");
  assert.notEqual(segundo, primeiro);
});

test("descartar aviso não mexe no recibo do mesmo pedido", () => {
  const ref = "AMK-TESTE-11";
  const recibo = db.enqueueEmail(mensagem({ kind: "pedido_confirmado", orderReference: ref }));
  db.enqueueEmail(mensagem({ kind: "pedido_postado", orderReference: ref }));
  db.deleteOutboxEntry("pedido_postado", ref);
  assert.ok(db.getOutboxEmail(recibo), "o recibo tem de continuar lá");
});

/* ============ MINIATURAS DE PRODUTO NOS E-MAILS ============
   Os anexos são derivados do HTML na hora de enviar, porque a fila guarda só
   o texto da mensagem. O risco desse desenho é o HTML e a derivação saírem de
   sincronia: sobra um cid: sem anexo, que o Outlook desenha como ícone de
   imagem quebrada. Os testes abaixo existem para pegar exatamente isso. */

const UUID_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const rota = (id) => `/api/products/photos/${id}`;

function cidsNoHtml(html){
  return [...new Set(Array.from(html.matchAll(/cid:produto-([0-9a-f-]{36})/g), m => m[1]))];
}

async function plantarFoto(id){
  const jpeg = await sharp({ create: { width: 60, height: 60, channels: 3, background: "#EA8FB4" } })
    .jpeg().toBuffer();
  db.insertProductPhoto(id, "image/jpeg", jpeg);
}

function reciboCom(items){
  return email.formatOrderConfirmationEmail({
    externalReference: "AMK-FOTO", items,
    subtotal: 100, discount: 0, pixDiscount: 0, shippingPrice: 0, total: 100,
    couponCode: null, address: { nome: "Cliente" }, paidAt: Date.now(),
    trackUrl: "https://exemplo/a",
  });
}
function avisoDaLojistaCom(items){
  return email.formatOrderEmail({
    externalReference: "AMK-FOTO", items, address: { nome: "Cliente" },
    total: 100, paidAt: Date.now(), adminUrl: "https://exemplo/admin.html", allColors: [],
  });
}

test("todo cid de produto no HTML tem anexo correspondente", async () => {
  await plantarFoto(UUID_A);
  const itens = [
    { qty: 1, name: "Com foto", price: 50, photoUrl: rota(UUID_A) },
    { qty: 1, name: "Sem foto", price: 50, photoUrl: null },
  ];
  for(const [rotulo, msg] of [["recibo", reciboCom(itens)], ["aviso", avisoDaLojistaCom(itens)]]){
    const anexos = await emailPhotos.anexosDeMiniaturas(msg.html);
    assert.equal(anexos.length, cidsNoHtml(msg.html).length,
      `${rotulo}: sobrou cid sem anexo — vira ícone quebrado no Outlook`);
    assert.ok(anexos.every(a => msg.html.includes(`cid:${a.cid}`)),
      `${rotulo}: anexo sem cid correspondente no HTML`);
  }
});

test("produto sem foto não gera anexo, e mostra o laço", async () => {
  const msg = reciboCom([{ qty: 1, name: "Sem foto", price: 50, photoUrl: null }]);
  assert.deepEqual(await emailPhotos.anexosDeMiniaturas(msg.html), []);
  assert.match(msg.html, /&#127872;/, "o laço substitui a foto que não existe");
});

test("o mesmo produto repetido custa um anexo só", async () => {
  await plantarFoto(UUID_B);
  const msg = reciboCom([
    { qty: 1, name: "Igual", price: 50, photoUrl: rota(UUID_B) },
    { qty: 2, name: "Igual de novo", price: 50, photoUrl: rota(UUID_B) },
  ]);
  assert.equal((await emailPhotos.anexosDeMiniaturas(msg.html)).length, 1);
});

/* A lojista trocar a foto de um produto APAGA o blob antigo. Um e-mail pode
   ficar na fila até ~9h esperando retentativa, então essa corrida é real. */
test("foto apagada depois de enfileirar ainda rende um anexo", async () => {
  const id = "cccccccc-3333-4333-8333-cccccccccccc";
  await plantarFoto(id);
  const msg = reciboCom([{ qty: 1, name: "Trocada", price: 50, photoUrl: rota(id) }]);

  const antes = await emailPhotos.anexosDeMiniaturas(msg.html);
  db.deleteProductPhoto(id);
  const depois = await emailPhotos.anexosDeMiniaturas(msg.html);

  assert.equal(depois.length, antes.length,
    "sem anexo, o cid vira ícone de imagem quebrada — pior que não ter miniatura");
  assert.ok(depois[0].content.length > 0, "o bloco liso precisa ter conteúdo");
});

test("URL externa não vira anexo, entra como imagem remota", async () => {
  const msg = reciboCom([{ qty: 1, name: "Externa", price: 50, photoUrl: "https://exemplo.com/f.jpg" }]);
  assert.deepEqual(await emailPhotos.anexosDeMiniaturas(msg.html), []);
  assert.match(msg.html, /src="https:\/\/exemplo\.com\/f\.jpg"/);
});

/* =========================================================================
   Avisos que vão para a LOJISTA (venda nova, mensagem de contato)
   -------------------------------------------------------------------------
   Antes eram envio direto: uma falha de SMTP no instante da venda apagava o
   aviso para sempre, e ela nunca saberia que perdeu um pedido de vista. Os
   testes abaixo trancam as três garantias que a fila trouxe.
========================================================================= */
function avisoDeVenda(extra = {}){
  return {
    kind: "aviso_venda",
    toEmail: "lojista@exemplo.com",
    subject: "Novo pedido pago",
    textBody: "texto",
    htmlBody: "<p>html</p>",
    orderReference: "AMK-AVISO-1",
    ...extra,
  };
}

test("aviso de venda fica guardado na fila, não se perde numa falha de SMTP", () => {
  const id = db.enqueueEmail(avisoDeVenda());
  assert.ok(id);

  db.markEmailFailed(id, "smtp fora do ar");
  const linha = db.getOutboxEmail(id);
  assert.equal(linha.sent_at, null, "aviso que falhou não pode contar como enviado");
  assert.equal(linha.last_error, "smtp fora do ar");
  assert.equal(linha.attempts, 1, "a falha precisa ficar registrada para o cron tentar de novo");
});

test("o painel enxerga o aviso preso e o erro que o prendeu", () => {
  const id = db.enqueueEmail(avisoDeVenda({ orderReference: "AMK-AVISO-2" }));
  db.markEmailFailed(id, "senha de app vencida");

  const situacao = db.avisosDaLojista();
  assert.ok(situacao.presos >= 1, "aviso não entregue tem que aparecer como preso");
  assert.match(String(situacao.ultimoErro), /senha de app vencida|smtp fora do ar/);
});

test("aviso entregue sai da fila e vira a data do último aviso", () => {
  const id = db.enqueueEmail(avisoDeVenda({ orderReference: "AMK-AVISO-3" }));
  const presosAntes = db.avisosDaLojista().presos;

  db.markEmailSent(id);

  const situacao = db.avisosDaLojista();
  assert.equal(situacao.presos, presosAntes - 1);
  assert.ok(situacao.ultimoEnviadoEm, "entregue precisa deixar a data, é o que o painel mostra");
  assert.ok(!db.pendingEmails(100).some(l => l.id === id));
});

test("aviso de contato usa a mesma fila e não colide com o de venda", () => {
  const venda = db.enqueueEmail(avisoDeVenda({ orderReference: "AMK-AVISO-4" }));
  const contato = db.enqueueEmail({
    kind: "aviso_contato",
    toEmail: "lojista@exemplo.com",
    subject: "Nova mensagem de contato",
    textBody: "texto",
    htmlBody: "<p>html</p>",
  });
  assert.ok(venda && contato, "contato não tem pedido; a fila precisa aceitar sem referência");
  assert.notEqual(venda, contato);
  assert.equal(db.getOutboxEmail(contato).order_reference, null);
});
