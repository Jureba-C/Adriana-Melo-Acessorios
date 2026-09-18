/**
 * Cache de CSS/JS em brotli 11 (lib/precompress.js).
 * Roda com: node --test
 *
 * O que estes testes trancam, e por quê:
 *  - o que chega ao navegador descomprime para EXATAMENTE o arquivo do disco.
 *    É a única garantia que importa aqui: bytes iguais não renderizam
 *    diferente, e é por isso que dá para comprimir mais sem medo;
 *  - o primeiro pedido não espera pelo brotli caro (127 ms no style.css) —
 *    ele sai pelo caminho normal e o cache se enche depois;
 *  - o ETag é o MESMO tenha a resposta saído daqui ou do express.static;
 *    fossem diferentes, quem voltasse ao site baixaria tudo de novo;
 *  - o Cache-Control acompanha o do express.static (immutable só com ?v=);
 *  - quem não aceita brotli, quem pede Range e quem pede outra extensão
 *    passam direto, sem o middleware inventar resposta.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const http = require("node:http");

const RAIZ = path.join(__dirname, "..");
const PORT = 39578;
const ORIGIN = `http://localhost:${PORT}`;
const TMP_DB = path.join(os.tmpdir(), `plc-pc-${process.pid}-${Date.now()}.db`);

let child;

before(async () => {
  child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.js"], {
    cwd: RAIZ,
    env: { ...process.env, DB_PATH: TMP_DB, PORT: String(PORT), CLIENT_ORIGIN: ORIGIN,
           MP_ACCESS_TOKEN: "TEST-fake", NODE_ENV: "test" },
    stdio: "ignore",
  });
  const limite = Date.now() + 10000;
  for(;;){
    try { if((await fetch(ORIGIN + "/")).ok) break; } catch {}
    if(Date.now() > limite) throw new Error("servidor de teste não subiu");
    await new Promise(r => setTimeout(r, 200));
  }
});

after(() => {
  if(child) child.kill();
  for(const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
});

const ARQUIVOS = ["/css/style.css", "/js/main.js", "/js/animacoes.js", "/css/fonts.css"];

function pegar(caminho, headers){
  return fetch(ORIGIN + caminho, { headers: { "Accept-Encoding": "identity", ...headers } });
}

/* ⚠️ Para medir TAMANHO tem de ser http cru: o fetch do Node descomprime o
   corpo sozinho, então arrayBuffer() devolve o arquivo inteiro e qualquer
   comparação de bytes comprimidos dá empate falso. */
function pegarCru(caminho, headers){
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "localhost", port: PORT, path: caminho, method: "GET",
      headers: { Accept: "*/*", ...headers } }, (res) => {
      const pedacos = [];
      res.on("data", (d) => pedacos.push(d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers,
        buf: Buffer.concat(pedacos) }));
    });
    req.on("error", reject);
    req.end();
  });
}

// Pede uma vez para disparar o preenchimento, espera o brotli terminar no
// thread pool, e devolve a resposta já vinda do cache.
async function comCacheQuente(caminho){
  await pegarCru(caminho, { "Accept-Encoding": "br" });
  for(let i = 0; i < 40; i++){
    const r = await pegarCru(caminho, { "Accept-Encoding": "br" });
    // O caminho em cache manda Content-Length; o compression() da resposta
    // normal vai em chunked, sem ele. É o sinal de que o cache esquentou.
    if(r.headers["content-length"]) return r;
    await new Promise(r2 => setTimeout(r2, 100));
  }
  throw new Error(`o cache de ${caminho} não esquentou`);
}

test("o que vai comprimido descomprime para o arquivo do disco, byte a byte", async () => {
  for(const caminho of ARQUIVOS){
    const r = await comCacheQuente(caminho);
    assert.equal(r.headers["content-encoding"], "br", caminho);
    const disco = fs.readFileSync(path.join(RAIZ, caminho));
    const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
    assert.equal(sha(zlib.brotliDecompressSync(r.buf)), sha(disco),
      `${caminho}: o corpo servido não bate com o arquivo em disco`);
  }
});

test("comprime mais do que o compression() da resposta normal", async () => {
  // A chave do cache é o ARQUIVO, não a URL — trocar a query acerta o cache do
  // mesmo jeito (e está certo: é o mesmo arquivo). Então o caminho normal é
  // reproduzido aqui com o mesmo zlib, na qualidade que o compression() usa.
  const disco = fs.readFileSync(path.join(RAIZ, "css/style.css"));
  const naHora = zlib.brotliCompressSync(disco, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 },
  });
  const doCache = (await comCacheQuente("/css/style.css")).buf;
  assert.ok(doCache.length < naHora.length,
    `cache ${doCache.length} B não ficou menor que o na-hora ${naHora.length} B`);
});

test("o primeiro pedido não espera o brotli caro", async () => {
  // Um endereço que o cache nunca viu: se o middleware comprimisse na hora,
  // esta resposta levaria os ~127 ms do brotli 11 do style.css.
  const antes = Date.now();
  await pegarCru("/css/style.css?primeiraVez=" + Date.now(), { "Accept-Encoding": "br" });
  assert.ok(Date.now() - antes < 100,
    "a primeira resposta bloqueou — o preenchimento do cache deixou de ser assíncrono");
});

test("o ETag é o mesmo com e sem brotli", async () => {
  await comCacheQuente("/css/style.css");
  const comBr = await pegar("/css/style.css", { "Accept-Encoding": "br" });
  const semBr = await pegar("/css/style.css", { "Accept-Encoding": "gzip" });
  assert.ok(comBr.headers.get("etag"), "sem ETag no caminho comprimido");
  assert.equal(comBr.headers.get("etag"), semBr.headers.get("etag"),
    "ETag diferente por caminho faria o navegador rebaixar tudo ao voltar");
});

test("If-None-Match responde 304 sem corpo", async () => {
  const marca = (await comCacheQuente("/js/main.js")).headers.etag;
  const denovo = await pegar("/js/main.js", { "Accept-Encoding": "br", "If-None-Match": marca });
  assert.equal(denovo.status, 304);
  assert.equal((await denovo.arrayBuffer()).byteLength, 0);

  // A comparação de If-None-Match é fraca: sem o W/ tem de casar igual.
  const forte = await pegar("/js/main.js", {
    "Accept-Encoding": "br", "If-None-Match": marca.replace(/^W\//, ""),
  });
  assert.equal(forte.status, 304, "comparação de ETag deixou de ser fraca");
});

test("o Cache-Control acompanha o do express.static", async () => {
  const comV = await comCacheQuente("/css/style.css?v=abc123");
  assert.equal(comV.headers["cache-control"], "public, max-age=31536000, immutable");
  const semV = await pegar("/css/style.css", { "Accept-Encoding": "br" });
  assert.equal(semV.headers.get("cache-control"), "no-cache",
    "sem ?v= o arquivo tem de revalidar — senão um deploy fica preso um ano");
});

test("quem não pede brotli, pede Range ou pede outra extensão passa direto", async () => {
  await comCacheQuente("/css/style.css");

  const semBr = await pegar("/css/style.css", { "Accept-Encoding": "gzip" });
  assert.notEqual(semBr.headers.get("content-encoding"), "br");

  const comRange = await pegar("/css/style.css", { "Accept-Encoding": "br", Range: "bytes=0-99" });
  assert.notEqual(comRange.headers.get("content-encoding"), "br",
    "Range pede um pedaço: servir o arquivo comprimido inteiro entregaria bytes errados");

  const naoEhCssNemJs = await pegar("/img/logo-adriana-melo-6e53bc.png", { "Accept-Encoding": "br" });
  assert.equal(naoEhCssNemJs.status, 200);
  assert.notEqual(naoEhCssNemJs.headers.get("content-encoding"), "br");
});
