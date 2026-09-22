/**
 * Campanhas de novidades (lib/db.js + lib/campanhas.js), em banco ISOLADO.
 * Roda com: node --test
 *
 * É o primeiro envio em massa que o site faz, então o que está trancado é
 * o que separa "escrever para quem pediu" de "mandar e-mail para uma lista
 * comprada": só recebe quem pediu o cupom (opt_in_at), quem se descadastrou
 * fica de fora mesmo tendo entrado no retrato da lista, ninguém recebe duas
 * vezes, e todo e-mail leva link de descadastro.
 *
 * Também tranca a ordem da fila: e-mail de compra NUNCA pode ficar atrás de
 * uma campanha de 200 pessoas.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const TMP_DB = path.join(os.tmpdir(), `plc-campanhas-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = TMP_DB;
const db = require("../lib/db.js");
const campanhas = require("../lib/campanhas.js");

const ORIGEM = "https://exemplo.test";

function limpar(){
  for(const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
}
before(limpar);
after(limpar);

function novaCampanha(assunto = "Chegaram os laços de Natal"){
  return db.criarCampanha({ assunto, chamada: "Novidades do ateliê", corpo: "Oi!\n\nChegaram laços novos.", produtos: [] });
}

test("só entra na lista quem pediu para receber", () => {
  db.addNewsletterSubscriber("pediu@test.com");
  db.garantirTokenDeContato("so-carrinho@test.com");
  const ativas = db.assinantesAtivas();
  assert.ok(ativas.includes("pediu@test.com"));
  assert.equal(ativas.includes("so-carrinho@test.com"), false,
    "linha criada só para hospedar token de descadastro não é inscrita");
});

test("quem se descadastra entre o disparo e o envio não recebe", () => {
  db.addNewsletterSubscriber("desistiu@test.com");
  const campanha = novaCampanha("Novidades de agosto");
  db.prepararEnvioDaCampanha(campanha.id);

  const token = db.getOrCreateUnsubscribeToken("desistiu@test.com");
  db.unsubscribeNewsletter("desistiu@test.com", token);

  campanhas.enfileirarLote({ campanha: db.getCampanha(campanha.id), produtos: [], origem: ORIGEM });
  assert.equal(db.getOutboxEntry("campanha", `campanha:${campanha.id}:desistiu@test.com`), null);
});

test("cada pessoa recebe uma vez só, mesmo rodando o lote de novo", () => {
  db.addNewsletterSubscriber("uma-vez@test.com");
  const campanha = novaCampanha("Novidades de setembro");
  db.prepararEnvioDaCampanha(campanha.id);

  const primeira = campanhas.enfileirarLote({ campanha, produtos: [], origem: ORIGEM });
  const segunda = campanhas.enfileirarLote({ campanha: db.getCampanha(campanha.id), produtos: [], origem: ORIGEM });
  assert.ok(primeira.novos >= 1);
  assert.equal(segunda.novos, 0);
  assert.equal(db.getCampanha(campanha.id).status, "concluida");
});

test("o e-mail leva descadastro e não vira HTML o que a lojista escreveu", () => {
  db.addNewsletterSubscriber("html@test.com");
  const campanha = db.criarCampanha({
    assunto: "Promoção", chamada: null,
    corpo: 'Olha só <script>alert(1)</script> que novidade', produtos: [],
  });
  db.prepararEnvioDaCampanha(campanha.id);
  campanhas.enfileirarLote({ campanha, produtos: [], origem: ORIGEM });

  const linha = db.getOutboxEntry("campanha", `campanha:${campanha.id}:html@test.com`);
  assert.ok(linha, "e-mail foi para a fila");
  assert.ok(linha.html_body.includes("&lt;script&gt;"), "tag digitada vira texto");
  assert.ok(!linha.html_body.includes("<script>alert"), "e nunca script de verdade");
  assert.ok(linha.html_body.includes("unsubscribe"), "link de descadastro no corpo");
});

test("o lote respeita o limite e continua de onde parou", () => {
  for(let i = 0; i < 5; i++) db.addNewsletterSubscriber(`lote${i}@test.com`);
  const campanha = novaCampanha("Novidades de outubro");
  const total = db.prepararEnvioDaCampanha(campanha.id);
  assert.ok(total >= 5);

  const primeiro = campanhas.enfileirarLote({ campanha, produtos: [], origem: ORIGEM, limite: 2 });
  assert.equal(primeiro.contagem.enfileirados, 2);
  assert.equal(db.getCampanha(campanha.id).status, "enviando", "não termina antes da hora");

  let voltas = 0;
  while(db.getCampanha(campanha.id).status === "enviando" && voltas++ < 20){
    campanhas.enfileirarLote({ campanha: db.getCampanha(campanha.id), produtos: [], origem: ORIGEM, limite: 2 });
  }
  assert.equal(db.getCampanha(campanha.id).status, "concluida");
});

test("cancelar tira da fila só o que ainda não saiu", () => {
  db.addNewsletterSubscriber("cancelar@test.com");
  const campanha = novaCampanha("Novidades de novembro");
  db.prepararEnvioDaCampanha(campanha.id);
  campanhas.enfileirarLote({ campanha, produtos: [], origem: ORIGEM });

  const chave = `campanha:${campanha.id}:cancelar@test.com`;
  const linha = db.getOutboxEntry("campanha", chave);
  db.markEmailSent(linha.id);

  db.apagarFilaDaCampanha(campanha.id);
  assert.ok(db.getOutboxEntry("campanha", chave), "e-mail já enviado continua no histórico");
  assert.equal(db.contagemDaCampanha(campanha.id).enviados, 1);
});

test("e-mail de compra nunca fica atrás de uma campanha na fila", () => {
  const campanha = novaCampanha("Fila");
  for(let i = 0; i < 3; i++){
    db.enqueueEmail({
      kind: "campanha", toEmail: `fila${i}@test.com`,
      orderReference: `campanha:${campanha.id}:fila${i}@test.com`,
      subject: "Novidades", textBody: "oi", htmlBody: "<p>oi</p>",
    });
  }
  db.enqueueEmail({
    kind: "pedido_confirmado", toEmail: "compra@test.com", orderReference: "pedido-xyz",
    subject: "Seu pedido", textBody: "recibo", htmlBody: "<p>recibo</p>",
  });

  const fila = db.pendingEmails(10);
  assert.equal(fila[0].kind, "pedido_confirmado", "transacional primeiro, mesmo tendo entrado depois");
});
