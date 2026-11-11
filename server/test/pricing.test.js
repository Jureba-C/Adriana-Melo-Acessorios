/**
 * Testes das regras de preço (js/pricing.js) — desconto Pix e parcelamento.
 * Roda com: node --test
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const pricing = require("../js/pricing.js");

test("round2 arredonda para 2 casas", () => {
  assert.equal(pricing.round2(10.126), 10.13);
  assert.equal(pricing.round2(34.899), 34.9);
  assert.equal(pricing.round2("abc"), 0);
});

test("formatMoney formata em reais com vírgula", () => {
  // O código usa espaço não-quebrável (U+00A0) entre "R$" e o número, de
  // propósito; normalizamos para comparar de forma legível.
  assert.equal(pricing.formatMoney(34.9).replace(/\u00a0/g, " "), "R$ 34,90");
  assert.equal(pricing.formatMoney(0).replace(/\u00a0/g, " "), "R$ 0,00");
});

test("desconto Pix é 5% do valor", () => {
  assert.equal(pricing.pixDiscountFor(100), 5);
  assert.equal(pricing.pixPriceFor(100), 95);
  assert.equal(pricing.pixDiscountFor(34.9), 1.75);
});

test("parcelamento respeita máximo e valor mínimo por parcela", () => {
  // Total alto: 3x (máximo).
  assert.equal(pricing.installmentCountFor(300), 3);
  // Total baixo: reduz o número de parcelas para não ficar abaixo do mínimo (R$5).
  assert.equal(pricing.installmentCountFor(8), 1);
  // Valor da parcela nunca abaixo do mínimo configurado.
  const plan = pricing.installmentPlanFor(300);
  assert.ok(plan.value >= 5);
  assert.equal(plan.count, 3);
  assert.equal(plan.interestFree, true);
});

test("pixPriceFor e round2 lidam com entrada inválida sem quebrar", () => {
  assert.equal(pricing.pixPriceFor(null), 0);
  assert.equal(pricing.pixPriceFor(undefined), 0);
});

test("promoção Leve 4 Pague 3: nada grátis abaixo de 4 unidades", () => {
  assert.equal(pricing.promoLeve4Pague3For([]), 0);
  assert.equal(pricing.promoLeve4Pague3For([{ qty: 1, price: 50 }]), 0);
  assert.equal(pricing.promoLeve4Pague3For([{ qty: 3, price: 50 }]), 0);
});

test("promoção Leve 4 Pague 3: 1 grátis a cada 4 unidades, sempre a mais barata do grupo", () => {
  // 4 unidades iguais: a 4ª sai grátis.
  assert.equal(pricing.promoLeve4Pague3For([{ qty: 4, price: 50 }]), 50);
  // 5 e 7 unidades: ainda só 1 grupo completo de 4 (a mais barata do grupo).
  assert.equal(pricing.promoLeve4Pague3For([{ qty: 5, price: 50 }]), 50);
  assert.equal(pricing.promoLeve4Pague3For([{ qty: 7, price: 50 }]), 50);
  // 8 unidades: 2 grupos completos, 2 grátis.
  assert.equal(pricing.promoLeve4Pague3For([{ qty: 8, price: 50 }]), 100);
  // 12 unidades: 3 grupos completos.
  assert.equal(pricing.promoLeve4Pague3For([{ qty: 12, price: 50 }]), 150);
});

test("promoção Leve 4 Pague 3: mistura produtos, sempre libera a mais barata do grupo de 4", () => {
  // 3 unidades de R$100 + 1 de R$20: um grupo de 4, a mais barata (R$20) sai grátis.
  assert.equal(pricing.promoLeve4Pague3For([
    { qty: 3, price: 100 },
    { qty: 1, price: 20 },
  ]), 20);
  // 6 unidades de R$100 + 2 de R$10: ordenado por preço, os 4 primeiros
  // (todos R$100) formam o 1º grupo — a mais barata DELE (R$100) sai
  // grátis; os 4 seguintes (2x R$100 + 2x R$10) formam o 2º grupo — a
  // mais barata dele (R$10) sai grátis.
  assert.equal(pricing.promoLeve4Pague3For([
    { qty: 6, price: 100 },
    { qty: 2, price: 10 },
  ]), 110);
});

test("promoção Leve 4 Pague 3: não muda com a ordem dos itens no carrinho", () => {
  const a = pricing.promoLeve4Pague3For([{ qty: 1, price: 90 }, { qty: 3, price: 30 }]);
  const b = pricing.promoLeve4Pague3For([{ qty: 3, price: 30 }, { qty: 1, price: 90 }]);
  assert.equal(a, b);
  assert.equal(a, 30);
});

test("Pix só desconta as peças pagas: na Leve 4 pague 3 a grátis fica de fora", () => {
  const p = require("../js/pricing.js");
  const quatro = [1, 2, 3, 4].map(id => ({ id, qty: 1, price: 32 }));
  assert.equal(p.pixDiscountForItems(quatro), 4.8, "3 pagas × R$ 1,60");
  assert.equal(p.pixDiscountForItems(quatro.slice(0, 3)), 4.8, "sem promoção, 5% de tudo");
  assert.equal(p.pixDiscountForItems([{ id: 1, qty: 4, price: 32 }]), 4.8, "4 unidades do mesmo produto");
  assert.equal(p.pixDiscountForItems([{ id: 1, qty: 8, price: 10 }]), 3, "8 unidades: 2 grátis, 6 pagas × R$ 0,50");
  assert.equal(p.pixDiscountForItems([{ id: 1, qty: 3, price: 28.8 }, { id: 2, qty: 1, price: 18 }]), 4.32,
    "a grátis é a mais barata (R$ 18); Pix sobre as 3 de R$ 28,80");
  assert.equal(p.pixDiscountForItems([]), 0);
});
