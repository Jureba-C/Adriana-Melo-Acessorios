/**
 * =============================================================================
 *  TAREFAS PERIÓDICAS — fila de e-mail + confirmação de entrega
 * =============================================================================
 *  Uso:
 *      cd server && node scripts/tarefas-periodicas.js
 *
 *  Na Hostinger, agendar no cron do hPanel a cada 15 minutos (mesmo lugar
 *  onde já roda o backup-db.js):
 *      cd ~/.../server && /usr/bin/node scripts/tarefas-periodicas.js
 *
 *  POR QUE CRON, E NÃO setInterval DENTRO DO SERVIDOR
 *  --------------------------------------------------------------------------
 *  O Passenger (que serve o app na Hostinger) hiberna o processo web quando
 *  não há visitas e o reinicia na próxima requisição. Um setInterval, ali,
 *  dispara em horários imprevisíveis — e duplica se o Passenger subir mais de
 *  um worker. O cron do sistema roda sempre, uma vez só, mesmo com o site
 *  parado. O backup do banco já é feito assim.
 *
 *  O QUE FAZ
 *  --------------------------------------------------------------------------
 *  1. Reenvia os e-mails de cliente que ficaram na fila (lib/db.js, tabela
 *     email_outbox) porque a tentativa na hora do pedido falhou — SMTP fora
 *     do ar, credencial vencida, caixa cheia. Cada falha aumenta a espera até
 *     a próxima tentativa (5min, 15, 45, 2h15, 6h45) e desiste após 5
 *     tentativas, deixando o erro gravado em last_error para investigação.
 *  2. Pergunta ao Melhor Envio se os pedidos postados já chegaram, e fecha a
 *     entrega (fulfillment_status = 'entregue') nos que já confirmaram.
 *  3. Enfileira "seu pedido chegou?" para quem passou do prazo do frete sem
 *     entrega confirmada, e "como ficaram os laços?" para quem recebeu há 2
 *     dias e não avaliou. Cada um sai UMA vez por pedido (índice único da
 *     fila). Só entram pedidos postados nos últimos 45 dias / entregues nos
 *     últimos 30 — trava para o primeiro deploy não disparar e-mail para
 *     cliente de meses atrás.
 *  4. Enfileira o lembrete de carrinho esquecido: pedido criado no checkout,
 *     nunca pago, entre 8 horas e 3 dias atrás, para quem deixou e-mail. A
 *     espera de 8 horas existe porque o Pix fica válido por horas — lembrar
 *     antes seria cobrar quem ainda ia pagar. Um por pedido (índice único da
 *     fila) e no máximo um por pessoa a cada 30 dias.
 *  5. Enfileira o cupom de aniversário para quem cadastrou a data em "Minha
 *     conta" e faz aniversário hoje (horário de Brasília, a partir das 9h),
 *     um por ano — a chave da fila é "aniversario:<id>:<ano>".
 *  6. Enfileira o próximo lote das campanhas de novidades em envio (aba
 *     "Novidades" do painel), ~40 por rodada. O disparo mora em
 *     lib/campanhas.js porque o painel também precisa dele: sem o cron
 *     configurado no hPanel, a lojista toca a campanha pelo botão "enviar um
 *     lote agora", e duas cópias da mesma rotina divergiriam.
 *  7. Grava a hora desta rodada. O painel mostra, e avisa quando passa de
 *     1 hora — é o único sinal de que o agendamento no hPanel sumiu.
 *
 *  A ordem importa: fechar entregas ANTES de escolher quem recebe "seu
 *  pedido chegou?" (quem o Melhor Envio acabou de confirmar não precisa da
 *  pergunta), e enfileirar ANTES de reenviar a fila (o e-mail novo já sai
 *  nesta mesma rodada).
 */
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const db = require("../lib/db.js");
const emailPhotos = require("../lib/emailPhotos.js");
const rastreio = require("../lib/rastreio.js");
const melhorEnvio = require("../lib/melhorEnvio.js");
const email = require("../lib/email.js");
const campanhas = require("../lib/campanhas.js");
const catalogo = require("../lib/catalogo.js");
const produtoUrl = require("../js/produto-url.js");
const pricing = require("../js/pricing.js");

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:3333";

const LOTE = 20;

async function reenviarFilaDeEmail(){
  const pendentes = db.pendingEmails(LOTE);
  if(!pendentes.length){
    console.log("Fila de e-mail vazia — nada a reenviar.");
    return { enviados: 0, falhas: 0 };
  }

  let enviados = 0;
  let falhas = 0;
  for(const linha of pendentes){
    try{
      // Deriva as miniaturas do HTML guardado, igual ao envio original.
      await emailPhotos.enviarComMiniaturas({
        to: linha.to_email,
        subject: linha.subject,
        text: linha.text_body,
        html: linha.html_body,
        headers: KINDS_COM_DESCADASTRO.has(linha.kind)
          ? email.cabecalhosDeDescadastro(linkDeDescadastro(linha.to_email))
          : undefined,
      });
      db.markEmailSent(linha.id);
      enviados++;
      console.log(`  ✓ ${linha.kind} → ${linha.to_email} (pedido ${linha.order_reference || "-"})`);
    }catch(err){
      db.markEmailFailed(linha.id, err.message || err);
      falhas++;
      console.error(`  ✗ ${linha.kind} → ${linha.to_email}: ${err.message || err}`);
    }
  }
  console.log(`Fila de e-mail: ${enviados} enviado(s), ${falhas} falha(s), ${pendentes.length} tentado(s).`);
  return { enviados, falhas };
}

/* Pergunta ao Melhor Envio se os pedidos já postados chegaram. Uma pausa
   entre as consultas para não metralhar a API deles — e porque cada pedido
   ainda sem id de envio gasta duas chamadas (busca pelo código + rastreio).
   ⚠️ O id descoberto aqui é gravado no pedido: da próxima rodada em diante
   esse pedido custa uma chamada só. */
async function fecharEntregasConfirmadas(){
  const pedidos = db.listOrdersAwaitingDelivery();
  if(!pedidos.length){
    console.log("Entregas: nenhum pedido postado aguardando confirmação.");
    return { conferidos: 0, entregues: 0 };
  }
  let entregues = 0;
  for(const pedido of pedidos){
    const { live, shipmentId, descoberto } = await melhorEnvio.rastreioDoPedido({
      trackingCode: pedido.tracking_code,
      shipmentId: pedido.melhor_envio_shipment_id,
    });
    if(descoberto && shipmentId) db.setMelhorEnvioShipmentId(pedido.external_reference, shipmentId);
    const evento = rastreio.eventoDeEntrega(live);
    if(evento){
      db.markOrderDelivered(pedido.external_reference, rastreio.dataDoEvento(evento));
      entregues++;
      console.log(`  ✓ ${pedido.external_reference} entregue — ${evento.description}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  console.log(`Entregas: ${pedidos.length} conferido(s), ${entregues} confirmado(s) como entregue(s).`);
  return { conferidos: pedidos.length, entregues };
}

function linkDeAvaliacao(reference){
  const token = db.garantirTokenDeAvaliacao(reference);
  return `${CLIENT_ORIGIN}/avaliar.html?pedido=${encodeURIComponent(reference)}#t=${token}`;
}

const WHATSAPP_DA_LOJA = "https://wa.me/5561982749808";

// Kinds promocionais: precisam de List-Unsubscribe, e a fila não guarda
// cabeçalho nenhum — só assunto, texto e HTML. Remontar aqui, na hora do
// envio, é o que faz o botão "cancelar inscrição" do Gmail aparecer.
const KINDS_COM_DESCADASTRO = new Set(["carrinho_esquecido", "campanha"]);

function linkDeDescadastro(emailDestino){
  const token = db.garantirTokenDeContato(emailDestino);
  return `${CLIENT_ORIGIN}/api/newsletter/unsubscribe?email=${encodeURIComponent(emailDestino)}&token=${token}`;
}

/* items_json guarda só {id, qty, price} — nome e foto não cabem lá, porque
   o produto pode ser renomeado depois da compra e o pedido tem de continuar
   mostrando o que foi comprado, não um retrato velho. Para o e-mail, o nome
   vem do catálogo na hora do envio.
   ⚠️ Sem isto o lembrete de carrinho listava "• undefined" para a cliente. */
function itensComNome(itemsJson){
  let brutos = [];
  try { brutos = JSON.parse(itemsJson); } catch { return []; }
  const overrides = catalogo.getProductOverridesMap();
  return brutos.map(item => {
    const p = catalogo.effectiveProduct(Number(item.id), overrides);
    return {
      id: item.id,
      qty: Number(item.qty) || 1,
      name: p?.name || `Produto #${item.id}`,
      photoUrl: p?.photoUrl || null,
    };
  });
}

function enderecoDe(pedido){
  try { return JSON.parse(pedido.address_json); } catch { return null; }
}

function enfileirarConfirmacoesDeRecebimento(agora = Date.now()){
  let novos = 0;
  for(const pedido of db.pedidosParaConfirmarRecebimento(agora)){
    const conteudo = email.formatConfirmarRecebimentoEmail({
      externalReference: pedido.external_reference,
      address: enderecoDe(pedido),
      avaliarUrl: linkDeAvaliacao(pedido.external_reference),
    });
    const id = db.enqueueEmail({
      kind: "confirmar_recebimento",
      toEmail: pedido.customer_email,
      orderReference: pedido.external_reference,
      subject: conteudo.subject,
      textBody: conteudo.text,
      htmlBody: conteudo.html,
    });
    if(id) novos++;
  }
  console.log(`"Seu pedido chegou?": ${novos} novo(s) na fila.`);
  return novos;
}

function enfileirarPedidosDeAvaliacao(agora = Date.now()){
  let novos = 0;
  for(const pedido of db.pedidosParaPedirAvaliacao(agora)){
    const conteudo = email.formatPedirAvaliacaoEmail({
      externalReference: pedido.external_reference,
      address: enderecoDe(pedido),
      avaliarUrl: linkDeAvaliacao(pedido.external_reference),
    });
    const id = db.enqueueEmail({
      kind: "pedir_avaliacao",
      toEmail: pedido.customer_email,
      orderReference: pedido.external_reference,
      subject: conteudo.subject,
      textBody: conteudo.text,
      htmlBody: conteudo.html,
    });
    if(id) novos++;
  }
  console.log(`"Como ficaram os laços?": ${novos} novo(s) na fila.`);
  return novos;
}

/* ⚠️ Promocional, não transacional: leva link de descadastro, e quem já
   pediu para sair não entra (a consulta em lib/db.js cuida disso). O
   e-mail sai da FILA, e a fila não guarda cabeçalho — por isso o
   List-Unsubscribe é remontado na hora do envio, em reenviarFilaDeEmail. */
function enfileirarLembretesDeCarrinho(agora = Date.now()){
  let novos = 0;
  for(const pedido of db.pedidosParaLembrarCarrinho(agora)){
    const conteudo = email.formatCarrinhoEsquecidoEmail({
      address: enderecoDe(pedido),
      items: itensComNome(pedido.items_json),
      retomarUrl: `${CLIENT_ORIGIN}/?recuperar=${encodeURIComponent(pedido.external_reference)}`,
      whatsappUrl: WHATSAPP_DA_LOJA,
      unsubscribeUrl: linkDeDescadastro(pedido.customer_email),
    });
    const id = db.enqueueEmail({
      kind: "carrinho_esquecido",
      toEmail: pedido.customer_email,
      orderReference: pedido.external_reference,
      subject: conteudo.subject,
      textBody: conteudo.text,
      htmlBody: conteudo.html,
    });
    if(id) novos++;
  }
  console.log(`Carrinhos esquecidos: ${novos} lembrete(s) novo(s) na fila.`);
  return novos;
}

/* ⚠️ Isto já foi um fetch em ${CLIENT_ORIGIN}/api/products — ou seja, o
   servidor chamando a si mesmo por HTTP quando a rodada é disparada pela
   rota /api/interno/tarefas-periodicas. Além de frágil, qualquer falha
   desse fetch era engolida e a campanha saía SEM os laços que a lojista
   escolheu. Agora lê o catálogo direto, no mesmo processo. */
function produtosDaCampanha(campanha){
  let ids = [];
  try { ids = JSON.parse(campanha.produtos || "[]"); } catch {}
  if(!ids.length) return [];
  const overrides = catalogo.getProductOverridesMap();
  return ids.map(id => {
    const p = catalogo.effectiveProduct(Number(id), overrides);
    if(!p || p.hidden) return null;
    return {
      nome: p.name,
      preco: pricing.formatMoney(p.price),
      photoUrl: p.photoUrl,
      url: `${CLIENT_ORIGIN}${produtoUrl.caminhoDoProduto(Number(id), p.name)}?utm_source=newsletter&utm_medium=email&utm_campaign=campanha-${campanha.id}`,
    };
  }).filter(Boolean);
}

async function enfileirarLotesDeCampanha(){
  const emEnvio = db.campanhasEnviando();
  if(!emEnvio.length){
    console.log("Campanhas: nenhuma em envio.");
    return 0;
  }
  let novos = 0;
  for(const campanha of emEnvio){
    const produtos = produtosDaCampanha(campanha);
    const resultado = campanhas.enfileirarLote({ campanha, produtos, origem: CLIENT_ORIGIN });
    novos += resultado.novos;
    console.log(`  Campanha "${campanha.assunto}": ${resultado.contagem.enfileirados}/${resultado.contagem.total} na fila.`);
  }
  console.log(`Campanhas: ${novos} e-mail(s) novo(s) na fila.`);
  return novos;
}

function hojeEmBrasilia(agora){
  const partes = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(agora)).map(p => [p.type, p.value]));
  return { ano: partes.year, mesDia: `${partes.month}-${partes.day}`, hora: Number(partes.hour) };
}

// Sem cupom (a lojista apagou o ANIVERSARIO10 no painel) não manda nada: o
// e-mail prometeria um desconto que o carrinho recusaria.
function enfileirarCuponsDeAniversario(agora = Date.now()){
  const cupom = db.getCoupon(db.CUPOM_ANIVERSARIO);
  const { ano, mesDia, hora } = hojeEmBrasilia(agora);
  if(!cupom || hora < 9){
    console.log(`Aniversários: ${cupom ? "antes das 9h, fica para a próxima rodada" : "cupom de aniversário apagado no painel, nada a enviar"}.`);
    return 0;
  }
  let novos = 0;
  for(const cliente of db.aniversariantesDoDia(mesDia)){
    const conteudo = email.formatAniversarioEmail({
      nome: String(cliente.name || "").trim().split(" ")[0],
      couponCode: cupom.code,
      percentOff: cupom.percent_off,
      shopUrl: `${CLIENT_ORIGIN}/index.html#colecoes`,
      contaUrl: `${CLIENT_ORIGIN}/pedidos.html#dados`,
    });
    const id = db.enqueueEmail({
      kind: "aniversario",
      toEmail: cliente.email,
      orderReference: `aniversario:${cliente.id}:${ano}`,
      subject: conteudo.subject,
      textBody: conteudo.text,
      htmlBody: conteudo.html,
    });
    if(id) novos++;
  }
  console.log(`Aniversários: ${novos} cupom(ns) novo(s) na fila.`);
  return novos;
}

async function main(){
  await fecharEntregasConfirmadas();
  enfileirarConfirmacoesDeRecebimento();
  enfileirarPedidosDeAvaliacao();
  enfileirarLembretesDeCarrinho();
  enfileirarCuponsDeAniversario();
  await enfileirarLotesDeCampanha();
  await reenviarFilaDeEmail();
  db.gravarEstado("tarefas_periodicas_em", new Date().toISOString());
}

if(require.main === module){
  main().catch(err => {
    console.error("Erro nas tarefas periódicas:", err);
    process.exit(1);
  });
}

module.exports = { main, reenviarFilaDeEmail, fecharEntregasConfirmadas, enfileirarConfirmacoesDeRecebimento, enfileirarPedidosDeAvaliacao, enfileirarLembretesDeCarrinho, enfileirarCuponsDeAniversario, enfileirarLotesDeCampanha };
