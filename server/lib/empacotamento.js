/**
 * =============================================================================
 *  EMPACOTAMENTO — como o pedido vira UMA caixa para cotar frete
 * =============================================================================
 *  Fica fora do server.js para poder ser testado sem subir o servidor nem
 *  chamar o Melhor Envio. Isso não é preciosismo: a regra de empacotamento
 *  já cobrou frete errado em produção sem ninguém perceber (ver
 *  CATEGORIAS_FORA_DA_CAIXA), justamente por não ter teste.
 * =============================================================================
 */

/* A lojista posta TUDO junto, numa caixa só — o TAMANHO dela nunca muda com
   a quantidade, mas o PESO nunca é fixo: é a embalagem em si (caixa + papel)
   mais ~20g por peça, da primeira em diante. Calibrado com o dado dela — 8
   laços pesam uns 200g — então a embalagem sozinha é 200g − 8×20g = 40g. */
const CAIXA_PADRAO = { weight: 0.2, width: 16, height: 7, length: 20 };
const PESO_EMBALAGEM_KG = 0.04;
const PESO_LACO_KG = 0.02;

/* ⚠️ Categorias que NÃO cabem na caixinha padrão e viajam ocupando espaço
   próprio. Tudo o que não estiver aqui divide a mesma caixa.

   O padrão é "divide a caixa" de propósito, e o motivo é uma regressão real:
   antes a regra era `id < 1000` (catálogo fixo = laço, painel = volume
   próprio). Fazia sentido quando o painel só tinha a bolsa, mas a lojista
   cadastrou o catálogo inteiro por ali — 41 dos 47 produtos, quase todos
   laços. Cada laço passou a ser empilhado como um pacote separado e o frete
   dobrou (R$12 → R$29 no mesmo CEP) até uma cliente reclamar. Com a lista
   invertida, uma categoria nova de laço nasce empacotando certo; só o que é
   realmente volumoso precisa ser declarado aqui. */
const CATEGORIAS_FORA_DA_CAIXA = new Set(["cabide"]);

/* A escolha feita no cadastro ("padrao" | "maior") manda. Só produto
   criado antes dessa opção existir (caixa NULL) cai na regra por categoria. */
const CAIXAS = new Set(["padrao", "maior"]);

function vaiNaCaixaPadrao(product) {
  if (product.caixa === "maior") return false;
  if (product.caixa === "padrao") return true;
  return !CATEGORIAS_FORA_DA_CAIXA.has(String(product.category || "").trim());
}

/**
 * ⚠️ O peso gravado no catálogo é ignorado de propósito para quem vai na
 * caixinha. O formulário do painel nasceu com 0,2kg pré-preenchido (o peso
 * da CAIXA CHEIA, não de uma peça) e a lojista confirmou ter deixado esse
 * valor na maioria dos 41 produtos que cadastrou — usar o valor gravado
 * cobraria 10x o peso real de cada laço. A conta calibrada por ela vale mais
 * que um campo que nunca foi preenchido de verdade.
 *
 * Quem está FORA da caixa continua somando peso e altura por unidade: se vier
 * junto com a caixinha, as duas se empilham (altura soma, peso soma,
 * largura/comprimento ficam com o maior dos dois).
 */
function buildPackage(validatedItems) {
  let width = 0, length = 0, insurance = 0;
  let qtdNaCaixa = 0;
  let pesoForaDaCaixa = 0, alturaForaDaCaixa = 0;

  for (const { qty, product } of validatedItems) {
    insurance += product.price * qty;

    if (vaiNaCaixaPadrao(product)) {
      qtdNaCaixa += qty;
    } else {
      width = Math.max(width, product.width);
      length = Math.max(length, product.length);
      pesoForaDaCaixa += product.weight * qty;
      alturaForaDaCaixa += product.height * qty;
    }
  }

  const pesoDaCaixaPadrao = qtdNaCaixa > 0
    ? PESO_EMBALAGEM_KG + qtdNaCaixa * PESO_LACO_KG
    : 0;
  const alturaTotal = (qtdNaCaixa > 0 ? CAIXA_PADRAO.height : 0) + alturaForaDaCaixa;

  return {
    weight: pesoDaCaixaPadrao + pesoForaDaCaixa,
    width: Math.max(width, CAIXA_PADRAO.width),
    length: Math.max(length, CAIXA_PADRAO.length),
    height: Math.max(alturaTotal, CAIXA_PADRAO.height),
    insurance_value: Math.round(insurance * 100) / 100,
  };
}

module.exports = {
  CAIXA_PADRAO,
  PESO_EMBALAGEM_KG,
  PESO_LACO_KG,
  CATEGORIAS_FORA_DA_CAIXA,
  CAIXAS,
  vaiNaCaixaPadrao,
  buildPackage,
};
