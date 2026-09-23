/**
 * CATÁLOGO — a fonte da verdade de nome, preço, peso e dimensões.
 *
 * Morava dentro do server.js, mas passou a ser necessário FORA do processo
 * web: o cron (scripts/tarefas-periodicas.js) monta o e-mail de carrinho
 * esquecido e o de campanha, e os dois precisam do nome e da foto de cada
 * laço. Enquanto isso vivia só no server.js, o cron não tinha como saber o
 * nome — o e-mail de carrinho esquecido saiu listando "undefined" — e a
 * campanha contornava fazendo uma requisição HTTP para o próprio site, que
 * falha em silêncio e manda a campanha sem os produtos escolhidos.
 *
 * ⚠️ Nada aqui pode depender do Express nem de `req`: este arquivo roda
 * tanto dentro do servidor quanto num processo de linha de comando.
 */
const db = require("./db.js");

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
const { CAIXA_PADRAO, buildPackage } = require("./empacotamento.js");
const PRODUCTS = {
  1: { name:"Laço Bailarina",        price:34.90, ...CAIXA_PADRAO, category:"laco-unico",  badges:[] },
  2: { name:"Laço Duquesa",          price:49.90, ...CAIXA_PADRAO, category:"laco-unico",  badges:["Mais vendido"] },
  3: { name:"Laço Recém-nascida",    price:29.90, ...CAIXA_PADRAO, category:"laco-unico",  badges:[] },
  4: { name:"Laço Pérola",           price:59.90, ...CAIXA_PADRAO, category:"laco-unico",  badges:[] },
  5: { name:"Laço Borboleta",        price:44.90, ...CAIXA_PADRAO, category:"laco-unico",  badges:[] },
  6: { name:"Kit Presente 3 Laços",  price:89.90, ...CAIXA_PADRAO, category:"kit",         badges:["Novo"] },
  7: { name:"Laço Tiara Flor",       price:39.90, ...CAIXA_PADRAO, category:"tiara",       badges:[] },
  8: { name:"Laço Personalizado",    price:64.90, ...CAIXA_PADRAO, category:"laco-unico",  badges:["Novo"] },
};

/* Categorias fixas — precisam ficar em sincronia com os chips de filtro em
   index.html (data-cat). getAllCategories() (abaixo) soma estas com as
   criadas pelo painel ("+ Nova categoria"), guardadas em custom_categories;
   PRODUCT_CATEGORIES continua existindo só com os slugs fixos porque é
   contra ela que product_overrides valida uma categoria vinda do painel
   antes de somar as dinâmicas — ver isValidCategory, mais abaixo.

   ⚠️ Aqui é POR TIPO DE PRODUTO, não por ocasião. Antes eram Maternidade,
   Festa, Batizado, Dia a dia e Presente — e o resultado é que 28 dos 47
   produtos caíram todos em "maternidade": um mesmo laço é de festa E de
   batizado, então quem cadastra escolhe um e o resto vai para o genérico.
   Tipo é excludente (ou é tiara, ou é bolsa) e está escrito no nome de todo
   produto, o que também deixa a reclassificação automática funcionar. */
const BUILTIN_CATEGORIES = [
  { slug: "laco-unico",  label: "Laço Único" },
  { slug: "parzinho",    label: "Parzinho" },
  { slug: "laco-g",      label: "Laço G" },
  { slug: "laco-pompom", label: "Laço Pompom" },
  { slug: "tiara",       label: "Tiara" },
  { slug: "kit",         label: "Kit" },
  { slug: "bolsa",       label: "Bolsa" },
  { slug: "cabide",      label: "Cabide" },
];
const PRODUCT_CATEGORIES = BUILTIN_CATEGORIES.map(c => c.slug);
const PRODUCT_BADGES = ["Mais vendido", "Novo"];

/* Produtos criados pelo painel ("+ Adicionar produto") recebem id a partir
   daqui — os ids 1-8 (PRODUCTS acima) nunca mudam, então não há colisão
   possível mesmo que o catálogo fixo cresça um pouco no futuro. */
const CUSTOM_PRODUCT_ID_START = 1000;

/* Categorias do modelo antigo, por ocasião. Saíram de BUILTIN_CATEGORIES na
   virada para tipo de produto, mas continuam listadas ENQUANTO houver produto
   usando: sem isso os produtos ainda não reclassificados ficam sem chip de
   filtro e o card passa a exibir o slug cru ("maternidade") no lugar do
   rótulo, porque categoryLabelFor() em js/main.js descobre o rótulo lendo o
   texto do chip. Somem sozinhas quando o último produto sair delas — não é
   preciso apagar nada à mão. */
const CATEGORIAS_APOSENTADAS = [
  { slug: "maternidade",   label: "Maternidade" },
  { slug: "festa",         label: "Festa" },
  { slug: "batizado",      label: "Batizado" },
  { slug: "dia-a-dia",     label: "Dia a dia" },
  { slug: "presente",      label: "Presente" },
  { slug: "recem-nascido", label: "Recém Nascido" },
];

function categoriasEmUso(){
  const overridesMap = getProductOverridesMap();
  const usadas = new Set();
  for (const id of getAllProductIds()) {
    const cat = effectiveProduct(id, overridesMap).category;
    if (cat) usadas.add(cat);
  }
  return usadas;
}

function getAllCategories(){
  const usadas = categoriasEmUso();
  const lista = [
    ...BUILTIN_CATEGORIES.map(c => ({ ...c, builtin: true })),
    ...db.listCustomCategories().map(c => ({ slug: c.slug, label: c.label, builtin: false })),
    ...CATEGORIAS_APOSENTADAS
      .filter(c => usadas.has(c.slug))
      .map(c => ({ ...c, builtin: true, aposentada: true })),
  ];
  /* Deduplica por slug: o detector automático do painel já criou categorias
     custom com o mesmo slug de fixas ("tiara", "kit", "bolsa"...), e a lista
     saía com entradas repetidas. A primeira ocorrência vence, então a fixa
     tem prioridade sobre a custom homônima. */
  const vistos = new Set();
  return lista.filter(c => (vistos.has(c.slug) ? false : vistos.add(c.slug)));
}
function isValidCategorySlug(slug){
  return getAllCategories().some(c => c.slug === slug);
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

module.exports = {
  CAIXA_PADRAO,
  buildPackage,
  PRODUCTS,
  BUILTIN_CATEGORIES,
  PRODUCT_CATEGORIES,
  PRODUCT_BADGES,
  CUSTOM_PRODUCT_ID_START,
  CATEGORIAS_APOSENTADAS,
  categoriasEmUso,
  getAllCategories,
  isValidCategorySlug,
  getProductOverridesMap,
  getAllProductIds,
  photosFromRow,
  effectiveProduct,
};
