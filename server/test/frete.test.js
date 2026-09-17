const { test } = require("node:test");
const assert = require("node:assert/strict");
const { prazoDaCotacao, diasDoFrete } = require("../lib/prazoFrete.js");

test("faixa da transportadora vira \"2 a 3 dias úteis\" e o número guardado é o maior", () => {
  const p = prazoDaCotacao({ delivery_time: 3, delivery_range: { min: 2, max: 3 }, custom_delivery_time: 3, custom_delivery_range: { min: 2, max: 3 } });
  assert.deepEqual(p, { texto: "2 a 3 dias úteis", dias: 3, extra: 0 });
});

test("sem faixa, usa o prazo único com singular e plural certos", () => {
  assert.equal(prazoDaCotacao({ delivery_time: 1 }).texto, "1 dia útil");
  assert.equal(prazoDaCotacao({ delivery_time: 4 }).texto, "4 dias úteis");
  assert.equal(prazoDaCotacao({ delivery_range: { min: 5, max: 5 } }).texto, "5 dias úteis");
  assert.equal(prazoDaCotacao({}).texto, "prazo a confirmar");
});

test("dias extras do painel do Melhor Envio aparecem em `extra` e o prazo mostrado é o personalizado", () => {
  const p = prazoDaCotacao({ delivery_time: 2, delivery_range: { min: 1, max: 2 }, custom_delivery_time: 5, custom_delivery_range: { min: 4, max: 5 } });
  assert.deepEqual(p, { texto: "4 a 5 dias úteis", dias: 5, extra: 3 });
});

test("dias de frete gravado: campo novo, número antigo e texto antigo", () => {
  assert.equal(diasDoFrete({ delivery_days: 3, delivery_time: "2 a 3 dias úteis" }), 3);
  assert.equal(diasDoFrete({ delivery_time: 6 }), 6);
  assert.equal(diasDoFrete({ delivery_time: "4 dia(s) útil(eis)" }), 4, "o texto antigo dava NaN e caía em 7 dias");
  assert.equal(diasDoFrete({ delivery_time: "2 a 3 dias úteis" }), 3);
  assert.equal(diasDoFrete({ delivery_time: "prazo a confirmar" }), null);
});
