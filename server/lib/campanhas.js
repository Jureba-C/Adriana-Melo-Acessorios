/**
 * Disparo das campanhas de novidades, em lotes.
 *
 * Mora aqui, e não no server.js nem no script do cron, porque os DOIS
 * precisam da mesma rotina: o cron a cada 15 minutos e o botão "enviar um
 * lote agora" do painel — que existe justamente porque o agendamento no
 * hPanel pode não estar configurado. Duas cópias divergiriam, e divergir
 * aqui significa e-mail duplicado ou campanha parada pela metade.
 *
 * A trava contra envio repetido não é um estado guardado aqui: é o índice
 * único (kind, order_reference) do email_outbox, com a chave
 * "campanha:<id>:<email>". Rodar duas vezes, clicar duas vezes ou o cron
 * pegar a mesma campanha no meio de uma rodada anterior não duplica nada —
 * enqueueEmail devolve null quando o índice barra.
 */
const db = require("./db.js");
const email = require("./email.js");

// Por rodada do cron (15 min) => ~160 e-mails/hora. Conservador de propósito:
// o SMTP da Hostinger é compartilhado, e disparo rápido demais é o caminho
// mais curto para a caixa de spam.
const LOTE_PADRAO = Number(process.env.CAMPANHA_POR_RODADA) || 40;

function linkDeDescadastro(origem, emailDestino){
  const token = db.garantirTokenDeContato(emailDestino);
  return `${origem}/api/newsletter/unsubscribe?email=${encodeURIComponent(emailDestino)}&token=${token}`;
}

/* Os produtos escolhidos pela lojista viajam como uma lista simples (nome,
   preço, foto, link) montada por quem chama — server.js, que é quem conhece
   o catálogo. Assim este módulo não depende do catálogo nem do PRODUCTS. */
function enfileirarLote({ campanha, produtos, origem, limite = LOTE_PADRAO }){
  const destinatarios = db.destinatariosPendentes(campanha.id, limite);
  let novos = 0;

  for(const destino of destinatarios){
    // Quem se descadastrou DEPOIS do disparo não pode receber. É a checagem
    // que mais importa aqui, e por isso é feita na hora de enfileirar, não
    // no retrato da lista.
    if(db.pediuDescadastro(destino)){
      db.marcarDestinatarioEnfileirado(campanha.id, destino);
      continue;
    }

    const conteudo = email.formatCampanhaEmail({
      assunto: campanha.assunto,
      chamada: campanha.chamada,
      corpo: campanha.corpo,
      produtos,
      shopUrl: origem,
      unsubscribeUrl: linkDeDescadastro(origem, destino),
    });

    const id = db.enqueueEmail({
      kind: "campanha",
      toEmail: destino,
      orderReference: `campanha:${campanha.id}:${destino}`,
      subject: conteudo.subject,
      textBody: conteudo.text,
      htmlBody: conteudo.html,
    });
    db.marcarDestinatarioEnfileirado(campanha.id, destino);
    if(id) novos++;
  }

  const contagem = db.contagemDaCampanha(campanha.id);
  if(contagem.enfileirados >= contagem.total) db.mudarStatusCampanha(campanha.id, "concluida");
  return { novos, contagem };
}

module.exports = { enfileirarLote, LOTE_PADRAO };
