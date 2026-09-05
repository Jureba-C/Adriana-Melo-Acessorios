/**
 * =============================================================================
 *  E-MAIL PARA A LOJISTA — Petit Laço / Adriana Melo Acessórios
 * =============================================================================
 *  Envia um e-mail para a lojista sempre que um pagamento é aprovado
 *  (chamado pelo webhook do Mercado Pago em server.js), com o resumo do
 *  pedido e um link direto para o pedido no painel administrativo
 *  (admin.html — ver server/server.js e admin.html/js/admin.js).
 *
 *  Usa Nodemailer com SMTP genérico — funciona com Gmail (o endereço que
 *  recebe o aviso hoje é @gmail.com) ou qualquer outro provedor SMTP
 *  (SendGrid, Mailgun, etc.), sem depender de um serviço específico.
 *
 *  🔑 Credenciais (ver server/.env.example):
 *    SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS — conta
 *    que vai ENVIAR o e-mail. Para usar uma conta Gmail como remetente:
 *    host smtp.gmail.com, porta 587, secure=false, e SMTP_PASS precisa ser
 *    uma "senha de app" (myaccount.google.com/apppasswords — exige
 *    verificação em duas etapas ativada na conta; a senha normal da conta
 *    NÃO funciona aqui).
 *    SMTP_FROM — remetente exibido (opcional; usa SMTP_USER se vazio).
 *    OWNER_EMAIL — endereço que RECEBE o aviso.
 *
 *  Se as credenciais não estiverem configuradas, ou se o envio falhar, isso
 *  NUNCA deve derrubar a confirmação do pedido: quem chama
 *  `notifyOwnerOfPaidOrder` (server.js) sempre envolve a chamada em
 *  try/catch, do mesmo jeito que já é feito para o aviso de WhatsApp e
 *  para a compra automática da etiqueta de envio.
 * =============================================================================
 */
const nodemailer = require("nodemailer");
const path = require("path");
const { colorLabelForItem, formatCurrency, formatOrderDateTime, deliveryLineFor } = require("./orderFormatting");

// Logo embutida como anexo inline (Content-ID) em vez de <img src> apontando
// pra URL remota: e-mail nenhum carrega imagem remota sozinho — todo cliente
// (Gmail, Outlook...) esconde a imagem até a pessoa clicar em "exibir
// imagens", e a logo é a primeira coisa que aparece no e-mail, então não dá
// pra depender desse clique. CID sempre renderiza de cara, sem esse aviso.
const LOGO_CID = "logo-adriana-melo";
const LOGO_PATH = path.join(__dirname, "..", "img", "logo-adriana-melo-6e53bc.png");

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

/* =========================================================================
   MOLDE COMPARTILHADO — cabeçalho (logo) + cartão branco + rodapé
   -------------------------------------------------------------------------
   Os 4 e-mails do site (pedido pago, redefinir senha, contato, cupom de
   boas-vindas) usam a mesma moldura visual — só o miolo muda. Um molde só
   garante que os 4 fiquem sempre iguais entre si e que uma mudança de
   marca (cor, logo, rodapé) se aplique a todos de uma vez.

   Tudo em <table> com estilo inline: é o que sobrevive ao motor de
   renderização do Outlook desktop (baseado no Word — não entende
   <div>/flex/grid nem <style> no <head>). Cores replicam os tokens de
   css/style.css (--blush-*, --ink, --cream) em hex direto, porque
   variável CSS não existe fora de um navegador.

   Fontes: Fraunces (título) e Poppins (corpo) não podem ser carregadas por
   @font-face aqui — a maioria dos clientes de e-mail bloqueia fonte
   externa — então cada uma cai numa pilha de fontes do sistema com a
   mesma "família" visual (serifada / geométrica). O script Caveat nem
   tenta: itálico serifado já passa o "escrito à mão" sem depender de
   fonte nenhuma.

   Logo: SVG com <use>/<symbol> (como no site) não renderiza em e-mail —
   por isso é a logo em PNG já hospedada (mesma imagem do cabeçalho do
   site), sempre por URL absoluta, porque não existe "origem" dentro de
   um cliente de e-mail. */
const FONT_TITULO = "Georgia, 'Times New Roman', serif";
const FONT_CORPO = "'Segoe UI', Helvetica, Arial, sans-serif";

function emailShell({ titulo, preheader, eyebrow, tituloCartao, corpoHtml }) {
  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHTML(titulo)}</title>
</head>
<body style="margin:0; padding:0; background:#FFFDFC;">
  <!-- Pré-cabeçalho: texto que aparece ao lado do assunto na caixa de entrada, escondido no corpo do e-mail. -->
  <div style="display:none; max-height:0; overflow:hidden; opacity:0;">
    ${escapeHTML(preheader)}
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFFDFC;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">

          <!-- Cabeçalho: logo sobre o rosa mais claro, mesmo tom do topo da home -->
          <tr>
            <td align="center" style="background:#FBDCE8; border-radius:24px 24px 0 0; padding:28px 24px 22px;">
              <img src="cid:${LOGO_CID}" alt="Adriana Melo Acessórios" width="150" style="display:block; border:0;">
            </td>
          </tr>

          <!-- Cartão principal -->
          <tr>
            <td style="background:#FFFFFF; border-radius:0 0 24px 24px; padding:36px 32px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="font-family:${FONT_TITULO}; font-style:italic; color:#C05480; font-size:15px; padding-bottom:6px;">
                    ${escapeHTML(eyebrow)}
                  </td>
                </tr>
                <tr>
                  <td align="center" style="font-family:${FONT_TITULO}; color:#54293C; font-size:26px; line-height:1.3; font-weight:bold; padding-bottom:14px;">
                    ${tituloCartao}
                  </td>
                </tr>
                ${corpoHtml}
              </table>
            </td>
          </tr>

          <!-- Rodapé -->
          <tr>
            <td align="center" style="font-family:${FONT_CORPO}; color:#8C6577; font-size:12px; line-height:1.7; padding:22px 24px 0;">
              Adriana Melo Acessórios — ateliê artesanal de laços, feitos à mão em Brasília/DF.<br>
              Dúvidas? Responda este e-mail ou fale pelo
              <a href="https://wa.me/5561982749808" style="color:#C05480; text-decoration:none;">WhatsApp</a>.
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

// Botão de ação (pílula, blush-600) — reaproveitado pelos 4 e-mails.
function botaoEmail(href, rotulo){
  return `
    <tr>
      <td align="center" style="padding-bottom:8px;">
        <table role="presentation" cellpadding="0" cellspacing="0">
          <tr>
            <td align="center" style="background:#DD6E9B; border-radius:999px;">
              <a href="${escapeHTML(href)}" style="display:inline-block; font-family:${FONT_CORPO}; font-size:15px; font-weight:600; color:#FFFFFF; text-decoration:none; padding:13px 32px;">
                ${escapeHTML(rotulo)}
              </a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `;
}

/* Miniatura do produto ao lado do nome, nos dois e-mails de pedido.
   `photoUrl` tem TRÊS formas possíveis (ver effectiveProduct em server.js):

     /api/products/photos/<uuid>  -> anexo cid:, sempre visível
     https://... (colado à mão)   -> <img> remoto; o Gmail mostra, o Outlook
                                     bloqueia e sobra o quadrado rosa
     null                          -> laço 🎀 sobre o quadrado rosa

   O caso null é o COMUM, não a exceção: todo produto do catálogo de exemplo
   vem sem foto. <use href="#bow-shape"> não funciona em e-mail e o Outlook
   nem renderiza SVG embutido, por isso o laço entra como caractere — a mesma
   Segoe UI Emoji que já desenha o 🎀 do assunto deste arquivo.

   width/height como ATRIBUTO, não só CSS: sem isso o motor do Word, que o
   Outlook usa, colapsa a célula. E o bgcolor fica na própria <td>, então
   imagem bloqueada deixa um quadrado rosa com o nome no alt, nunca um vão. */
const ROTA_FOTO_LOCAL =
  /^\/api\/products\/photos\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const ESTILO_IMG =
  'width="56" height="56" style="display:block; width:56px; height:56px; border:0; border-radius:10px;"';

function celulaMiniatura(photoUrl, nome){
  const alt = escapeHTML(nome || "produto");
  const local = typeof photoUrl === "string" ? photoUrl.match(ROTA_FOTO_LOCAL) : null;

  let interior;
  if(local){
    interior = `<img src="cid:produto-${local[1]}" alt="${alt}" ${ESTILO_IMG}>`;
  } else if(/^https?:\/\//i.test(photoUrl || "")){
    interior = `<img src="${escapeHTML(photoUrl)}" alt="${alt}" ${ESTILO_IMG}>`;
  } else {
    interior = "&#127872;";
  }

  return `<td width="56" bgcolor="#FBDCE8" align="center" valign="middle" style="width:56px; height:56px; background:#FBDCE8; border-radius:10px; font-size:26px; line-height:56px; mso-line-height-rule:exactly; border-bottom:1px solid #FBDCE8;">${interior}</td>`;
}

const CELULA_ESPACO =
  '<td width="12" style="width:12px; font-size:0; line-height:0; border-bottom:1px solid #FBDCE8;">&nbsp;</td>';

/* Do 9º item em diante entra o laço, sem foto. O corte é aplicado AQUI, na
   marcação — nunca na hora de montar os anexos: cortar lá deixaria cid sem
   anexo, que é justamente o ícone de imagem quebrada. */
const MAX_MINIATURAS = 8;

// Linha "rótulo: valor" — usada nos e-mails internos (pedido pago, contato).
function linhaDado(rotulo, valor){
  return `<strong style="color:#54293C;">${escapeHTML(rotulo)}:</strong> ${escapeHTML(valor)}<br>`;
}

/**
 * Monta assunto/texto/HTML do e-mail a partir de um pedido já resolvido
 * (itens com nome/quantidade, endereço, total, data do pagamento, link do
 * painel administrativo). Função pura — sem chamada de rede — fácil de
 * ajustar/testar isoladamente.
 */
function formatOrderEmail({ externalReference, items, address, total, paidAt, adminUrl, allColors }) {
  const itemLinesText = items
    .map(item => `${item.qty}x ${item.name} — cor: ${colorLabelForItem(item, allColors)}`)
    .join("\n");
  const itemLinesHtml = items
    .map(item => `<li>${item.qty}x ${escapeHTML(item.name)} — cor: ${escapeHTML(colorLabelForItem(item, allColors))}</li>`)
    .join("");

  const subject = `🎀 Novo pedido pago — ${externalReference}`;
  const deliveryLine = deliveryLineFor(address);

  const text = [
    "Novo pedido pago!",
    `Pedido: ${externalReference}`,
    `Data/hora: ${formatOrderDateTime(paidAt)}`,
    "",
    "Itens:",
    itemLinesText,
    "",
    `Total: ${formatCurrency(total)}`,
    "",
    `Cliente: ${address?.nome || "-"}`,
    `Telefone: ${address?.telefone || "-"}`,
    `CPF: ${address?.cpf || "-"}`,
    `Entrega: ${deliveryLine || "-"}`,
    "",
    `Ver no painel administrativo: ${adminUrl}`,
  ].join("\n");

  const itemRowsHtml = items
    .map((item, i) => `
      <tr>
        ${celulaMiniatura(i < MAX_MINIATURAS ? item.photoUrl : null, item.name)}
        ${CELULA_ESPACO}
        <td valign="middle" style="font-family:${FONT_CORPO}; color:#54293C; font-size:14px; padding:8px 0; border-bottom:1px solid #FBDCE8;">
          ${escapeHTML(item.qty)}x ${escapeHTML(item.name)} — cor: ${escapeHTML(colorLabelForItem(item, allColors))}
        </td>
      </tr>
    `).join("");

  const html = emailShell({
    titulo: subject,
    preheader: `${formatCurrency(total)} — ${address?.nome || "novo pedido"}`,
    eyebrow: "pedido pago",
    tituloCartao: "Novo pedido! 🎀",
    corpoHtml: `
      <tr>
        <td align="left" style="font-family:${FONT_CORPO}; color:#8C6577; font-size:13px; line-height:1.6; padding-bottom:18px;">
          ${linhaDado("Pedido", externalReference)}
          ${linhaDado("Data/hora", formatOrderDateTime(paidAt))}
        </td>
      </tr>
      <tr>
        <td style="padding-bottom:18px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${itemRowsHtml}
          </table>
        </td>
      </tr>
      <tr>
        <td align="left" style="font-family:${FONT_CORPO}; font-size:16px; font-weight:bold; color:#C05480; padding-bottom:20px;">
          Total: ${escapeHTML(formatCurrency(total))}
        </td>
      </tr>
      <tr>
        <td align="left" style="font-family:${FONT_CORPO}; color:#8C6577; font-size:13px; line-height:1.6; background:#FFF5F9; border-radius:14px; padding:14px 16px; margin-bottom:20px;">
          ${linhaDado("Cliente", address?.nome || "-")}
          ${linhaDado("Telefone", address?.telefone || "-")}
          ${linhaDado("CPF", address?.cpf || "-")}
          ${linhaDado("Entrega", deliveryLine || "-")}
        </td>
      </tr>
      <tr><td style="padding-bottom:20px;"></td></tr>
      ${botaoEmail(adminUrl, "Ver no painel administrativo")}
    `,
  });

  return { subject, text, html };
}

/**
 * Envia um e-mail via SMTP (Nodemailer). Lança erro se as credenciais não
 * estiverem configuradas ou se o envio falhar — quem chama decide o que
 * fazer com isso (server.js sempre envolve em try/catch).
 */
async function sendEmail({ to, subject, text, html, headers, attachments = [] }) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    throw new Error("SMTP não configurado (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS ausentes no .env).");
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  await transporter.sendMail({
    from: process.env.SMTP_FROM || SMTP_USER,
    // Reply-To real (a própria lojista) em todo e-mail — se a cliente
    // responder o recibo, cai na caixa dela, não se perde. É também um dos
    // muitos sinais pequenos que ajudam a reputação do remetente: caixa que
    // aceita resposta lê como correspondência de verdade, não disparo.
    replyTo: process.env.OWNER_EMAIL || undefined,
    to,
    subject,
    text,
    html,
    headers,
    // Todos os 4 e-mails usam o mesmo molde (emailShell) com a logo no
    // cabeçalho, referenciada como cid:LOGO_CID no HTML — por isso o anexo
    // entra aqui, incondicional, em vez de cada função de e-mail repetir.
    // A logo vem primeiro e os extras são espalhados depois, para que um
    // chamador nunca consiga deslocá-la sem querer.
    attachments: [
      { filename: "adriana-melo-acessorios.png", path: LOGO_PATH, cid: LOGO_CID },
      ...attachments,
    ],
  });
}

/**
 * Ponto de entrada chamado pelo webhook quando um pagamento é aprovado:
 * formata o e-mail e envia para o endereço da lojista (OWNER_EMAIL).
 * Propaga erro (não engole) — quem chama decide como logar/isolar a falha,
 * igual ao padrão já usado em whatsapp.js e purchaseShippingLabel.
 */
async function notifyOwnerOfPaidOrder(order) {
  const ownerEmail = process.env.OWNER_EMAIL;
  if (!ownerEmail) {
    throw new Error("OWNER_EMAIL não configurado no .env — e-mail não enviado.");
  }
  const { subject, text, html } = formatOrderEmail(order);
  // require aqui dentro, não no topo: emailPhotos carrega este arquivo de
  // volta, e a dependência circular só é segura porque os dois lados exigem
  // o outro na hora de usar, nunca na hora de carregar.
  const { anexosDeMiniaturas } = require("./emailPhotos.js");
  await sendEmail({
    to: ownerEmail, subject, text, html,
    attachments: await anexosDeMiniaturas(html),
  });
}

/**
 * E-mail de redefinição de senha, enviado para a CLIENTE (diferente dos
 * demais, que vão para a lojista). Propaga erro se o SMTP não estiver
 * configurado — quem chama (server.js) decide o que registrar.
 */
async function sendPasswordResetEmail({ to, name, resetUrl, expiresInMinutes }) {
  const firstName = String(name || "").trim().split(" ")[0] || "cliente";
  const subject = "Redefinição de senha — Adriana Melo Acessórios";

  const text = [
    `Olá, ${firstName}!`,
    "",
    "Recebemos um pedido para redefinir a senha da sua conta na Adriana Melo Acessórios.",
    "",
    `Abra este link para escolher uma nova senha (vale por ${expiresInMinutes} minutos):`,
    resetUrl,
    "",
    "Se não foi você que pediu, pode ignorar esta mensagem — sua senha atual continua valendo.",
  ].join("\n");

  const html = emailShell({
    titulo: subject,
    preheader: `O link para escolher uma nova senha vale por ${expiresInMinutes} minutos.`,
    eyebrow: "redefinição de senha",
    tituloCartao: "Vamos criar sua nova senha",
    corpoHtml: `
      <tr>
        <td align="center" style="font-family:${FONT_CORPO}; color:#8C6577; font-size:15px; line-height:1.6; padding-bottom:26px;">
          Olá, ${escapeHTML(firstName)}! Recebemos um pedido para redefinir a senha
          da sua conta. Clique no botão abaixo para escolher uma nova — o link
          vale por <strong style="color:#54293C;">${escapeHTML(String(expiresInMinutes))} minutos</strong>.
        </td>
      </tr>
      ${botaoEmail(resetUrl, "Criar nova senha")}
      <tr>
        <td align="center" style="font-family:${FONT_CORPO}; color:#8C6577; font-size:13px; line-height:1.6; padding-top:22px;">
          Se não foi você que pediu, pode ignorar esta mensagem — sua senha atual continua valendo.
        </td>
      </tr>
    `,
  });

  await sendEmail({ to, subject, text, html });
}

/**
 * Código de verificação em duas etapas por e-mail — alternativa ao app
 * autenticador, no MESMO desafio de login (server.js: POST
 * /api/auth/login/2fa/email). Propaga erro — diferente do reset de senha,
 * aqui quem pediu já provou a senha e tem um desafio válido, então uma
 * falha real de envio deve virar um erro real na tela, não um sucesso
 * genérico (não há risco de enumeração de conta nesta etapa).
 */
async function sendTwoFactorEmailCode({ to, name, code, expiresInMinutes }) {
  const firstName = String(name || "").trim().split(" ")[0] || "";
  const subject = "Seu código de verificação — Adriana Melo Acessórios";

  const text = [
    firstName ? `Olá, ${firstName}!` : "Olá!",
    "",
    "Você pediu um código de verificação para entrar no painel administrativo.",
    "",
    `Código: ${code}`,
    `Vale por ${expiresInMinutes} minutos.`,
    "",
    "Se não foi você que tentou entrar, troque sua senha assim que possível.",
  ].join("\n");

  const html = emailShell({
    titulo: subject,
    preheader: `Seu código vale por ${expiresInMinutes} minutos.`,
    eyebrow: "verificação em duas etapas",
    tituloCartao: "Aqui está seu código 🔐",
    corpoHtml: `
      <tr>
        <td align="center" style="font-family:${FONT_CORPO}; color:#8C6577; font-size:15px; line-height:1.6; padding-bottom:22px;">
          Use este código para entrar no painel administrativo — vale por
          <strong style="color:#54293C;">${escapeHTML(String(expiresInMinutes))} minutos</strong>.
        </td>
      </tr>
      <tr>
        <td align="center" style="padding-bottom:22px;">
          <table role="presentation" cellpadding="0" cellspacing="0">
            <tr>
              <td align="center" style="background:#FFF5F9; border:2px dashed #EA8FB4; border-radius:16px; padding:16px 36px;">
                <span style="font-family:${FONT_CORPO}; font-size:28px; font-weight:bold; letter-spacing:6px; color:#C05480;">
                  ${escapeHTML(code)}
                </span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td align="center" style="font-family:${FONT_CORPO}; color:#8C6577; font-size:13px; line-height:1.6;">
          Se não foi você que tentou entrar, troque sua senha assim que possível.
        </td>
      </tr>
    `,
  });

  await sendEmail({ to, subject, text, html });
}

/**
 * Cupom de boas-vindas, enviado para quem se inscreve na newsletter da home.
 * Propaga erro — quem chama (server.js) trata como melhor esforço, porque a
 * inscrição em si já foi gravada e o código também volta na resposta HTTP.
 */
/* =========================================================================
   E-MAILS PARA A CLIENTE
   -------------------------------------------------------------------------
   Até aqui todo e-mail de pedido ia para a LOJISTA. Quem comprava não recebia
   nada — nem confirmação, nem rastreio, apesar de a home prometer "código de
   rastreio por e-mail".

   As duas funções abaixo são puras (montam assunto/texto/HTML e devolvem):
   quem envia é a fila em lib/db.js, para que uma falha de SMTP fique gravada
   em vez de sumir dentro de um try/catch.
   ========================================================================= */

function linhasDeItens(items){
  return {
    texto: items.map(i => `${i.qty}x ${i.name}`).join("\n"),
    html: items.map((i, indice) => `
      <tr>
        ${celulaMiniatura(indice < MAX_MINIATURAS ? i.photoUrl : null, i.name)}
        ${CELULA_ESPACO}
        <td valign="middle" style="font-family:${FONT_CORPO}; color:#54293C; font-size:14px; padding:8px 0; border-bottom:1px solid #FBDCE8;">
          ${escapeHTML(String(i.qty))}x ${escapeHTML(i.name)}
        </td>
        <td align="right" valign="middle" style="font-family:${FONT_CORPO}; color:#8C6577; font-size:14px; padding:8px 0; border-bottom:1px solid #FBDCE8; white-space:nowrap;">
          ${escapeHTML(formatCurrency((i.price || 0) * i.qty))}
        </td>
      </tr>
    `).join(""),
  };
}

function linhaResumo(rotulo, valor, forte){
  const cor = forte ? "#C05480" : "#8C6577";
  const peso = forte ? "bold" : "normal";
  const tamanho = forte ? "16px" : "14px";
  return `
    <tr>
      <td style="font-family:${FONT_CORPO}; color:${cor}; font-size:${tamanho}; font-weight:${peso}; padding:4px 0;">${escapeHTML(rotulo)}</td>
      <td align="right" style="font-family:${FONT_CORPO}; color:${cor}; font-size:${tamanho}; font-weight:${peso}; padding:4px 0; white-space:nowrap;">${escapeHTML(valor)}</td>
    </tr>
  `;
}

/** Recibo da compra, enviado quando o pagamento é aprovado. */
function formatOrderConfirmationEmail({
  externalReference, items, subtotal, discount, pixDiscount, shippingPrice,
  total, couponCode, address, paidAt, trackUrl,
}){
  const subject = `Pedido confirmado — ${externalReference}`;
  const itens = linhasDeItens(items);
  const entrega = deliveryLineFor(address);
  const nome = (address && address.nome) ? String(address.nome).split(" ")[0] : "";

  const text = [
    nome ? `Oi, ${nome}!` : "Oi!",
    "",
    "Recebemos o seu pagamento — seu pedido já entrou na fila de produção.",
    "",
    `Pedido: ${externalReference}`,
    `Data: ${formatOrderDateTime(paidAt)}`,
    "",
    "Itens:",
    itens.texto,
    "",
    `Subtotal: ${formatCurrency(subtotal)}`,
    ...(discount > 0 ? [`Desconto${couponCode ? ` (${couponCode})` : ""}: -${formatCurrency(discount)}`] : []),
    ...(pixDiscount > 0 ? [`Desconto Pix: -${formatCurrency(pixDiscount)}`] : []),
    `Frete: ${shippingPrice > 0 ? formatCurrency(shippingPrice) : "grátis"}`,
    `Total: ${formatCurrency(total)}`,
    "",
    `Entrega: ${entrega || "-"}`,
    "",
    "Cada laço é feito à mão, um de cada vez. Assim que despacharmos, você",
    "recebe outro e-mail com o código de rastreio.",
    "",
    `Acompanhar o pedido: ${trackUrl}`,
    "",
    "Adriana Melo Acessórios — ateliê artesanal de laços, Brasília/DF",
    "adrianameloacessorios@gmail.com",
  ].join("\n");

  const html = emailShell({
    titulo: subject,
    preheader: `Pagamento confirmado — ${formatCurrency(total)}. Seu pedido entrou na fila de produção.`,
    eyebrow: "pagamento confirmado",
    tituloCartao: nome ? `Obrigada, ${nome}! 🎀` : "Pedido confirmado 🎀",
    corpoHtml: `
      <tr>
        <td align="center" style="font-family:${FONT_CORPO}; color:#8C6577; font-size:15px; line-height:1.6; padding-bottom:24px;">
          Recebemos o seu pagamento. Seu pedido <strong style="color:#54293C;">${escapeHTML(externalReference)}</strong> já entrou na fila de produção.
        </td>
      </tr>
      <tr>
        <td style="padding-bottom:8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${itens.html}
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding-bottom:22px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${linhaResumo("Subtotal", formatCurrency(subtotal))}
            ${discount > 0 ? linhaResumo(`Desconto${couponCode ? ` (${couponCode})` : ""}`, `-${formatCurrency(discount)}`) : ""}
            ${pixDiscount > 0 ? linhaResumo("Desconto Pix", `-${formatCurrency(pixDiscount)}`) : ""}
            ${linhaResumo("Frete", shippingPrice > 0 ? formatCurrency(shippingPrice) : "grátis")}
            ${linhaResumo("Total", formatCurrency(total), true)}
          </table>
        </td>
      </tr>
      <tr>
        <td align="left" style="font-family:${FONT_CORPO}; color:#8C6577; font-size:13px; line-height:1.6; background:#FFF5F9; border-radius:14px; padding:14px 16px;">
          ${linhaDado("Entrega", entrega || "-")}
        </td>
      </tr>
      <tr><td style="height:22px;"></td></tr>
      <tr>
        <td align="center" style="font-family:${FONT_CORPO}; color:#8C6577; font-size:14px; line-height:1.6; padding-bottom:22px;">
          Cada laço é feito à mão, um de cada vez. Assim que despacharmos, você recebe outro e-mail com o código de rastreio.
        </td>
      </tr>
      ${botaoEmail(trackUrl, "Acompanhar meu pedido")}
    `,
  });

  return { subject, text, html };
}

/** Aviso de postagem, enviado quando a lojista grava o código de rastreio. */
function formatTrackingEmail({ externalReference, trackingCode, address, trackUrl }){
  const subject = `Seu pedido está a caminho — ${externalReference}`;
  const nome = (address && address.nome) ? String(address.nome).split(" ")[0] : "";

  const text = [
    nome ? `Oi, ${nome}!` : "Oi!",
    "",
    "Seu pedido saiu do ateliê e já está a caminho.",
    "",
    `Pedido: ${externalReference}`,
    `Código de rastreio: ${trackingCode}`,
    "",
    `Acompanhar a entrega: ${trackUrl}`,
    "",
    "Adriana Melo Acessórios — ateliê artesanal de laços, Brasília/DF",
    "adrianameloacessorios@gmail.com",
  ].join("\n");

  const html = emailShell({
    titulo: subject,
    preheader: `Código de rastreio: ${trackingCode}`,
    eyebrow: "pedido postado",
    tituloCartao: "Seu laço está a caminho 💌",
    corpoHtml: `
      <tr>
        <td align="center" style="font-family:${FONT_CORPO}; color:#8C6577; font-size:15px; line-height:1.6; padding-bottom:26px;">
          ${nome ? `Oi, ${escapeHTML(nome)}! ` : ""}Seu pedido <strong style="color:#54293C;">${escapeHTML(externalReference)}</strong> saiu do ateliê e já está a caminho.
        </td>
      </tr>
      <tr>
        <td align="center" style="padding-bottom:26px;">
          <table role="presentation" cellpadding="0" cellspacing="0">
            <tr>
              <td align="center" style="background:#FFF5F9; border:2px dashed #EA8FB4; border-radius:16px; padding:16px 30px;">
                <div style="font-family:${FONT_CORPO}; font-size:12px; color:#8C6577; padding-bottom:6px;">código de rastreio</div>
                <span style="font-family:${FONT_CORPO}; font-size:20px; font-weight:bold; letter-spacing:2px; color:#C05480;">
                  ${escapeHTML(trackingCode)}
                </span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      ${botaoEmail(trackUrl, "Acompanhar a entrega")}
    `,
  });

  return { subject, text, html };
}

async function sendWelcomeCouponEmail({ to, couponCode, percentOff, shopUrl, unsubscribeUrl }) {
  const subject = `🎀 Seu cupom de ${percentOff}% — Adriana Melo Acessórios`;

  const text = [
    "Obrigada por se cadastrar!",
    "",
    `Seu cupom de ${percentOff}% de desconto na primeira compra:`,
    couponCode,
    "",
    "É só usar no carrinho, no campo de cupom, antes de finalizar o pedido.",
    "",
    `Ver a coleção: ${shopUrl}`,
    "",
    "Adriana Melo Acessórios — ateliê artesanal de laços, Brasília/DF",
    "adrianameloacessorios@gmail.com",
    ...(unsubscribeUrl ? ["", `Não quer mais receber estes e-mails? ${unsubscribeUrl}`] : []),
  ].join("\n");

  const html = emailShell({
    titulo: subject,
    preheader: `Seu cupom de ${percentOff}% já está pronto para a primeira compra.`,
    eyebrow: "obrigada por se cadastrar",
    tituloCartao: "Seu laço de boas-vindas chegou 🎀",
    corpoHtml: `
      <tr>
        <td align="center" style="font-family:${FONT_CORPO}; color:#8C6577; font-size:15px; line-height:1.6; padding-bottom:26px;">
          Aqui está o seu cupom de <strong style="color:#54293C;">${escapeHTML(String(percentOff))}% de desconto</strong> na primeira compra — vale para qualquer laço da coleção.
        </td>
      </tr>

      <!-- Cupom: mesma moldura tracejada usada no site (cupom aplicado no carrinho) -->
      <tr>
        <td align="center" style="padding-bottom:26px;">
          <table role="presentation" cellpadding="0" cellspacing="0">
            <tr>
              <td align="center" style="background:#FFF5F9; border:2px dashed #EA8FB4; border-radius:16px; padding:16px 36px;">
                <span style="font-family:${FONT_CORPO}; font-size:24px; font-weight:bold; letter-spacing:3px; color:#C05480;">
                  ${escapeHTML(couponCode)}
                </span>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <tr>
        <td align="center" style="font-family:${FONT_CORPO}; color:#8C6577; font-size:14px; line-height:1.6; padding-bottom:26px;">
          É só colar esse código no campo de cupom, no carrinho, antes de finalizar o pedido.
        </td>
      </tr>

      ${botaoEmail(shopUrl, "Ver a coleção")}
      ${unsubscribeUrl ? `
      <tr>
        <td align="center" style="font-family:${FONT_CORPO}; color:#B79AA9; font-size:11px; line-height:1.6; padding-top:18px;">
          <a href="${escapeHTML(unsubscribeUrl)}" style="color:#B79AA9; text-decoration:underline;">Não quero mais receber estes e-mails</a>
        </td>
      </tr>
      ` : ""}
    `,
  });

  // List-Unsubscribe: sinal de e-mail legítimo/não-spam para os filtros dos
  // provedores (Gmail, Outlook...) — só faz sentido aqui, o único dos 4
  // e-mails do site que é promocional (os outros 3 são transacionais:
  // pedido pago, redefinição de senha, contato — cancelar "inscrição"
  // deles não faz sentido). O mailto é o reforço que funciona mesmo sem
  // JS/rede no cliente de e-mail; a URL é o link clicável e também o que
  // permite o "cancelar inscrição" de um clique do Gmail/Yahoo (RFC 8058),
  // por isso List-Unsubscribe-Post só é declarado quando há URL.
  const headers = unsubscribeUrl ? {
    "List-Unsubscribe": `<mailto:${process.env.SMTP_USER}?subject=descadastrar>, <${unsubscribeUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  } : undefined;

  await sendEmail({ to, subject, text, html, headers });
}

/**
 * Aviso para a lojista quando o formulário "Vamos criar seu laço?" da home
 * é enviado (POST /api/contact em server.js). Mesmo padrão de
 * notifyOwnerOfPaidOrder: vai para OWNER_EMAIL, propaga erro — quem chama
 * trata como melhor esforço, porque a mensagem já foi gravada no banco (ver
 * db.createContactMessage) e aparece no painel mesmo se o e-mail falhar.
 */
async function notifyOwnerOfContactMessage({ nome, telefone, ocasiao, mensagem }) {
  const ownerEmail = process.env.OWNER_EMAIL;
  if (!ownerEmail) {
    throw new Error("OWNER_EMAIL não configurado no .env — e-mail não enviado.");
  }
  const subject = `🎀 Nova mensagem de contato — ${nome}`;

  const text = [
    "Nova mensagem pelo formulário \"Vamos criar seu laço?\":",
    "",
    `Nome: ${nome}`,
    `WhatsApp: ${telefone}`,
    `Ocasião: ${ocasiao || "-"}`,
    "",
    "Mensagem:",
    mensagem,
  ].join("\n");

  const html = emailShell({
    titulo: subject,
    preheader: `${nome}: ${mensagem.slice(0, 100)}`,
    eyebrow: "novo contato",
    tituloCartao: "Nova mensagem pelo site 🎀",
    corpoHtml: `
      <tr>
        <td align="left" style="font-family:${FONT_CORPO}; color:#8C6577; font-size:13px; line-height:1.6; padding-bottom:18px;">
          ${linhaDado("Nome", nome)}
          ${linhaDado("WhatsApp", telefone)}
          ${linhaDado("Ocasião", ocasiao || "-")}
        </td>
      </tr>
      <tr>
        <td align="left" style="font-family:${FONT_CORPO}; color:#54293C; font-size:14px; line-height:1.6; background:#FFF5F9; border-radius:14px; padding:16px 18px; white-space:pre-wrap;">
          ${escapeHTML(mensagem)}
        </td>
      </tr>
    `,
  });

  await sendEmail({ to: ownerEmail, subject, text, html });
}

/* Aviso de tentativas de login na conta de admin
   -------------------------------------------------------------------------
   Disparado quando o bloqueio por força bruta fecha a porta numa conta de
   administrador. É o único canal em que a lojista fica sabendo: o atacante,
   por definição, não chega ao painel para deixar rastro visível lá dentro.
   Vai para o e-mail da própria conta atacada (e não para uma lista fixa)
   porque é quem precisa agir — trocar a senha, conferir se foi ela mesma. */
async function sendAdminLoginAlert({ email: contaAlvo, ip, failures }) {
  const subject = "⚠️ Tentativas de login no painel da loja";
  const quando = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const text = [
    "Detectamos tentativas de login malsucedidas na sua conta de administradora.",
    "",
    `Conta: ${contaAlvo}`,
    `Tentativas seguidas: ${failures}`,
    `Endereço de origem (IP): ${ip}`,
    `Quando: ${quando}`,
    "",
    "O acesso desse endereço já foi bloqueado por 30 minutos.",
    "",
    "Se foi você que errou a senha, pode ignorar este aviso — é só esperar o prazo.",
    "Se NÃO foi você, troque sua senha assim que conseguir entrar.",
  ].join("\n");

  const html = emailShell({
    titulo: subject,
    preheader: `${failures} tentativas de login na conta ${contaAlvo}`,
    eyebrow: "alerta de segurança",
    tituloCartao: "Tentativas de login bloqueadas",
    corpoHtml: `
      <tr>
        <td align="left" style="font-family:${FONT_CORPO}; color:#8C6577; font-size:13px; line-height:1.6; padding-bottom:18px;">
          ${linhaDado("Conta", contaAlvo)}
          ${linhaDado("Tentativas seguidas", String(failures))}
          ${linhaDado("Origem (IP)", ip)}
          ${linhaDado("Quando", quando)}
        </td>
      </tr>
      <tr>
        <td align="left" style="font-family:${FONT_CORPO}; color:#54293C; font-size:14px; line-height:1.6; background:#FFF5F9; border-radius:14px; padding:16px 18px;">
          O acesso desse endereço já foi <strong>bloqueado por 30 minutos</strong>.<br><br>
          Se foi você que errou a senha, é só esperar o prazo.<br>
          Se <strong>não</strong> foi você, troque sua senha assim que conseguir entrar.
        </td>
      </tr>
    `,
  });

  await sendEmail({ to: contaAlvo, subject, text, html });
}

module.exports = {
  formatOrderEmail,
  formatOrderConfirmationEmail,
  formatTrackingEmail,
  sendEmail,
  notifyOwnerOfPaidOrder,
  notifyOwnerOfContactMessage,
  sendPasswordResetEmail,
  sendTwoFactorEmailCode,
  sendWelcomeCouponEmail,
  sendAdminLoginAlert,
};
