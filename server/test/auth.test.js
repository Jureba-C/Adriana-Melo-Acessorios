/**
 * Testes das funções de autenticação (lib/auth.js) — hashing, validações,
 * 2FA (TOTP) e códigos de recuperação. Roda com: node --test
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const auth = require("../lib/auth.js");

test("hashPassword/verifyPassword — round-trip e rejeição", async () => {
  const hash = await auth.hashPassword("SenhaForte123!");
  assert.match(hash, /^\$2[aby]\$/, "deve ser um hash bcrypt");
  assert.equal(await auth.verifyPassword("SenhaForte123!", hash), true);
  assert.equal(await auth.verifyPassword("errada", hash), false);
});

test("verifyPassword não quebra com hash ausente (comparação dummy)", async () => {
  assert.equal(await auth.verifyPassword("qualquer", undefined), false);
});

test("isValidPassword — mínimo 8 e limite de 72 bytes do bcrypt", () => {
  assert.equal(auth.isValidPassword("1234567"), false);
  assert.equal(auth.isValidPassword("12345678"), true);
  assert.equal(auth.isValidPassword("a".repeat(72)), true);
  assert.equal(auth.isValidPassword("a".repeat(73)), false);
  assert.equal(auth.isValidPassword("á".repeat(40)), false, "40 'á' = 80 bytes > 72");
});

test("isValidEmail", () => {
  assert.equal(auth.isValidEmail("cliente@example.com"), true);
  assert.equal(auth.isValidEmail("sem-arroba"), false);
  assert.equal(auth.isValidEmail("a@b"), false);
});

test("normalizeCep / isValidCep", () => {
  assert.equal(auth.normalizeCep("70040-020"), "70040020");
  assert.equal(auth.isValidCep("70040020"), true);
  assert.equal(auth.isValidCep("7004002"), false);
});

test("normalizeCpf / isValidCpf", () => {
  assert.equal(auth.normalizeCpf("111.444.777-35"), "11144477735");
  assert.equal(auth.isValidCpf("11144477735"), true, "CPF válido conhecido");
  assert.equal(auth.isValidCpf("11144477736"), false, "dígito verificador errado");
  assert.equal(auth.isValidCpf("1114447773"), false, "menos de 11 dígitos");
  assert.equal(auth.isValidCpf("00000000000"), false, "sequência repetida");
  assert.equal(auth.isValidCpf("11111111111"), false, "sequência repetida");
});

test("isValidAddress", () => {
  const enderecoCompleto = {
    nome: "Maria Silva", telefone: "61982749808", cpf: "11144477735", rua: "Rua das Flores",
    numero: "123", bairro: "Centro", cidade: "Brasília", uf: "DF",
  };
  assert.equal(auth.isValidAddress(enderecoCompleto), true);
  assert.equal(auth.isValidAddress({ ...enderecoCompleto, numero: "" }), false, "campo obrigatório em branco");
  assert.equal(auth.isValidAddress({ ...enderecoCompleto, numero: undefined }), false, "campo obrigatório ausente");
  // CPF tem checagem própria (dígito verificador) — presente mas inválido
  // também derruba o endereço, não só "campo vazio".
  assert.equal(auth.isValidAddress({ ...enderecoCompleto, cpf: "12345678900" }), false, "CPF com dígito verificador errado");
  assert.equal(auth.isValidAddress({ ...enderecoCompleto, cpf: "00000000000" }), false, "sequência repetida nunca é CPF real");
  assert.equal(auth.isValidAddress(null), false);
  assert.equal(auth.isValidAddress(undefined), false);
  // complemento é opcional — a ausência dele não invalida o endereço.
  const { complemento, ...semComplemento } = { ...enderecoCompleto, complemento: "" };
  assert.equal(auth.isValidAddress(semComplemento), true);
});

test("TOTP — segredo em base32 e rejeição de códigos inválidos", () => {
  const secret = auth.generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]+$/, "base32");
  assert.equal(auth.verifyTotp(secret, ""), false);
  assert.equal(auth.verifyTotp(secret, "12"), false);       // curto
  assert.equal(auth.verifyTotp(secret, "000000"), false);   // improvável de bater
  assert.equal(auth.verifyTotp("", "123456"), false);       // sem segredo
});

test("códigos de recuperação — geração, hash e consumo único", async () => {
  const codes = auth.generateRecoveryCodes();
  assert.ok(codes.length >= 1);
  assert.match(codes[0], /^[0-9A-F]{5}-[0-9A-F]{5}$/);
  const hashes = await auth.hashRecoveryCodes(codes);
  // Código válido é aceito e some da lista devolvida.
  const remaining = await auth.consumeRecoveryCode(codes[0], hashes);
  assert.equal(remaining.length, hashes.length - 1);
  // Código errado não consome nada.
  assert.equal(await auth.consumeRecoveryCode("00000-00000", hashes), null);
  // Case-insensitive: aceita em minúsculo.
  assert.ok(await auth.consumeRecoveryCode(codes[1].toLowerCase(), hashes));
});
