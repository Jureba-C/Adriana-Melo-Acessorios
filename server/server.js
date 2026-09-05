/**
 * =============================================================================
 *  BACK-END DE EXEMPLO — Petit Laço / Adriana Melo Acessórios
 * =============================================================================
 *  Por que isso precisa existir?
 *  ------------------------------------------------------------------------
 *  O site (index.html/main.js) é 100% estático — HTML, CSS e JS puros, sem
 *  servidor. Mas o Access Token do Mercado Pago E o token do Melhor Envio
 *  são credenciais SECRETAS: se forem colocadas em qualquer arquivo que o
 *  navegador baixa (main.js, index.html, etc.), QUALQUER pessoa pode abrir
 *  o "Ver código-fonte" e roubá-las.
 *
 *  Por isso essas credenciais só podem viver aqui: em um servidor, lidas de
 *  variáveis de ambiente (.env), nunca commitadas no git, nunca enviadas ao
 *  navegador. Rode este arquivo com `npm install && npm start` dentro da
 *  pasta server/ (veja README.md).
 * =============================================================================
 */

require("dotenv").config({ quiet: true });

process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name !== "ExperimentalWarning") console.warn(warning);
});

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const multer = require("multer");
// Comprime/redimensiona a foto de produto antes de gravar no banco (ver
// UPLOAD DE FOTO DE PRODUTO, abaixo) — sem isso, um upload de 4MB
// multiplicado por vários produtos incharia rápido o data.db.
const sharp = require("sharp");
const { randomUUID } = require("crypto");
const rateLimit = require("express-rate-limit");
// Só para desenhar o QR code do cadastro da verificação em duas etapas —
// o algoritmo TOTP em si é feito com o crypto do próprio Node (lib/auth.js).
const qrcode = require("qrcode");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago");
const db = require("./lib/db");
const spreadsheetExport = require("./lib/export-spreadsheet");
const auth = require("./lib/auth");
const whatsapp = require("./lib/whatsapp");
const instagram = require("./lib/instagram");
const email = require("./lib/email");
const emailPhotos = require("./lib/emailPhotos.js");
const { colorLabelForItem } = require("./lib/orderFormatting");
// Mesmo arquivo que a vitrine e o carrinho carregam no navegador (js/pricing.js,
// em formato UMD) — é o que garante que o "5% no Pix" e o "3x sem juros"
// mostrados na tela do produto sejam exatamente os valores cobrados aqui.
const pricing = require("./js/pricing.js");
// Mesmo esquema: js/colors.js em UMD, única fonte da paleta de cores de
// laço — usada tanto para validar a cor escolhida no checkout quanto para
// o front (vitrine e Quick View) saberem quais cores existem.
const colors = require("./js/colors.js");

const app = express();
const PORT = process.env.PORT || 3333;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:3333";

/* ⚠️ Em produção este processo roda ATRÁS do proxy da hospedagem (a
   Hostinger serve por LiteSpeed), então o IP da conexão é sempre o do
   proxy — o IP real da cliente vem no cabeçalho X-Forwarded-For.

   Sem isto, o express-rate-limit contava TODO MUNDO como um visitante só
   e derrubava clientes legítimas com "muitas requisições" assim que o
   tráfego somado passasse do limite (100 req/15min). Era isso que o log
   da Hostinger vinha acusando (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR).

   O valor é 1, e não `true`: confia em UM salto, o proxy imediato. Com
   `true` o Express aceitaria qualquer X-Forwarded-For que chegasse, e aí
   bastaria forjar o cabeçalho para furar o limite de tentativas de login.
   Em desenvolvimento não há proxy nenhum e o cabeçalho não existe, então
   o IP continua vindo direto da conexão. */
app.set("trust proxy", 1);

/* -----------------------------------------------------------------------
   🔑 ONDE COLOCAR SUAS CREDENCIAIS
   -------------------------------------------------------------------------
   1. Copie server/.env.example para server/.env
   2. Preencha MP_ACCESS_TOKEN (Mercado Pago) e MELHOR_ENVIO_TOKEN (frete),
      além dos dados do remetente (SELLER_*) — NUNCA neste arquivo, NUNCA
      no front-end.
   3. O .env já está no .gitignore: confirme que ele nunca é commitado.
   Mercado Pago: https://www.mercadopago.com.br/developers/panel
   Melhor Envio: https://melhorenvio.com.br/painel/gerenciar/tokens
----------------------------------------------------------------------- */
/* Checagem de configuração no boot. Em produção (CLIENT_ORIGIN https, o
   mesmo sinal que a CSP já usa, em vez de depender de NODE_ENV) os avisos
   de segredo essencial ausente saem em DESTAQUE — a ideia é transformar um
   erro de configuração silencioso (loja no ar com checkout quebrado, ou
   webhook sem assinatura) numa mensagem impossível de não ver no log do
   deploy. Não aborta o processo de propósito: este mesmo servidor também
   serve o site inteiro, então derrubá-lo por um segredo faltando seria um
   apagão maior que o problema que ele resolve. */
const EM_PRODUCAO = CLIENT_ORIGIN.startsWith("https://");
function avisoConfig(mensagem){
  console.warn(`${EM_PRODUCAO ? "🔴 [PRODUÇÃO] " : "⚠️  "}${mensagem}`);
}
if(!process.env.MP_ACCESS_TOKEN){
  avisoConfig("MP_ACCESS_TOKEN não definido. Copie server/.env.example para server/.env e preencha antes de aceitar pagamentos reais — sem ele, o checkout QUEBRA na hora de pagar.");
}
if(!process.env.MELHOR_ENVIO_TOKEN){
  avisoConfig("MELHOR_ENVIO_TOKEN não definido. O cálculo de frete não vai funcionar até preencher o .env.");
}
if(!process.env.INSTAGRAM_ACCESS_TOKEN){
  avisoConfig("INSTAGRAM_ACCESS_TOKEN não definido. A seção \"nossa história\" mostra o botão \"Seguir no Instagram\" em vez do feed ao vivo até preencher o .env (ver docs/instagram-setup.md).");
}
if(!process.env.ADMIN_EMAIL_HASHES){
  avisoConfig("ADMIN_EMAIL_HASHES não definido. NINGUÉM consegue entrar no painel administrativo (todo login vira cliente comum) até preencher o .env.");
}
// F2 da auditoria: sem o segredo, a assinatura do webhook do Mercado Pago
// não é verificada (ver verifyMpWebhookSignature). Continua aceitando (a
// confirmação real do pagamento vem do payment.get autenticado, então não
// dá para forjar um "pago"), mas em produção isso precisa gritar no log.
if(EM_PRODUCAO && !process.env.MP_WEBHOOK_SECRET){
  avisoConfig("MP_WEBHOOK_SECRET não definido. O webhook do Mercado Pago aceita chamadas SEM verificar a assinatura — configure o segredo no painel do MP e no .env para fechar essa porta.");
}

const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN || "COLOQUE_SEU_ACCESS_TOKEN_NO_.ENV",
});

/* =========================================================================
   CATÁLOGO — fonte da verdade para PREÇOS *e* para peso/dimensões (usados
   no cálculo de frete). Precisa ficar sincronizado com o array `products`
   de js/main.js (nomes/categorias podem divergir sem problema — o que
   importa é id/preço/peso/dimensões). Em produção, troque isto por uma
   consulta ao seu banco de dados.
   weight em kg. width/height/length em cm (medidas da embalagem individual
   de 1 unidade do produto).
========================================================================= */
// Peso/dimensões de todo o catálogo fixo padronizados pela caixa real que a
// lojista usa para postar (16x7x20cm, 200g) — antes cada linha tinha um
// palpite diferente (2 a 6cm de altura), que não correspondia à embalagem
// verdadeira e distorcia o frete calculado.
const CAIXA_PADRAO = { weight:0.2, width:16, height:7, length:20 };
const PRODUCTS = {
  1: { name:"Laço Bailarina",        price:34.90, ...CAIXA_PADRAO, category:"dia-a-dia",   badges:[] },
  2: { name:"Laço Duquesa",          price:49.90, ...CAIXA_PADRAO, category:"festa",       badges:["Mais vendido"] },
  3: { name:"Laço Recém-nascida",    price:29.90, ...CAIXA_PADRAO, category:"maternidade", badges:[] },
  4: { name:"Laço Pérola",           price:59.90, ...CAIXA_PADRAO, category:"batizado",    badges:[] },
  5: { name:"Laço Borboleta",        price:44.90, ...CAIXA_PADRAO, category:"festa",       badges:[] },
  6: { name:"Kit Presente 3 Laços",  price:89.90, ...CAIXA_PADRAO, category:"presente",    badges:["Novo"] },
  7: { name:"Laço Tiara Flor",       price:39.90, ...CAIXA_PADRAO, category:"dia-a-dia",   badges:[] },
  8: { name:"Laço Personalizado",    price:64.90, ...CAIXA_PADRAO, category:"presente",    badges:["Novo"] },
};

/* Categorias fixas — precisam ficar em sincronia com os chips de filtro em
   index.html (data-cat). getAllCategories() (abaixo) soma estas com as
   criadas pelo painel ("+ Nova categoria"), guardadas em custom_categories;
   PRODUCT_CATEGORIES continua existindo só com os slugs fixos porque é
   contra ela que product_overrides valida uma categoria vinda do painel
   antes de somar as dinâmicas — ver isValidCategory, mais abaixo. */
const BUILTIN_CATEGORIES = [
  { slug: "maternidade", label: "Maternidade" },
  { slug: "festa",       label: "Festa" },
  { slug: "batizado",    label: "Batizado" },
  { slug: "dia-a-dia",   label: "Dia a dia" },
  { slug: "presente",    label: "Presente" },
];
const PRODUCT_CATEGORIES = BUILTIN_CATEGORIES.map(c => c.slug);
const PRODUCT_BADGES = ["Mais vendido", "Novo"];

/* Produtos criados pelo painel ("+ Adicionar produto") recebem id a partir
   daqui — os ids 1-8 (PRODUCTS acima) nunca mudam, então não há colisão
   possível mesmo que o catálogo fixo cresça um pouco no futuro. */
const CUSTOM_PRODUCT_ID_START = 1000;

/* A lojista posta TUDO junto, numa caixa só — o TAMANHO dela (16x7x20cm,
   CAIXA_PADRAO acima) nunca muda com a quantidade, mas o PESO nunca é fixo:
   é a embalagem em si (caixa + papel) mais ~20g por laço, do primeiro em
   diante. Calibrado com o dado dela — 8 laços pesam uns 200g — então a
   embalagem sozinha é 200g − 8×20g = 40g. Ver buildPackage, abaixo. */
const PESO_EMBALAGEM_KG = 0.04;
const PESO_LACO_KG = 0.02;

function getAllCategories(){
  return [
    ...BUILTIN_CATEGORIES.map(c => ({ ...c, builtin: true })),
    ...db.listCustomCategories().map(c => ({ slug: c.slug, label: c.label, builtin: false })),
  ];
}
function isValidCategorySlug(slug){
  return getAllCategories().some(c => c.slug === slug);
}

// A escolha de cor saiu do site, mas PEDIDOS ANTIGOS têm a cor gravada em
// items_json — esta paleta (fixa de js/colors.js + as criadas no painel,
// em custom_colors) continua existindo só para traduzir aquele hex num
// nome legível no painel, no e-mail e no WhatsApp (colorLabelForItem, em
// lib/orderFormatting.js). Nada novo grava cor.
function getAllColors(){
  return [...colors.RIBBON_COLORS, ...db.listCustomColors().map(c => ({ hex: c.hex, label: c.label }))];
}

/* =========================================================================
   EDIÇÕES DE PRODUTO (painel administrativo)
   -------------------------------------------------------------------------
   Dois jeitos de um produto vir do painel:
   - Editado: nome/preço/foto/categoria/selos sobrescritos via PATCH
     /api/admin/products/:id, gravados em product_overrides. PRODUCTS acima
     continua sendo a fonte de peso/dimensões (não editável pelo painel).
   - Criado do zero ("+ Adicionar produto"): id >= CUSTOM_PRODUCT_ID_START,
     guardado inteiro em custom_products — não há PRODUCTS[id] para herdar
     peso/dimensões, então a linha do banco já é a base completa.
   effectiveProduct() é o único lugar que decide "qual é o valor de verdade
   agora" nos dois casos — todo o resto do arquivo (checkout, listagem de
   pedidos, avisos de WhatsApp/e-mail) usa essa função em vez de ler
   PRODUCTS[id] direto, para que uma edição no painel passe a valer
   imediatamente em TUDO, inclusive no preço cobrado.
========================================================================= */
function getProductOverridesMap(){
  const map = new Map();
  for(const row of db.listProductOverrides()) map.set(row.product_id, row);
  return map;
}
/* Ordem em que os produtos aparecem na vitrine e no painel.
   A ordem base continua sendo "catálogo fixo primeiro, criados no painel
   depois" — é ela que vale enquanto a lojista nunca tiver reordenado nada.
   Quem tem sort_order gravado (ver setProductsOrder em lib/db.js) vem
   primeiro, na ordem escolhida; quem está com NULL cai no fim mantendo a
   ordem base entre si, que é onde um produto novo deve entrar. */
function getAllProductIds(){
  const baseOrder = [...Object.keys(PRODUCTS).map(Number), ...db.listCustomProducts().map(p => p.id)];
  const sortOrderById = new Map();
  for(const row of db.listProductOverrides()){
    if(row.sort_order != null) sortOrderById.set(row.product_id, row.sort_order);
  }
  for(const p of db.listCustomProducts()){
    if(p.sort_order != null) sortOrderById.set(p.id, p.sort_order);
  }
  if(sortOrderById.size === 0) return baseOrder;
  // Ordenação estável: o índice na ordem base é o desempate, então produtos
  // sem posição salva não embaralham entre si de um carregamento pro outro.
  return baseOrder
    .map((id, baseIndex) => ({ id, baseIndex, pos: sortOrderById.get(id) }))
    .sort((a, b) => {
      if(a.pos == null && b.pos == null) return a.baseIndex - b.baseIndex;
      if(a.pos == null) return 1;
      if(b.pos == null) return -1;
      return a.pos - b.pos || a.baseIndex - b.baseIndex;
    })
    .map(item => item.id);
}
// `photos` (array, na ordem de exibição) é a fonte da verdade da galeria;
// `photoUrl` (string) continua existindo como a "capa" — sempre photos[0] —
// para que carrinho, WhatsApp, e-mail e o card do produto (que só conhecem
// uma foto) continuem funcionando sem qualquer mudança. `row.photos` NULL
// (coluna nunca editada) cai para a foto única antiga em photo_url, então um
// produto com foto salva antes desta coluna existir já aparece com galeria
// de 1 foto, sem precisar de migração.
function photosFromRow(row){
  return row.photos != null ? JSON.parse(row.photos) : (row.photo_url ? [row.photo_url] : []);
}
function effectiveProduct(id, overridesMap){
  if(id >= CUSTOM_PRODUCT_ID_START){
    const custom = db.getCustomProduct(id);
    if(!custom) return null;
    const photos = photosFromRow(custom);
    return {
      name: custom.name, price: custom.price,
      weight: custom.weight, width: custom.width, height: custom.height, length: custom.length,
      category: custom.category, photos, photoUrl: photos[0] || null,
      badges: custom.badges ? JSON.parse(custom.badges) : [],
      // NULL = nunca customizado -> todas as cores disponíveis (não deixa
      // nada subitamente incomprável para produto que a lojista nunca editou).
      description: custom.description || null,
      hidden: Boolean(custom.hidden),
      soldOut: Boolean(custom.sold_out),
    };
  }
  const base = PRODUCTS[id];
  if(!base) return null;
  const override = overridesMap.get(id);
  if(!override) return { ...base, photos: [], photoUrl: null, description: null, hidden: false, soldOut: false };
  const photos = photosFromRow(override);
  return {
    ...base,
    name: override.name || base.name,
    price: override.price != null ? override.price : base.price,
    photos, photoUrl: photos[0] || null,
    category: override.category || base.category,
    badges: override.badges ? JSON.parse(override.badges) : base.badges,
    description: override.description || null,
    hidden: Boolean(override.hidden),
    soldOut: Boolean(override.sold_out),
  };
}

/* =========================================================================
   CUPONS — assim como PRODUCTS, é a fonte da verdade no servidor. O
   front-end manda só o código; o desconto real é sempre calculado aqui,
   nunca confiando em um valor de desconto vindo do navegador (mesma lógica
   de "nunca confiar em preço/valor do cliente" usada para o carrinho).
   Cupons ficam em server/db.js (tabela coupons) — criados/apagados pelo
   painel administrativo em /api/admin/coupons, sem precisar editar código.
========================================================================= */
function findCoupon(rawCode){
  const code = String(rawCode || "").trim().toUpperCase();
  if(!code) return null;
  const row = db.getCoupon(code);
  if(!row) return null;
  return {
    code: row.code,
    percentOff: row.percent_off,
    description: row.description,
    oncePerCustomer: Boolean(row.once_per_customer),
  };
}

// Mesma normalização usada na gravação do pedido e na consulta de uso: sem
// isso, "(61) 98274-9808" e "61982749808" seriam clientes diferentes e o
// limite de uso único não valeria nada.
function phoneDigits(value){
  return String(value || "").replace(/\D/g, "") || null;
}

const COUPON_ALREADY_USED_MESSAGE =
  "Este cupom é de uso único e já foi usado nesta conta. Remova-o para continuar.";

/* =========================================================================
   FORMAS DE PAGAMENTO — Pix (com desconto) x cartão/boleto
   -------------------------------------------------------------------------
   O cliente escolhe no carrinho e o servidor faz DUAS coisas com essa
   escolha, nunca só uma:
     1) aplica (ou não) o desconto do Pix no preço de cada item;
     2) restringe, na própria preferência do Mercado Pago, quais meios de
        pagamento aparecem na tela de checkout.
   O (2) é o que impede a fraude óbvia do (1): escolher "Pix" para ganhar
   os 5% e pagar no cartão na tela seguinte. É por isso que o lado do Pix
   exclui todo tipo de cartão — essa é a exclusão que protege a loja.

   ⚠️ `account_money` (saldo do Mercado Pago) NÃO pode entrar em nenhuma
   das listas: a API do Mercado Pago recusa a preferência inteira com
   "account_money cannot be excluded" (HTTP 400), e o cliente não
   consegue nem chegar na tela de pagamento. Ele já esteve na lista do
   cartão e deixava cartão/boleto 100% quebrados, com a loja recebendo
   só por Pix sem ninguém perceber — a tela de erro genérica não
   distinguia isso de uma instabilidade do Mercado Pago.

   O efeito de deixá-lo passar nos dois lados é só de justiça, não de
   segurança: quem escolheu "cartão" e paga com saldo acaba pagando o
   preço cheio, sem o desconto do Pix. Paga a mais, nunca a menos.
   IDs conforme a documentação de payment types do Mercado Pago.
========================================================================= */
const PAYMENT_METHODS = {
  pix: {
    label: "Pix",
    excludedPaymentTypes: ["credit_card", "debit_card", "prepaid_card", "ticket", "atm"],
  },
  card: {
    label: "Cartão ou boleto",
    excludedPaymentTypes: ["bank_transfer"],
  },
};

/* -------------------------- MIDDLEWARES DE SEGURANÇA -------------------------- */
// Normaliza barras repetidas no caminho ANTES de qualquer rota. Sem isto,
// "//admin.html" escapa do app.get("/admin.html") (que casa o caminho exato,
// e "//admin.html" não é "/admin.html") mas o express.static logo abaixo
// colapsa as barras e serve o arquivo assim mesmo — ou seja, a barra dupla
// furava o guarda do painel. Vale para qualquer rota de caminho exato, não
// só o admin, então a correção certa é aqui, na entrada: um 301 para a
// versão canônica (uma barra), que já é o comportamento web esperado e ainda
// preserva a query string. Barra dupla depois do host nunca é intencional
// num site sem esse padrão de URL.
app.use((req, res, next) => {
  // Opera sobre originalUrl (cru), não req.path (já decodificado): mexer só
  // nas barras e deixar o resto do endereço intacto evita reintroduzir
  // problemas de codificação ao remontar a URL.
  const semQuery = req.originalUrl.split("?")[0];
  if (semQuery.includes("//")) {
    const query = req.originalUrl.slice(semQuery.length);
    return res.redirect(301, semQuery.replace(/\/{2,}/g, "/") + query);
  }
  // Segmentos "." e ".." NUNCA são legítimos neste site (URLs são todas
  // limpas; o versionamento de asset usa ?v=hash, não caminho). Sem barrá-los
  // AQUI, na entrada, "/js/../server.js" passa pela allowlist PUBLIC_TOP_LEVEL
  // (o 1º segmento vira "js", que é permitido) e chega ao express.static, que
  // colapsa o ".." e serve arquivos de FORA da pasta pública — o código-fonte
  // do back-end, e o próprio data.db quando o DB_PATH aponta para cá. É um
  // vazamento de leitura arbitrária de arquivo, anônimo e sem 2FA.
  // Decodifica antes de checar para pegar também as formas escapadas
  // (%2e%2e, ..%2f); uma URL com codificação inválida (decode falha) também
  // não é legítima e cai no 404. Cobre o mesmo furo que o tratamento de
  // barra dupla acima cobria só pela metade.
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(semQuery);
  } catch {
    return sendNotFound(req, res);
  }
  if (decodedPath.split("/").some(seg => seg === "." || seg === "..")) {
    return sendNotFound(req, res);
  }
  next();
});

// CSP explícita (mesmas origens já liberadas na <meta> de index.html — mantenha
// as duas em sincronia). Sem isto, o helmet() aplicaria a CSP padrão dele
// (bem mais restritiva) e bloquearia o Bootstrap/ícones/fontes via CDN e as
// imagens do Picsum agora que este servidor também serve o site (abaixo).
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      // Nenhum CDN aqui: Bootstrap, ícones, JsBarcode e as fontes são
      // todos servidos por este mesmo servidor (css/vendor/, js/vendor/,
      // css/fonts/), então 'self' cobre tudo. Só o SDK do Mercado Pago
      // continua externo — ele precisa vir do domínio deles.
      scriptSrc: ["'self'", "https://sdk.mercadopago.com"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'"],
      // `https:` (qualquer origem https) em vez de uma lista fixa: o painel
      // administrativo deixa a lojista colar a URL de uma foto hospedada em
      // qualquer lugar (Google Drive, Imgur, CDN da loja...), e não há como
      // saber esses domínios de antemão — com a lista fixa, toda foto
      // customizada era silenciosamente bloqueada pela CSP e a vitrine ficava
      // sem imagem. Continua barrando http:// e, principalmente, o que a CSP
      // realmente protege aqui (script/style/connect) segue restrito.
      // blob: é para o recorte de foto do painel (js/admin.js): a imagem
      // escolhida é lida como object URL para a lojista enquadrar antes de
      // subir. É um endereço gerado pela própria página e válido só nela —
      // não abre caminho para carregar nada de fora.
      // ⚠️ Espelhado no <meta> de cada página HTML — os dois têm que mudar
      // juntos (ver "CSP is duplicated" no CLAUDE.md).
      imgSrc: ["'self'", "https:", "data:", "blob:"],
      connectSrc: ["'self'", "https://api.mercadopago.com", "https://viacep.com.br"],
      frameSrc: ["https://www.mercadopago.com", "https://www.mercadopago.com.br"],
      objectSrc: ["'none'"],
      formAction: ["'self'"],
      // `upgrade-insecure-requests` manda o navegador trocar todo http://
      // por https:// nas sub-requisições da página. Em produção (site em
      // HTTPS) isso é o certo, e o helmet o inclui sozinho. Em
      // desenvolvimento, servindo http://localhost, ele quebra a página
      // inteira: o navegador tenta https://localhost:3333/css/style.css,
      // que não existe (não há TLS nessa porta), e nenhum CSS/JS carrega.
      // O Chrome disfarça o problema (ignora a diretiva em localhost, que
      // ele já considera origem confiável), o Safari NÃO — lá o site
      // aparece sem estilo nenhum. Por isso a diretiva só entra quando o
      // CLIENT_ORIGIN é de fato https, em vez de depender de NODE_ENV
      // (que este projeto mantém como "production" mesmo localmente, para
      // o cookie de sessão se comportar igual ao do ar).
      ...(CLIENT_ORIGIN.startsWith("https://") ? {} : { upgradeInsecureRequests: null }),
    },
  },
}));
// `credentials: true` é necessário para o cookie de sessão trafegar quando o
// site é aberto de uma origem diferente da API (ex.: durante o desenvolvimento
// com um live-reload em outra porta). Combinado com `origin` fixo (não "*"),
// só o seu próprio site pode enviar/receber esse cookie.
app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }));
// Comprime HTML/CSS/JS/JSON com gzip antes de enviar — sem isso, o
// style.css (~21KB) e o main.js (~37KB) saíam do jeito que estão no disco,
// mesmo o navegador sempre anunciando que aceita gzip. Não comprime
// imagens/binários (já vêm comprimidos, gastar CPU tentando de novo
// não ajuda).
app.use(compression());

/* =========================================================================
   MODO MANUTENÇÃO — MAINTENANCE_MODE=true no .env
   -------------------------------------------------------------------------
   Serve manutencao.html no lugar do site inteiro, para uma parada
   PLANEJADA (mexer no banco, trocar preços em massa, testar algo pesado)
   sem a cliente ver meia loja funcionando.

   ⚠️ O QUE ISTO **NÃO** RESOLVE: se o processo do Node cair ou estiver
   reiniciando, nada aqui roda — o navegador mostra "não foi possível
   conectar ao servidor", porque não há servidor para responder. Para
   cobrir esse caso, quem tem que servir o manutencao.html é o servidor
   web na frente (nginx/Apache do painel da Hostinger), com algo como:
       error_page 502 503 504 /manutencao.html;
   Este middleware cobre a parada planejada; a config do host cobre a queda.

   Vem logo depois do compression() e ANTES do parser de JSON, do
   attachUser e dos limitadores: em manutenção não faz sentido gastar
   consulta ao banco nem contar requisição de rate limit.
========================================================================= */
const MAINTENANCE_MODE = String(process.env.MAINTENANCE_MODE || "").toLowerCase() === "true";
if (MAINTENANCE_MODE) {
  // Lida do disco UMA vez, na subida, e servida da memória. Não é
  // micro-otimização: res.sendFile falha em silêncio quando o caminho do
  // projeto tem um diretório começando com ponto (o `send` recusa
  // dot-segments por padrão) e devolve "Erro interno" — justo nesta página,
  // que só existe para o momento em que tudo já está dando errado. Ler aqui
  // também faz um arquivo ausente aparecer no boot, e não na pior hora.
  let maintenancePage;
  try {
    maintenancePage = fs.readFileSync(path.join(__dirname, "manutencao.html"), "utf8");
  } catch (err) {
    console.error("Não foi possível ler manutencao.html:", err.message);
    maintenancePage = "<!doctype html><meta charset=\"utf-8\"><title>Em manutenção</title>"
      + "<p>A loja está em manutenção. Voltamos em alguns minutos.</p>";
  }
  console.warn("⚠️  MAINTENANCE_MODE ligado — o site está servindo manutencao.html para todo mundo.");
  app.use((req, res, next) => {
    // O webhook do Mercado Pago é a ÚNICA exceção, e não é detalhe: é por
    // ele que um pagamento aprovado vira pedido pago. Respondendo 503 aqui,
    // uma cliente que pagou durante a manutenção ficaria com o pedido
    // "pendente" — o MP até reenvia, mas com espera crescente e um limite
    // de tentativas. Deixar passar é mais seguro do que confiar no retry.
    if (req.path === "/api/webhook") return next();

    // 503 (e não 200) de propósito: diz ao Google "é temporário, não
    // desindexe a loja". Retry-After completa o recado.
    res.status(503);
    res.set("Retry-After", "900");
    // Sem cache: quando a manutenção acabar, ninguém pode ficar preso
    // nesta página por causa de um cache intermediário.
    res.set("Cache-Control", "no-store");
    if (req.path.startsWith("/api/")) {
      return res.json({ error: "A loja está em manutenção. Tente novamente em alguns minutos." });
    }
    if ((req.method === "GET" || req.method === "HEAD") && req.accepts("html")) {
      res.type("html");
      return res.send(maintenancePage);
    }
    return res.send("A loja está em manutenção. Tente novamente em alguns minutos.");
  });
}

app.use(express.json({ limit: "50kb" }));   // corpo pequeno: evita payloads gigantes (DoS simples)
app.use(auth.attachUser);                   // preenche req.user (ou null) a partir do cookie de sessão

/* =========================================================================
   PROTEÇÃO CSRF
   -------------------------------------------------------------------------
   O cookie de sessão já é `SameSite=Lax` (auth.js) — navegadores modernos
   não o enviam em POST/PUT/DELETE disparados por outro site. Esta camada
   é uma segunda barreira explícita, independente do cookie: navegadores
   sempre mandam o header `Origin` em requisições não seguras (POST etc.),
   mesmo same-origin; se ele vier ausente ou de outro domínio, a requisição
   é recusada. Isso bloqueia tanto um <form>/fetch hospedado em outro site
   quanto ferramentas que tentam chamar a API "no escuro" sem passar por
   um navegador apontando para o nosso próprio front-end.
   Exceção: /api/webhook é chamado pelo servidor do Mercado Pago, não por
   um navegador — nunca terá `Origin`, então fica de fora desta checagem
   (a segurança dele vem de outro lugar: sempre confirmar o pagamento
   consultando a API do Mercado Pago pelo ID, nunca só pelo payload recebido).
   Mesma exceção para /api/newsletter/unsubscribe: o POST de "cancelamento
   de um clique" (RFC 8058) é feito pelo servidor do Gmail/Yahoo direto,
   não por um navegador — também nunca terá `Origin`. A segurança dele vem
   do token aleatório de 48 caracteres na própria URL, não de sessão/cookie
   (é a mesma lógica de segurança do link de redefinição de senha, que já
   escapa desta checagem por ser GET).
========================================================================= */
function verifyOrigin(req, res, next){
  if(["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if(req.path === "/webhook") return next();
  if(req.path === "/newsletter/unsubscribe") return next();
  const origin = req.headers.origin;
  if(!origin || origin !== CLIENT_ORIGIN){
    return res.status(403).json({ error: "Requisição recusada (origem não confiável)." });
  }
  next();
}
app.use("/api", verifyOrigin);

// Limite amplo para TODO o site — de propósito bem mais folgado que os de
// baixo: não é para conter uso normal (nenhuma visita real chega perto
// disso), é só para conter flood de verdade — um script batendo a mesma
// URL sem pausa. Foi assim que apareceu em produção: curl em loop em
// /index.html, milhares de vezes numa janela de poucas horas, vindo sempre
// do mesmo IP. CSS/JS/imagens ficam de fora: são o que a PRÓPRIA página de
// erro 429 precisa para renderizar com a marca — sem essa exceção, uma
// cliente bloqueada via também bloqueava o motivo de a tela de erro
// aparecer sem estilo nenhum (só texto preto). O alvo real do flood daquele
// incidente foi sempre a página HTML, nunca os arquivos estáticos.
app.use(rateLimit({
  windowMs: 60 * 1000, max: 1200, handler: sendTooManyRequests,
  skip: (req) => ["css", "js", "img"].includes(req.path.split("/").filter(Boolean)[0]),
}));

// Limite geral, só para a API (arquivos estáticos têm o limite amplo acima,
// ou ficam de fora dele): 500 requisições / 15 min por IP — bem acima do
// que uma sessão de compra real gera (catálogo, carrinho, frete, etc.), só
// para conter abuso automatizado. A consulta de status do Pix fica de fora:
// ela sozinha já passa desse total num único pagamento (ver
// statusPollLimiter, mais abaixo) e tem seu próprio limite, maior.
app.use("/api", rateLimit({
  windowMs: 15 * 60 * 1000, max: 500, handler: sendTooManyRequests,
  skip: (req) => req.path.startsWith("/orders/") && req.path.endsWith("/status"),
}));

// Limite mais rígido para rotas sensíveis (evita spam/força bruta). Essas
// rotas dividem o mesmo balde: calcular frete, validar cupom e criar o
// pagamento (Pix/cartão/boleto), então uma cliente indecisa — corrige o
// CEP, testa dois cupons, tenta pagar de novo porque a conexão travou —
// facilmente soma 8-10 chamadas numa única compra. Era 20 antes e já
// estourou em uso manual normal (bem menos que um ataque de verdade), por
// isso a folga maior aqui.
const strictLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, handler: sendTooManyRequests });

// Limite ainda mais rígido para login/cadastro — dificulta força bruta de
// senha e criação em massa de contas. Não segue a mesma folga dos outros
// limites de propósito: é o único que existe para conter um ataque contra
// UMA conta específica (adivinhar senha), não uso legítimo em excesso —
// afrouxar este enfraqueceria a proteção real que ele oferece.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, handler: sendTooManyRequests });

// Limite próprio para a consulta de status do Pix: a página fica perguntando
// sozinha de 4 em 4 segundos por até 20 minutos (ver js/pagamento-pix.js),
// o que sozinho já passa de 200 chamadas — muito mais do que o limite geral
// da API permite. Sem um balde separado, uma cliente que demora para pagar
// esbarraria no limite geral e o status parava de atualizar em silêncio.
const statusPollLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 500, handler: sendTooManyRequests });

/* =========================================================================
   ARQUIVOS ESTÁTICOS DO SITE
   -------------------------------------------------------------------------
   O servidor agora também serve o site (antes só a API rodava aqui — o
   front-end chamava `/api/...` com caminho relativo, mas era aberto em outra
   origem/porta, então essas chamadas nunca chegavam ao back-end). Servir os
   dois juntos corrige isso e também simplifica o cookie de sessão (mesma
   origem, sem depender de CORS cross-site para cookies).
   A lista abaixo é uma ALLOWLIST (mais seguro que bloquear por exceção):
   só esses arquivos/pastas na raiz do projeto ficam acessíveis por HTTP —
   isso impede que a pasta server/ (código-fonte do back-end) seja servida
   por engano caso alguém peça, por exemplo, /server/server.js.
========================================================================= */
const SITE_ROOT = __dirname;
const PUBLIC_TOP_LEVEL = new Set([
  "index.html", "conta.html", "pedidos.html", "admin.html",
  "acompanhar-pedido.html",
  "pagamento-sucesso.html", "pagamento-erro.html", "pagamento-pendente.html",
  "pagamento-pix.html",
  "redefinir-senha.html", "politica.html", "404.html", "429.html", "css", "js", "img",
  // Precisa ser alcançável por caminho direto para o servidor web da frente
  // (nginx/Apache) poder servi-la quando o Node estiver fora do ar — que é
  // justamente quando este middleware aqui não roda. Ver MAINTENANCE_MODE.
  "manutencao.html",
  // Buscadores e navegadores pedem estes na raiz, por convenção — sem entrar
  // aqui eles caem no 404 mesmo existindo em disco. O .ico e o apple-touch
  // são pedidos sozinhos pelo navegador, mesmo sem <link> na página.
  "robots.txt", "sitemap.xml", "favicon.ico", "apple-touch-icon.png",
  // Descrição da loja em texto para assistentes de IA (ChatGPT, Claude,
  // Perplexity) — mesmo papel do robots.txt, só que para quem lê o site
  // para responder perguntas em vez de indexar.
  "llms.txt",
]);
// Usada tanto pelo bloqueio de allowlist abaixo quanto pelo catch-all no fim
// do arquivo (depois de express.static e de todas as rotas). Navegação de
// página (GET/HEAD aceitando HTML) recebe a 404 com a identidade do site;
// o resto (chamada de API, asset que faltou, etc.) recebe uma resposta
// simples do jeito que já era antes.
function sendNotFound(req, res){
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Rota não encontrada." });
  }
  if ((req.method === "GET" || req.method === "HEAD") && req.accepts("html")) {
    return res.status(404).sendFile(path.join(SITE_ROOT, "404.html"));
  }
  return res.status(404).send("Não encontrado.");
}

// Mesma ideia do sendNotFound acima, para quando um limite de requisições é
// estourado: sem isto, express-rate-limit responde com o texto cru dele
// ("Too many requests, please try again later."), sem estilo nenhum — a
// única resposta do site sem a identidade visual da loja.
function sendTooManyRequests(req, res){
  if (req.path.startsWith("/api/")) {
    return res.status(429).json({ error: "Muitas requisições. Aguarde um instante e tente novamente." });
  }
  if ((req.method === "GET" || req.method === "HEAD") && req.accepts("html")) {
    return res.status(429).sendFile(path.join(SITE_ROOT, "429.html"));
  }
  return res.status(429).send("Muitas requisições. Aguarde um instante e tente novamente.");
}
app.use((req, res, next) => {
  if (req.path === "/" || req.path.startsWith("/api/")) return next();
  const firstSegment = req.path.split("/").filter(Boolean)[0];
  if (firstSegment && PUBLIC_TOP_LEVEL.has(firstSegment)) return next();
  return sendNotFound(req, res);
});

/* admin.html só sai daqui para quem já é admin
   -------------------------------------------------------------------------
   Antes disto, o arquivo era servido como qualquer outro estático: qualquer
   pessoa abria /admin.html e via a casca do painel (menus, abas, tabelas
   vazias). Nenhum DADO vazava — todas as rotas /api/admin/* já respondiam
   401/403 sem sessão de admin, então a tela ficava vazia —, mas entregar a
   casca é ruim por dois motivos: confunde (parece invasão bem-sucedida para
   quem olha de fora, e foi exatamente o que aconteceu no teste que motivou
   esta mudança) e entrega de graça o mapa do painel (nomes de campo, rotas
   chamadas pelo js/admin.js, estrutura das tabelas) para quem for procurar
   uma brecha.
   Vem ANTES do express.static de propósito: registrado depois, o estático já
   teria respondido e este guarda nunca rodaria. */
app.get("/admin.html", (req, res, next) => {
  if (req.user?.isAdmin) return next();
  // Mesma resposta para "não está logado" e "está logado mas não é admin":
  // um 403 diferenciado confirmaria a existência do painel para quem estiver
  // sondando. Quem não é admin vê exatamente o que veria numa URL inexistente.
  if (!req.user) {
    return res.redirect(302, "/conta.html?admin=1");
  }
  return sendNotFound(req, res);
});
/* Política de cache — o que garante que um deploy apareça na hora
   -------------------------------------------------------------------------
   Este projeto não tem passo de build, então os arquivos NÃO têm nome
   versionado (style.css é sempre style.css). Sem isso, qualquer prazo de
   cache significa gente vendo o site antigo por até aquele prazo — foi o
   que aconteceu com o `maxAge: 1h` anterior: o HTML vinha novo e o CSS
   vinha velho, e a página aparecia quebrada (botão sem estilo).

   `no-cache` NÃO quer dizer "não guarde": quer dizer "guarde, mas
   pergunte antes de usar". O navegador manda o ETag e o servidor
   responde 304 (algumas centenas de bytes) quando nada mudou, então o
   arquivo continua vindo do disco local — o custo é uma ida rápida à
   rede, e em troca ninguém nunca vê versão antiga.

   Fonte e imagem ficam de fora porque já têm nome único: as fontes
   trazem hash (poppins-400-latin-5a6413.woff2) e as fotos de produto
   trazem timestamp (produto-1-1786813302518.jpg). Nome novo a cada
   mudança = pode cachear por muito tempo sem risco, e é o que segura a
   nota de velocidade no PageSpeed. */
const REVALIDATE_ALWAYS = /\.(html|css|js)$/i;
// favicon.ico e apple-touch-icon.png entram à parte (não via extensão,
// que pegaria toda foto .png do site): navegadores — o Safari em
// particular — buscam /favicon.ico direto na raiz por convenção, sem
// passar pelo <link> do HTML, então ignoram a query de versão (?v=) que
// protege CSS/JS/ícone linkado. Sem revalidar, quem visitou antes de uma
// troca de ícone fica com o antigo por até 365 dias (o maxAge abaixo).
const ICONES_RAIZ = new Set(["favicon.ico", "apple-touch-icon.png"]);

/* Versão no endereço do CSS/JS — o que impede HTML novo com estilo antigo
   -------------------------------------------------------------------------
   `no-cache` acima resolve para navegador que obedece. O navegador embutido
   do WhatsApp não obedeceu: serviu o HTML novo com o style.css antigo do
   cache, e sem a regra que dimensiona o logo ele apareceu no tamanho do
   arquivo, por cima do título.

   A cura é o endereço mudar quando o conteúdo muda: `style.css?v=a1b2c3d4`
   é outro endereço, então um cache antigo nunca casa com HTML novo. O hash
   sai do próprio arquivo.

   Feito aqui, no servidor, e não escrito à mão no HTML: à mão dependeria
   de alguém lembrar de trocar a versão a cada mudança de CSS, e é
   exatamente esse tipo de esquecimento que produziu o bug.

   O resultado fica em memória com a assinatura (mtime + tamanho) do
   arquivo junto, e é refeito quando ela muda. Sem isso o hash congelaria
   no primeiro acesso: `node --watch` reinicia por arquivo .js, não por
   .css, então editar o estilo em desenvolvimento não derrubaria o cache. */
const CACHE_ASSET = new Map();
function versaoDoAsset(relativo){
  const absoluto = path.join(SITE_ROOT, relativo);
  let assinatura;
  try {
    const st = fs.statSync(absoluto);
    assinatura = `${st.mtimeMs}:${st.size}`;
  } catch {
    return ""; // Arquivo ausente: segue sem versão em vez de derrubar a página.
  }
  const cacheado = CACHE_ASSET.get(relativo);
  if(cacheado && cacheado.assinatura === assinatura) return cacheado.versao;
  const versao = require("crypto")
    .createHash("sha256").update(fs.readFileSync(absoluto)).digest("hex").slice(0, 8);
  CACHE_ASSET.set(relativo, { assinatura, versao });
  return versao;
}

/* =========================================================================
   DADOS ESTRUTURADOS (JSON-LD) — o que o Google usa para montar o resultado
   -------------------------------------------------------------------------
   Sem isto a loja aparece na busca como um link de texto comum. Com isto o
   Google pode mostrar preço, disponibilidade e os dados da loja direto no
   resultado, e o site fica elegível a aparecer no Google Shopping/aba
   Imagens com preço.

   Gerado AQUI, no servidor, e não escrito à mão no index.html, pelo mesmo
   motivo da versão dos assets logo acima: preço e nome de produto são
   editáveis pelo painel (effectiveProduct), e marcação com preço diferente
   do que a página mostra é justamente o que o Google penaliza. Saindo da
   mesma função que a vitrine e o checkout usam, os três nunca divergem.

   ⚠️ De propósito NÃO emite aggregateRating/review: as avaliações que
   aparecem no site hoje são texto de exemplo, e publicar nota agregada
   inventada em dados estruturados é violação das diretrizes do Google
   (sujeita a ação manual) além de enganar quem compra. Quando houver
   avaliação real de cliente, aí sim vale acrescentar.
========================================================================= */
const SITE_URL = "https://adrianameloacessorios.com";

// Política de troca real da loja (ver politica.html, seção "arrependimento"):
// 7 dias corridos, reembolso integral incluindo o frete, sem justificativa
// — direito garantido pelo art. 49 do CDC para compra fora de loja física,
// que por lei corre por conta da loja (aqui, "FreeReturn"). Um objeto só,
// referenciado por @id em cada oferta, para não repetir o mesmo bloco nas
// 8 ofertas.
const POLITICA_TROCA_ID = `${SITE_URL}/politica.html#arrependimento`;
const politicaTroca = {
  "@type": "MerchantReturnPolicy",
  "@id": POLITICA_TROCA_ID,
  applicableCountry: "BR",
  returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow",
  merchantReturnDays: 7,
  returnMethod: "https://schema.org/ReturnByMail",
  returnFees: "https://schema.org/FreeReturn",
};

function dadosEstruturados(){
  const overridesMap = getProductOverridesMap();
  const rotuloCategoria = new Map(getAllCategories().map(c => [c.slug, c.label]));
  const produtos = getAllProductIds().map((id, i) => {
    const p = effectiveProduct(id, overridesMap);
    if(!p) return null;
    const categoria = rotuloCategoria.get(p.category) || p.category;
    const item = {
      "@type": "Product",
      name: p.name,
      // Gerada a partir do que já se sabe do produto (nome + categoria) —
      // não é copy inventada, só não existe campo de descrição própria por
      // produto hoje (nem no painel). O Google marca a ausência disto como
      // "optional" mas soma pontos de qualidade quando existe.
      description: `${p.name} — laço artesanal feito à mão pela Adriana Melo Acessórios, ideal para ${categoria.toLowerCase()}.`,
      category: p.category,
      brand: { "@type": "Brand", name: "Adriana Melo Acessórios" },
      offers: {
        "@type": "Offer",
        price: p.price.toFixed(2),
        priceCurrency: "BRL",
        availability: "https://schema.org/InStock",
        itemCondition: "https://schema.org/NewCondition",
        url: `${SITE_URL}/#colecoes`,
        seller: { "@id": `${SITE_URL}/#loja` },
        hasMerchantReturnPolicy: { "@id": POLITICA_TROCA_ID },
      },
    };
    // Só entra se existir de verdade: imagem quebrada em dado estruturado
    // vale menos que dado estruturado sem imagem.
    if(p.photoUrl){
      item.image = p.photoUrl.startsWith("http") ? p.photoUrl : `${SITE_URL}/${p.photoUrl.replace(/^\//, "")}`;
    }
    return { "@type": "ListItem", position: i + 1, item };
  }).filter(Boolean);

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Store",
        "@id": `${SITE_URL}/#loja`,
        name: "Adriana Melo Acessórios",
        description: "Ateliê artesanal de laços e presilhas para bebês e crianças. Cada peça é feita à mão, sob encomenda, na cor escolhida pela cliente.",
        url: SITE_URL,
        logo: `${SITE_URL}/img/logo-adriana-melo-6e53bc.png`,
        image: `${SITE_URL}/img/og-adriana-melo-6b333a.jpg`,
        telephone: "+5561982749808",
        email: "adrianameloacessorios@gmail.com",
        taxID: "54.732.065/0001-50",
        priceRange: "R$ 29 - R$ 90",
        currenciesAccepted: "BRL",
        paymentAccepted: "Pix, Cartão de crédito, Boleto",
        address: {
          "@type": "PostalAddress",
          addressLocality: "Brasília",
          addressRegion: "DF",
          addressCountry: "BR",
        },
        areaServed: { "@type": "Country", name: "Brasil" },
        sameAs: ["https://www.instagram.com/adriana_melo_acessorios"],
      },
      {
        "@type": "WebSite",
        "@id": `${SITE_URL}/#site`,
        url: SITE_URL,
        name: "Adriana Melo Acessórios",
        inLanguage: "pt-BR",
        publisher: { "@id": `${SITE_URL}/#loja` },
      },
      {
        "@type": "ItemList",
        name: "Coleção de laços artesanais",
        itemListElement: produtos,
      },
      politicaTroca,
    ],
  };
}

/* `<` vira < para que um nome de produto com "</script>" (o painel
   deixa a lojista escrever qualquer texto) não consiga fechar a tag e
   injetar HTML na página. */
function blocoDadosEstruturados(){
  const json = JSON.stringify(dadosEstruturados()).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}

/* Cupom mostrado na notificação de boas-vindas (js/cupom-toast.js). Lê a
   MESMA linha da tabela `coupons` que o checkout valida (WELCOME_COUPON_CODE,
   mais abaixo) — nunca um código solto escrito na página. Se a lojista
   apagar o cupom pelo painel, isto devolve null e a notificação
   simplesmente não aparece, em vez de anunciar um código que o carrinho ia
   recusar.

   ⚠️ Sai como atributo `data-cupom` (JSON escapado), NUNCA como <script>
   inline: a CSP do site é `script-src 'self'`, sem `'unsafe-inline'` — um
   <script> escrito aqui seria bloqueado pelo navegador. O JSON-LD escapa
   dessa regra por ter type="application/ld+json" (não é script executável
   aos olhos da CSP); um <script> normal não teria essa sorte. */
function atributoCupomBoasVindas(){
  const coupon = db.getCoupon(WELCOME_COUPON_CODE);
  const dados = coupon ? { code: coupon.code, percentOff: coupon.percent_off } : null;
  return JSON.stringify(dados)
    .replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// Pega href/src de css/…, js/… e img/… que ainda não tenham query própria, e
// também favicon.ico/apple-touch-icon.png na raiz — todos ficam em cache de
// 365 dias (setHeaders mais abaixo, maxAge padrão do express.static) sem o
// "no-cache" que .html/.css/.js têm via REVALIDATE_ALWAYS, então são os que
// mais precisam do endereço mudar quando o arquivo muda — sem isso, quem
// visitou antes de uma troca (ícone, foto do hero etc.) fica com a versão
// antiga por até um ano em qualquer aparelho, sem jeito de forçar
// atualização a não ser limpando o cache manualmente.
const REF_ASSET = /\b(href|src)="((?:css|js|img)\/[^"?#]+\.(?:css|js|jpg|jpeg|png|svg|webp|gif)|favicon\.ico|apple-touch-icon\.png)"/g;
// srcset é outro atributo e outra gramática ("arquivo 400w, arquivo 760w"),
// então não cabe no REF_ASSET acima — mas precisa do MESMO ?v=, senão a foto
// responsiva do hero seria o único asset da página a cair no "no-cache" e
// pagar uma revalidação por visita.
const REF_SRCSET = /\bsrcset="([^"]+)"/g;
const CAMINHO_NO_SRCSET = /((?:css|js|img)\/[^\s,?#]+\.(?:jpg|jpeg|png|svg|webp|gif))/g;
// Marcadores no <head>/<body> do index.html, trocados na hora de servir.
const MARCA_JSONLD = "<!--#DADOS-ESTRUTURADOS#-->";
const MARCA_CUPOM = "<!--#CUPOM-BOAS-VINDAS#-->";
/* O resultado fica guardado por página. Sem isto, TODA visita pagava um
   readFileSync bloqueante de 68 KB + a regex por cima dele + a reconstrução
   do JSON-LD inteiro a partir do SQLite — e como o HTML sai com "no-cache",
   toda navegação pagava de novo.

   Invalidar exige três chaves, e é por isso que o cache não existia antes:
   1. o arquivo em si (mtime + tamanho);
   2. a versão de CADA asset citado — trocar o style.css tem de mudar o
      ?v= dentro do HTML, senão o cache serviria o endereço antigo. Os
      caminhos achados na primeira passada ficam guardados para as
      seguintes só conferirem a assinatura, sem reler o arquivo;
   3. a versão do catálogo, para o JSON-LD — vinda do banco (db.catalogVersion),
      NUNCA de um contador em memória: o Passenger pode subir mais de um
      worker e os contadores divergiriam entre eles.

   O cupom fica de fora do cache de propósito: é uma leitura por chave
   primária, barata, e assim o código promovido no site nunca sai defasado
   do que o checkout aceita. */
const CACHE_HTML = new Map();

function assinaturaDosAssets(refs){
  let assinatura = "";
  for(const rel of refs) assinatura += rel + "=" + versaoDoAsset(rel) + ";";
  return assinatura;
}

function htmlVersionado(absoluto){
  const st = fs.statSync(absoluto);
  const assinatura = `${st.mtimeMs}:${st.size}`;
  const cacheado = CACHE_HTML.get(absoluto);

  const valido = cacheado
    && cacheado.assinatura === assinatura
    && cacheado.assets === assinaturaDosAssets(cacheado.refs)
    // Só o index.html tem JSON-LD; as outras 12 páginas nem consultam o banco.
    && (!cacheado.temJsonld || cacheado.catalogo === db.catalogVersion());

  if(valido) return comCupom(cacheado.html);

  const refs = [];
  const versionar = (rel) => {
    refs.push(rel);
    const v = versaoDoAsset(rel);
    return v ? `${rel}?v=${v}` : rel;
  };
  let html = fs.readFileSync(absoluto, "utf8")
    .replace(REF_ASSET, (inteiro, attr, rel) => {
      const versionado = versionar(rel);
      return versionado === rel ? inteiro : `${attr}="${versionado}"`;
    })
    .replace(REF_SRCSET, (inteiro, lista) =>
      `srcset="${lista.replace(CAMINHO_NO_SRCSET, versionar)}"`);

  const temJsonld = html.includes(MARCA_JSONLD);
  if(temJsonld) html = html.replace(MARCA_JSONLD, blocoDadosEstruturados());

  CACHE_HTML.set(absoluto, {
    assinatura,
    refs,
    assets: assinaturaDosAssets(refs),
    temJsonld,
    catalogo: temJsonld ? db.catalogVersion() : "",
    html,
  });
  return comCupom(html);
}

function comCupom(html){
  return html.includes(MARCA_CUPOM)
    ? html.replace(MARCA_CUPOM, atributoCupomBoasVindas())
    : html;
}

app.use((req, res, next) => {
  if(req.method !== "GET" && req.method !== "HEAD") return next();
  let rota = decodeURIComponent(req.path);
  if(rota === "/") rota = "/index.html";
  if(!rota.endsWith(".html") || rota.includes("..")) return next();
  const arquivo = path.join(SITE_ROOT, rota);
  // Só serve o que está dentro da pasta do site e na allowlist — as mesmas
  // duas travas que o restante do arquivo já aplica.
  if(!arquivo.startsWith(SITE_ROOT + path.sep)) return next();
  if(!PUBLIC_TOP_LEVEL.has(rota.split("/")[1])) return next();
  let html;
  try { html = htmlVersionado(arquivo); } catch { return next(); }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  return res.send(html);
});

app.use(express.static(SITE_ROOT, {
  extensions: ["html"],
  dotfiles: "ignore",
  maxAge: "365d",
  setHeaders(res, filePath){
    // Ícone da raiz é buscado sem query (o Safari vai direto em /favicon.ico),
    // então nunca pode virar immutable — ficaria preso por um ano.
    if(ICONES_RAIZ.has(path.basename(filePath))){
      res.setHeader("Cache-Control", "no-cache");
      return;
    }
    if(!REVALIDATE_ALWAYS.test(filePath)) return;
    /* Com ?v= o endereço é o próprio conteúdo: arquivo diferente é endereço
       diferente, então pode ficar guardado para sempre e a navegação deixa de
       pagar uma ida à rede só para ouvir 304. Seguro porque o .html nunca é
       versionado e continua "no-cache" — todo deploy publica ?v= novo.
       Sem a query (link escrito à mão, acesso direto) volta a revalidar. */
    if(res.req && res.req.query && res.req.query.v){
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      res.setHeader("Cache-Control", "no-cache");
    }
  },
}));

/* =========================================================================
   UPLOAD DE FOTO DE PRODUTO (painel administrativo)
   -------------------------------------------------------------------------
   Antes o painel só aceitava colar a URL de uma imagem já hospedada em
   outro lugar. Agora a lojista pode enviar o arquivo direto do computador
   dela — o arquivo é comprimido (sharp) e gravado como BLOB na tabela
   product_photos (lib/db.js), não em disco: um upload em img/products/ é
   apagado por qualquer redeploy que reinstale a aplicação do zero (pasta
   fora do git, sem backup — foi exatamente assim que as fotos já enviadas
   sumiram), enquanto data.db é a única coisa com backup automático
   (server/scripts/backup-db.js).
   POST /api/admin/products/:id/photo devolve um caminho curto
   ("/api/products/photos/<uuid>") para o painel salvar como `photoUrl`,
   exatamente como já fazia com uma URL externa — ver a rota, mais abaixo.
   Por que um caminho curto e não a imagem em base64 direto no JSON: o
   `photoUrl`/`photos` de cada produto viaja em TODA resposta de
   /api/products (carregado por qualquer visitante da vitrine); embutir
   base64 ali, multiplicado por até 8 fotos por produto, pesaria a home
   inteira. O caminho curto mantém esse payload do tamanho de sempre — a
   imagem em si é servida (e cacheada como immutable, já que cada id nunca
   muda de conteúdo) pela rota GET /api/products/photos/:id, mais abaixo.
========================================================================= */
const PRODUCT_PHOTO_MIME_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

// memoryStorage: o arquivo chega inteiro em req.file.buffer, sem tocar o
// disco — é comprimido/redimensionado (sharp) e gravado no banco dentro do
// handler da rota, mais abaixo.
const productPhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 }, // 4MB — teto do envio bruto; o arquivo salvo fica bem menor após a compressão
  fileFilter(req, file, cb){
    // O `accept="image/*"` no <input type="file"> do admin.html é só uma
    // dica de UI — um cliente HTTP direto (curl/Postman) pode mandar
    // qualquer coisa, então o tipo é revalidado aqui contra uma allowlist
    // fixa antes de processar/gravar.
    cb(null, Boolean(PRODUCT_PHOTO_MIME_EXT[file.mimetype]));
  },
});

// Se o `photoUrl` sendo substituído aponta para um upload nosso (e não uma
// URL externa colada à mão), apaga a foto velha — best-effort: nunca deve
// derrubar a resposta do PATCH por causa disso. Só chamado de dentro do
// PATCH, depois que o novo valor já foi confirmado como o que vai ser
// salvo (nunca apaga uma foto que ainda está em uso, mesmo que a lojista
// tenha enviado uma foto nova e cancelado o modal sem salvar — nesse caso
// o upload novo é que fica órfão, não o antigo, que é sempre o lado mais
// seguro do erro).
// Trata os dois formatos possíveis de photoUrl: o atual (rota apontando
// para o banco) e o antigo (caminho em disco, de antes desta mudança) —
// nenhum arquivo novo é gravado em img/products/, mas uma aba do admin
// aberta antes do deploy ainda pode reenviar o formato antigo.
function deleteOldLocalPhoto(oldPhotoUrl){
  if(!oldPhotoUrl) return;
  if(PHOTO_ROUTE_PATTERN.test(oldPhotoUrl)){
    db.deleteProductPhoto(oldPhotoUrl.slice(oldPhotoUrl.lastIndexOf("/") + 1));
    return;
  }
  if(!oldPhotoUrl.startsWith("/img/products/")) return;
  const filePath = path.join(SITE_ROOT, oldPhotoUrl);
  fs.unlink(filePath, (err) => {
    if(err && err.code !== "ENOENT"){
      console.error("Não foi possível apagar a foto antiga do produto:", err);
    }
  });
}

/* =========================================================================
   Validação e montagem de itens a partir do que o CLIENTE enviou.
   Nunca usa preço/peso vindos do navegador — sempre busca no catálogo do
   servidor (effectiveProduct, que já aplica eventual edição do painel).
========================================================================= */
// A escolha de cor saiu do site (a lojista pediu para remover). O controle
// de disponibilidade que antes era feito por cor virou o booleano
// `soldOut` por produto — checado abaixo junto de `hidden`, para o produto
// esgotado ser recusado no servidor e não só escondido na tela.
function buildValidatedItems(items){
  if(!Array.isArray(items) || items.length === 0){
    throw { status:400, message:"Carrinho vazio ou inválido." };
  }
  if(items.length > 50){
    throw { status:400, message:"Carrinho excede o limite de itens." };
  }
  const overridesMap = getProductOverridesMap();
  return items.map(raw => {
    const id = Number(raw?.id);
    const qty = Number(raw?.qty);
    const product = Number.isInteger(id) ? effectiveProduct(id, overridesMap) : null;
    if(!product){
      throw { status:400, message:`Produto inválido: ${raw?.id}` };
    }
    if(product.hidden){
      throw { status:409, message:`"${product.name}" não está mais disponível.` };
    }
    // Fecha a corrida "a cliente colocou no carrinho quando tinha, a lojista
    // marcou como esgotado antes de finalizar": recusa aqui em vez de deixar
    // passar um pedido que a loja não consegue atender.
    if(product.soldOut){
      throw { status:409, message:`"${product.name}" está esgotado no momento.` };
    }
    if(!Number.isInteger(qty) || qty < 1 || qty > 10){
      throw { status:400, message:`Quantidade inválida para o produto ${id}.` };
    }
    return { id, qty, product };
  });
}

/* Empacotamento: os laços do catálogo fixo (id < 1000) vão TODOS na MESMA
   caixa — o TAMANHO dela (CAIXA_PADRAO) nunca muda com a quantidade, 1 laço
   ou 20. O PESO nunca é fixo: soma PESO_EMBALAGEM_KG (a caixa+papel em si)
   com PESO_LACO_KG por laço, do primeiro em diante — não é "grátis até 8",
   é sempre proporcional; 8 laços só é o ponto que a lojista usou para
   calibrar o peso da embalagem sozinha (200g − 8×20g = 40g).
   Um produto do painel (id >= 1000, ex.: uma bolsa) ainda não compartilha
   essa caixa — não é um laço, pode não caber nela — então continua somando
   peso e altura por unidade, do jeito que já funcionava antes. Se os dois
   tipos vierem no mesmo pedido, as caixas se empilham: altura soma, peso
   soma, e a largura/comprimento ficam com o maior dos dois. */
function buildPackage(validatedItems){
  let width = 0, length = 0, insurance = 0;
  let lacosQty = 0;
  let pesoOutros = 0, alturaOutros = 0;

  for(const { id, qty, product } of validatedItems){
    width = Math.max(width, product.width);
    length = Math.max(length, product.length);
    insurance += product.price * qty;

    if(id < CUSTOM_PRODUCT_ID_START){
      lacosQty += qty;
    } else {
      pesoOutros += product.weight * qty;
      alturaOutros += product.height * qty;
    }
  }

  const pesoDaCaixaDeLacos = lacosQty > 0
    ? PESO_EMBALAGEM_KG + lacosQty * PESO_LACO_KG
    : 0;
  const alturaComLacos = (lacosQty > 0 ? CAIXA_PADRAO.height : 0) + alturaOutros;

  return {
    weight: pesoDaCaixaDeLacos + pesoOutros,
    width: Math.max(width, CAIXA_PADRAO.width),
    length: Math.max(length, CAIXA_PADRAO.length),
    height: Math.max(alturaComLacos, CAIXA_PADRAO.height),
    insurance_value: Math.round(insurance * 100) / 100,
  };
}

/* =========================================================================
   MELHOR ENVIO — cliente HTTP mínimo (sem SDK, só fetch nativo do Node 18+)
   -------------------------------------------------------------------------
   A API exige Bearer token + um header User-Agent identificando sua
   aplicação e um e-mail de contato (exigência deles, não nossa).
   Baseado na documentação pública em docs.melhorenvio.com.br.

   ⚠️ O padrão é PRODUÇÃO porque o Melhor Envio não oferece mais ambiente
   de sandbox. Enquanto o padrão apontava para sandbox.melhorenvio.com.br,
   uma instalação nova (sem MELHOR_ENVIO_BASE_URL no .env) recebia 401
   "Unauthenticated." em toda cotação, sem nenhuma pista de que a causa
   era o endereço e não o token. Cotar frete (shipment/calculate) é
   consulta pura: não cria etiqueta nem gasta saldo, então apontar para
   produção por padrão não tem custo. O que gasta saldo de verdade é a
   compra de etiqueta, e essa continua atrás de AUTO_PURCHASE_SHIPPING_LABEL
   (desligada por padrão — ver purchaseShippingLabel mais abaixo).
========================================================================= */
const MELHOR_ENVIO_BASE_URL = process.env.MELHOR_ENVIO_BASE_URL || "https://melhorenvio.com.br";
const MELHOR_ENVIO_USER_AGENT = process.env.MELHOR_ENVIO_USER_AGENT || "PetitLaco (defina MELHOR_ENVIO_USER_AGENT no .env com seu e-mail)";

/* ⚠️ TIMEOUT É OBRIGATÓRIO AQUI. O fetch do Node não tem timeout padrão: se o
   Melhor Envio aceitar a conexão e não responder, a promessa fica pendurada
   para sempre — e como esta função roda DENTRO do checkout, a cliente ficaria
   com o botão de pagar girando sem fim, sem erro e sem pedido.

   `retries` é explícito por chamada, nunca padrão, porque as duas famílias de
   chamada são opostas: cotar frete é leitura pura e pode ser repetida à
   vontade; comprar etiqueta GASTA SALDO REAL e não pode ser repetida sozinha
   nunca — uma repetição automática ali compraria duas etiquetas. */
async function meFetch(path, { method = "GET", body, timeoutMs = 12000, retries = 0 } = {}){
  let ultimoErro = null;

  for(let tentativa = 0; tentativa <= retries; tentativa++){
    if(tentativa > 0) await new Promise(r => setTimeout(r, 700 * tentativa));

    let res;
    try{
      res = await fetch(`${MELHOR_ENVIO_BASE_URL}${path}`, {
        method,
        headers: {
          "Authorization": `Bearer ${process.env.MELHOR_ENVIO_TOKEN}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": MELHOR_ENVIO_USER_AGENT,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    }catch(erroDeRede){
      const estourouOTempo = erroDeRede?.name === "TimeoutError";
      ultimoErro = new Error(
        estourouOTempo
          ? `Melhor Envio não respondeu em ${timeoutMs / 1000}s.`
          : `Falha de rede ao falar com o Melhor Envio: ${erroDeRede?.message || erroDeRede}`
      );
      ultimoErro.cause = erroDeRede;
      /* Timeout NÃO é repetido, mesmo com retries liberado: quem não respondeu
         em N segundos está sobrecarregado, e insistir só dobra a espera da
         cliente (que está olhando o carrinho) enquanto piora a fila deles.
         Conexão recusada/derrubada falha na hora — essa vale repetir. */
      if(estourouOTempo) throw ultimoErro;
      continue;
    }

    const data = await res.json().catch(() => null);

    if(res.ok) return data;

    const err = new Error(data?.message || `Melhor Envio respondeu ${res.status}`);
    err.status = res.status;
    err.data = data;

    /* Credencial recusada é a falha mais cara que existe aqui: TODA cotação
       para de funcionar e ninguém consegue fechar compra. Diferente do
       Instagram (lib/instagram.js), este token não se renova sozinho — só
       trocando no .env. Por isso o log grita, em vez de virar mais uma linha
       genérica de "não foi possível calcular o frete". */
    if(res.status === 401 || res.status === 403){
      console.error(
        `⚠️  MELHOR ENVIO RECUSOU AS CREDENCIAIS (HTTP ${res.status}). ` +
        "Enquanto isso, NENHUMA cliente consegue calcular frete nem finalizar compra. " +
        "O MELHOR_ENVIO_TOKEN provavelmente venceu: gere um novo no painel do Melhor Envio " +
        "e atualize o .env de produção."
      );
      throw err;
    }

    // 5xx é problema do lado deles e costuma passar; 4xx não melhora repetindo.
    if(res.status >= 500){ ultimoErro = err; continue; }
    throw err;
  }

  throw ultimoErro;
}

/* Transportadoras que a loja oferece. O Melhor Envio cota TODAS as que
   atendem o CEP (Jadlog, JeT, Total Express, Azul, LATAM...), o que enche
   o carrinho de opções parecidas e trava a cliente na hora de escolher.
   A vitrine fica com três serviços, os que a loja realmente usa para
   postar: o PAC e o SEDEX dos Correios, e o Loggi Express.

   Os três cobrem faixas diferentes de preço/prazo, que é o que faz a
   escolha valer a pena para a cliente (medido numa cotação real
   Brasília → São Paulo: PAC R$ 25,39/5 dias, SEDEX R$ 49,11/2 dias,
   Loggi Express R$ 21,45/3 dias).

   Os outros serviços da própria Loggi ficam de fora de propósito:
   "Loggi Ponto" exige a cliente retirar num ponto (não é entrega em
   casa, e quem escolhe sem ler reclama depois) e "Loggi Coleta" custa
   quase o triplo do Express pela coleta em domicílio. Dos Correios,
   "Mini Envios" também fica fora: o limite de dimensão dele é menor que
   a caixa da loja, então ele volta com erro em toda cotação.

   Se um CEP não for atendido por nenhum dos três, a cotação volta vazia
   e o carrinho já mostra "nenhuma transportadora disponível" (o caminho
   de lista vazia em /api/calculate-shipping). */
function isOfferedCarrier(companyName, serviceName){
  const company = String(companyName || "").toLowerCase();
  const service = String(serviceName || "").toLowerCase().trim();
  if(company.includes("loggi") && service.includes("express")) return true;
  // Comparação exata nos dois dos Correios (e não `includes`) para o
  // filtro não abrir sozinho se o Melhor Envio passar a cotar uma
  // variante nova com o mesmo prefixo no nome (ex.: "SEDEX 12", que tem
  // outro preço e outro prazo).
  if(company.includes("correios") && (service === "pac" || service === "sedex")) return true;
  return false;
}

/* Pede a cotação ao Melhor Envio e devolve só as opções utilizáveis,
   já normalizadas para o formato que o front-end espera. Filtra os
   serviços que vieram com erro (ex.: transportadora indisponível para
   aquela rota) e os de transportadora que a loja não usa
   (isOfferedCarrier), e ordena do mais barato para o mais caro. */
async function quoteShipping(cepDestino, validatedItems){
  const pkg = buildPackage(validatedItems);

  /* Leitura pura (não cria etiqueta, não gasta saldo): uma repetição cobre a
     instabilidade momentânea que hoje derrubaria a cotação inteira.
     8 segundos porque a cliente está parada olhando o carrinho — e como
     timeout não é repetido (ver meFetch), o pior caso continua sendo 8s. */
  const quotes = await meFetch("/api/v2/me/shipment/calculate", {
    method: "POST",
    timeoutMs: 8000,
    retries: 1,
    body: {
      from: { postal_code: process.env.ORIGIN_CEP },
      to: { postal_code: cepDestino },
      package: {
        weight: pkg.weight,
        width: pkg.width,
        height: pkg.height,
        length: pkg.length,
      },
      options: {
        insurance_value: pkg.insurance_value,
        receipt: false,
        own_hand: false,
        collect: false,
      },
    },
  });

  /* A API devolve uma lista. Se um dia devolver outra coisa (mudança de
     contrato, página de erro com HTTP 200), sem esta guarda o .filter abaixo
     estouraria um TypeError e a cliente veria erro 500 no meio da compra. */
  if(!Array.isArray(quotes)){
    console.error("Melhor Envio devolveu um formato inesperado na cotação:", quotes);
    return [];
  }

  return quotes
    .filter(q => !q.error && (q.custom_price || q.price))
    .filter(q => isOfferedCarrier(q.company?.name, q.name))
    .map(q => ({
      service_id: q.id,
      name: `${q.company?.name ? q.company.name + " · " : ""}${q.name}`,
      price: Number(q.custom_price ?? q.price),
      delivery_time: q.custom_delivery_time
        ? `${q.custom_delivery_time} dia(s) útil(eis)`
        : (q.delivery_time ? `${q.delivery_time} dia(s) útil(eis)` : "prazo a confirmar"),
    }))
    .sort((a, b) => a.price - b.price);
}

/* =========================================================================
   POST /api/calculate-shipping
   -------------------------------------------------------------------------
   Recebe { cep, items: [{id, qty}] } e devolve as opções de frete
   calculadas de verdade junto ao Melhor Envio (peso/valor vêm do
   catálogo do servidor, nunca do navegador).
========================================================================= */
app.post("/api/calculate-shipping", strictLimiter, async (req, res) => {
  try {
    const cep = String(req.body?.cep || "").replace(/\D/g, "");
    if(!/^\d{8}$/.test(cep)){
      return res.status(400).json({ error: "CEP inválido." });
    }
    if(!process.env.ORIGIN_CEP){
      return res.status(500).json({ error: "Servidor sem CEP de origem configurado (ORIGIN_CEP no .env)." });
    }

    const validatedItems = buildValidatedItems(req.body?.items);
    const options = await quoteShipping(cep, validatedItems);

    if(options.length === 0){
      return res.status(200).json({ options: [], warning: "Nenhuma transportadora disponível para esse CEP." });
    }
    res.json({ options });
  } catch (err) {
    // Distingue os dois tipos de erro que caem aqui: os que a GENTE lança
    // de propósito (objeto simples, ex.: buildValidatedItems — mensagem já
    // pensada pro cliente ler) dos que vêm de uma falha real de rede/API
    // externa (sempre um Error de verdade — meFetch, na chamada ao Melhor
    // Envio). Mostrar a mensagem crua do segundo tipo pro cliente (ex.:
    // "Unauthenticated." quando o token do Melhor Envio está errado) é
    // confuso e vaza detalhe interno — por isso só o primeiro tipo é
    // devolvido como está; o resto vira uma mensagem genérica, com o erro
    // de verdade só no log do servidor.
    if(!(err instanceof Error) && err.status && err.message){
      console.error("Erro de validação/frete:", err.message);
      return res.status(err.status).json({ error: err.message });
    }
    // CEP com 8 dígitos mas que não existe (ex.: 13480-107) passa pela
    // validação de formato acima e só é recusado pelo Melhor Envio, com
    // 422 e `errors.postal_code`. Sem este caso, a cliente via "não foi
    // possível calcular agora, tente de novo" e ficava tentando de novo
    // para sempre — o problema é o CEP digitado, não uma falha passageira.
    if(err.status === 422 && err.data?.errors?.postal_code){
      console.error("CEP recusado pelo Melhor Envio:", String(req.body?.cep || "").replace(/\D/g, ""));
      return res.status(400).json({ error: "CEP inválido." });
    }
    console.error("Erro ao calcular frete:", err);
    res.status(502).json({ error: "Não foi possível calcular o frete agora. Tente novamente em instantes." });
  }
});

/* =========================================================================
   POST /api/validate-coupon
   -------------------------------------------------------------------------
   Recebe { code, items: [{id, qty}] }. Assim como o frete, o desconto NUNCA
   é confiado vindo do navegador — o servidor valida o código contra COUPONS
   e recalcula o desconto a partir do subtotal real (catálogo do servidor).
========================================================================= */
app.post("/api/validate-coupon", strictLimiter, (req, res) => {
  try {
    const coupon = findCoupon(req.body?.code);
    if(!coupon){
      return res.status(404).json({ error: "Cupom inválido ou expirado." });
    }
    // Aviso adiantado, ainda no carrinho: aqui só dá para reconhecer quem
    // está logada (não há telefone digitado nesta etapa). Quem compra sem
    // conta só é barrada no checkout, onde o telefone existe — por isso a
    // checagem de lá é a que vale, e esta é conveniência.
    if(coupon.oncePerCustomer && req.user && db.hasUsedCoupon({ code: coupon.code, userId: req.user.id })){
      return res.status(409).json({ error: COUPON_ALREADY_USED_MESSAGE });
    }
    const validatedItems = buildValidatedItems(req.body?.items);
    const subtotal = validatedItems.reduce((sum, { qty, product }) => sum + product.price * qty, 0);
    const discount = Math.round(subtotal * (coupon.percentOff / 100) * 100) / 100;
    res.json({ code: coupon.code, percentOff: coupon.percentOff, discount });
  } catch (err) {
    if(!(err instanceof Error) && err.status && err.message){
      return res.status(err.status).json({ error: err.message });
    }
    console.error("Erro ao validar cupom:", err);
    res.status(500).json({ error: "Não foi possível validar o cupom agora." });
  }
});

/* =========================================================================
   POST /api/create-preference
   -------------------------------------------------------------------------
   Recebe { items: [{id, qty}], cep, shipping_service_id, address, coupon,
   paymentMethod } do front-end — SEM preço de produto, SEM preço de frete,
   SEM valor de desconto. O servidor:
     1) recalcula os itens a partir de PRODUCTS;
     2) recalcula o frete de novo junto ao Melhor Envio e confirma que
        `shipping_service_id` ainda é uma opção válida para esse pedido
        (nunca confia no preço de frete que o navegador mostrou);
     3) revalida o cupom (se houver) contra COUPONS e aplica o desconto
        proporcionalmente ao preço de cada item (nunca confia no desconto
        que o navegador mostrou);
     4) aplica o desconto do Pix (js/pricing.js) quando essa é a forma de
        pagamento escolhida, e restringe a preferência aos meios de
        pagamento correspondentes (ver PAYMENT_METHODS);
     5) grava o pedido no banco (server/db.js), vinculado ao usuário logado
        (req.user, ver server/auth.js) — é isso que permite ao cliente ver
        o pedido depois em "Meus pedidos";
     6) cria a preferência no Mercado Pago com o frete somado como um
        item da compra.

   Exige sessão (auth.requireAuth): comprar sem conta não é permitido, para
   que todo pedido tenha um dono e apareça em "Meus pedidos". O aviso no
   carrinho (js/main.js) é só conveniência — a trava é esta.
========================================================================= */
/* Valida o pedido que chegou do carrinho e recalcula tudo do lado do
   servidor: itens, cupom, desconto do Pix e frete. É o miolo compartilhado
   entre as duas formas de cobrar — Checkout Pro (create-preference, cartão
   e boleto) e Pix nativo (create-pix-payment) —, para que as duas cobrem
   exatamente o mesmo valor pelas mesmas regras. Se divergirem um dia, o
   preço anunciado no carrinho deixa de bater com o cobrado.

   Lança { status, message } (objeto simples, não Error) nos erros de
   validação, que é a convenção que os catch das rotas usam para saber que a
   mensagem pode ser mostrada ao cliente. */
async function buildCheckoutDraft(req){
  const { cep: rawCep, shipping_service_id, address } = req.body || {};
  const cep = String(rawCep || "").replace(/\D/g, "");
  if(!/^\d{8}$/.test(cep)){
    throw { status: 400, message: "CEP inválido." };
  }
  if(!shipping_service_id){
    throw { status: 400, message: "Escolha uma opção de frete." };
  }
  const paymentMethod = String(req.body?.paymentMethod || "card").toLowerCase();
  if(!PAYMENT_METHODS[paymentMethod]){
    throw { status: 400, message: "Forma de pagamento inválida." };
  }
  if(!auth.isValidAddress(address)){
    throw { status: 400, message: "Endereço de entrega incompleto." };
  }

  // Best-effort: salva o endereço como padrão da conta para pré-preencher a
  // próxima compra, a menos que a cliente tenha desmarcado a opção no
  // carrinho. Nunca pode derrubar o checkout — um erro aqui só fica no log.
  if(req.body?.saveAddress !== false){
    try{
      db.saveAddress(req.user.id, { ...address, cep });
    }catch(err){
      console.error("Falha ao salvar endereço padrão da conta:", err.message);
    }
  }

  const validatedItems = buildValidatedItems(req.body?.items);

  // Cupom opcional: revalidado aqui, nunca confiando no desconto do front.
  const coupon = req.body?.coupon ? findCoupon(req.body.coupon) : null;
  if(req.body?.coupon && !coupon){
    throw { status: 409, message: "Esse cupom não é mais válido. Remova-o e tente novamente." };
  }

  // Ponto de decisão do uso único. Fica AQUI, e não só no /validate-coupon,
  // porque este é o passo que realmente cria o pedido — quem chamar a API
  // direto, pulando o carrinho, esbarra no mesmo bloqueio.
  const customerPhone = phoneDigits(address.telefone);
  if(coupon?.oncePerCustomer){
    const alreadyUsed = db.hasUsedCoupon({
      code: coupon.code,
      userId: req.user ? req.user.id : null,
      phone: customerPhone,
    });
    if(alreadyUsed){
      throw { status: 409, message: COUPON_ALREADY_USED_MESSAGE };
    }
  }

  const couponFactor = coupon ? (1 - coupon.percentOff / 100) : 1;

  /* Descontos aplicados no PREÇO UNITÁRIO e somados item a item (em vez de
     calculados de uma vez sobre o subtotal): o Mercado Pago cobra
     `unit_price * quantity` já arredondado por item, então somar os
     descontos do mesmo jeito é o que faz o "Total" gravado no pedido bater
     exatamente com o valor cobrado — calcular por fora sobre o subtotal
     deixaria uma diferença de centavos entre o recibo e a cobrança. */
  let subtotal = 0, couponDiscount = 0, pixDiscount = 0;
  const preferenceItems = validatedItems.map(({ id, qty, product }) => {
    const afterCoupon = pricing.round2(product.price * couponFactor);
    const unitPrice = paymentMethod === "pix" ? pricing.pixPriceFor(afterCoupon) : afterCoupon;
    subtotal += product.price * qty;
    couponDiscount += (product.price - afterCoupon) * qty;
    pixDiscount += (afterCoupon - unitPrice) * qty;
    return {
      id: String(id),
      title: product.name,
      quantity: qty,
      unit_price: unitPrice,   // <- preço vem do servidor, não do cliente
      currency_id: "BRL",
    };
  });
  subtotal = pricing.round2(subtotal);
  const discount = pricing.round2(couponDiscount);
  pixDiscount = pricing.round2(pixDiscount);

  // Recalcula o frete de novo (nunca confia no preço que o front mostrou)
  const shippingOptions = await quoteShipping(cep, validatedItems);
  const chosenShipping = shippingOptions.find(o => String(o.service_id) === String(shipping_service_id));
  if(!chosenShipping){
    throw { status: 409, message: "Essa opção de frete expirou ou não está mais disponível. Recalcule o frete e tente de novo." };
  }
  preferenceItems.push({
    id: "frete",
    title: `Frete — ${chosenShipping.name}`,
    quantity: 1,
    unit_price: chosenShipping.price,
    currency_id: "BRL",
  });

  return {
    cep, address, paymentMethod, validatedItems, preferenceItems,
    coupon, customerPhone, chosenShipping, subtotal, discount, pixDiscount,
    total: pricing.round2(subtotal - discount - pixDiscount + chosenShipping.price),
  };
}

/* Monta o registro do pedido a partir do rascunho acima. Separado de
   buildCheckoutDraft porque as duas formas de cobrar gravam o pedido em
   momentos diferentes: o Checkout Pro só depois que o Mercado Pago aceita a
   preferência, o Pix só depois que o QR existe. */
function orderRowFrom(draft, orderRef, user){
  return {
    externalReference: orderRef,
    userId: user?.id ?? null,
    // Cópia do e-mail no momento da compra: é para cá que vão o recibo e o
    // aviso de rastreio, e conta apagada depois não pode quebrar isso.
    customerEmail: user?.email ?? null,
    status: "pendente",
    // Guarda o preço de CATÁLOGO no momento da compra (não só id/qty) —
    // o histórico de pedidos precisa continuar exibindo o valor correto
    // mesmo se o preço do produto mudar depois. É o preço "de tabela"
    // (sem o desconto do cupom, que já aparece como uma linha separada
    // de "Desconto" no resumo), igual a um item de nota fiscal.
    // Sem `color`: a escolha de cor saiu do site. Pedidos ANTIGOS continuam
    // com a cor gravada e seguem exibindo o rótulo normalmente (ver
    // colorLabelForItem em lib/orderFormatting.js) — só os novos não têm.
    items: draft.validatedItems.map(({ id, qty, product }) => ({
      id, qty, price: product.price,
    })),
    address: { ...draft.address, cep: draft.cep },
    shipping: draft.chosenShipping,
    couponCode: draft.coupon ? draft.coupon.code : null,
    customerPhone: draft.customerPhone,
    subtotal: draft.subtotal,
    discount: draft.discount,
    pixDiscount: draft.pixDiscount,
    paymentMethod: draft.paymentMethod,
    shippingPrice: draft.chosenShipping.price,
    total: draft.total,
  };
}

app.post("/api/create-preference", strictLimiter, auth.requireAuth, async (req, res) => {
  try {
    const draft = await buildCheckoutDraft(req);
    const { address, paymentMethod, preferenceItems } = draft;

    const orderRef = randomUUID();

    // Só grava o pedido DEPOIS que o Mercado Pago confirmar a preferência —
    // se essa chamada falhar (token inválido, MP fora do ar), não queremos
    // um pedido "pendente" órfão no histórico do cliente que nunca vai virar
    // nada (nenhum link de pagamento chegou a existir para ele).
    // payer é opcional na API do Mercado Pago — mandamos o que já temos
    // (nome do endereço de entrega; e-mail só quando o cliente está
    // logado, já que o checkout de visitante não coleta e-mail) pra
    // pré-preencher a tela de pagamento. Sem telefone aqui de propósito:
    // o Mercado Pago exige um formato específico (DDD + número
    // separados) e um valor mal formatado rejeitaria a preferência
    // inteira — não vale o risco por um campo que já é opcional.
    const payer = {
      name: address.nome,
      ...(req.user?.email ? { email: req.user.email } : {}),
    };

    const preference = new Preference(mpClient);
    const result = await preference.create({
      body: {
        items: preferenceItems,
        payer,
        // Trava a tela de pagamento na forma que o cliente escolheu (e no
        // limite de parcelas que a vitrine anunciou) — ver PAYMENT_METHODS.
        payment_methods: {
          excluded_payment_types: PAYMENT_METHODS[paymentMethod].excludedPaymentTypes.map(id => ({ id })),
          installments: paymentMethod === "pix" ? 1 : pricing.PAYMENT_RULES.maxInstallments,
        },
        external_reference: orderRef,
        back_urls: {
          success: `${CLIENT_ORIGIN}/pagamento-sucesso.html`,
          failure: `${CLIENT_ORIGIN}/pagamento-erro.html`,
          pending: `${CLIENT_ORIGIN}/pagamento-pendente.html`,
        },
        auto_return: "approved",
        notification_url: `${process.env.SERVER_PUBLIC_URL || "https://SEU-DOMINIO-DO-SERVIDOR.com"}/api/webhook`,
        statement_descriptor: "PETIT LACO",
      },
    });

    db.createOrder(orderRowFrom(draft, orderRef, req.user));

    // init_point = link de pagamento (Checkout Pro) para redirecionar o cliente
    res.json({ id: result.id, init_point: result.init_point });
  } catch (err) {
    // Mesmo racional do catch em /api/calculate-shipping: só mostra a
    // mensagem crua pro cliente quando é um erro de validação nosso
    // (objeto simples); qualquer Error de verdade (Melhor Envio, Mercado
    // Pago) vira mensagem genérica aqui, com o detalhe real só no log.
    if(!(err instanceof Error) && err.status && err.message){
      return res.status(err.status).json({ error: err.message });
    }
    console.error("Erro ao criar preferência:", err);
    res.status(500).json({ error: "Não foi possível iniciar o pagamento. Tente novamente em instantes." });
  }
});

/* =========================================================================
   POST /api/create-pix-payment — Pix sem sair do site
   -------------------------------------------------------------------------
   Mesmo cálculo do Checkout Pro (buildCheckoutDraft), mas em vez de devolver
   um link para o site do Mercado Pago, cria o pagamento Pix direto pela API
   e devolve o QR Code para a página exibir. A cliente paga pelo app do banco
   e nunca sai de adrianameloacessorios.com.

   Quem confirma o pagamento continua sendo o webhook (/api/webhook), nunca
   esta resposta: aqui o pagamento nasce sempre "pending" — o QR acabou de
   ser gerado e ninguém pagou ainda. A página consulta
   GET /api/orders/:reference/status para saber quando virou "pago".
========================================================================= */
app.post("/api/create-pix-payment", strictLimiter, auth.requireAuth, async (req, res) => {
  try {
    const draft = await buildCheckoutDraft(req);
    if(draft.paymentMethod !== "pix"){
      return res.status(400).json({ error: "Esta rota é só para pagamento via Pix." });
    }

    const orderRef = randomUUID();
    const payment = new Payment(mpClient);
    const result = await payment.create({
      body: {
        transaction_amount: draft.total,
        description: `Pedido ${orderRef.slice(0, 8)} — Adriana Melo Acessórios`,
        payment_method_id: "pix",
        external_reference: orderRef,
        notification_url: `${process.env.SERVER_PUBLIC_URL || "https://SEU-DOMINIO-DO-SERVIDOR.com"}/api/webhook`,
        payer: {
          email: req.user.email,
          first_name: draft.address.nome,
        },
      },
      // Sem isso, um duplo-clique no botão (ou um retry de rede) geraria
      // dois Pix de verdade para o mesmo pedido. A referência do pedido é
      // única por definição, então serve de chave.
      requestOptions: { idempotencyKey: orderRef },
    });

    const tx = result.point_of_interaction?.transaction_data;
    if(!tx?.qr_code){
      // Sem QR não há como pagar: não deixa um pedido órfão no histórico.
      console.error("Pix criado sem QR Code:", result.id, result.status);
      return res.status(502).json({ error: "Não foi possível gerar o código Pix agora. Tente novamente em instantes." });
    }

    db.createOrder(orderRowFrom(draft, orderRef, req.user));
    db.updateOrderStatus(orderRef, "pendente", String(result.id));

    res.json({
      reference: orderRef,
      total: draft.total,
      qrCode: tx.qr_code,                 // "copia e cola"
      qrCodeBase64: tx.qr_code_base64,    // imagem PNG já pronta
      expiresAt: result.date_of_expiration || null,
    });
  } catch (err) {
    if(!(err instanceof Error) && err.status && err.message){
      return res.status(err.status).json({ error: err.message });
    }
    console.error("Erro ao criar pagamento Pix:", err);
    res.status(500).json({ error: "Não foi possível gerar o Pix agora. Tente novamente em instantes." });
  }
});

/* =========================================================================
   POST /api/orders/:reference/resume-payment — continuar pagamento pendente
   -------------------------------------------------------------------------
   Gera um pagamento NOVO (Pix ou preferência do Checkout Pro) para um
   pedido que já existe e está "pendente" — o link/QR de pagamento nunca é
   guardado no banco (só payment_id, preenchido DEPOIS que o pagamento é
   confirmado pelo webhook ou o Pix é gerado), então não dá para simplesmente
   reexibir o que já existia; é preciso pedir um novo ao Mercado Pago.

   Reconstrói o corpo que buildCheckoutDraft espera a partir do que já está
   salvo no pedido (items_json, address_json, shipping_json, coupon_code,
   payment_method) e revalida tudo de novo — frete, cupom, estoque de cor —
   exatamente como um checkout novo faria, porque qualquer um pode ter
   mudado desde a tentativa original (por isso pode devolver 409 se o frete
   escolhido não existir mais ou o cupom tiver expirado). Atualiza o MESMO
   pedido (updateOrderDraft) em vez de criar um duplicado.
========================================================================= */
app.post("/api/orders/:reference/resume-payment", strictLimiter, auth.requireAuth, async (req, res) => {
  try {
    const order = db.getOrderByExternalReference(req.params.reference);
    if(!order || order.user_id !== req.user.id){
      return res.status(404).json({ error: "Pedido não encontrado." });
    }
    if(order.status !== "pendente"){
      return res.status(409).json({ error: "Este pedido não está mais pendente." });
    }

    const items = JSON.parse(order.items_json);
    const address = JSON.parse(order.address_json);
    const shipping = JSON.parse(order.shipping_json);

    const draft = await buildCheckoutDraft({
      user: req.user,
      body: {
        items: items.map(({ id, qty, color, secondColor }) => ({ id, qty, color, secondColor })),
        cep: address.cep,
        address,
        shipping_service_id: shipping.service_id,
        coupon: order.coupon_code,
        paymentMethod: order.payment_method,
        // Endereço já foi salvo como padrão da conta na tentativa original;
        // não precisa repetir aqui.
        saveAddress: false,
      },
    });
    const orderRef = order.external_reference;

    if(draft.paymentMethod === "pix"){
      const payment = new Payment(mpClient);
      const result = await payment.create({
        body: {
          transaction_amount: draft.total,
          description: `Pedido ${orderRef.slice(0, 8)} — Adriana Melo Acessórios`,
          payment_method_id: "pix",
          external_reference: orderRef,
          notification_url: `${process.env.SERVER_PUBLIC_URL || "https://SEU-DOMINIO-DO-SERVIDOR.com"}/api/webhook`,
          payer: {
            email: req.user.email,
            first_name: draft.address.nome,
          },
        },
        // Cada tentativa de retomar precisa de uma chave nova — reaproveitar
        // orderRef aqui devolveria o MESMO Pix (provavelmente já expirado)
        // gerado na tentativa anterior.
        requestOptions: { idempotencyKey: `${orderRef}-resume-${randomUUID()}` },
      });

      const tx = result.point_of_interaction?.transaction_data;
      if(!tx?.qr_code){
        console.error("Pix (retomada) criado sem QR Code:", result.id, result.status);
        return res.status(502).json({ error: "Não foi possível gerar o código Pix agora. Tente novamente em instantes." });
      }

      db.updateOrderDraft(orderRef, orderRowFrom(draft, orderRef, req.user.id));
      db.updateOrderStatus(orderRef, "pendente", String(result.id));

      return res.json({
        reference: orderRef,
        total: draft.total,
        qrCode: tx.qr_code,
        qrCodeBase64: tx.qr_code_base64,
        expiresAt: result.date_of_expiration || null,
      });
    }

    const { preferenceItems } = draft;
    const payer = {
      name: draft.address.nome,
      ...(req.user?.email ? { email: req.user.email } : {}),
    };
    const preference = new Preference(mpClient);
    const result = await preference.create({
      body: {
        items: preferenceItems,
        payer,
        payment_methods: {
          excluded_payment_types: PAYMENT_METHODS[draft.paymentMethod].excludedPaymentTypes.map(id => ({ id })),
          installments: pricing.PAYMENT_RULES.maxInstallments,
        },
        external_reference: orderRef,
        back_urls: {
          success: `${CLIENT_ORIGIN}/pagamento-sucesso.html`,
          failure: `${CLIENT_ORIGIN}/pagamento-erro.html`,
          pending: `${CLIENT_ORIGIN}/pagamento-pendente.html`,
        },
        auto_return: "approved",
        notification_url: `${process.env.SERVER_PUBLIC_URL || "https://SEU-DOMINIO-DO-SERVIDOR.com"}/api/webhook`,
        statement_descriptor: "PETIT LACO",
      },
    });

    db.updateOrderDraft(orderRef, orderRowFrom(draft, orderRef, req.user.id));

    res.json({ id: result.id, init_point: result.init_point });
  } catch (err) {
    if(!(err instanceof Error) && err.status && err.message){
      return res.status(err.status).json({ error: err.message });
    }
    console.error("Erro ao retomar pagamento:", err);
    res.status(500).json({ error: "Não foi possível retomar o pagamento agora. Tente novamente em instantes." });
  }
});

/* =========================================================================
   GET /api/orders/:reference/status — usado pela página do Pix
   -------------------------------------------------------------------------
   Devolve só o status, e só para a dona do pedido (o filtro por user_id é o
   que impede alguém adivinhar/enumerar referências e espiar pedido alheio).
   Mantido minúsculo de propósito: é chamado de poucos em poucos segundos
   enquanto a página do Pix está aberta.
========================================================================= */
app.get("/api/orders/:reference/status", statusPollLimiter, auth.requireAuth, (req, res) => {
  const order = db.getOrderByExternalReference(req.params.reference);
  if(!order || order.user_id !== req.user.id){
    return res.status(404).json({ error: "Pedido não encontrado." });
  }
  res.json({ status: order.status });
});

/* =========================================================================
   GET /api/orders/:reference — detalhe de UM pedido, para a página de
   acompanhamento (acompanhar-pedido.html).
   -------------------------------------------------------------------------
   Mesma checagem de dono do endpoint /status acima (404 tanto para pedido
   inexistente quanto para pedido de outra cliente, de propósito — não dá
   pista sobre qual dos dois casos é). Só consulta o rastreio ao vivo
   quando já existe um código salvo — sem isso, é uma chamada de rede a mais
   para todo pedido pago, mesmo antes de postado.
   Duas fontes possíveis para o "ao vivo": se a etiqueta foi comprada PELO
   Melhor Envio (melhor_envio_shipment_id preenchido), consulta a API deles
   (fetchLiveTracking); senão — etiqueta comprada direto com a
   transportadora e o código só colado no painel — tenta o rastreio direto
   dos Correios (fetchCorreiosPublicTracking), que só funciona para código
   no formato deles. Nos dois casos, falha vira `null` sem quebrar a
   página: o link de rastreio (carrierTrackingUrl) sempre continua servindo.
========================================================================= */
app.get("/api/orders/:reference", statusPollLimiter, auth.requireAuth, async (req, res) => {
  try {
    const order = db.getOrderByExternalReference(req.params.reference);
    if(!order || order.user_id !== req.user.id){
      return res.status(404).json({ error: "Pedido não encontrado." });
    }
    const overridesMap = getProductOverridesMap();
    const allColors = getAllColors();
    const items = JSON.parse(order.items_json).map(item => ({
      id: item.id, qty: item.qty,
      name: effectiveProduct(item.id, overridesMap)?.name || `Produto #${item.id}`,
      color: colorLabelForItem(item, allColors),
    }));
    const shipping = JSON.parse(order.shipping_json);
    const trackingCode = order.tracking_code || "";
    const live = trackingCode
      ? (order.melhor_envio_shipment_id
          ? await fetchLiveTracking(order.melhor_envio_shipment_id)
          : await fetchCorreiosPublicTracking(trackingCode))
      : null;
    res.json({
      reference: order.external_reference,
      status: order.status,
      fulfillmentStatus: order.fulfillment_status || null,
      shippedAt: order.shipped_at || null,
      deliveredAt: order.delivered_at || null,
      items,
      shipping: { name: shipping.name, deliveryTime: shipping.delivery_time },
      total: order.total,
      createdAt: order.created_at,
      trackingCode,
      carrierUrl: carrierTrackingUrl(trackingCode),
      tracking: live,
    });
  } catch (err) {
    console.error("Erro ao carregar detalhe do pedido:", err);
    res.status(500).json({ error: "Não foi possível carregar o pedido agora." });
  }
});

/* =========================================================================
   Compra da etiqueta de envio no Melhor Envio (opcional, best-effort)
   -------------------------------------------------------------------------
   ⚠️ Isto gasta saldo de verdade da sua conta Melhor Envio. Por isso vem
   DESLIGADO por padrão (AUTO_PURCHASE_SHIPPING_LABEL=false no .env).
   Fluxo, conforme a documentação pública (docs.melhorenvio.com.br):
     1) POST /me/cart              → adiciona o frete escolhido ao carrinho,
                                      com endereço completo de origem/destino
     2) POST /me/shipment/checkout → paga o(s) frete(s) do carrinho com o
                                      saldo da conta Melhor Envio
     3) POST /me/shipment/generate → gera a etiqueta (retorna o código de
                                      rastreio)
   ⚠️ Este fluxo nunca foi executado de ponta a ponta: os passos 2 e 3
   gastam saldo real e o Melhor Envio não oferece mais sandbox, então não
   existe forma de ensaiar sem pagar de verdade. Trate como um ponto de
   partida, não como algo pronto para rodar sem revisão — e, ao ligar pela
   primeira vez, acompanhe o primeiro pedido de perto (o passo 1, /me/cart,
   é reversível pelo painel do Melhor Envio; a partir do checkout, não).
========================================================================= */
async function purchaseShippingLabel(order, externalReference){
  const seller = {
    name: process.env.SELLER_NAME,
    phone: process.env.SELLER_PHONE,
    email: process.env.SELLER_EMAIL,
    document: process.env.SELLER_DOCUMENT,
    address: process.env.SELLER_ADDRESS,
    complement: process.env.SELLER_COMPLEMENT || "",
    number: process.env.SELLER_NUMBER,
    district: process.env.SELLER_DISTRICT,
    city: process.env.SELLER_CITY,
    state_abbr: process.env.SELLER_STATE,
    postal_code: process.env.ORIGIN_CEP,
    country_id: "BR",
  };

  /* Usa effectiveProduct (e não PRODUCTS direto) pelo mesmo motivo do resto
     do arquivo: um nome/preço editado no painel precisa valer aqui também,
     senão a declaração de conteúdo e o valor segurado da etiqueta saem com
     o dado antigo. O filter() descarta um id que não exista mais no
     catálogo — sem ele, um produto removido derrubaria a geração da
     etiqueta inteira com um TypeError. */
  const labelOverridesMap = getProductOverridesMap();
  const labelItems = order.items
    .map(({ id, qty }) => ({ qty, product: effectiveProduct(id, labelOverridesMap) }))
    .filter(({ product }) => product);
  if(labelItems.length === 0){
    throw new Error("Nenhum item válido no pedido para gerar a etiqueta.");
  }
  const items = labelItems.map(({ qty, product }) => ({
    name: product.name, quantity: qty, unitary_value: product.price,
  }));
  const pkg = buildPackage(labelItems);

  /* As três chamadas abaixo GASTAM SALDO REAL. Timeout maior porque gerar
     etiqueta é bem mais lento que cotar, e retries fica no padrão ZERO de
     propósito: repetir automaticamente compraria etiqueta duplicada. Se
     falhar, a lojista repete pelo botão do painel, vendo o que aconteceu. */
  const cartItem = await meFetch("/api/v2/me/cart", {
    method: "POST",
    timeoutMs: 30000,
    body: {
      service: order.shipping.service_id,
      from: seller,
      to: {
        name: order.address.nome,
        phone: order.address.telefone,
        address: order.address.rua,
        complement: order.address.complemento || "",
        number: order.address.numero,
  district: order.address.bairro,
        city: order.address.cidade,
        state_abbr: order.address.uf,
        postal_code: order.address.cep,
        country_id: "BR",
      },
      products: items,
      volumes: [{ height: pkg.height, width: pkg.width, length: pkg.length, weight: pkg.weight }],
      options: {
        insurance_value: pkg.insurance_value,
        receipt: false,
        own_hand: false,
        non_commercial: false,
      },
    },
  });

  // Guardado ANTES do checkout/generate abaixo, que ainda podem falhar: se
  // falharem, pelo menos fica registrado com qual envio esta tentativa
  // mexeu (útil para depuração e para uma nova tentativa não perder o
  // vínculo), e é este id que a página de acompanhamento da cliente usa
  // depois para consultar o rastreio ao vivo (fetchLiveTracking, abaixo).
  if(externalReference) db.setMelhorEnvioShipmentId(externalReference, String(cartItem.id));

  await meFetch("/api/v2/me/shipment/checkout", {
    method: "POST",
    timeoutMs: 30000,
    body: { orders: [cartItem.id] },
  });

  const generated = await meFetch("/api/v2/me/shipment/generate", {
    method: "POST",
    timeoutMs: 30000,
    body: { orders: [cartItem.id] },
  });

  return generated;
}

/* =========================================================================
   Rastreio ao vivo (Melhor Envio) — best-effort, nunca lança.
   -------------------------------------------------------------------------
   A página de acompanhamento de pedido (acompanhar-pedido.html) chama isto
   sob demanda quando a cliente abre a página — não há polling nem webhook
   de rastreio, é uma consulta pontual.
   A documentação pública de POST /api/v2/me/shipment/tracking não pôde ser
   confirmada em detalhe (formato exato da resposta, se traz um histórico
   de eventos com local/data ou só um status atual). Por isso
   normalizeTrackingResponse tenta reconhecer algumas formas plausíveis e,
   se não reconhecer nada, devolve null — quem chama sempre cai de volta
   para a linha do tempo manual (fulfillmentStatus) + link oficial da
   transportadora (carrierTrackingUrl), nunca deixa a página quebrada.
========================================================================= */
async function fetchLiveTracking(shipmentId){
  if(!shipmentId || !process.env.MELHOR_ENVIO_TOKEN) return null;
  try{
    const data = await meFetch("/api/v2/me/shipment/tracking", {
      method: "POST",
      // A cliente está olhando a página esperando: melhor cair no rastreio
      // manual em 6s do que deixar a tela pendurada.
      timeoutMs: 6000,
      body: { orders: [shipmentId] },
    });
    return normalizeTrackingResponse(data, shipmentId);
  }catch(err){
    console.error(`Não foi possível consultar rastreio ao vivo (envio ${shipmentId}):`, err.message || err);
    return null;
  }
}

function normalizeTrackingResponse(data, shipmentId){
  if(!data || typeof data !== "object") return null;
  // A resposta pode vir como um objeto chaveado pelo id do envio
  // ({ "<id>": {...} }) ou, para uma consulta de um único envio, já como o
  // objeto direto — aceita as duas formas.
  const entry = data[shipmentId] && typeof data[shipmentId] === "object" ? data[shipmentId] : data;
  const rawEvents = entry.tracking_events || entry.events || entry.occurrences || entry.tracking || null;
  const events = Array.isArray(rawEvents)
    ? rawEvents.map(normalizeTrackingEvent).filter(Boolean)
    : [];
  const status = typeof entry.status === "string" ? entry.status : null;
  if(!status && events.length === 0) return null;
  return { status, events };
}

function normalizeTrackingEvent(raw){
  if(!raw || typeof raw !== "object") return null;
  const description = raw.description || raw.message || raw.status || raw.title || null;
  const date = raw.date || raw.created_at || raw.occurred_at || raw.time || null;
  const location = raw.location || raw.local || [raw.city, raw.state].filter(Boolean).join("/") || null;
  if(!description && !date) return null;
  return { description, date, location: location || null };
}

/* =========================================================================
   Rastreio "ao vivo" DIRETO dos Correios (best-effort) — para quando a
   etiqueta foi comprada fora do Melhor Envio (direto no site da
   transportadora) e só o código foi colado no painel. Nesse caso não existe
   melhor_envio_shipment_id (só é gravado quando a etiqueta é comprada PELO
   Melhor Envio), então fetchLiveTracking não tem o que consultar — este é
   o equivalente para esse caminho.
   -------------------------------------------------------------------------
   ⚠️ Não é uma API pública documentada/com contrato: é o mesmo endpoint que
   o site oficial dos Correios usa para a própria página de rastreio, sem
   autenticação. Pode mudar de formato ou parar de responder sem aviso — por
   isso é estritamente best-effort, no mesmo espírito de fetchLiveTracking:
   qualquer falha (rede, formato inesperado, indisponibilidade, bloqueio)
   só faz a página cair de volta para "sem eventos ao vivo". O link direto
   para o rastreio oficial (carrierTrackingUrl) sempre funciona de qualquer
   jeito, então a cliente nunca fica sem conseguir rastrear — só sem o
   histórico embutido na nossa página quando este endpoint falhar. */
async function fetchCorreiosPublicTracking(trackingCode){
  if(!trackingCode || !CODIGO_CORREIOS_REGEX.test(trackingCode)) return null;
  try{
    const res = await fetch(`https://proxyapp.correios.com.br/v1/sro-rastro/${encodeURIComponent(trackingCode)}`, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    if(!res.ok) return null;
    const data = await res.json();
    const objeto = Array.isArray(data?.objetos) ? data.objetos[0] : (Array.isArray(data) ? data[0] : data);
    const rawEventos = objeto?.eventos || objeto?.tracking_events || objeto?.events || null;
    if(!Array.isArray(rawEventos)) return null;
    const events = rawEventos.map(ev => {
      if(!ev || typeof ev !== "object") return null;
      const description = ev.descricao || ev.description || ev.message || null;
      const date = ev.dtHrCriado || ev.data || ev.date || ev.created_at || null;
      const unidade = ev.unidade || {};
      const location = (unidade.cidade && unidade.uf) ? `${unidade.cidade}/${unidade.uf}` : (ev.local || ev.location || null);
      if(!description && !date) return null;
      return { description, date, location: location || null };
    }).filter(Boolean);
    if(events.length === 0) return null;
    return { status: events[0].description, events };
  }catch(err){
    console.error(`Não foi possível consultar rastreio direto dos Correios (${trackingCode}):`, err.message || err);
    return null;
  }
}

// Código dos Correios tem sempre 13 caracteres, terminando em "BR" (ex.:
// AA123456789BR) — usado tanto para escolher o link de rastreio quanto para
// decidir se vale tentar o rastreio direto dos Correios (mais abaixo).
const CODIGO_CORREIOS_REGEX = /^[A-Z]{2}\d{9}BR$/;

// Link de rastreio da transportadora, sempre presente quando há código —
// complemento permanente da rota "ao vivo" (fetchLiveTracking), não um
// fallback só de erro. Código dos Correios cai no link oficial deles;
// qualquer outro formato (etiqueta de outra transportadora comprada via
// Melhor Envio) cai no link do próprio Melhor Envio, que redireciona para a
// transportadora certa.
function carrierTrackingUrl(trackingCode){
  if(!trackingCode) return null;
  return CODIGO_CORREIOS_REGEX.test(trackingCode)
    ? `https://rastreamento.correios.com.br/app/index.php?objetos=${encodeURIComponent(trackingCode)}`
    : `https://www.melhorenvio.com.br/rastreio/${encodeURIComponent(trackingCode)}`;
}

/* =========================================================================
   POST /api/webhook  (configurar essa URL pública no painel do Mercado Pago)
   -------------------------------------------------------------------------
   O Mercado Pago chama esta rota quando o status de um pagamento muda.
   NUNCA confie apenas no redirecionamento do navegador (back_urls) para
   liberar/despachar o pedido — a confirmação de verdade é sempre esta
   notificação, validada consultando a API do Mercado Pago pelo ID
   recebido.
========================================================================= */
// Mapeia os status do Mercado Pago para o rótulo salvo no pedido (o que o
// cliente vê em "Meus pedidos").
const PAYMENT_STATUS_MAP = {
  approved: "pago",
  pending: "pendente",
  in_process: "em análise",
  rejected: "recusado",
  cancelled: "cancelado",
  refunded: "reembolsado",
  charged_back: "estornado",
};

/* Tudo que só deve acontecer UMA VEZ, na primeira vez que um pedido vira
   "pago" (comprar etiqueta, avisar a lojista por WhatsApp/e-mail) — ver
   guarda de idempotência (wasAlreadyApproved) no handler do webhook,
   abaixo, que é quem decide SE isso é chamado. Roda depois da resposta
   200 já ter sido enviada ao Mercado Pago (fire-and-forget, com seu
   próprio catch) — chamadas de rede a terceiros (WhatsApp/SMTP) podem
   demorar alguns segundos, e nunca podem atrasar/arriscar o timeout da
   confirmação do webhook. */
/* Tira uma mensagem da fila e tenta entregar. Chamado logo depois de
   enfileirar (o caso normal, em que o e-mail sai na hora) e pelo cron, para
   o que falhou. Nunca lança: a falha vira estado gravado, não exceção. */
async function entregarEmailDaFila(id){
  if(!id) return;
  const linha = db.getOutboxEmail(id);
  if(!linha || linha.sent_at) return;
  try{
    // enviarComMiniaturas e não sendEmail: a fila guarda só o HTML, então os
    // anexos das miniaturas são derivados dele na hora de entregar — e assim
    // a retentativa do cron os remonta sozinha.
    await emailPhotos.enviarComMiniaturas({
      to: linha.to_email,
      subject: linha.subject,
      text: linha.text_body,
      html: linha.html_body,
    });
    db.markEmailSent(id);
    console.log(`E-mail "${linha.kind}" entregue à cliente (pedido ${linha.order_reference || "-"}).`);
  }catch(err){
    db.markEmailFailed(id, err.message || err);
    console.error(`Falha ao entregar e-mail "${linha.kind}" — segue na fila para nova tentativa:`, err.message || err);
  }
}

/* ÚNICO lugar que grava código de rastreio. Existem três caminhos que geram
   um código — a lojista digitando no painel, o botão "gerar etiqueta" e a
   compra automática ao aprovar o pagamento — e antes cada um gravava por
   conta própria: dois deles não avisavam a cliente de jeito nenhum, e a home
   promete rastreio por e-mail. Passando os três por aqui, o aviso sai igual
   em qualquer um.
   Devolve o id na fila (ou null quando não há o que enviar: pedido sem
   e-mail, ou aviso já enfileirado antes para este pedido). */
function salvarRastreioEAvisar(reference, trackingCode){
  if(!reference || !trackingCode) return null;

  const anterior = db.getOrderByExternalReference(reference);
  const mudou = !anterior || anterior.tracking_code !== trackingCode;
  db.updateOrderTracking(reference, trackingCode);

  // Regravar o MESMO código (salvar duas vezes no painel, webhook reenviado)
  // não avisa de novo. Um código DIFERENTE avisa: significa que a lojista
  // corrigiu um erro de digitação, e a cliente precisa saber do certo.
  if(!mudou) return null;
  db.deleteOutboxEntry("pedido_postado", reference);

  const pedido = db.getOrderByExternalReference(reference);
  if(!pedido || !pedido.customer_email) return null;

  let endereco = null;
  try { endereco = JSON.parse(pedido.address_json); } catch { endereco = null; }

  const conteudo = email.formatTrackingEmail({
    externalReference: reference,
    trackingCode,
    address: endereco,
    trackUrl: `${CLIENT_ORIGIN}/acompanhar-pedido.html?pedido=${encodeURIComponent(reference)}`,
  });
  return db.enqueueEmail({
    kind: "pedido_postado",
    toEmail: pedido.customer_email,
    orderReference: reference,
    subject: conteudo.subject,
    textBody: conteudo.text,
    htmlBody: conteudo.html,
  });
}

async function runApprovedOrderSideEffects(orderRow, info){
  const order = {
    items: JSON.parse(orderRow.items_json),
    address: JSON.parse(orderRow.address_json),
    shipping: JSON.parse(orderRow.shipping_json),
  };

  // Preenchido quando a etiqueta é comprada automaticamente logo abaixo.
  let rastreioDaEtiqueta = null;

  if(process.env.AUTO_PURCHASE_SHIPPING_LABEL === "true"){
    try{
      const label = await purchaseShippingLabel(order, info.external_reference);
      console.log("Etiqueta de envio comprada:", label);
      // O código vinha sendo descartado aqui: a etiqueta era comprada e a
      // lojista ainda tinha de digitar o rastreio à mão no painel. Guardado
      // para ser avisado à cliente logo depois do recibo, mais abaixo.
      rastreioDaEtiqueta = label?.[0]?.tracking || label?.tracking || null;
    }catch(labelErr){
      console.error("Falha ao comprar etiqueta automaticamente (pedido ficou pago, mas sem etiqueta — gere manualmente no painel do Melhor Envio):", labelErr);
    }
  } else {
    console.log("Pagamento aprovado. Gere a etiqueta manualmente no painel do Melhor Envio para o pedido:", info.external_reference);
  }

  // Dados comuns aos dois avisos abaixo (WhatsApp e e-mail), montados uma
  // única vez.
  const notifyOverridesMap = getProductOverridesMap();
  const notificationOrder = {
    externalReference: info.external_reference,
    items: order.items.map(({ id, qty, color, secondColor }) => ({
      id, qty, color: color || null, secondColor: secondColor || null,
      name: effectiveProduct(id, notifyOverridesMap)?.name || `Produto #${id}`,
      photoUrl: effectiveProduct(id, notifyOverridesMap)?.photoUrl || null,
    })),
    address: order.address,
    total: orderRow.total,
    paidAt: info.date_approved || info.date_created || Date.now(),
    // Paleta atual (fixa + criada pelo painel), para colorLabelForItem
    // resolver o nome certo de uma cor personalizada no aviso.
    allColors: getAllColors(),
  };

  // Os dois avisos abaixo são best-effort e independentes um do outro:
  // uma falha em qualquer um deles (credenciais ausentes, provedor fora
  // do ar, etc.) nunca pode reverter a confirmação do pedido, que já foi
  // gravada antes de chegar aqui.
  try{
    await whatsapp.notifyOwnerOfPaidOrder(notificationOrder);
    console.log(`Aviso de WhatsApp enviado à lojista para o pedido ${info.external_reference}.`);
  }catch(waErr){
    console.error(`Falha ao enviar aviso de WhatsApp (pedido ${info.external_reference} segue pago normalmente):`, waErr.message || waErr);
  }

  try{
    await email.notifyOwnerOfPaidOrder({
      ...notificationOrder,
      adminUrl: `${CLIENT_ORIGIN}/admin.html?pedido=${encodeURIComponent(info.external_reference)}`,
    });
    console.log(`E-mail de aviso enviado à lojista para o pedido ${info.external_reference}.`);
  }catch(mailErr){
    console.error(`Falha ao enviar e-mail de aviso (pedido ${info.external_reference} segue pago normalmente):`, mailErr.message || mailErr);
  }

  /* Recibo para a CLIENTE. Diferente dos dois avisos acima, este NÃO pode
     falhar em silêncio: quem comprou não tem painel para conferir. Por isso
     vai para a fila antes de ser tentado — o índice único (tipo, pedido)
     ainda garante que um webhook reenviado não gere recibo repetido. */
  if(orderRow.customer_email){
    const conteudo = email.formatOrderConfirmationEmail({
      externalReference: info.external_reference,
      items: order.items.map(item => ({
        qty: item.qty,
        price: item.price,
        name: effectiveProduct(item.id, notifyOverridesMap)?.name || `Produto #${item.id}`,
        photoUrl: effectiveProduct(item.id, notifyOverridesMap)?.photoUrl || null,
      })),
      subtotal: orderRow.subtotal,
      discount: orderRow.discount,
      pixDiscount: orderRow.pix_discount,
      shippingPrice: orderRow.shipping_price,
      total: orderRow.total,
      couponCode: orderRow.coupon_code,
      address: order.address,
      paidAt: info.date_approved || info.date_created || Date.now(),
      trackUrl: `${CLIENT_ORIGIN}/acompanhar-pedido.html?pedido=${encodeURIComponent(info.external_reference)}`,
    });
    const id = db.enqueueEmail({
      kind: "pedido_confirmado",
      toEmail: orderRow.customer_email,
      orderReference: info.external_reference,
      subject: conteudo.subject,
      textBody: conteudo.text,
      htmlBody: conteudo.html,
    });
    await entregarEmailDaFila(id);
  } else {
    console.warn(`Pedido ${info.external_reference} sem e-mail da cliente gravado — recibo não enviado.`);
  }

  /* Se a etiqueta foi comprada automaticamente, o rastreio já existe neste
     instante e a cliente recebe os dois e-mails na sequência certa: primeiro
     o recibo, depois o "está a caminho". Com a compra automática desligada
     (o padrão), não há código nenhum ainda — o aviso sai quando a lojista
     gravar o rastreio no painel. */
  if(rastreioDaEtiqueta){
    await entregarEmailDaFila(salvarRastreioEAvisar(info.external_reference, rastreioDaEtiqueta));
  }
}

/* Verificação da assinatura do webhook do Mercado Pago (header x-signature).
   OPT-IN: só é exigida se MP_WEBHOOK_SECRET estiver no .env — sem o segredo,
   mantém o comportamento atual (compatível com deploys que ainda não o
   configuraram). Mesmo sem esta camada, um webhook forjado não consegue
   marcar pedido como pago (o status vem do payment.get autenticado, abaixo);
   isto é defesa em profundidade + evita chamadas payment.get disparadas por
   terceiros. Formato conforme a doc do Mercado Pago:
     x-signature: "ts=<timestamp>,v1=<hmac_sha256_hex>"
     manifesto:   "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"  */
function verifyMpWebhookSignature(req, dataId) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true; // não configurado → não exige (opt-in)
  const crypto = require("crypto");
  const parts = Object.fromEntries(
    String(req.get("x-signature") || "")
      .split(",")
      .map(kv => kv.split("=").map(s => s?.trim()))
  );
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return false;
  const requestId = req.get("x-request-id") || "";
  // data.id alfanumérico entra em minúsculo no manifesto (regra do MP).
  const idForManifest = /[a-zA-Z]/.test(String(dataId)) ? String(dataId).toLowerCase() : String(dataId);
  const manifest = `id:${idForManifest};request-id:${requestId};ts:${ts};`;
  const expected = crypto.createHmac("sha256", secret).update(manifest).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(v1, "hex"));
  } catch {
    return false;
  }
}

app.post("/api/webhook", async (req, res) => {
  try {
    const paymentId = req.query?.["data.id"] || req.body?.data?.id;
    const topic = req.query?.type || req.body?.type;

    if (topic === "payment" && paymentId) {
      if (!verifyMpWebhookSignature(req, paymentId)) {
        console.warn(`Webhook: assinatura x-signature inválida para ${paymentId} — ignorado.`);
        return res.sendStatus(401);
      }
      const payment = new Payment(mpClient);
      const info = await payment.get({ id: paymentId });
      console.log(`Webhook recebido — pagamento ${paymentId}: ${info.status}`);

      const orderRow = info.external_reference
        ? db.getOrderByExternalReference(info.external_reference)
        : null;

      if(!orderRow){
        console.warn(`Webhook: pagamento ${paymentId} não corresponde a nenhum pedido conhecido (external_reference=${info.external_reference || "ausente"}).`);
        return res.sendStatus(200);
      }

      // Guarda de idempotência: o Mercado Pago pode reenviar a mesma
      // notificação (rede instável, ou nosso servidor demorou a
      // responder da vez anterior). Se esse pedido JÁ estava "pago"
      // antes desta chamada, é um reenvio — sem esta checagem, cada
      // reenvio mandaria WhatsApp/e-mail de novo pra lojista e, com
      // AUTO_PURCHASE_SHIPPING_LABEL ligado, compraria a etiqueta de novo
      // (gastando saldo real duplicado).
      const wasAlreadyApproved = orderRow.status === "pago";
      const status = PAYMENT_STATUS_MAP[info.status] || info.status;
      db.updateOrderStatus(info.external_reference, status, String(paymentId));
      // "Em produção" começa a valer assim que o pagamento é aprovado pela
      // primeira vez — mesma guarda de idempotência de runApprovedOrderSideEffects,
      // logo abaixo, para um reenvio do mesmo webhook não fazer nada de novo.
      if(info.status === "approved" && !wasAlreadyApproved){
        db.markOrderInProduction(info.external_reference);
      }

      // Responde ao Mercado Pago AGORA. O que falta (etiqueta, avisos)
      // são chamadas de rede a terceiros que podem demorar — rodam depois,
      // sem bloquear esta resposta nem arriscar um timeout que faria o
      // Mercado Pago reenviar este mesmo webhook.
      res.sendStatus(200);

      if(info.status === "approved" && !wasAlreadyApproved){
        runApprovedOrderSideEffects(orderRow, info).catch(err => {
          console.error(`Falha inesperada processando efeitos do pedido ${info.external_reference}:`, err);
        });
      }
      return;
    }

    // Notificação de um tipo que não nos interessa (ex.: merchant_order) —
    // confirma recebimento mesmo assim, pra o Mercado Pago não ficar
    // reenviando algo que nunca vamos processar.
    res.sendStatus(200);
  } catch (err) {
    console.error("Erro no webhook:", err);
    if(!res.headersSent) res.sendStatus(500);
  }
});

/* =========================================================================
   POST /api/contact e /api/newsletter — exemplos de validação server-side.
   O front-end já valida (main.js), mas isso NUNCA é suficiente sozinho:
   qualquer pessoa pode chamar a API diretamente (curl/Postman) pulando o
   HTML. Por isso validamos e limitamos tudo de novo aqui.
========================================================================= */
// Cupom prometido pelo bloco "Ganhe 10% na primeira compra" da home. É uma
// linha de verdade na tabela `coupons` (semeada em db.js) — a mesma que o
// checkout valida — e não um código solto escrito só aqui.
const WELCOME_COUPON_CODE = "BEMVINDA10";

app.post("/api/newsletter", strictLimiter, async (req, res) => {
  const emailAddress = auth.normalizeEmail(req.body?.email);
  if(!auth.isValidEmail(emailAddress)){
    return res.status(400).json({ error: "E-mail inválido." });
  }

  db.addNewsletterSubscriber(emailAddress);

  const coupon = db.getCoupon(WELCOME_COUPON_CODE);
  if(!coupon){
    // Cupom apagado no painel: ainda registra a inscrição, mas não promete
    // um desconto que o checkout recusaria.
    console.warn(`Cupom de boas-vindas ${WELCOME_COUPON_CODE} não existe — inscrição salva sem cupom.`);
    return res.json({ ok: true, coupon: null });
  }

  // O código também volta na resposta e é mostrado na tela. Assim a cliente
  // recebe o que foi prometido mesmo se o e-mail falhar (SMTP fora do ar,
  // caixa cheia, endereço com erro de digitação) — o e-mail vira reforço,
  // não o único caminho.
  let emailed = false;
  try {
    const unsubscribeToken = db.getOrCreateUnsubscribeToken(emailAddress);
    const unsubscribeUrl = `${CLIENT_ORIGIN}/api/newsletter/unsubscribe?email=${encodeURIComponent(emailAddress)}&token=${unsubscribeToken}`;
    await email.sendWelcomeCouponEmail({
      to: emailAddress,
      couponCode: coupon.code,
      percentOff: coupon.percent_off,
      shopUrl: `${CLIENT_ORIGIN}/index.html#colecoes`,
      unsubscribeUrl,
    });
    emailed = true;
  } catch (err) {
    console.error("Falha ao enviar o cupom de boas-vindas por e-mail:", err.message);
  }

  res.json({ ok: true, coupon: coupon.code, percentOff: coupon.percent_off, emailed });
});

// Link de descadastro do e-mail do cupom de boas-vindas (List-Unsubscribe).
// GET é o clique manual no rodapé do e-mail; POST é o "cancelamento de um
// clique" que Gmail/Yahoo fazem sozinhos, sem abrir página nenhuma, quando
// veem o header List-Unsubscribe-Post — por isso as duas rotas fazem
// exatamente a mesma coisa e nenhuma delas exige confirmação extra.
function handleNewsletterUnsubscribe(req, res) {
  const emailAddress = auth.normalizeEmail(req.query.email || req.body?.email || "");
  const token = req.query.token || req.body?.token || "";
  const ok = emailAddress && token && db.unsubscribeNewsletter(emailAddress, token);
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Descadastro — Adriana Melo Acessórios</title></head>
<body style="margin:0; padding:0; background:#FFFDFC; font-family:'Segoe UI', Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFFDFC;"><tr><td align="center" style="padding:64px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:420px; background:#FFFFFF; border-radius:24px; padding:36px 32px; text-align:center;">
      <tr><td style="font-size:26px; padding-bottom:10px;">${ok ? "🎀" : "⚠️"}</td></tr>
      <tr><td style="color:#54293C; font-size:18px; font-weight:bold; padding-bottom:8px;">
        ${ok ? "Descadastro concluído" : "Não foi possível descadastrar"}
      </td></tr>
      <tr><td style="color:#8C6577; font-size:14px; line-height:1.6;">
        ${ok
          ? "Você não vai mais receber e-mails promocionais da Adriana Melo Acessórios. Pedidos e redefinições de senha continuam chegando normalmente, se você tiver conta."
          : "O link parece inválido ou já foi usado. Se precisar de ajuda, fale pelo WhatsApp."}
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`);
}
app.get("/api/newsletter/unsubscribe", handleNewsletterUnsubscribe);
app.post("/api/newsletter/unsubscribe", handleNewsletterUnsubscribe);

app.post("/api/contact", strictLimiter, async (req, res) => {
  const nome = (req.body?.nome || "").trim().slice(0, 120);
  const telefone = (req.body?.telefone || "").trim().slice(0, 30);
  const ocasiao = (req.body?.ocasiao || "").trim().slice(0, 40);
  const mensagem = (req.body?.mensagem || "").trim().slice(0, 2000);

  if(!nome || !telefone || !mensagem){
    return res.status(400).json({ error: "Preencha nome, telefone e mensagem." });
  }
  // Gravado no banco (e lido na aba "Clientes" do painel). Antes isso só ia
  // para o console: uma mensagem escrita com o log fechado se perdia.
  // Continua valendo tratar nome/mensagem como texto puro — a exibição no
  // painel escapa tudo (js/admin.js) e as queries são parametrizadas.
  db.createContactMessage({ nome, telefone, ocasiao, mensagem });

  // Best-effort, mesmo racional dos avisos de pedido pago (ver
  // runApprovedOrderSideEffects): a mensagem já está salva e visível no
  // painel antes daqui, então uma falha de SMTP nunca pode impedir a
  // cliente de saber que a mensagem foi enviada.
  try{
    await email.notifyOwnerOfContactMessage({ nome, telefone, ocasiao, mensagem });
  }catch(err){
    console.error("Falha ao enviar aviso de mensagem de contato por e-mail:", err.message || err);
  }

  res.json({ ok: true });
});

/* =========================================================================
   AUTENTICAÇÃO — /api/auth/*
   -------------------------------------------------------------------------
   Sessão por cookie httpOnly (ver server/auth.js para o porquê). O
   front-end nunca vê nem guarda uma senha ou token de sessão em
   localStorage/sessionStorage — só o cookie, que o navegador envia sozinho.
========================================================================= */
app.post("/api/auth/register", authLimiter, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const email = auth.normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");
    const cpf = auth.normalizeCpf(req.body?.cpf);

    if(!auth.isValidName(name)){
      return res.status(400).json({ error: "Informe seu nome completo." });
    }
    if(!auth.isValidEmail(email)){
      return res.status(400).json({ error: "E-mail inválido." });
    }
    if(!auth.isValidPassword(password)){
      return res.status(400).json({ error: "A senha precisa ter entre 8 e 72 caracteres." });
    }
    if(!auth.isValidCpf(cpf)){
      return res.status(400).json({ error: "CPF inválido — confira os números digitados." });
    }
    if(db.getUserByEmail(email)){
      return res.status(409).json({ error: "Já existe uma conta com este e-mail." });
    }

    const passwordHash = await auth.hashPassword(password);
    const user = db.createUser({ name, email, passwordHash, cpf });
    auth.issueSession(res, user.id);
    // isAdmin vai junto para o front saber para onde redirecionar sem
    // precisar de uma segunda chamada a /api/auth/me logo em seguida.
    res.status(201).json({ id: user.id, name: user.name, email: user.email, cpf: user.cpf, isAdmin: auth.isAdminEmail(user.email) });
  } catch (err) {
    console.error("Erro ao criar conta:", err);
    res.status(500).json({ error: "Não foi possível criar a conta agora. Tente novamente em instantes." });
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    // `emailAddress`, e não `email`: o módulo de envio importado no topo
    // deste arquivo também se chama `email`, e uma variável local com esse
    // nome o sombreia — foi o que quebrou o alerta de tentativas de login
    // aqui embaixo. Mesmo nome usado no forgot-password, logo adiante.
    const emailAddress = auth.normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");
    const ip = auth.clientIp(req);
    const genericError = () => res.status(401).json({ error: "E-mail ou senha inválidos." });

    if(!auth.isValidEmail(emailAddress) || !password){
      return genericError();
    }

    // Bloqueio ANTES de comparar a senha: se já estourou o limite, a senha
    // certa também não entra — senão o bloqueio não valeria de nada contra
    // quem finalmente acertasse na 6ª tentativa.
    const lockout = auth.checkLoginLockout(emailAddress, ip);
    if(lockout.locked){
      const minutos = Math.ceil(lockout.retryAfterMs / 60000);
      return res.status(429).json({
        error: `Muitas tentativas. Tente novamente em ${minutos} minuto${minutos === 1 ? "" : "s"}.`,
        lockedForMs: lockout.retryAfterMs,
      });
    }

    const user = db.getUserByEmail(emailAddress);
    // Sempre chama verifyPassword, mesmo sem usuário (compara contra um hash
    // de referência) — evita que o tempo de resposta revele se o e-mail existe.
    const ok = await auth.verifyPassword(password, user?.password_hash);
    if(!user || !ok){
      db.recordLoginAttempt({ email: emailAddress, ip, ok: false });
      // Avisa a lojista quando a conta DELA é o alvo e o limite estourou —
      // é a única forma de ela saber que alguém está tentando entrar, já
      // que o atacante nunca chega ao painel para deixar rastro visível.
      // Só no exato momento em que trava (=== LOGIN_MAX_FAILURES), senão
      // cada tentativa seguinte mandaria mais um e-mail.
      const depois = auth.checkLoginLockout(emailAddress, ip);
      if(depois.locked && depois.failures === auth.LOGIN_MAX_FAILURES && auth.isAdminEmail(emailAddress)){
        email.sendAdminLoginAlert({ email: emailAddress, ip, failures: depois.failures })
          .catch(err => console.error("Falha ao avisar sobre tentativas de login:", err.message));
      }
      return genericError();
    }

    // Senha certa, mas com 2FA ligado a sessão ainda NÃO é emitida: só um
    // desafio curto, trocado pelo cookie depois que o código conferir.
    if(user.totp_secret){
      const challengeToken = auth.issueTwoFactorChallenge(user.id);
      return res.json({ twoFactorRequired: true, challengeToken });
    }

    db.recordLoginAttempt({ email: emailAddress, ip, ok: true });
    auth.issueSession(res, user.id);
    res.json({ id: user.id, name: user.name, email: user.email, cep: user.cep || null, isAdmin: auth.isAdminEmail(user.email) });
  } catch (err) {
    console.error("Erro ao fazer login:", err);
    res.status(500).json({ error: "Não foi possível entrar agora. Tente novamente em instantes." });
  }
});

/* POST /api/auth/login/2fa — 2ª etapa: troca o desafio pelo cookie de sessão.
   Aceita o código de 6 dígitos do app OU um código de recuperação. */
app.post("/api/auth/login/2fa", authLimiter, async (req, res) => {
  try {
    const challengeToken = String(req.body?.challengeToken || "");
    const code = String(req.body?.code || "").trim();
    const userId = auth.peekTwoFactorChallenge(challengeToken);
    if(!userId){
      return res.status(401).json({ error: "Sessão expirada. Faça login novamente.", restart: true });
    }
    const user = db.getUserById(userId);
    if(!user?.totp_secret){
      auth.consumeTwoFactorChallenge(challengeToken);
      return res.status(401).json({ error: "Sessão expirada. Faça login novamente.", restart: true });
    }

    const ip = auth.clientIp(req);
    // O 2º fator tem o mesmo bloqueio do 1º: sem isso, seriam só 1 milhão de
    // combinações de 6 dígitos separando o atacante que já tem a senha.
    const lockout = auth.checkLoginLockout(user.email, ip);
    if(lockout.locked){
      const minutos = Math.ceil(lockout.retryAfterMs / 60000);
      return res.status(429).json({ error: `Muitas tentativas. Tente novamente em ${minutos} minuto${minutos === 1 ? "" : "s"}.` });
    }

    let ok = auth.verifyTotp(user.totp_secret, code);
    // Não conferiu como código do app: pode ser um dos de recuperação.
    if(!ok){
      const restantes = await auth.consumeRecoveryCode(code, JSON.parse(user.totp_recovery_json || "[]"));
      if(restantes){
        ok = true;
        db.setUserTotp(user.id, { secret: user.totp_secret, recoveryJson: JSON.stringify(restantes) });
      }
    }
    // Nem app nem recuperação: por último, tenta como o código mandado por
    // e-mail (POST /api/auth/login/2fa/email, abaixo) para este mesmo desafio.
    if(!ok){
      ok = await auth.verifyTwoFactorEmailCode(challengeToken, code);
    }

    if(!ok){
      db.recordLoginAttempt({ email: user.email, ip, ok: false });
      return res.status(401).json({ error: "Código inválido. Confira o app e tente de novo." });
    }

    auth.consumeTwoFactorChallenge(challengeToken);
    db.recordLoginAttempt({ email: user.email, ip, ok: true });
    auth.issueSession(res, user.id);
    res.json({ id: user.id, name: user.name, email: user.email, cep: user.cep || null, isAdmin: auth.isAdminEmail(user.email) });
  } catch (err) {
    console.error("Erro na verificação em duas etapas:", err);
    res.status(500).json({ error: "Não foi possível verificar o código agora." });
  }
});

/* =========================================================================
   POST /api/auth/login/2fa/email — pede um código de verificação por
   e-mail, para quem está no meio do login em duas etapas mas não tem o app
   autenticador nem um código de recuperação salvo. O código gerado aqui é
   verificado na MESMA rota de sempre (/api/auth/login/2fa, acima) — esta
   rota só cuida de gerar e mandar por e-mail.
========================================================================= */
app.post("/api/auth/login/2fa/email", authLimiter, async (req, res) => {
  try {
    const challengeToken = String(req.body?.challengeToken || "");
    const userId = auth.peekTwoFactorChallenge(challengeToken);
    if(!userId){
      return res.status(401).json({ error: "Sessão expirada. Faça login novamente.", restart: true });
    }
    const user = db.getUserById(userId);
    if(!user?.totp_secret){
      auth.consumeTwoFactorChallenge(challengeToken);
      return res.status(401).json({ error: "Sessão expirada. Faça login novamente.", restart: true });
    }

    // Mesmo bloqueio do login por senha/TOTP: uma conta já travada não
    // ganha uma via nova de bombardear a caixa de entrada com e-mails.
    const ip = auth.clientIp(req);
    const lockout = auth.checkLoginLockout(user.email, ip);
    if(lockout.locked){
      const minutos = Math.ceil(lockout.retryAfterMs / 60000);
      return res.status(429).json({ error: `Muitas tentativas. Tente novamente em ${minutos} minuto${minutos === 1 ? "" : "s"}.` });
    }

    const result = await auth.issueTwoFactorEmailCode(challengeToken);
    if(result.error === "expired"){
      return res.status(401).json({ error: "Sessão expirada. Faça login novamente.", restart: true });
    }
    if(result.error === "cooldown"){
      const segundos = Math.ceil(result.retryAfterMs / 1000);
      return res.status(429).json({ error: `Aguarde ${segundos} segundo${segundos === 1 ? "" : "s"} para pedir um novo código.` });
    }

    try{
      await email.sendTwoFactorEmailCode({
        to: result.user.email, name: result.user.name, code: result.code,
        expiresInMinutes: Math.round(auth.EMAIL_2FA_CODE_TTL_MS / 60000),
      });
    }catch(mailErr){
      console.error("Falha ao enviar código de verificação por e-mail:", mailErr.message);
      return res.status(502).json({ error: "Não foi possível enviar o e-mail agora. Tente novamente em instantes." });
    }

    res.json({ ok: true, message: "Enviamos um código para o e-mail da sua conta." });
  } catch (err) {
    console.error("Erro ao enviar código de verificação por e-mail:", err);
    res.status(500).json({ error: "Não foi possível enviar o e-mail agora." });
  }
});

app.post("/api/auth/logout", (req, res) => {
  auth.clearSession(req, res);
  res.json({ ok: true });
});

/* DELETE /api/auth/account — exclusão de conta pelo próprio titular (LGPD
   art. 18, direito à eliminação). Exige a senha atual: sem isso, uma sessão
   sequestrada ou um CSRF poderia apagar a conta. Apaga login/PII e anonimiza
   os pedidos, preservando o histórico financeiro (ver db.deleteUserAccount).
   É irreversível — o front confirma com o usuário antes de chamar. */
// authLimiter (não só o limitador genérico da API): esta rota confere
// senha, igual login/2FA/reset — sem o mesmo orçamento apertado, vira um
// oráculo de tentativa de senha com 500 tentativas/15min em vez de 10.
app.delete("/api/auth/account", authLimiter, auth.requireAuth, async (req, res) => {
  try {
    const password = req.body?.password;
    if (!password || typeof password !== "string") {
      return res.status(400).json({ error: "Confirme sua senha para excluir a conta." });
    }
    const user = db.getUserById(req.user.id);
    const ok = user && await auth.verifyPassword(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Senha incorreta." });
    }
    db.deleteUserAccount(req.user.id);
    auth.clearSession(req, res);
    res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao excluir conta:", err);
    res.status(500).json({ error: "Não foi possível excluir a conta agora. Tente novamente." });
  }
});

/* -------------------------------------------------------------------------
   REDEFINIÇÃO DE SENHA — "esqueci a senha"
   -------------------------------------------------------------------------
   Ponto central: a resposta é SEMPRE a mesma, exista ou não uma conta com
   o e-mail informado. Responder "e-mail não encontrado" transformaria esta
   rota num verificador de quem é cliente da loja (enumeração de contas) —
   é o mesmo motivo do erro genérico no login.
------------------------------------------------------------------------- */
app.post("/api/auth/forgot-password", authLimiter, async (req, res) => {
  // Declarada fora do try: mesma resposta no caminho feliz, no e-mail
  // inexistente e numa falha de envio.
  const genericOk = () => res.json({
    ok: true,
    message: "Se existir uma conta com esse e-mail, enviamos o link de redefinição.",
  });

  try {
    const emailAddress = auth.normalizeEmail(req.body?.email);
    if(!auth.isValidEmail(emailAddress)){
      return genericOk();
    }

    const user = db.getUserByEmail(emailAddress);
    if(!user){
      return genericOk();
    }

    const token = auth.issuePasswordReset(user.id);
    const resetUrl = `${CLIENT_ORIGIN}/redefinir-senha.html?token=${encodeURIComponent(token)}`;
    const expiresInMinutes = Math.round(auth.PASSWORD_RESET_TTL_MS / 60000);

    // Fire-and-forget (não espera o envio terminar antes de responder,
    // mesmo padrão de sendAdminLoginAlert acima): a resposta já era
    // idêntica para e-mail existente/inexistente, mas dar `await` aqui
    // fazia o TEMPO de resposta vazar a diferença — uma conta existente
    // esperava o round-trip real do SMTP, uma inexistente voltava na
    // hora. Isso reabria por timing a mesma enumeração que a resposta
    // igual foi desenhada para fechar.
    email.sendPasswordResetEmail({ to: user.email, name: user.name, resetUrl, expiresInMinutes })
      .catch(mailErr => {
        console.error("Falha ao enviar e-mail de redefinição de senha:", mailErr.message);
        // Só imprime o link em texto puro quando o SMTP nem está
        // configurado — é a única forma de testar o fluxo localmente
        // antes de preencher o .env. Com SMTP configurado (produção), uma
        // falha aqui é só uma instabilidade pontual, e não vale o risco
        // de um token de redefinição válido parar num log, que pode ter
        // acesso mais amplo que o próprio banco.
        if(!process.env.SMTP_HOST){
          console.warn(`[redefinição de senha] Link para ${user.email}: ${resetUrl}`);
        }
      });

    return genericOk();
  } catch (err) {
    console.error("Erro ao processar pedido de redefinição de senha:", err);
    return genericOk();
  }
});

app.post("/api/auth/reset-password", authLimiter, async (req, res) => {
  try {
    const token = String(req.body?.token || "");
    const password = String(req.body?.password || "");

    if(!auth.isValidPassword(password)){
      return res.status(400).json({ error: "A senha precisa ter entre 8 e 72 caracteres." });
    }

    const userId = auth.consumePasswordReset(token);
    if(!userId){
      return res.status(400).json({ error: "Este link de redefinição é inválido ou já expirou. Peça um novo." });
    }

    const passwordHash = await auth.hashPassword(password);
    db.updateUserPassword(userId, passwordHash);
    // Trocar a senha derruba todas as sessões: se alguém tinha entrado com a
    // senha antiga (o motivo provável de a cliente estar redefinindo), esse
    // acesso morre aqui. Inclui a sessão de quem está redefinindo — daí o
    // front mandar para a tela de login em seguida.
    db.deleteAllSessionsForUser(userId);
    auth.clearSession(req, res);

    res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao redefinir senha:", err);
    res.status(500).json({ error: "Não foi possível redefinir a senha agora. Tente novamente em instantes." });
  }
});

app.get("/api/auth/me", (req, res) => {
  if(!req.user) return res.status(401).json({ error: "Não autenticado." });
  res.json(req.user);
});

/* =========================================================================
   GET/PUT /api/auth/address — endereço de entrega padrão da conta
   -------------------------------------------------------------------------
   Sempre escopado a req.user.id (sessão), nunca a um id vindo do corpo/URL —
   mesmo padrão de DELETE /api/auth/account. Usado pelo carrinho para
   pré-preencher o formulário de endereço (GET, na primeira visita ao
   checkout) e para permitir editar o padrão fora do fluxo de compra (PUT).
   O PUT normal do checkout acontece direto em buildCheckoutDraft.
========================================================================= */
app.get("/api/auth/address", strictLimiter, auth.requireAuth, (req, res) => {
  res.json({ address: db.getSavedAddress(req.user.id) });
});

app.put("/api/auth/address", strictLimiter, auth.requireAuth, (req, res) => {
  const address = req.body?.address;
  if(!auth.isValidAddress(address)){
    return res.status(400).json({ error: "Endereço incompleto." });
  }
  const cep = auth.normalizeCep(address.cep);
  if(!auth.isValidCep(cep)){
    return res.status(400).json({ error: "CEP inválido — informe os 8 dígitos." });
  }
  db.saveAddress(req.user.id, { ...address, cep });
  res.json({ ok: true });
});

/* =========================================================================
   GET /api/orders — histórico de pedidos do usuário logado
   -------------------------------------------------------------------------
   Exige sessão (auth.requireAuth). Cada pedido é devolvido já com os nomes
   dos produtos resolvidos a partir de PRODUCTS (o banco só guarda id/qty),
   para o front-end não precisar reimplementar o catálogo.
========================================================================= */
app.get("/api/orders", auth.requireAuth, (req, res) => {
  try {
    const rows = db.listOrdersByUser(req.user.id);
    const overridesMap = getProductOverridesMap();
    const allColors = getAllColors();
    const orders = rows.map(row => {
      const items = JSON.parse(row.items_json).map(item => ({
        id: item.id, qty: item.qty,
        name: effectiveProduct(item.id, overridesMap)?.name || `Produto #${item.id}`,
        // Preço gravado no momento da compra (fallback ao catálogo atual só
        // para pedidos antigos, de antes dessa informação ser salva).
        unitPrice: item.price ?? effectiveProduct(item.id, overridesMap)?.price ?? null,
        // Cor real escolhida; pedidos antigos (de antes desta escolha
        // existir) caem no rótulo fixo por produto (colorLabelForItem).
        color: colorLabelForItem(item, allColors),
      }));
      const shipping = JSON.parse(row.shipping_json);
      return {
        reference: row.external_reference,
        status: row.status,
        fulfillmentStatus: row.fulfillment_status || null,
        shippedAt: row.shipped_at || null,
        deliveredAt: row.delivered_at || null,
        trackingCode: row.tracking_code || "",
        items,
        shipping: { name: shipping.name, deliveryTime: shipping.delivery_time },
        couponCode: row.coupon_code,
        subtotal: row.subtotal,
        discount: row.discount,
        pixDiscount: row.pix_discount || 0,
        paymentMethod: row.payment_method || "card",
        shippingPrice: row.shipping_price,
        total: row.total,
        createdAt: row.created_at,
      };
    });
    res.json({ orders });
  } catch (err) {
    console.error("Erro ao listar pedidos:", err);
    res.status(500).json({ error: "Não foi possível carregar seus pedidos agora." });
  }
});

/* =========================================================================
   PAINEL ADMINISTRATIVO — /api/admin/*  (ver admin.html / js/admin.js)
   -------------------------------------------------------------------------
   Exige sessão + e-mail com hash cadastrado em ADMIN_EMAIL_HASHES
   (auth.requireAdmin, ver server/auth.js). Diferente de /api/orders
   (cliente só vê os próprios pedidos), aqui devolve TODOS os pedidos com
   dados do cliente (nome, telefone, endereço de entrega) — por isso o
   controle de acesso é crítico: nunca relaxar para auth.requireAuth aqui.

   `noStore` abaixo evita que essas respostas (dados de cliente, preços)
   fiquem guardadas no cache do navegador/proxy — relevante em computador
   compartilhado, onde outra pessoa poderia usar "voltar" no histórico e
   ver a última resposta cacheada mesmo depois do logout.
========================================================================= */
function noStore(req, res, next){
  res.set("Cache-Control", "no-store, private");
  next();
}
app.use("/api/admin", noStore);

/* -------------------------------------------------------------------------
   VERIFICAÇÃO EM DUAS ETAPAS DO PAINEL — /api/admin/2fa/*
   -------------------------------------------------------------------------
   Estas três rotas passam só por requireAdmin, SEM o requireAdminTwoFactor
   que protege todo o resto — é o que permite a primeira ativação. Sem essa
   exceção o painel ficaria impossível de destravar: o cadastro do 2FA
   exigiria um 2FA já cadastrado.
------------------------------------------------------------------------- */

/* POST /api/admin/2fa/setup — gera o segredo e devolve o QR code.
   Ainda NÃO ativa: só depois de /activate, provando que o app já lê o
   código. Sem esse passo, um erro na leitura do QR trancaria o painel. */
app.post("/api/admin/2fa/setup", auth.requireAdmin, async (req, res) => {
  try {
    const secret = auth.generateTotpSecret();
    const uri = auth.totpAuthUri({ secret, email: req.user.email, issuer: "Adriana Melo Acessórios" });
    // Data URI: a CSP já libera `data:` em img-src, então nenhuma imagem
    // precisa ser gravada em disco nem servida por uma rota própria.
    const qrDataUri = await qrcode.toDataURL(uri, { margin: 1, width: 240 });
    res.json({ secret, qrDataUri });
  } catch (err) {
    console.error("Erro ao preparar 2FA:", err);
    res.status(500).json({ error: "Não foi possível preparar a verificação em duas etapas." });
  }
});

/* POST /api/admin/2fa/activate — confere o 1º código e liga de verdade.
   Devolve os códigos de recuperação em texto puro; é a ÚNICA vez que eles
   aparecem (no banco só ficam os hashes bcrypt). */
app.post("/api/admin/2fa/activate", auth.requireAdmin, async (req, res) => {
  try {
    const secret = String(req.body?.secret || "").trim().toUpperCase();
    const code = String(req.body?.code || "").trim();
    if(!/^[A-Z2-7]{32}$/.test(secret)){
      return res.status(400).json({ error: "Segredo inválido. Recarregue a página e tente de novo." });
    }
    // Se o 2FA JÁ está ativo, reativar (trocar de aparelho) exige a senha da
    // conta — sem isso, quem só sequestrou a sessão poderia reinscrever o 2FA
    // num aparelho próprio e queimar os códigos de recuperação, virando a
    // sessão temporária em posse permanente. Pedir a SENHA (e não o código
    // atual) fecha essa porta sem estragar a recuperação de aparelho perdido:
    // a lojista entra por código de recuperação/e-mail e ainda sabe a senha,
    // enquanto um sequestrador de sessão normalmente não.
    const usuarioAtual = db.getUserById(req.user.id);
    if(usuarioAtual?.totp_secret){
      const senha = req.body?.password;
      if(!senha || typeof senha !== "string" || !(await auth.verifyPassword(senha, usuarioAtual.password_hash))){
        return res.status(401).json({ error: "Confirme sua senha para trocar a verificação em duas etapas.", needsPassword: true });
      }
    }
    if(!auth.verifyTotp(secret, code)){
      return res.status(400).json({ error: "Código incorreto. Confira o app e tente de novo." });
    }
    const recoveryCodes = auth.generateRecoveryCodes();
    const hashes = await auth.hashRecoveryCodes(recoveryCodes);
    db.setUserTotp(req.user.id, { secret, recoveryJson: JSON.stringify(hashes) });
    // Ativar o 2FA derruba as outras sessões: se alguém já estava dentro com
    // a senha roubada, o 2FA novo não o expulsaria sozinho.
    db.deleteAllSessionsForUser(req.user.id);
    auth.issueSession(res, req.user.id);
    res.json({ ok: true, recoveryCodes });
  } catch (err) {
    console.error("Erro ao ativar 2FA:", err);
    res.status(500).json({ error: "Não foi possível ativar a verificação em duas etapas." });
  }
});

/* GET /api/admin/2fa/status — o painel usa para decidir entre mostrar a tela
   de cadastro ou o painel normal. */
app.get("/api/admin/2fa/status", auth.requireAdmin, (req, res) => {
  const user = db.getUserById(req.user.id);
  res.json({
    enabled: Boolean(user?.totp_secret),
    required: auth.ADMIN_2FA_REQUIRED,
    recoveryCodesLeft: JSON.parse(user?.totp_recovery_json || "[]").length,
  });
});

/* GET /api/admin/login-attempts — auditoria: quem tentou entrar, de onde,
   quando, e se conseguiu. Últimos 7 dias. */
app.get("/api/admin/login-attempts", auth.requireAdmin, auth.requireAdminTwoFactor, (req, res) => {
  try {
    // Limpeza oportunista na leitura (mesmo padrão de sessions/resets): sem
    // isso a tabela cresceria para sempre num banco de arquivo único.
    db.pruneLoginAttempts(90 * 24 * 60 * 60 * 1000);
    const rows = db.listRecentLoginAttempts({ sinceMs: 7 * 24 * 60 * 60 * 1000, limit: 200 });
    res.json(rows.map(r => ({ email: r.email, ip: r.ip, ok: Boolean(r.ok), at: r.created_at })));
  } catch (err) {
    console.error("Erro ao listar tentativas de login:", err);
    res.status(500).json({ error: "Não foi possível carregar as tentativas de login." });
  }
});

app.get("/api/admin/orders", auth.requireAdmin, auth.requireAdminTwoFactor, (req, res) => {
  try {
    const rows = db.listAllOrders();
    const overridesMap = getProductOverridesMap();
    const allColors = getAllColors();
    const orders = rows.map(row => {
      const items = JSON.parse(row.items_json).map(item => ({
        id: item.id, qty: item.qty,
        name: effectiveProduct(item.id, overridesMap)?.name || `Produto #${item.id}`,
        color: colorLabelForItem(item, allColors),
        unitPrice: item.price ?? effectiveProduct(item.id, overridesMap)?.price ?? null,
      }));
      const address = JSON.parse(row.address_json);
      const shipping = JSON.parse(row.shipping_json);
      const account = row.user_id ? db.getUserById(row.user_id) : null;
      return {
        reference: row.external_reference,
        status: row.status,
        items,
        customer: {
          nome: address?.nome || null,
          telefone: address?.telefone || null,
          cpf: address?.cpf || null,
          email: account?.email || null,
        },
        address,
        shipping: { name: shipping.name, deliveryTime: shipping.delivery_time },
        trackingCode: row.tracking_code || "",
        fulfillmentStatus: row.fulfillment_status || null,
        shippedAt: row.shipped_at || null,
        deliveredAt: row.delivered_at || null,
        subtotal: row.subtotal,
        discount: row.discount,
        pixDiscount: row.pix_discount || 0,
        paymentMethod: row.payment_method || "card",
        shippingPrice: row.shipping_price,
        total: row.total,
        createdAt: row.created_at,
      };
    });
    const stats = db.getOrderStats();
    res.json({ orders, stats: { totalRevenue: stats.revenue, totalOrders: stats.count } });
  } catch (err) {
    console.error("Erro ao listar pedidos (admin):", err);
    res.status(500).json({ error: "Não foi possível carregar os pedidos agora." });
  }
});

/* =========================================================================
   GET /api/admin/customers — quem já comprou, com histórico e total gasto
   -------------------------------------------------------------------------
   Agrupado em JS (e não em SQL) de propósito: o nome da cliente mora dentro
   do address_json e o e-mail vem da tabela users, então em SQL isso viraria
   json_extract + LEFT JOIN para uma loja que tem dezenas — não milhões — de
   pedidos. Ler `listAllOrders()` e agrupar aqui é mais simples de acompanhar
   e rápido o bastante nessa escala.

   A chave de agrupamento é a mesma do limite de cupom (conta OU telefone):
   quem comprou logada e depois sem entrar continua sendo a mesma pessoa.

   Faturamento só conta pedido 'pago' — carrinho abandonado não é receita.
========================================================================= */
app.get("/api/admin/customers", auth.requireAdmin, auth.requireAdminTwoFactor, (req, res) => {
  try {
    const byIdentity = new Map();

    for(const row of db.listAllOrders()){
      const address = JSON.parse(row.address_json);
      const account = row.user_id ? db.getUserById(row.user_id) : null;
      // Prefere a conta: um telefone pode ser digitado diferente a cada
      // compra, o id da conta não muda.
      const identity = row.user_id ? `conta:${row.user_id}` : `tel:${row.customer_phone || row.external_reference}`;

      let entry = byIdentity.get(identity);
      if(!entry){
        entry = {
          identity,
          nome: address?.nome || account?.name || "—",
          email: account?.email || null,
          telefone: address?.telefone || null,
          hasAccount: Boolean(row.user_id),
          totalOrders: 0,
          paidOrders: 0,
          totalSpent: 0,
          lastOrderAt: 0,
          orders: [],
        };
        byIdentity.set(identity, entry);
      }

      entry.totalOrders += 1;
      if(row.status === "pago"){
        entry.paidOrders += 1;
        entry.totalSpent += row.total;
      }
      // listAllOrders vem do mais recente para o mais antigo, então o
      // primeiro que chega já é o dado mais atual de nome/telefone.
      if(row.created_at > entry.lastOrderAt){
        entry.lastOrderAt = row.created_at;
        entry.nome = address?.nome || entry.nome;
        entry.telefone = address?.telefone || entry.telefone;
      }
      if(account?.email) entry.email = account.email;

      entry.orders.push({
        reference: row.external_reference,
        status: row.status,
        total: row.total,
        couponCode: row.coupon_code || null,
        createdAt: row.created_at,
      });
    }

    const customers = [...byIdentity.values()]
      .map(c => ({ ...c, totalSpent: Math.round(c.totalSpent * 100) / 100 }))
      .sort((a, b) => b.totalSpent - a.totalSpent);

    res.json({ customers });
  } catch (err) {
    console.error("Erro ao listar clientes (admin):", err);
    res.status(500).json({ error: "Não foi possível carregar os clientes agora." });
  }
});

/* GET /api/admin/leads — quem demonstrou interesse mas pode não ter comprado:
   inscritos na newsletter e mensagens do formulário de contato. */
app.get("/api/admin/leads", auth.requireAdmin, auth.requireAdminTwoFactor, (req, res) => {
  try {
    res.json({
      subscribers: db.listNewsletterSubscribers().map(s => ({
        email: s.email,
        createdAt: s.created_at,
      })),
      messages: db.listContactMessages().map(m => ({
        id: m.id,
        nome: m.nome,
        telefone: m.telefone,
        ocasiao: m.ocasiao || null,
        mensagem: m.mensagem,
        createdAt: m.created_at,
      })),
    });
  } catch (err) {
    console.error("Erro ao listar contatos (admin):", err);
    res.status(500).json({ error: "Não foi possível carregar os contatos agora." });
  }
});

/* GET /api/admin/export.xlsx — baixa toda a base da loja numa planilha Excel
   (uma aba por entidade: Usuários, Compras, Pagamentos, Endereços, Mensagens),
   para abrir no Excel ou importar no Google Sheets. É só leitura e passa pelo
   mesmo guarda das outras rotas admin (sessão + 2FA). A planilha nunca inclui
   hash de senha, segredo de 2FA nem dados de cartão (o site não recebe cartão;
   o Mercado Pago trata isso no lado deles). */
app.get("/api/admin/export.xlsx", auth.requireAdmin, auth.requireAdminTwoFactor, (req, res) => {
  try {
    const overridesMap = getProductOverridesMap();
    const buffer = spreadsheetExport.buildStoreWorkbook({
      resolveProductName: (id) => effectiveProduct(id, overridesMap)?.name || `Produto #${id}`,
    });
    // Data no nome do arquivo (fuso de Brasília) para diferenciar downloads.
    const stamp = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date()); // formato AAAA-MM-DD
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="adriana-melo-${stamp}.xlsx"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  } catch (err) {
    console.error("Erro ao gerar planilha de exportação (admin):", err);
    res.status(500).json({ error: "Não foi possível gerar a planilha agora." });
  }
});

/* DELETE /api/admin/contact-messages/:id — apaga uma mensagem do
   formulário "Vamos criar seu laço?" já respondida/lida. Sem checagem de
   status (diferente do DELETE de pedido): não é histórico financeiro,
   então não há "mensagem paga" que precise ficar protegida. */
app.delete("/api/admin/contact-messages/:id", auth.requireAdmin, auth.requireAdminTwoFactor, (req, res) => {
  try {
    const id = Number(req.params.id);
    if(!Number.isInteger(id) || !db.getContactMessage(id)){
      return res.status(404).json({ error: "Mensagem não encontrada." });
    }
    db.deleteContactMessage(id);
    res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao apagar mensagem de contato:", err);
    res.status(500).json({ error: "Não foi possível apagar a mensagem agora." });
  }
});

/* PATCH /api/admin/orders/:reference/tracking — salva o código de postagem/
   rastreio dos Correios para um pedido (preenchido à mão pela lojista). */
app.patch("/api/admin/orders/:reference/tracking", auth.requireAdmin, auth.requireAdminTwoFactor, (req, res) => {
  try {
    const reference = String(req.params.reference || "");
    const trackingCode = String(req.body?.trackingCode || "").trim().slice(0, 60);
    const order = db.getOrderByExternalReference(reference);
    if(!order){
      return res.status(404).json({ error: "Pedido não encontrado." });
    }
    db.updateOrderTracking(reference, trackingCode);
    res.json({ ok: true, trackingCode });

    /* Depois de responder, para a lojista não ficar esperando o SMTP. Regravar
       o MESMO pedido não reenvia — o índice único da fila barra. */
    entregarEmailDaFila(salvarRastreioEAvisar(reference, trackingCode)).catch(() => {});
  } catch (err) {
    console.error("Erro ao salvar código de rastreio:", err);
    res.status(500).json({ error: "Não foi possível salvar o código de rastreio agora." });
  }
});

/* PATCH /api/admin/orders/:reference/delivered — marca manualmente que a
   entrega chegou. Existe porque a resposta de rastreio do Melhor Envio
   (fetchLiveTracking) não tem formato de "entregue" confirmado — a lojista
   sempre pode fechar esse último passo à mão, do mesmo jeito que sempre
   pôde digitar o código de rastreio à mão. Só faz sentido depois de
   'postado' (não dá pra pular etapa da linha do tempo). */
app.patch("/api/admin/orders/:reference/delivered", auth.requireAdmin, auth.requireAdminTwoFactor, (req, res) => {
  try {
    const reference = String(req.params.reference || "");
    const order = db.getOrderByExternalReference(reference);
    if(!order){
      return res.status(404).json({ error: "Pedido não encontrado." });
    }
    if(order.fulfillment_status !== "postado"){
      return res.status(409).json({ error: "Só é possível marcar como entregue um pedido já postado." });
    }
    db.markOrderDelivered(reference);
    res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao marcar pedido como entregue:", err);
    res.status(500).json({ error: "Não foi possível marcar o pedido como entregue agora." });
  }
});

/* =========================================================================
   GET /api/instagram/feed — perfil + posts recentes do Instagram para a
   seção "nossa história" (js/instagram-feed.js). Rota pública, sem PII,
   sem rate limiter dedicado (mesmo tier de /api/products) — o próprio
   lib/instagram.js já cacheia e nunca deixa vazar o token de acesso.
========================================================================= */
app.get("/api/instagram/feed", async (req, res) => {
  try {
    const feed = await instagram.getInstagramFeed();
    res.json(feed);
  } catch (err) {
    console.error("[instagram] erro inesperado na rota /api/instagram/feed:", err);
    res.json({ available: false });
  }
});

/* =========================================================================
   POST /api/admin/instagram/reconnect
   -------------------------------------------------------------------------
   Botão "Reconectar" do painel. Existe porque trocar INSTAGRAM_ACCESS_TOKEN
   no .env (ou nas variáveis de ambiente do painel de hospedagem) sozinho
   NÃO tem efeito depois da primeira vez que o servidor rodou com um valor
   preenchido — o token vivo fica salvo no banco, e reescrever o .env não
   é olhado de novo até esse registro ser apagado. Esta rota apaga o
   registro e testa a conexão na hora, devolvendo a mensagem exata da
   Graph API (ex.: "Cannot parse access token") em vez de exigir acesso ao
   log do servidor para descobrir o motivo.
========================================================================= */
app.post("/api/admin/instagram/reconnect", auth.requireAdmin, async (req, res) => {
  instagram.resetToken();
  const resultado = await instagram.testConnection();
  res.json(resultado);
});

/* =========================================================================
   GET /api/products — catálogo público (nome/preço/foto já mesclando
   eventuais edições do painel administrativo). O front-end (js/main.js)
   busca isso para atualizar a vitrine sem precisar recarregar a página
   depois de uma edição — ver loadProductOverrides() em js/main.js.
========================================================================= */
app.get("/api/products", (req, res) => {
  const overridesMap = getProductOverridesMap();
  const products = getAllProductIds()
    .map(id => ({ id, p: effectiveProduct(id, overridesMap) }))
    .filter(({ p }) => !p.hidden)
    .map(({ id, p }) => ({ id, name: p.name, price: p.price, photoUrl: p.photoUrl, photos: p.photos, category: p.category, badges: p.badges, soldOut: p.soldOut, description: p.description }));
  // `paymentRules` viaja junto do catálogo (em vez de numa rota própria) para
  // não gastar mais uma das requisições do rate limit por carregamento de
  // página. A vitrine calcula os preços sozinha com o js/pricing.js que já
  // baixou — isto serve para ela CONFERIR se esse arquivo, que pode vir de
  // um cache de até 1h, ainda concorda com o que o servidor vai cobrar.
  // Ver loadProductOverrides() em js/main.js. `categories` viaja junto pelo
  // mesmo motivo: é o que permite a vitrine criar um chip de filtro para
  // uma categoria nova sem precisar editar index.html — ver
  // ensureCategoryChips() em js/main.js.
  res.json({ products, categories: getAllCategories(), paymentRules: pricing.PAYMENT_RULES });
});

/* =========================================================================
   GESTÃO DE PRODUTOS (painel administrativo) — /api/admin/products
   -------------------------------------------------------------------------
   Edita nome, preço, foto, categoria e selos de destaque ("Mais
   vendido"/"Novo") dos produtos que já existem em PRODUCTS (peso/dimensões
   continuam vindo só de lá, nunca editáveis pelo painel) e cria produtos
   novos do zero (POST, abaixo), guardados inteiros — peso/dimensões
   incluídos — em custom_products, já que não há PRODUCTS[id] para herdar.
========================================================================= */
app.get("/api/admin/products", auth.requireAdmin, auth.requireAdminTwoFactor, (req, res) => {
  const overridesMap = getProductOverridesMap();
  const products = getAllProductIds().map(id => {
    const p = effectiveProduct(id, overridesMap);
    return { id, name: p.name, price: p.price, photoUrl: p.photoUrl, photos: p.photos, category: p.category, badges: p.badges, description: p.description, hidden: p.hidden, soldOut: p.soldOut };
  });
  res.json({ products, categories: getAllCategories(), availableBadges: PRODUCT_BADGES });
});

/* =========================================================================
   PUT /api/admin/products/order — ordem dos produtos na vitrine
   -------------------------------------------------------------------------
   Recebe { ids: [...] } com TODOS os ids do catálogo, já na ordem desejada.
   Exigir a lista inteira (e não "mova o produto X para a posição 3") é o
   que torna a operação idempotente e livre de corrida: duas abas do painel
   salvando ao mesmo tempo produzem uma ordem completa e válida, nunca uma
   lista com posições duplicadas ou buracos.
========================================================================= */
app.put("/api/admin/products/order", auth.requireAdmin, auth.requireAdminTwoFactor, (req, res) => {
  try {
    const ids = req.body?.ids;
    if(!Array.isArray(ids) || ids.length === 0){
      return res.status(400).json({ error: "Envie a lista de produtos na ordem desejada." });
    }
    const numericIds = ids.map(Number);
    if(numericIds.some(id => !Number.isInteger(id))){
      return res.status(400).json({ error: "Lista de produtos inválida." });
    }
    if(new Set(numericIds).size !== numericIds.length){
      return res.status(400).json({ error: "Lista de produtos com itens repetidos." });
    }
    // A lista precisa bater EXATAMENTE com o catálogo atual. Se um produto
    // foi criado ou excluído em outra aba desde que esta tela carregou, a
    // ordem enviada está velha — gravar assim deixaria o produto novo sem
    // posição ou apontaria para um que não existe mais.
    const atuais = getAllProductIds();
    const mesmoConjunto = numericIds.length === atuais.length
      && numericIds.every(id => atuais.includes(id));
    if(!mesmoConjunto){
      return res.status(409).json({ error: "A lista de produtos mudou. Recarregue a página e ordene de novo." });
    }

    const customIds = numericIds.filter(id => id >= CUSTOM_PRODUCT_ID_START);
    db.setProductsOrder(numericIds, customIds);
    res.json({ ok: true, ids: getAllProductIds() });
  } catch (err) {
    console.error("Erro ao salvar a ordem dos produtos:", err);
    res.status(500).json({ error: "Não foi possível salvar a ordem agora." });
  }
});

function isValidProductPrice(v){
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v < 100000;
}
// Formato antigo (de antes das fotos passarem a ser gravadas no banco) —
// mantido só para não rejeitar um PATCH vindo de uma aba do admin ainda
// aberta com esse formato em cache; nenhum upload novo gera mais isto.
const LOCAL_UPLOAD_PATTERN = /^\/img\/products\/produto-\d+-\d+\.(jpe?g|png|webp|gif)$/;
// Formato atual, devolvido por POST /api/admin/products/:id/photo — um
// UUID apontando para uma linha da tabela product_photos (lib/db.js),
// servida por GET /api/products/photos/:id, abaixo.
const PHOTO_ROUTE_PATTERN = /^\/api\/products\/photos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Aceita vazio (remove a foto customizada, volta para o padrão calculado no
// front-end a partir do nome), uma URL http(s) (link colado à mão) ou um
// caminho de upload (gerado por POST /api/admin/products/:id/photo,
// abaixo, atual ou antigo) — nunca javascript:/data: etc., que não fazem
// sentido como <img src> de um formulário.
function isValidPhotoUrl(v){
  if(!v) return true;
  if(typeof v !== "string" || v.length > 2000) return false;
  if(LOCAL_UPLOAD_PATTERN.test(v) || PHOTO_ROUTE_PATTERN.test(v)) return true;
  try{
    const parsed = new URL(v);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  }catch{
    return false;
  }
}
function isValidBadges(v){
  if(!Array.isArray(v)) return false;
  if(v.length > PRODUCT_BADGES.length) return false;
  return v.every(b => PRODUCT_BADGES.includes(b)) && new Set(v).size === v.length;
}
// Galeria de fotos: array vazio é um estado real ("removeu todas as fotos"),
// mesmo racional das outras listas. Teto de 8 fotos por produto — generoso
// para uma loja de acessórios, protege contra payload/lista sem limite.
// Cada item passa pela MESMA validação de photoUrl (URL http(s) ou caminho
// de upload local), sem duplicata.
const MAX_PRODUCT_PHOTOS = 8;
function isValidPhotos(v){
  if(!Array.isArray(v)) return false;
  if(v.length > MAX_PRODUCT_PHOTOS) return false;
  return v.every(url => typeof url === "string" && url && isValidPhotoUrl(url)) && new Set(v).size === v.length;
}
// true tanto para um id do catálogo fixo (PRODUCTS) quanto para um criado
// pelo painel (custom_products) — o único "existe?" que PATCH/upload de
// foto/exclusão precisam, sem se importar de onde o produto veio.
function productExists(id){
  if(!Number.isInteger(id)) return false;
  return id >= CUSTOM_PRODUCT_ID_START ? Boolean(db.getCustomProduct(id)) : Boolean(PRODUCTS[id]);
}
// Peso em kg, dimensões em cm — mesma unidade de PRODUCTS. O teto de 20kg/
// 100cm não é uma regra de frete real, é só uma rede de segurança contra
// erro de digitação (ex.: "200" em vez de "20") que sairia caríssimo na
// cotação antes de alguém notar.
function isValidDimension(v, max){
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= max;
}

/* =========================================================================
   POST /api/admin/products — cria um produto do zero
   -------------------------------------------------------------------------
   Diferente do PATCH abaixo (que edita um produto que já existe), esta
   rota recebe o produto INTEIRO — inclusive peso/dimensões, que para os 8
   produtos fixos vêm só de PRODUCTS e nunca são editáveis por aqui, mas
   para um produto novo não têm de onde herdar. A foto entra depois, pelo
   fluxo de sempre (POST .../:id/photo + PATCH), porque o upload de foto
   exige um id que só existe depois deste POST responder.
========================================================================= */
app.post("/api/admin/products", auth.requireAdmin, auth.requireAdminTwoFactor, (req, res) => {
  try {
    const body = req.body || {};

    const name = String(body.name || "").trim();
    if(name.length < 2 || name.length > 120){
      return res.status(400).json({ error: "Nome precisa ter entre 2 e 120 caracteres." });
    }
    const price = Number(body.price);
    if(!isValidProductPrice(price)){
      return res.status(400).json({ error: "Preço inválido. Use um valor entre R$ 0,01 e R$ 99.999,99." });
    }
    const weight = Number(body.weight);
    if(!isValidDimension(weight, 20)){
      return res.status(400).json({ error: "Peso inválido. Use um valor entre 0,01 e 20 kg." });
    }
    const width = Number(body.width);
    const height = Number(body.height);
    const length = Number(body.length);
    if(![width, height, length].every(v => isValidDimension(v, 100))){
      return res.status(400).json({ error: "Dimensões inválidas. Use valores entre 0,01 e 100 cm." });
    }
    const category = body.category ? String(body.category).trim() : "";
    if(category && !isValidCategorySlug(category)){
      return res.status(400).json({ error: "Categoria inválida." });
    }
    const badges = "badges" in body ? body.badges : [];
    if(!isValidBadges(badges)){
      return res.status(400).json({ error: "Selo de destaque inválido." });
    }
    const description = body.description ? String(body.description).trim() : "";
    if(description.length > 500){
      return res.status(400).json({ error: "Descrição muito longa (máximo 500 caracteres)." });
    }

    const created = db.insertCustomProduct({
      startAt: CUSTOM_PRODUCT_ID_START, name, price: Math.round(price * 100) / 100,
      weight, width, height, length, category: category || null, badges, description: description || null,
    });
    res.status(201).json({
      id: created.id, name: created.name, price: created.price, photoUrl: null, photos: [],
      category: created.category, badges: created.badges ? JSON.parse(created.badges) : [],
      description: created.description || null,
    });
  } catch (err) {
    console.error("Erro ao criar produto:", err);
    res.status(500).json({ error: "Não foi possível criar o produto agora." });
  }
});

/* =========================================================================
   PATCH /api/admin/products/:id
   -------------------------------------------------------------------------
   Parcial de verdade: só valida/grava os campos que vieram no corpo da
   requisição (checados com `"campo" in req.body`, não truthiness — um
   valor vazio de propósito, como apagar a URL da foto, ainda precisa ser
   distinguível de "campo não enviado"). O painel manda só o que a lojista
   realmente mudou naquele clique em "Salvar" (ver js/admin.js), em vez do
   produto inteiro a cada edição — menos payload, e elimina o risco de um
   campo antigo em cache no navegador sobrescrever por acidente uma edição
   mais recente feita em outra aba.
========================================================================= */
app.patch("/api/admin/products/:id", auth.requireAdmin, auth.requireAdminTwoFactor, (req, res) => {
  try {
    const id = Number(req.params.id);
    if(!productExists(id)){
      return res.status(404).json({ error: "Produto não encontrado." });
    }

    const body = req.body || {};
    const fields = {};

    if("name" in body){
      const name = String(body.name || "").trim();
      if(name.length < 2 || name.length > 120){
        return res.status(400).json({ error: "Nome precisa ter entre 2 e 120 caracteres." });
      }
      fields.name = name;
    }
    if("price" in body){
      const price = Number(body.price);
      if(!isValidProductPrice(price)){
        return res.status(400).json({ error: "Preço inválido. Use um valor entre R$ 0,01 e R$ 99.999,99." });
      }
      fields.price = Math.round(price * 100) / 100;
    }
    if("photoUrl" in body){
      const photoUrl = body.photoUrl ? String(body.photoUrl).trim() : "";
      if(!isValidPhotoUrl(photoUrl)){
        return res.status(400).json({ error: "URL da foto inválida. Use um link http(s) ou deixe em branco." });
      }
      const previousPhotoUrl = effectiveProduct(id, getProductOverridesMap())?.photoUrl;
      if(previousPhotoUrl && previousPhotoUrl !== (photoUrl || null)){
        deleteOldLocalPhoto(previousPhotoUrl);
      }
      fields.photoUrl = photoUrl || null;
    }
    if("category" in body){
      const category = body.category ? String(body.category).trim() : "";
      if(category && !isValidCategorySlug(category)){
        return res.status(400).json({ error: "Categoria inválida." });
      }
      fields.category = category || null;
    }
    if("badges" in body){
      if(!isValidBadges(body.badges)){
        return res.status(400).json({ error: "Selo de destaque inválido." });
      }
      fields.badges = body.badges;
    }
    if("photos" in body){
      if(!isValidPhotos(body.photos)){
        return res.status(400).json({ error: `Lista de fotos inválida. Envie até ${MAX_PRODUCT_PHOTOS} fotos, sem repetir.` });
      }
      // Qualquer foto que saiu da lista (reordenar não conta — só remoção de
      // verdade) e aponta para um upload nosso é apagada do disco, melhor
      // esforço, mesmo racional de deleteOldLocalPhoto ao trocar a foto
      // única antiga — sem isso, img/products/ só cresce.
      const previousPhotos = effectiveProduct(id, getProductOverridesMap())?.photos || [];
      const nextPhotosSet = new Set(body.photos);
      for(const oldUrl of previousPhotos){
        if(!nextPhotosSet.has(oldUrl)) deleteOldLocalPhoto(oldUrl);
      }
      fields.photos = body.photos;
    }
    if("description" in body){
      const description = body.description ? String(body.description).trim() : "";
      if(description.length > 500){
        return res.status(400).json({ error: "Descrição muito longa (máximo 500 caracteres)." });
      }
      fields.description = description || null;
    }
    if("hidden" in body){
      fields.hidden = Boolean(body.hidden);
    }
    if("soldOut" in body){
      fields.soldOut = Boolean(body.soldOut);
    }

    if(Object.keys(fields).length === 0){
      return res.status(400).json({ error: "Nada para salvar." });
    }

    if(id >= CUSTOM_PRODUCT_ID_START) db.updateCustomProduct(id, fields);
    else db.upsertProductOverride(id, fields);

    const updated = effectiveProduct(id, getProductOverridesMap());
    res.json({ id, name: updated.name, price: updated.price, photoUrl: updated.photoUrl, photos: updated.photos, category: updated.category, badges: updated.badges, description: updated.description, hidden: updated.hidden, soldOut: updated.soldOut });
  } catch (err) {
    console.error("Erro ao atualizar produto:", err);
    res.status(500).json({ error: "Não foi possível salvar o produto agora." });
  }
});

/* =========================================================================
   DELETE /api/admin/products/:id
   -------------------------------------------------------------------------
   Só apaga produto criado pelo painel (id >= CUSTOM_PRODUCT_ID_START,
   guardado em custom_products) — os 8 do catálogo fixo (PRODUCTS) são
   código-fonte, não uma linha de banco: não existe "apagar" um valor que
   está em server.js sem editar o arquivo. Um pedido antigo que referencia
   este id continua abrindo normalmente: effectiveProduct() devolve null
   para ele, e cada lugar que mostra o item (e-mail, painel, etiqueta) já
   trata isso com um "Produto #<id>" de reserva, em vez de quebrar.
========================================================================= */
app.delete("/api/admin/products/:id", auth.requireAdmin, auth.requireAdminTwoFactor, (req, res) => {
  try {
    const id = Number(req.params.id);
    if(!Number.isInteger(id) || id < CUSTOM_PRODUCT_ID_START){
      return res.status(400).json({
        error: "Este produto faz parte do catálogo fixo e não pode ser excluído — edite-o ou peça para removê-lo do código.",
      });
    }
    const product = db.getCustomProduct(id);
    if(!product){
      return res.status(404).json({ error: "Produto não encontrado." });
    }
    deleteOldLocalPhoto(product.photo_url);
    db.deleteCustomProduct(id);
    res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao apagar produto:", err);
    res.status(500).json({ error: "Não foi possível apagar o produto agora." });
  }
});

/* =========================================================================
   POST /api/admin/products/:id/photo — upload de arquivo
   -------------------------------------------------------------------------
   Rota separada do PATCH acima de propósito: o corpo aqui é
   multipart/form-data (um arquivo), não JSON, então precisa de um parser
   diferente (multer) — misturar os dois no mesmo handler exigiria detectar
   o Content-Type manualmente e complicaria a rota que já funciona bem para
   os outros campos. Só GRAVA o arquivo e devolve o caminho; quem decide
   "salvar isso no produto" continua sendo o PATCH de sempre (ver
   js/admin.js: o caminho devolvido aqui vira o valor de `photoUrl` no
   próximo clique em "Salvar alterações", passando pelo mesmo payload
   compacto e pela mesma validação de sempre) — assim um upload feito e
   depois descartado (lojista fecha o modal sem salvar) nunca deixa o
   produto apontando para uma foto indevida.
========================================================================= */
app.post("/api/admin/products/:id/photo", auth.requireAdmin, auth.requireAdminTwoFactor, (req, res) => {
  const id = Number(req.params.id);
  if(!productExists(id)){
    return res.status(404).json({ error: "Produto não encontrado." });
  }
  productPhotoUpload.single("photo")(req, res, async (err) => {
    if(err instanceof multer.MulterError){
      if(err.code === "LIMIT_FILE_SIZE"){
        return res.status(413).json({ error: "Imagem muito grande. O limite é 4MB." });
      }
      return res.status(400).json({ error: "Não foi possível enviar a imagem." });
    }
    if(err){
      console.error("Erro no upload de foto:", err);
      return res.status(500).json({ error: "Não foi possível enviar a imagem agora." });
    }
    if(!req.file){
      return res.status(400).json({ error: "Envie um arquivo de imagem (JPEG, PNG, WEBP ou GIF)." });
    }
    try{
      // rotate() sem argumento reorienta pela EXIF (uma foto tirada com o
      // celular de lado não fica deitada na vitrine); resize().fit:"inside"
      // nunca estica a imagem, só limita o maior lado; sempre reencodada
      // para JPEG — produto de loja de acessórios é sempre fundo opaco, não
      // há necessidade real de transparência aqui (quem quiser um PNG com
      // transparência ainda pode colar uma URL externa em vez de enviar
      // arquivo).
      const compressed = await sharp(req.file.buffer)
        .rotate()
        .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80, mozjpeg: true })
        .toBuffer();
      const photoId = randomUUID();
      db.insertProductPhoto(photoId, "image/jpeg", compressed);
      res.status(201).json({ photoUrl: `/api/products/photos/${photoId}` });
    }catch(procErr){
      console.error("Erro ao processar imagem de produto:", procErr);
      res.status(500).json({ error: "Não foi possível processar a imagem enviada." });
    }
  });
});

/* =========================================================================
   GET /api/products/photos/:id — serve o BLOB gravado em product_photos.
   -------------------------------------------------------------------------
   Pública (sem auth), como qualquer outra imagem de produto hoje — a
   vitrine é pública. Cache-Control "immutable" é seguro aqui porque um id
   nunca é reescrito: um novo upload sempre grava uma linha nova, então o
   conteúdo por trás de uma URL já emitida jamais muda.

   ⚠️ Sem ?w= a resposta é o original byte a byte: é essa URL que fica gravada
   no banco, que PHOTO_ROUTE_PATTERN valida e que lib/emailPhotos.js procura no
   HTML dos e-mails.
========================================================================= */
// ⚠️ Lista fixa: largura livre deixaria qualquer visitante encher o banco de
// variantes. 160 = miniatura do carrinho; 400/600 = card; 900 = Quick View.
const LARGURAS_DE_FOTO = new Set([160, 400, 600, 900]);

app.get("/api/products/photos/:id", async (req, res) => {
  if(!PHOTO_ROUTE_PATTERN.test(`/api/products/photos/${req.params.id}`)){
    return res.status(404).end();
  }

  const pedida = Number(req.query.w);
  const largura = LARGURAS_DE_FOTO.has(pedida) ? pedida : null;

  // Só WebP: AVIF pouparia mais uns 8 KB por 275ms de CPU (medido), caro
  // demais para gerar sob demanda num host compartilhado.
  const querWebp = /\bimage\/webp\b/.test(req.headers.accept || "");
  const formato = querWebp ? "webp" : "jpeg";

  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

  if(!largura){
    const photo = db.getProductPhoto(req.params.id);
    if(!photo) return res.status(404).end();
    res.setHeader("Content-Type", photo.mime_type);
    return res.end(Buffer.from(photo.data));
  }

  // res.vary() e não setHeader("Vary"): o compression() já pode ter escrito
  // "Accept-Encoding" aí, e sobrescrever quebraria o cache dele.
  res.vary("Accept");

  const emCache = db.getProductPhotoVariant(req.params.id, largura, formato);
  if(emCache){
    res.setHeader("Content-Type", emCache.mime_type);
    return res.end(Buffer.from(emCache.data));
  }

  const photo = db.getProductPhoto(req.params.id);
  if(!photo) return res.status(404).end();

  try{
    const mime = formato === "webp" ? "image/webp" : "image/jpeg";
    let pipeline = sharp(Buffer.from(photo.data))
      .resize({ width: largura, withoutEnlargement: true });
    pipeline = formato === "webp"
      ? pipeline.webp({ quality: 72 })
      : pipeline.jpeg({ quality: 78, mozjpeg: true });
    const reduzida = await pipeline.toBuffer();

    db.saveProductPhotoVariant(req.params.id, largura, formato, mime, reduzida);
    res.setHeader("Content-Type", mime);
    res.end(reduzida);
  }catch(err){
    // Reduzir é otimização, não requisito: servir o original é melhor do que
    // deixar a vitrine com buraco no lugar da imagem.
    console.error(`Falha ao reduzir a foto ${req.params.id} para ${largura}px:`, err.message || err);
    res.setHeader("Content-Type", photo.mime_type);
    res.end(Buffer.from(photo.data));
  }
});

/* Slug curto e sem acento a partir do texto digitado — o mesmo formato dos
   5 slugs fixos ("dia-a-dia"), porque é isso que vai para o data-cat dos
   chips de filtro e para PRODUCT.category no banco. */
function slugifyCategory(label){
  return label
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/* =========================================================================
   POST /api/admin/categories — cria uma categoria além das 5 fixas
   -------------------------------------------------------------------------
   Só grava slug + label (custom_categories); o produto continua guardando
   category como o slug, do mesmo jeito que já fazia para as 5 fixas — o
   resto do sistema (filtro da vitrine, validação de PATCH/POST de produto)
   não precisa saber a categoria é "fixa" ou "criada pelo painel".
========================================================================= */
app.post("/api/admin/categories", auth.requireAdmin, auth.requireAdminTwoFactor, (req, res) => {
  try {
    const label = String(req.body?.label || "").trim();
    if(label.length < 2 || label.length > 40){
      return res.status(400).json({ error: "Nome da categoria precisa ter entre 2 e 40 caracteres." });
    }
    const slug = slugifyCategory(label);
    if(!slug){
      return res.status(400).json({ error: "Nome da categoria inválido." });
    }
    if(isValidCategorySlug(slug)){
      return res.status(409).json({ error: "Já existe uma categoria parecida com essa." });
    }
    const created = db.insertCustomCategory({ slug, label });
    res.status(201).json({ ...created, builtin: false });
  } catch (err) {
    console.error("Erro ao criar categoria:", err);
    res.status(500).json({ error: "Não foi possível criar a categoria agora." });
  }
});

/* =========================================================================
   PATCH /api/admin/categories/:slug — renomeia uma categoria criada pelo
   painel. Só o rótulo muda; o slug (o que fica gravado em
   product_overrides.category/custom_products.category) continua o mesmo,
   então nenhum produto precisa ser tocado.
   -------------------------------------------------------------------------
   Categoria fixa (BUILTIN_CATEGORIES) não pode ser renomeada aqui: ela vive
   em código (server.js), não no banco — mudar o rótulo exigiria editar
   BUILTIN_CATEGORIES e reiniciar o servidor, então não faz sentido pelo
   painel.
========================================================================= */
app.patch("/api/admin/categories/:slug", auth.requireAdmin, auth.requireAdminTwoFactor, (req, res) => {
  try {
    const slug = String(req.params.slug || "");
    const isCustom = db.listCustomCategories().some(c => c.slug === slug);
    if(!isCustom){
      if(PRODUCT_CATEGORIES.includes(slug)){
        return res.status(400).json({ error: "Categorias fixas do catálogo não podem ser renomeadas por aqui." });
      }
      return res.status(404).json({ error: "Categoria não encontrada." });
    }
    const label = String(req.body?.label || "").trim();
    if(label.length < 2 || label.length > 40){
      return res.status(400).json({ error: "Nome da categoria precisa ter entre 2 e 40 caracteres." });
    }
    db.updateCustomCategoryLabel(slug, label);
    res.json({ slug, label });
  } catch (err) {
    console.error("Erro ao renomear categoria:", err);
    res.status(500).json({ error: "Não foi possível renomear a categoria agora." });
  }
});

/* =========================================================================
   DELETE /api/admin/categories/:slug — apaga uma categoria criada pelo
   painel. Bloqueada se algum produto (fixo com override ou criado pelo
   painel) ainda usa esse slug — apagar a categoria sem mudar o produto
   deixaria category apontando para um rótulo que não existe mais.
========================================================================= */
app.delete("/api/admin/categories/:slug", auth.requireAdmin, auth.requireAdminTwoFactor, (req, res) => {
  try {
    const slug = String(req.params.slug || "");
    const isCustom = db.listCustomCategories().some(c => c.slug === slug);
    if(!isCustom){
      if(PRODUCT_CATEGORIES.includes(slug)){
        return res.status(400).json({ error: "Categorias fixas do catálogo não podem ser excluídas por aqui." });
      }
      return res.status(404).json({ error: "Categoria não encontrada." });
    }
    const emUso = db.countProductsUsingCategory(slug);
    if(emUso > 0){
      return res.status(409).json({
        error: `${emUso} produto${emUso === 1 ? "" : "s"} ainda usa${emUso === 1 ? "" : "m"} essa categoria — mude a categoria del${emUso === 1 ? "e" : "es"} antes de excluir.`,
      });
    }
    db.deleteCustomCategory(slug);
    res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao excluir categoria:", err);
    res.status(500).json({ error: "Não foi possível excluir a categoria agora." });
  }
});


/* DELETE /api/admin/orders/:reference — apaga um pedido (carrinho
   abandonado, teste, etc.). NUNCA apaga um pedido "pago": isso é
   histórico financeiro do pedido, não um "carrinho" — remover um pago de
   verdade tem que ser uma decisão manual direta no banco, não um clique
   no painel. */
app.delete("/api/admin/orders/:reference", auth.requireAdmin, auth.requireAdminTwoFactor, (req, res) => {
  try {
    const reference = String(req.params.reference || "");
    const order = db.getOrderByExternalReference(reference);
    if(!order){
      return res.status(404).json({ error: "Pedido não encontrado." });
    }
    if(order.status === "pago"){
      return res.status(409).json({ error: "Pedidos pagos não podem ser apagados — é o histórico financeiro do pedido." });
    }
    db.deleteOrder(reference);
    res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao apagar pedido:", err);
    res.status(500).json({ error: "Não foi possível apagar o pedido agora." });
  }
});

/* =========================================================================
   GESTÃO DE CUPONS (painel administrativo) — /api/admin/coupons
   -------------------------------------------------------------------------
   Cria/lista/apaga cupons de desconto percentual. findCoupon() (usado no
   checkout de verdade) lê da mesma tabela — um cupom criado aqui já vale
   pro cliente no próximo checkout, sem precisar reiniciar o servidor.
========================================================================= */
app.get("/api/admin/coupons", auth.requireAdmin, auth.requireAdminTwoFactor, (req, res) => {
  try {
    const coupons = db.listCoupons().map(c => ({
      code: c.code, percentOff: c.percent_off, description: c.description, createdAt: c.created_at,
    }));
    res.json({ coupons });
  } catch (err) {
    console.error("Erro ao listar cupons:", err);
    res.status(500).json({ error: "Não foi possível carregar os cupons agora." });
  }
});

app.post("/api/admin/coupons", auth.requireAdmin, auth.requireAdminTwoFactor, (req, res) => {
  try {
    const code = String(req.body?.code || "").trim().toUpperCase().replace(/\s+/g, "");
    const percentOff = Number(req.body?.percentOff);
    const description = String(req.body?.description || "").trim().slice(0, 200);

    if(!/^[A-Z0-9]{3,20}$/.test(code)){
      return res.status(400).json({ error: "Código precisa ter de 3 a 20 letras/números, sem espaço." });
    }
    if(!Number.isFinite(percentOff) || percentOff <= 0 || percentOff > 90){
      return res.status(400).json({ error: "Desconto precisa ser um número entre 1 e 90 (%)." });
    }
    if(db.getCoupon(code)){
      return res.status(409).json({ error: "Já existe um cupom com esse código." });
    }

    const created = db.createCoupon({ code, percentOff, description });
    res.status(201).json({
      code: created.code, percentOff: created.percent_off, description: created.description, createdAt: created.created_at,
    });
  } catch (err) {
    console.error("Erro ao criar cupom:", err);
    res.status(500).json({ error: "Não foi possível criar o cupom agora." });
  }
});

// Parcial (mesmo padrão de PATCH /api/admin/products/:id): só percentOff/
// description são aceitos — code não muda (ver comentário em
// db.updateCoupon sobre por que renomear não é uma opção aqui).
app.patch("/api/admin/coupons/:code", auth.requireAdmin, auth.requireAdminTwoFactor, (req, res) => {
  try {
    const code = String(req.params.code || "").trim().toUpperCase();
    if(!db.getCoupon(code)){
      return res.status(404).json({ error: "Cupom não encontrado." });
    }

    const fields = {};
    if("percentOff" in req.body){
      const percentOff = Number(req.body.percentOff);
      if(!Number.isFinite(percentOff) || percentOff <= 0 || percentOff > 90){
        return res.status(400).json({ error: "Desconto precisa ser um número entre 1 e 90 (%)." });
      }
      fields.percentOff = percentOff;
    }
    if("description" in req.body){
      fields.description = String(req.body.description || "").trim().slice(0, 200);
    }

    const updated = db.updateCoupon(code, fields);
    res.json({
      code: updated.code, percentOff: updated.percent_off, description: updated.description, createdAt: updated.created_at,
    });
  } catch (err) {
    console.error("Erro ao editar cupom:", err);
    res.status(500).json({ error: "Não foi possível editar o cupom agora." });
  }
});

app.delete("/api/admin/coupons/:code", auth.requireAdmin, auth.requireAdminTwoFactor, (req, res) => {
  try {
    const code = String(req.params.code || "").trim().toUpperCase();
    if(!db.getCoupon(code)){
      return res.status(404).json({ error: "Cupom não encontrado." });
    }
    db.deleteCoupon(code);
    res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao apagar cupom:", err);
    res.status(500).json({ error: "Não foi possível apagar o cupom agora." });
  }
});

/* POST /api/admin/orders/:reference/generate-label — compra a etiqueta de
   envio no Melhor Envio para este pedido (ação manual, sob demanda —
   diferente de AUTO_PURCHASE_SHIPPING_LABEL, que é automático via
   webhook). ⚠️ Gasta saldo real da conta Melhor Envio: só funciona para
   pedido já pago, e é sempre a lojista quem decide clicar, pedido por
   pedido (nunca automático a partir daqui). */
app.post("/api/admin/orders/:reference/generate-label", auth.requireAdmin, auth.requireAdminTwoFactor, async (req, res) => {
  const reference = String(req.params.reference || "");
  try {
    const orderRow = db.getOrderByExternalReference(reference);
    if(!orderRow){
      return res.status(404).json({ error: "Pedido não encontrado." });
    }
    if(orderRow.status !== "pago"){
      return res.status(409).json({ error: "Só é possível gerar etiqueta para pedidos pagos." });
    }

    const order = {
      items: JSON.parse(orderRow.items_json),
      address: JSON.parse(orderRow.address_json),
      shipping: JSON.parse(orderRow.shipping_json),
    };
    const generated = await purchaseShippingLabel(order, reference);
    const trackingCode = generated?.[0]?.tracking || generated?.tracking || null;
    if(trackingCode){
      // Antes gravava direto no banco e a cliente não ficava sabendo.
      entregarEmailDaFila(salvarRastreioEAvisar(reference, trackingCode)).catch(() => {});
    }
    res.json({ ok: true, trackingCode, raw: generated });
  } catch (err) {
    console.error(`Erro ao gerar etiqueta para o pedido ${reference}:`, err);
    // Diferente de /api/calculate-shipping (rota pública, onde o erro cru do
    // Melhor Envio só confundiria a cliente): aqui quem chama é sempre a
    // lojista logada como admin, então a mensagem de verdade (ex.: "saldo
    // insuficiente", "documento do remetente inválido") é o que ajuda a
    // corrigir — esconder isso só faria ela adivinhar olhando o log do
    // servidor. err.data?.errors vem preenchido nos erros de validação da
    // API deles (um campo por linha, ex.: "from.document").
    const detail = err?.data?.errors
      ? Object.values(err.data.errors).flat().join(" ")
      : err?.message;
    res.status(502).json({
      error: detail
        ? `Não foi possível gerar a etiqueta: ${detail}`
        : "Não foi possível gerar a etiqueta agora. Confira as credenciais do Melhor Envio ou gere manualmente no painel deles.",
    });
  }
});

// Sobra daqui quem passou pela allowlist acima (então é um caminho dentro de
// css/js/img ou /api) mas não bateu com nenhum arquivo real do
// express.static nem com nenhuma rota da API — ex.: /css/arquivo-que-nao-
// existe.css ou /api/rota-que-nao-existe.
app.use(sendNotFound);

/* =========================================================================
   TRATAMENTO DE ERRO — última camada (tem que vir DEPOIS de tudo)
   -------------------------------------------------------------------------
   Sem isto, um erro não capturado (ex.: corpo JSON malformado, que o
   express.json rejeita antes de chegar em qualquer rota) cai no handler
   padrão do Express, que devolve uma página HTML com o STACK TRACE
   completo — caminhos absolutos do servidor, nome de usuário do sistema,
   versões das bibliotecas. Isso é entrega de informação para um atacante.

   Aqui o stack vai só para o log do servidor (onde a lojista/dev vê), e o
   cliente recebe uma resposta genérica: JSON para /api/*, texto para o
   resto. Assinatura de 4 argumentos (err primeiro) é o que faz o Express
   reconhecer isto como error handler.
========================================================================= */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Corpo malformado é erro do cliente (400), não falha do servidor (500) —
  // e não merece nem entrar no log como se fosse um bug.
  const isBadJson = err.type === "entity.parse.failed" || err instanceof SyntaxError;
  const status = isBadJson ? 400 : (err.status || err.statusCode || 500);

  if(!isBadJson){
    console.error("Erro não tratado:", err);
  }
  // Resposta já iniciada (raro): delega ao Express fechar a conexão.
  if(res.headersSent) return next(err);

  const message = isBadJson
    ? "Requisição malformada."
    : "Erro interno. Tente novamente em instantes.";

  if(req.path.startsWith("/api/")){
    return res.status(status).json({ error: message });
  }
  return res.status(status).type("text/plain").send(message);
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});