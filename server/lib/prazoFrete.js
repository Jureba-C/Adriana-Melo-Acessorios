/* Prazo de entrega de uma cotação do Melhor Envio, em texto para a cliente
   e em número para o sistema.

   custom_* vem primeiro: é o prazo JÁ com os dias extras que a lojista
   configurou no painel do Melhor Envio (a doc manda usar o custom quando
   existir). Por isso, quando custom > original, `extra` diz quantos dias o
   painel está somando — se a cliente acha o prazo longo, é lá que se ajusta.

   delivery_range/custom_delivery_range são dias úteis e trazem a faixa
   real da transportadora ("2 a 3 dias úteis"), mais honesta que só o
   máximo. O número guardado no pedido (`dias`) é o MAIOR da faixa: é o
   que o cron usa para decidir quando perguntar "seu pedido chegou?". */

function numero(v){
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function faixa(r){
  const min = numero(r?.min);
  const max = numero(r?.max);
  if(!min && !max) return null;
  return { min: min || max, max: Math.max(min || 0, max || 0) };
}

function textoDoPrazo(min, max){
  if(!max) return "prazo a confirmar";
  if(min && min < max) return `${min} a ${max} dias úteis`;
  return max === 1 ? "1 dia útil" : `${max} dias úteis`;
}

function prazoDaCotacao(q){
  const custom = faixa(q?.custom_delivery_range);
  const original = faixa(q?.delivery_range);
  const customUnico = numero(q?.custom_delivery_time);
  const originalUnico = numero(q?.delivery_time);

  const escolhida = custom || (customUnico ? { min: customUnico, max: customUnico } : null)
    || original || (originalUnico ? { min: originalUnico, max: originalUnico } : null);

  const maxCustom = custom?.max || customUnico;
  const maxOriginal = original?.max || originalUnico;
  const extra = maxCustom && maxOriginal && maxCustom > maxOriginal ? maxCustom - maxOriginal : 0;

  return {
    texto: textoDoPrazo(escolhida?.min, escolhida?.max),
    dias: escolhida?.max || null,
    extra,
  };
}

/* Dias de um frete já gravado no pedido. Pedidos novos têm delivery_days;
   os antigos só têm o texto ("4 dia(s) útil(eis)", "2 a 3 dias úteis") —
   Number() nesse texto dava NaN e o "seu pedido chegou?" caía sempre no
   padrão de 7 dias. Pega o maior número do texto. */
function diasDoFrete(shipping){
  const direto = numero(shipping?.delivery_days);
  if(direto) return direto;
  if(typeof shipping?.delivery_time === "number") return numero(shipping.delivery_time);
  const nums = String(shipping?.delivery_time || "").match(/\d+/g);
  return nums ? Math.max(...nums.map(Number)) : null;
}

module.exports = { prazoDaCotacao, diasDoFrete, textoDoPrazo };
