/**
 * =============================================================================
 *  AVISO DE WHATSAPP PARA A LOJISTA — Petit Laço / Adriana Melo Acessórios
 * =============================================================================
 *  Dispara uma mensagem de WhatsApp para o número da loja sempre que um
 *  pagamento é aprovado (chamado pelo webhook do Mercado Pago em server.js).
 *
 *  Usa a WhatsApp Cloud API oficial da Meta (https://developers.facebook.com/
 *  docs/whatsapp/cloud-api) via fetch nativo — mesma abordagem "sem SDK" já
 *  usada para o Melhor Envio (função meFetch em server.js), para não
 *  adicionar nenhuma dependência nova ao projeto. Troque
 *  `sendWhatsAppMessage` por outro provedor (Z-API, Evolution API, Twilio)
 *  se preferir — é a única função que fala com a rede; o resto (formatação
 *  da mensagem, chamada pelo webhook) não muda.
 *
 *  🔑 Credenciais (ver server/.env.example):
 *    WHATSAPP_CLOUD_API_TOKEN — token de acesso do app da Meta (System User
 *    token permanente, gerado em business.facebook.com > Configurações do
 *    negócio > Usuários do sistema — um token temporário de 24h também
 *    funciona para testar).
 *    WHATSAPP_CLOUD_PHONE_NUMBER_ID — Phone Number ID do número do
 *    WhatsApp Business que vai ENVIAR o aviso (developers.facebook.com >
 *    seu app > WhatsApp > Introdução).
 *    WHATSAPP_CLOUD_API_VERSION — versão da Graph API (opcional; default
 *    "v21.0" se não definida).
 *    OWNER_WHATSAPP_NUMBER — número que deve RECEBER o aviso (o da própria
 *    loja), só dígitos com DDI+DDD (ex.: 5561982749808).
 *
 *  ⚠️ Diferença importante em relação a provedores não-oficiais (Z-API/
 *  Evolution API): a API oficial da Meta só entrega mensagem de texto
 *  livre para números que enviaram uma mensagem à sua conta do WhatsApp
 *  Business nas últimas 24h ("janela de atendimento"). Fora dessa janela,
 *  a Meta exige um "message template" pré-aprovado. Para este aviso
 *  funcionar de forma confiável, a lojista precisa mandar uma mensagem
 *  qualquer para o número do WhatsApp Business pelo menos uma vez por dia
 *  (ou crie/aprove um template de notificação em vez de texto livre).
 *
 *  Criar/verificar o app da Meta, o WhatsApp Business Account e o número
 *  de telefone (e gerar o token) exige login e verificação de identidade
 *  no Meta Business Manager — isso só pode ser feito pela própria dona da
 *  loja, nunca por este assistente.
 *
 *  Se as credenciais não estiverem configuradas, ou se a Cloud API falhar,
 *  isso NUNCA deve derrubar a confirmação do pedido: quem chama
 *  `notifyOwnerOfPaidOrder` (server.js) sempre envolve a chamada em
 *  try/catch, do mesmo jeito que já é feito para a compra automática da
 *  etiqueta de envio.
 * =============================================================================
 */

const { colorLabelForItem, formatCurrency, formatOrderDateTime, deliveryLineFor } = require("./orderFormatting");

/**
 * Monta o texto da notificação a partir de um pedido já resolvido (itens
 * com nome/quantidade, endereço, total, data do pagamento). Função pura —
 * sem chamada de rede — para ser fácil de testar/ajustar isoladamente.
 */
function formatOrderMessage({ externalReference, items, address, total, paidAt, allColors }) {
  const itemLines = items
    .map(item => `• ${item.qty}x ${item.name} — cor: ${colorLabelForItem(item, allColors)}`)
    .join("\n");

  const deliveryLine = deliveryLineFor(address);

  return [
    "🎀 *Novo pedido pago!*",
    `Pedido: ${externalReference}`,
    `Data/hora: ${formatOrderDateTime(paidAt)}`,
    "",
    "Itens:",
    itemLines,
    "",
    `Total: ${formatCurrency(total)}`,
    "",
    `Cliente: ${address?.nome || "-"}`,
    `Telefone: ${address?.telefone || "-"}`,
    `CPF: ${address?.cpf || "-"}`,
    `Entrega: ${deliveryLine || "-"}`,
  ].join("\n");
}

/**
 * Envia `message` para `toNumber` via WhatsApp Cloud API oficial da Meta
 * (POST /{PHONE_NUMBER_ID}/messages, autenticado por Bearer token). Lança
 * erro se as credenciais não estiverem configuradas ou se a API responder
 * com falha — quem chama decide o que fazer com isso (server.js sempre
 * envolve em try/catch).
 */
async function sendWhatsAppMessage(toNumber, message) {
  const { WHATSAPP_CLOUD_API_TOKEN, WHATSAPP_CLOUD_PHONE_NUMBER_ID, WHATSAPP_CLOUD_API_VERSION } = process.env;
  if (!WHATSAPP_CLOUD_API_TOKEN || !WHATSAPP_CLOUD_PHONE_NUMBER_ID) {
    throw new Error("WhatsApp Cloud API não configurada (WHATSAPP_CLOUD_API_TOKEN/WHATSAPP_CLOUD_PHONE_NUMBER_ID ausentes no .env).");
  }
  const phone = String(toNumber || "").replace(/\D/g, "");
  if (!phone) {
    throw new Error("Número de WhatsApp de destino ausente/inválido (OWNER_WHATSAPP_NUMBER no .env).");
  }

  const apiVersion = WHATSAPP_CLOUD_API_VERSION || "v21.0";
  const url = `https://graph.facebook.com/${apiVersion}/${WHATSAPP_CLOUD_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${WHATSAPP_CLOUD_API_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body: message, preview_url: false },
    }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    throw new Error(data?.error?.message || `WhatsApp Cloud API respondeu ${res.status}`);
  }
  return data;
}

/**
 * Ponto de entrada chamado pelo webhook quando um pagamento é aprovado:
 * formata a mensagem e envia para o número da lojista (OWNER_WHATSAPP_NUMBER).
 * Propaga erro (não engole) — quem chama decide como logar/isolar a falha,
 * igual ao padrão já usado em purchaseShippingLabel.
 */
async function notifyOwnerOfPaidOrder(order) {
  const ownerNumber = process.env.OWNER_WHATSAPP_NUMBER;
  if (!ownerNumber) {
    throw new Error("OWNER_WHATSAPP_NUMBER não configurado no .env — aviso não enviado.");
  }
  const message = formatOrderMessage(order);
  await sendWhatsAppMessage(ownerNumber, message);
}

module.exports = { formatOrderMessage, sendWhatsAppMessage, notifyOwnerOfPaidOrder };
