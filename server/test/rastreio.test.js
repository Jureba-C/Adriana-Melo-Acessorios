/**
 * lib/rastreio.js — funções puras, sem rede.
 *
 * A loja parou de postar direto nos Correios: hoje só compra etiqueta pelo
 * Melhor Envio, e o código que ela cola no painel só é reconhecido lá.
 * Estes testes trancam as duas regras que dependem disso e que quebram em
 * silêncio: para onde o link do rastreio aponta, e o que conta como entrega.
 * Roda com: node --test
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const rastreio = require("../lib/rastreio.js");

test("link de rastreio aponta sempre para o Melhor Envio", () => {
  assert.equal(
    rastreio.linkDaTransportadora("ME220021P41BR"),
    "https://melhorenvio.com.br/rastreio/ME220021P41BR"
  );

  // Mesmo com código no formato dos Correios: PAC e SEDEX são revendidos
  // pelo Melhor Envio, e é lá que a etiqueta dela existe.
  assert.equal(
    rastreio.linkDaTransportadora("AA123456789BR"),
    "https://melhorenvio.com.br/rastreio/AA123456789BR"
  );

  // Sem "www.": a versão com www responde 302 para esta, e o redirecionamento
  // extra custa uma viagem a mais no celular da cliente.
  assert.ok(!rastreio.linkDaTransportadora("X1").includes("www."));

  assert.equal(rastreio.linkDaTransportadora(""), null);
  assert.equal(rastreio.linkDaTransportadora(null), null);
});

test("entrega é reconhecida pelo evento OU pelo status do envio", () => {
  const porEvento = rastreio.eventoDeEntrega({
    status: "in_transit",
    events: [{ description: "Objeto entregue ao destinatário", date: "2026-09-10 10:00" }],
  });
  assert.ok(porEvento);

  // O Melhor Envio às vezes devolve só a situação, sem histórico — sem este
  // caminho, um pedido entregue nunca se fecharia sozinho.
  const porStatus = rastreio.eventoDeEntrega({ status: "delivered", events: [] });
  assert.ok(porStatus);
});

test("devolução ao remetente NUNCA conta como entrega", () => {
  // Dizer "entregue" aqui avisaria a cliente que o pacote chegou quando na
  // verdade ele voltou para a loja.
  assert.equal(
    rastreio.eventoDeEntrega({ events: [{ description: "Objeto entregue ao remetente" }] }),
    null
  );
});

test("pedido a caminho não vira entregue, e rastreio vazio não quebra", () => {
  assert.equal(
    rastreio.eventoDeEntrega({ status: "in_transit", events: [{ description: "Saiu para entrega" }] }),
    null
  );
  assert.equal(rastreio.eventoDeEntrega(null), null);
  assert.equal(rastreio.eventoDeEntrega(undefined), null);
  assert.equal(rastreio.eventoDeEntrega({}), null);
  assert.equal(rastreio.eventoDeEntrega({ events: null }), null);
});

test("data do evento: aceita o formato do rastreio e recusa lixo", () => {
  assert.equal(typeof rastreio.dataDoEvento({ date: "2026-09-10 10:00:00" }), "number");
  assert.equal(rastreio.dataDoEvento({ date: "não é data" }), null);
  assert.equal(rastreio.dataDoEvento({}), null);
  assert.equal(rastreio.dataDoEvento(null), null);
});
