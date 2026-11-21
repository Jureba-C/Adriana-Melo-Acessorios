/**
 * =============================================================================
 *  FEED AUTOMÁTICO DO INSTAGRAM — seção "nossa história" (index.html)
 * =============================================================================
 *  Usa a "Instagram API with Instagram Login" oficial da Meta
 *  (graph.instagram.com) — o caminho atual que NÃO exige vincular uma
 *  Página do Facebook, via fetch nativo, sem SDK nem dependência nova
 *  (mesma abordagem "sem SDK" já usada em lib/whatsapp.js).
 *
 *  🔑 Credenciais e passo a passo de configuração: docs/instagram-setup.md
 *  e server/.env.example (INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_APP_SECRET).
 *
 *  O token de longa duração dura 60 dias. Este módulo guarda o token
 *  ATUAL no banco (db.getInstagramToken/saveInstagramToken), nunca no
 *  .env — o .env só serve para SEMEAR o primeiro token, uma vez; depois
 *  disso o banco é a fonte da verdade, porque cada renovação troca o
 *  valor do token e um processo Node não deveria reescrever seu próprio
 *  .env como mecanismo de persistência.
 *
 *  Criar o app da Meta e autorizar a conta @adriana_melo_acessorios exige
 *  login no painel do Meta Developers — isso só pode ser feito por quem
 *  tem acesso à conta, nunca por este assistente.
 *
 *  Se não houver token configurado, ou se qualquer chamada à Graph API
 *  falhar (token revogado, rede fora, rate limit), getInstagramFeed()
 *  NUNCA lança exceção: devolve { available: false } e loga o motivo no
 *  servidor. A rota (server.js) e o frontend (js/instagram-feed.js)
 *  tratam isso como "mostra o botão Seguir no Instagram", sem quebrar a
 *  página. O token de acesso nunca é incluído na resposta — só dados já
 *  públicos do Instagram (username, foto de perfil, imagem/link de cada
 *  post).
 * =============================================================================
 */

const db = require("./db");

const GRAPH_HOST = "https://graph.instagram.com";
const GRAPH_VERSION = "v25.0";

// Renova o token bem antes do vencimento de 60 dias — folga generosa para
// absorver o servidor ficar dias sem receber uma requisição na rota (ela
// só é revisada quando alguém abre a home, não por um cron dedicado).
const REFRESH_THRESHOLD_MS = 45 * 24 * 60 * 60 * 1000;

// Cache em memória: evita bater na Graph API a cada carregamento da home.
// Indisponibilidade tem TTL bem menor — se a lojista acabou de configurar
// o token, o site se recupera sozinho em minutos, não numa hora.
const CACHE_TTL_MS = 60 * 60 * 1000;
const UNAVAILABLE_CACHE_TTL_MS = 5 * 60 * 1000;

let cache = { data: null, expiresAt: 0 };

// SVG inline (data URI) só para o QA visual local ter algo pra mostrar no
// lugar de uma foto real — nunca aparece com credenciais de verdade.
function mockSquare(hex) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="${hex}"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
const MOCK_HEXES = ["#F4B4CC", "#EA8FB4", "#DD6E9B", "#FAD3E1", "#C05480", "#FBDCE8"];

/** Feed fixo para QA visual local, sem rede nem credenciais — ver docs/instagram-setup.md. */
const MOCK_FEED = {
  available: true,
  username: "adriana_melo_acessorios",
  profilePictureUrl: mockSquare("#DD6E9B"),
  posts: MOCK_HEXES.map((hex, i) => ({
    id: `mock-${i}`,
    permalink: "https://www.instagram.com/adriana_melo_acessorios/",
    caption: `Post de exemplo ${i + 1}`,
    displayUrl: mockSquare(hex),
  })),
};

async function refreshLongLivedToken(currentToken) {
  const url = `${GRAPH_HOST}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(currentToken)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    throw new Error(data?.error?.message || `refresh_access_token respondeu ${res.status}`);
  }
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

async function fetchProfile(token) {
  const url = `${GRAPH_HOST}/${GRAPH_VERSION}/me?fields=username,profile_picture_url&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    throw new Error(data?.error?.message || `/me respondeu ${res.status}`);
  }
  return data;
}

async function fetchRecentMedia(token, limit = 6) {
  const url = `${GRAPH_HOST}/${GRAPH_VERSION}/me/media?fields=id,caption,media_type,media_url,permalink,thumbnail_url,timestamp&limit=${limit}&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    throw new Error(data?.error?.message || `/me/media respondeu ${res.status}`);
  }
  return data.data || [];
}

/**
 * Mapeia um item cru da Graph API para o que o frontend precisa. Vídeo
 * não tem uma "foto" fixa em media_url utilizável como capa — usa
 * thumbnail_url. Função pura, sem chamada de rede, para ser fácil de
 * testar com fixtures.
 */
function mapMediaItem(item) {
  return {
    id: item.id,
    permalink: item.permalink,
    caption: item.caption || "",
    displayUrl: item.media_type === "VIDEO" ? item.thumbnail_url : item.media_url,
  };
}

/**
 * Garante um token de longa duração utilizável, renovando-o se estiver
 * perto do vencimento. Semeia o banco a partir do .env na primeira vez.
 * Devolve null se nada estiver configurado (nem banco, nem .env).
 */
async function ensureFreshToken() {
  let stored = db.getInstagramToken();

  if (!stored) {
    const envToken = process.env.INSTAGRAM_ACCESS_TOKEN;
    if (!envToken) return null;
    stored = { accessToken: envToken, refreshedAt: Date.now() };
    db.saveInstagramToken(stored);
  }

  const age = Date.now() - stored.refreshedAt;
  if (age > REFRESH_THRESHOLD_MS) {
    try {
      const refreshed = await refreshLongLivedToken(stored.accessToken);
      stored = { accessToken: refreshed.accessToken, refreshedAt: Date.now() };
      db.saveInstagramToken(stored);
    } catch (err) {
      // Falha na renovação (rede instável, etc.) não deve derrubar o feed
      // agora — segue com o token atual; se ele realmente estiver morto,
      // a chamada seguinte (fetchProfile/fetchRecentMedia) vai falhar de
      // forma limpa e getInstagramFeed() trata isso como indisponível.
      console.error("[instagram] falha ao renovar o token:", err.message);
    }
  }

  return stored.accessToken;
}

function buildUnavailable() {
  return { available: false };
}

function setCache(data, ttlMs) {
  cache = { data, expiresAt: Date.now() + ttlMs };
}

/**
 * Ponto de entrada usado pela rota GET /api/instagram/feed. Nunca lança
 * exceção — qualquer falha vira { available: false }, logada aqui.
 */
async function getInstagramFeed() {
  if (process.env.NODE_ENV !== "production" && process.env.INSTAGRAM_MOCK_FEED === "true") {
    return MOCK_FEED;
  }

  if (Date.now() < cache.expiresAt) {
    return cache.data;
  }

  try {
    const token = await ensureFreshToken();
    if (!token) {
      const result = buildUnavailable();
      setCache(result, UNAVAILABLE_CACHE_TTL_MS);
      return result;
    }

    const [profile, media] = await Promise.all([fetchProfile(token), fetchRecentMedia(token, 6)]);
    const result = {
      available: true,
      username: profile.username,
      profilePictureUrl: profile.profile_picture_url || "",
      posts: media.map(mapMediaItem),
    };
    setCache(result, CACHE_TTL_MS);
    return result;
  } catch (err) {
    console.error("[instagram] falha ao buscar feed:", err.message);
    const result = buildUnavailable();
    setCache(result, UNAVAILABLE_CACHE_TTL_MS);
    return result;
  }
}

/**
 * Apaga o token salvo no banco e o cache em memória — usada pelo botão
 * "Reconectar" do painel. Sem isto, trocar INSTAGRAM_ACCESS_TOKEN no .env
 * (ou nas variáveis de ambiente do painel de hospedagem) não tem efeito
 * nenhum depois da primeira vez que o servidor rodou com um valor
 * preenchido: ensureFreshToken() só volta a ler o .env quando não encontra
 * nada salvo no banco.
 */
function resetToken() {
  db.deleteInstagramToken();
  cache = { data: null, expiresAt: 0 };
}

/**
 * Testa a conexão agora, sem cache — usada pelo botão "Reconectar" do
 * painel para dar um retorno imediato e específico, em vez do genérico
 * { available: false } que a rota pública devolve. Nunca lança: a mensagem
 * de erro devolvida é a mesma da Graph API que hoje só aparecia no log do
 * servidor (ex.: "Cannot parse access token").
 */
async function testConnection() {
  try {
    const token = await ensureFreshToken();
    if (!token) {
      return { ok: false, error: "INSTAGRAM_ACCESS_TOKEN não está definido (nem no .env, nem salvo no banco)." };
    }
    const profile = await fetchProfile(token);
    return { ok: true, username: profile.username };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { getInstagramFeed, mapMediaItem, resetToken, testConnection };
