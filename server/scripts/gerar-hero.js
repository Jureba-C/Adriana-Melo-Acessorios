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

// recorte em pixels do original: left, top, width, height
const FOTOS = [
  { arquivo: "CAIO9686.jpg", saida: "hero-atelie-principal", recorte: { left: 0, top: 500, width: 4000, height: 5000 }, larguras: [480, 960] },
  { arquivo: "CAIO9643.jpg", saida: "hero-atelie-bailarina", recorte: { left: 0, top: 1500, width: 4000, height: 4000 }, larguras: [320, 640] },
  { arquivo: "CAIO9670.jpg", saida: "hero-atelie-tiara", recorte: { left: 0, top: 700, width: 4000, height: 4000 }, larguras: [320, 640] },
];

(async () => {
  const destino = path.join(__dirname, "..", "img");
  for (const foto of FOTOS) {
    const base = sharp(path.join(PASTA, foto.arquivo)).rotate().extract(foto.recorte);
    const buffer = await base.toBuffer();
    for (const largura of foto.larguras) {
      const redimensionada = sharp(buffer).resize({ width: largura });
      const webp = path.join(destino, `${foto.saida}-${largura}.webp`);
      const jpg = path.join(destino, `${foto.saida}-${largura}.jpg`);
      await redimensionada.clone().webp({ quality: 78 }).toFile(webp);
      await redimensionada.clone().jpeg({ quality: 80, mozjpeg: true }).toFile(jpg);
      console.log(`${path.basename(webp)} ${Math.round(fs.statSync(webp).size / 1024)}KB · ${path.basename(jpg)} ${Math.round(fs.statSync(jpg).size / 1024)}KB`);
    }
  }
})().catch((err) => { console.error(err); process.exit(1); });
