/**
 * Conferência do token de "Entrar com o Google".
 *
 * O navegador recebe do Google um ID token (JWT assinado) e manda para cá.
 * Esse token é a única prova de quem está entrando, então ele precisa ser
 * conferido NO SERVIDOR — confiar no e-mail que o navegador diz ter seria o
 * mesmo que deixar qualquer pessoa entrar como qualquer outra.
 *
 * A conferência é feita chamando o endpoint /tokeninfo do próprio Google, sem
 * biblioteca nova, do mesmo jeito que o projeto já fala com o Melhor Envio e
 * com a API do WhatsApp. O caminho alternativo seria baixar as chaves
 * públicas (JWKS) e validar a assinatura aqui com node:crypto — vale a troca
 * se um dia o volume de logins crescer, porque tira uma ida à rede do meio do
 * login; com poucos acessos por dia, o endpoint é mais simples e não tem
 * cache de chave para errar.
 *
 * ⚠️ O /tokeninfo devolve TODO claim como texto: "exp":"1790000000" e
 * "email_verified":"true". Comparar email_verified === true recusaria 100%
 * dos logins válidos, e comparar exp como número compararia strings.
 *
 * ⚠️ Tudo falha FECHADO: rede fora do ar, resposta estranha, timeout ou
 * qualquer erro inesperado negam o login. Nunca o contrário.
 */
/* ⚠️ O endereço só é configurável FORA de produção — ele existe para o teste
   apontar para um Google falso local. Em produção, quem conseguisse escrever
   essa variável passaria a emitir sessão para qualquer e-mail, sem precisar
   de senha nenhuma: é a variável mais perigosa do arquivo. */
const TOKENINFO_PADRAO = "https://oauth2.googleapis.com/tokeninfo";
const EM_PRODUCAO = String(process.env.CLIENT_ORIGIN || "").startsWith("https://");
const TOKENINFO_URL = EM_PRODUCAO
  ? TOKENINFO_PADRAO
  : (process.env.GOOGLE_TOKENINFO_URL || TOKENINFO_PADRAO);

// Três blocos base64url separados por ponto. Conferido ANTES de montar a URL:
// um token com "&" ou "#" no meio viraria parâmetro extra na query.
const FORMATO_JWT = /^[A-Za-z0-9_-]{10,4000}\.[A-Za-z0-9_-]{10,4000}\.[A-Za-z0-9_-]{10,4000}$/;

const EMISSORES = new Set(["accounts.google.com", "https://accounts.google.com"]);

function ehVerdadeiro(valor){
  return valor === true || valor === "true";
}

function estaConfigurado(){
  return Boolean(process.env.GOOGLE_CLIENT_ID);
}

/**
 * Devolve { sub, email, nome } quando o token é legítimo, ou lança um erro
 * com `status` para a rota responder sem vazar detalhe para quem tentou.
 */
async function verificarTokenDoGoogle(credential){
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if(!clientId) throw Object.assign(new Error("Entrar com o Google não está configurado."), { status: 503 });
  if(typeof credential !== "string" || !FORMATO_JWT.test(credential)){
    throw Object.assign(new Error("Token do Google inválido."), { status: 400 });
  }

  let resposta;
  try{
    resposta = await fetch(`${TOKENINFO_URL}?id_token=${encodeURIComponent(credential)}`, {
      signal: AbortSignal.timeout(5000),
    });
  }catch(err){
    throw Object.assign(new Error("Não consegui falar com o Google agora."), { status: 502, causa: err.message });
  }
  if(!resposta.ok){
    throw Object.assign(new Error("Token do Google recusado."), { status: 401 });
  }

  let dados;
  try{
    dados = await resposta.json();
  }catch{
    throw Object.assign(new Error("Resposta do Google ilegível."), { status: 502 });
  }

  const recusa = (motivo) => Object.assign(new Error("Token do Google recusado."), { status: 401, motivo });

  if(dados.aud !== clientId) throw recusa("aud diferente do GOOGLE_CLIENT_ID");
  if(!EMISSORES.has(String(dados.iss || ""))) throw recusa("iss inesperado");
  if(!(Number(dados.exp) * 1000 > Date.now())) throw recusa("token vencido");
  if(!ehVerdadeiro(dados.email_verified)) throw recusa("e-mail não verificado no Google");
  if(!dados.email) throw recusa("token sem e-mail");
  if(!dados.sub) throw recusa("token sem sub");

  return { sub: String(dados.sub), email: String(dados.email), nome: dados.name || dados.given_name || "" };
}

module.exports = { verificarTokenDoGoogle, estaConfigurado };
