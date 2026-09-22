/**
 * Lembrete de carrinho esquecido (lib/db.js + scripts/tarefas-periodicas.js),
 * num banco ISOLADO em tmp. Roda com: node --test
 *
 * É o primeiro e-mail que o site manda para quem NÃO pediu para receber
 * nada — quem só começou uma compra e parou. Por isso o que está trancado
 * aqui é principalmente o que ele NÃO pode fazer: chegar cedo demais (o Pix
 * ainda está válido e a pessoa ia pagar), repetir, insistir com quem já tem
 * dois carrinhos parados, ou cair na caixa de quem pediu para sair.
 *
 * Em vez de envelhecer linhas no banco, os testes passam um "agora" no
 * futuro — mesmo truque dos testes de cron em avaliacoes.test.js.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const TMP_DB = path.join(os.tmpdir(), `plc-carrinho-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.CLIENT_ORIGIN = "https://exemplo.test";
const db = require("../lib/db.js");
const tarefas = require("../scripts/tarefas-periodicas.js");

const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;

function limpar(){
  for(const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
}
before(limpar);
after(limpar);

let contador = 0;
function criarCarrinho({ email = "cliente@test.com", status = "pendente" } = {}){
  const ref = `ref-${++contador}-${Date.now()}`;
  db.createOrder({
    externalReference: ref,
    status,
    items: [{ id: 2, qty: 1 }, { id: 6, qty: 2 }],
    address: { nome: "Ana Paula", rua: "Rua das Flores", numero: "10", cep: "70000000" },
    shipping: { name: "PAC", price: 20 },
    subtotal: 100, shippingPrice: 20, total: 120,
    customerEmail: email, customerPhone: "61999999999",
  });
  return ref;
}

function seleciona(ref, agora){
  return db.pedidosParaLembrarCarrinho(agora).some(p => p.external_reference === ref);
}

test("cedo demais não recebe; depois de 8 horas recebe; passou de 3 dias não recebe mais", () => {
  const agora = Date.now();
  const ref = criarCarrinho({ email: "janela@test.com" });
  assert.equal(seleciona(ref, agora + 2 * HORA), false, "2h: o Pix ainda está de pé");
  assert.equal(seleciona(ref, agora + 10 * HORA), true);
  assert.equal(seleciona(ref, agora + 5 * DIA), false, "carrinho velho demais não vira e-mail do nada");
});

test("pedido pago nunca entra", () => {
  const agora = Date.now();
  const ref = criarCarrinho({ email: "pagou@test.com", status: "pago" });
  assert.equal(seleciona(ref, agora + 10 * HORA), false);
});

test("quem pagou depois sai da lista, mesmo com o carrinho velho parado", () => {
  const agora = Date.now();
  const ref = criarCarrinho({ email: "voltou@test.com" });
  assert.equal(seleciona(ref, agora + 10 * HORA), true);
  criarCarrinho({ email: "voltou@test.com", status: "pago" });
  assert.equal(seleciona(ref, agora + 10 * HORA), false);
});

test("sem e-mail não há para quem mandar", () => {
  const agora = Date.now();
  const ref = criarCarrinho({ email: null });
  assert.equal(seleciona(ref, agora + 10 * HORA), false);
});

test("quem pediu descadastro não recebe", () => {
  const agora = Date.now();
  const ref = criarCarrinho({ email: "saiu@test.com" });
  const token = db.garantirTokenDeContato("saiu@test.com");
  assert.equal(db.unsubscribeNewsletter("saiu@test.com", token), true,
    "o link do e-mail precisa funcionar para quem nunca se inscreveu");
  assert.equal(seleciona(ref, agora + 10 * HORA), false);
});

test("o lembrete sai uma vez só por carrinho, e com o link que reenche o carrinho", () => {
  const agora = Date.now();
  const ref = criarCarrinho({ email: "unico@test.com" });
  const quando = agora + 10 * HORA;

  const primeira = tarefas.enfileirarLembretesDeCarrinho(quando);
  const segunda = tarefas.enfileirarLembretesDeCarrinho(quando);
  assert.ok(primeira >= 1);
  assert.equal(segunda, 0, "índice único da fila: cada carrinho recebe uma vez");

  const fila = db.getOutboxEntry("carrinho_esquecido", ref);
  assert.ok(fila.html_body.includes(`?recuperar=${ref}`), "o link precisa trazer o carrinho de volta");
  assert.ok(fila.html_body.includes("Não quero mais receber"), "e-mail promocional sem descadastro é spam");
  assert.ok(!/cupom|desconto de|%\s*OFF/i.test(fila.text_body), "sem desconto por abandono");
});

test("segundo carrinho esquecido da mesma pessoa espera 30 dias", () => {
  const agora = Date.now();
  const primeiro = criarCarrinho({ email: "insistente@test.com" });
  tarefas.enfileirarLembretesDeCarrinho(agora + 10 * HORA);
  assert.ok(db.getOutboxEntry("carrinho_esquecido", primeiro));

  const segundo = criarCarrinho({ email: "insistente@test.com" });
  assert.equal(seleciona(segundo, agora + 10 * HORA), false, "dois lembretes na mesma semana é insistência");
});

test("o link de recuperação devolve os itens e nada de dado pessoal", () => {
  const ref = criarCarrinho({ email: "itens@test.com" });
  const itens = db.itensDoCarrinhoEsquecido(ref);
  assert.deepEqual(itens, [{ id: 2, qty: 1 }, { id: 6, qty: 2 }]);
  assert.equal(JSON.stringify(itens).includes("Ana Paula"), false);
  assert.equal(db.itensDoCarrinhoEsquecido("referencia-que-nao-existe"), null);
});

test("carrinho de mais de 14 dias não volta pelo link", () => {
  const ref = criarCarrinho({ email: "antigo@test.com" });
  assert.equal(db.itensDoCarrinhoEsquecido(ref, Date.now() + 20 * DIA), null);
});
