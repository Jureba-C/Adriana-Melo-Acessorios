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
 */
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const db = require("../lib/db.js");
const emailPhotos = require("../lib/emailPhotos.js");
const rastreio = require("../lib/rastreio.js");
const melhorEnvio = require("../lib/melhorEnvio.js");

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

async function main(){
  await reenviarFilaDeEmail();
  await fecharEntregasConfirmadas();
}

if(require.main === module){
  main().catch(err => {
    console.error("Erro nas tarefas periódicas:", err);
    process.exit(1);
  });
}

module.exports = { reenviarFilaDeEmail, fecharEntregasConfirmadas };
