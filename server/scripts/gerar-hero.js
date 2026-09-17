/**
 * Gera as fotos do topo da home a partir das fotos REAIS do ensaio da loja.
 *
 * Uso:
 *     cd server && node scripts/gerar-hero.js "/caminho/Fotos Site Adriana/Editadas"
 *
 * Os originais (4000×6000, ~13MB) ficam fora do repositório; aqui só entram
 * recortes leves em WebP e JPEG. Trocar a foto = mudar a lista FOTOS e rodar
 * de novo (os nomes de saída não mudam, o ?v= do servidor renova o cache).
 */
const path = require("node:path");
const fs = require("node:fs");
const sharp = require("sharp");

const PASTA = process.argv[2];
if (!PASTA || !fs.existsSync(PASTA)) {
  console.error("Informe a pasta das fotos editadas. Ex.: node scripts/gerar-hero.js \"/Users/.../Editadas\"");
  process.exit(1);
}

// Recorte em pixels do original (4000x6000): a peça fica sempre no
// centro-baixo do quadro, com flores desfocadas em cima e mesa branca no pé —
// por isso cada corte tira as duas pontas, nunca só o topo. Todos 4:5.
const FOTOS = [
  { arquivo: "CAIO9691.jpg", saida: "hero-laco-pink",      recorte: { left: 0, top: 750, width: 4000, height: 5000 } },
  { arquivo: "CAIO9686.jpg", saida: "hero-laco-bailarina", recorte: { left: 0, top: 600, width: 4000, height: 5000 } },
  { arquivo: "CAIO9503.jpg", saida: "hero-bolsa-glitter",  recorte: { left: 200, top: 450, width: 3600, height: 4500 } },
  { arquivo: "CAIO9509.jpg", saida: "hero-kit-unicornio",  recorte: { left: 0, top: 800, width: 4000, height: 5000 } },
  { arquivo: "CAIO9465.jpg", saida: "hero-lacos-perola",   recorte: { left: 400, top: 1600, width: 3400, height: 4250 } },
];
const LARGURAS = [480, 960];

// Recorte errado falha alto aqui, em vez de virar foto torta no site.
for (const { arquivo, recorte } of FOTOS) {
  const { left, top, width, height } = recorte;
  if (left + width > 4000 || top + height > 6000 || Math.abs(width / height - 0.8) > 0.001) {
    console.error(`Recorte inválido em ${arquivo}: precisa ser 4:5 e caber em 4000x6000.`);
    process.exit(1);
  }
}

(async () => {
  const destino = path.join(__dirname, "..", "img");
  for (const foto of FOTOS) {
    const base = sharp(path.join(PASTA, foto.arquivo)).rotate().extract(foto.recorte);
    const buffer = await base.toBuffer();
    for (const largura of LARGURAS) {
      const redimensionada = sharp(buffer).resize({ width: largura });
      const webp = path.join(destino, `${foto.saida}-${largura}.webp`);
      const jpg = path.join(destino, `${foto.saida}-${largura}.jpg`);
      await redimensionada.clone().webp({ quality: 78 }).toFile(webp);
      await redimensionada.clone().jpeg({ quality: 80, mozjpeg: true }).toFile(jpg);
      console.log(`${path.basename(webp)} ${Math.round(fs.statSync(webp).size / 1024)}KB · ${path.basename(jpg)} ${Math.round(fs.statSync(jpg).size / 1024)}KB`);
    }
  }
})().catch((err) => { console.error(err); process.exit(1); });
