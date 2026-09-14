"use strict";

/* =========================================================================
   MELHOR ENVIO — cliente HTTP e rastreio
   -------------------------------------------------------------------------
   Estava tudo dentro do server.js. Saiu para cá porque
   scripts/tarefas-periodicas.js roda em OUTRO processo (cron) e precisa das
   mesmas funções de rastreio — de lá não dá para chamar nada do server.js.
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

/* =========================================================================
   Rastreio ao vivo (Melhor Envio) — best-effort, nunca lança.
   -------------------------------------------------------------------------
   A página de acompanhamento de pedido (acompanhar-pedido.html) chama isto
   sob demanda quando a cliente abre a página — não há polling nem webhook
   de rastreio, é uma consulta pontual. A tarefa periódica
   (scripts/tarefas-periodicas.js) chama a mesma função de outro processo:
   é por isso que este cliente mora em lib/ e não dentro do server.js.
   ⚠️ A resposta deles tem cache de 1 hora do lado de lá (documentado na
   comunidade): consultar de novo no mesmo pedido em seguida devolve o
   mesmo conteúdo, não adianta insistir.
   A documentação pública de POST /api/v2/me/shipment/tracking não pôde ser
   confirmada em detalhe (formato exato da resposta, se traz um histórico
   de eventos com local/data ou só um status atual). Por isso
   normalizeTrackingResponse tenta reconhecer algumas formas plausíveis e,
   se não reconhecer nada, devolve null — quem chama sempre cai de volta
   para a linha do tempo manual (fulfillmentStatus) + link oficial da
   transportadora (rastreio.linkDaTransportadora), nunca deixa a página quebrada.
========================================================================= */
async function rastrearEnvio(shipmentId){
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
   Achar o envio a partir do código de rastreio
   -------------------------------------------------------------------------
   O rastreio ao vivo precisa do id do envio no Melhor Envio, e esse id só
   existe quando foi o site que comprou a etiqueta (purchaseShippingLabel,
   desligado por padrão). Quem compra a etiqueta no site do Melhor Envio e
   cola o código no painel não tem id nenhum — e era esse o caso real da
   loja, que por isso nunca via rota no acompanhamento.

   GET /api/v2/me/orders/search?q=<termo> resolve: `q` aceita código de
   rastreio (além de protocolo, autorização e documento) e devolve o envio
   da conta, com o id.

   ⚠️ A busca é ampla de propósito do lado deles, então NÃO dá para confiar
   no primeiro resultado: só vale o item cujo tracking/self_tracking é
   exatamente o código pedido. Sem essa conferência, um termo que casasse
   por outro campo devolveria o envio de OUTRO pedido — e a cliente veria a
   rota do pacote de outra pessoa.
========================================================================= */
async function buscarEnvioPeloCodigo(codigo){
  if(!codigo || !process.env.MELHOR_ENVIO_TOKEN) return null;
  const alvo = String(codigo).trim().toUpperCase();
  try{
    const data = await meFetch(`/api/v2/me/orders/search?q=${encodeURIComponent(alvo)}`, { timeoutMs: 6000 });
    const lista = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
    const envio = lista.find(item => {
      const codigos = [item?.tracking, item?.self_tracking]
        .filter(Boolean).map(c => String(c).trim().toUpperCase());
      return codigos.includes(alvo);
    });
    return envio?.id ? { id: String(envio.id), status: envio.status || null } : null;
  }catch(err){
    console.error(`Não foi possível achar o envio ${alvo} no Melhor Envio:`, err.message || err);
    return null;
  }
}

/* Rastreio de um pedido a partir do que já está salvo nele. Devolve também o
   shipmentId usado: quando ele foi DESCOBERTO agora pela busca, quem chamou
   grava no pedido (db.setMelhorEnvioShipmentId) e as próximas consultas
   pulam a busca. Best-effort do começo ao fim — qualquer falha vira live
   null, e a página cai na linha do tempo manual + link da transportadora. */
async function rastreioDoPedido({ trackingCode, shipmentId }){
  if(shipmentId) return { live: await rastrearEnvio(shipmentId), shipmentId, descoberto: false };
  if(!trackingCode) return { live: null, shipmentId: null, descoberto: false };

  const envio = await buscarEnvioPeloCodigo(trackingCode);
  if(!envio) return { live: null, shipmentId: null, descoberto: false };

  const live = await rastrearEnvio(envio.id);
  return {
    live: live || (envio.status ? { status: envio.status, events: [] } : null),
    shipmentId: envio.id,
    descoberto: true,
  };
}

module.exports = {
  meFetch,
  buscarEnvioPeloCodigo,
  rastrearEnvio,
  rastreioDoPedido,
};
