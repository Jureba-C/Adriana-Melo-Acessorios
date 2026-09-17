const { test } = require("node:test");
const assert = require("node:assert/strict");
const { formatOrderMessage } = require("../lib/whatsapp.js");

test("aviso de venda pelo WhatsApp não leva CPF (passa pela Meta; a política lista o que vai)", () => {
  const msg = formatOrderMessage({
    externalReference: "PED-1",
    items: [{ qty: 1, name: "Laço Bailarina" }],
    address: { nome: "Maria", telefone: "61999999999", cpf: "11144477735", rua: "Rua X", numero: "1", cidade: "Brasília", uf: "DF" },
    total: 50,
    paidAt: Date.now(),
  });
  assert.ok(!msg.includes("11144477735") && !/CPF/i.test(msg));
  assert.ok(msg.includes("Maria") && msg.includes("61999999999") && msg.includes("Laço Bailarina"));
});
