const { test } = require("node:test");
const assert = require("node:assert/strict");
const { minificar, minificarSync } = require("../lib/minificar.js");

test("minifica CSS e JS pelo mesmo caminho que desliga o esbuild parado", async () => {
  assert.equal((await minificar("a { color : red ; }", "css")).trim(), "a{color:red}");
  assert.equal(minificarSync("b { color : red ; }", "css").trim(), "b{color:red}");
  assert.match(await minificar("function soma(a, b) { return a + b; }", "js"), /return a\+b/);
});
