"use strict";

/* Recebe o rastreio inteiro (status + eventos), não só a lista de eventos:
   o Melhor Envio às vezes devolve a situação do envio SEM histórico, e aí a
   única pista de que chegou é o status "delivered". Sem olhar os dois, um
   pedido entregue sem lista de eventos nunca fecharia sozinho.

   ⚠️ "entregue ao remetente" é DEVOLUÇÃO, não entrega — marcar isso como
   entregue diria à cliente que o pacote chegou quando ele voltou. */
const STATUS_DE_ENTREGA = new Set(["delivered", "entregue"]);

function eventoDeEntrega(live){
  const events = Array.isArray(live?.events) ? live.events : (Array.isArray(live) ? live : []);
  const evento = events.find(ev => {
    const texto = String(ev?.description || "").toLowerCase();
    return texto.includes("entregue") && !texto.includes("remetente");
  });
  if(evento) return evento;

  const status = String(live?.status || "").trim().toLowerCase();
  if(STATUS_DE_ENTREGA.has(status)) return { description: live.status, date: null, location: null };
  return null;
}

function dataDoEvento(evento){
  if(!evento?.date) return null;
  const d = new Date(evento.date);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/* A loja só posta pelo Melhor Envio, e o código que ela cola no painel só é
   reconhecido lá — inclusive quando o serviço é PAC/SEDEX, que o Melhor
   Envio revende. Por isso o link é sempre deles, sem olhar o formato do
   código como antes.
   ⚠️ Sem "www.": medido, a versão com www responde 302 para esta, e o
   redirecionamento extra custa uma viagem a mais no celular da cliente. */
function linkDaTransportadora(trackingCode){
  if(!trackingCode) return null;
  return `https://melhorenvio.com.br/rastreio/${encodeURIComponent(trackingCode)}`;
}

module.exports = {
  eventoDeEntrega,
  dataDoEvento,
  linkDaTransportadora,
};
