// Precisam existir antes do require: o esbuild lê os dois ao carregar. O
// GOMAXPROCS limita as threads do programa Go; sem worker thread, o
// transformSync usa um processo que termina na hora.
process.env.GOMAXPROCS ||= "1";
process.env.ESBUILD_WORKER_THREADS ||= "0";
const esbuild = require("esbuild");

// O esbuild deixa dois processos filhos vivos depois do primeiro uso (~23
// threads), e a hospedagem conta cada thread no limite de processos da conta,
// vezes cada worker do Passenger. Só minificamos no boot e quando um arquivo
// muda, então ele é desligado após 10s parado; a próxima chamada religa.
const OCIOSO_MS = 10 * 1000;
let emUso = 0;
let parada = null;

function agendarParada(){
  clearTimeout(parada);
  parada = setTimeout(() => { if(!emUso) esbuild.stop(); }, OCIOSO_MS);
  parada.unref();
}

const opcoes = loader => ({ loader, minify: true, legalComments: "none", charset: "utf8" });

async function minificar(codigo, loader){
  emUso++;
  try { return (await esbuild.transform(codigo, opcoes(loader))).code; }
  finally { emUso--; agendarParada(); }
}

function minificarSync(codigo, loader){
  try { return esbuild.transformSync(codigo, opcoes(loader)).code; }
  finally { agendarParada(); }
}

module.exports = { minificar, minificarSync };
