/**
 * =============================================================================
 *  AUTENTICAÇÃO — hashing de senha, sessões e validação de entrada
 * =============================================================================
 *  Decisões de segurança (por quê):
 *  - Sessão por cookie httpOnly (não JWT em localStorage): um JWT guardado em
 *    localStorage pode ser lido por qualquer script — inclusive um script
 *    injetado por XSS — e roubado. Um cookie httpOnly não pode ser lido por
 *    JavaScript, só é enviado automaticamente pelo navegador para o servidor.
 *  - O token de sessão é aleatório (crypto.randomBytes) e só o HASH dele fica
 *    no banco — se o arquivo do banco vazar, os tokens de sessão de verdade
 *    não podem ser reconstruídos a partir do que foi vazado.
 *  - Senhas usam bcrypt (custo 12): lento de propósito, torna ataques de
 *    força bruta/rainbow table inviáveis mesmo se o hash vazar.
 *  - Mensagens de erro de login são genéricas ("e-mail ou senha inválidos")
 *    para não revelar se um e-mail existe ou não (evita enumeração de contas).
 * =============================================================================
 */
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("./db");

const SESSION_COOKIE_NAME = "plc_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
const BCRYPT_COST = 12;

// Usado para comparar contra quando o e-mail informado não existe, mantendo
// o tempo de resposta do login parecido nos dois casos (mitiga enumeração
// de contas por análise de tempo de resposta).
const DUMMY_HASH = bcrypt.hashSync("senha-de-referencia-para-tempo-constante", BCRYPT_COST);

/* ------------------------------ SENHAS ------------------------------ */
async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_COST);
}
async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash || DUMMY_HASH);
}

/* ------------------------------ VALIDAÇÃO ------------------------------ */
function isValidEmail(v) {
  return typeof v === "string" && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
function normalizeEmail(v) {
  return String(v || "").trim().toLowerCase();
}
function isValidPassword(v) {
  // 72 BYTES (não caracteres) é o limite efetivo do bcrypt — acima disso ele
  // trunca silenciosamente, o que seria uma falha sutil de segurança. Por
  // isso medimos Buffer.byteLength em vez de v.length: uma senha com
  // acentos/emoji pode ter 72 *caracteres* e passar de 72 bytes em UTF-8
  // (ex.: "á" = 2 bytes), e v.length não pegaria isso.
  return typeof v === "string" && v.length >= 8 && Buffer.byteLength(v, "utf8") <= 72;
}
function isValidName(v) {
  return typeof v === "string" && v.trim().length >= 2 && v.trim().length <= 120;
}
// CEP guardado só com dígitos, para casar com o que o carrinho manda para
// /api/calculate-shipping (que também tira a máscara antes de consultar).
function normalizeCep(v) {
  return String(v || "").replace(/\D/g, "");
}
function isValidCep(v) {
  return /^\d{8}$/.test(v);
}
// CPF guardado só com dígitos, mesmo padrão do CEP acima.
function normalizeCpf(v) {
  return String(v || "").replace(/\D/g, "");
}
function isValidCpf(v) {
  if (!/^\d{11}$/.test(v)) return false;
  // Sequências como "00000000000" batem os dígitos verificadores pela
  // fórmula abaixo mas nunca são um CPF real — todo validador oficial as recusa.
  if (/^(\d)\1{10}$/.test(v)) return false;
  const digits = v.split("").map(Number);
  const checkDigit = (base) => {
    let sum = 0;
    for (let i = 0; i < base.length; i++) sum += base[i] * (base.length + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  if (checkDigit(digits.slice(0, 9)) !== digits[9]) return false;
  if (checkDigit(digits.slice(0, 10)) !== digits[10]) return false;
  return true;
}

// Campos obrigatórios de um endereço de entrega — usado tanto na validação
// do checkout (server.js: buildCheckoutDraft) quanto na do endereço salvo
// (PUT /api/auth/address), para as duas nunca divergirem sobre o que é
// "endereço completo". `complemento` fica de fora de propósito: é opcional.
// `cpf` é o do DESTINATÁRIO (pode não ser o mesmo da conta — presente de
// aniversário, etc.), pedido na hora de calcular o frete porque é ali que a
// tela já pede os outros dados de entrega; a etiqueta/nota fiscal usa esse
// valor, não o CPF cadastrado na conta.
const ADDRESS_REQUIRED_FIELDS = ["nome", "telefone", "rua", "numero", "bairro", "cidade", "uf", "cpf"];
function isValidAddress(address) {
  if (!address) return false;
  if (!ADDRESS_REQUIRED_FIELDS.every(f => String(address[f] || "").trim())) return false;
  // CPF recebe uma checagem própria (dígito verificador), não só "não
  // vazio" — os outros campos são texto livre, mas um CPF errado aqui vai
  // direto para uma etiqueta de envio de verdade.
  return isValidCpf(normalizeCpf(address.cpf));
}

/* ------------------------------ COOKIES ------------------------------ */
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(";").forEach(pair => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  });
  return out;
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS,
  };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/* ------------------------------ SESSÕES ------------------------------ */
function issueSession(res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.createSession({
    tokenHash: hashToken(token),
    userId,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  res.cookie(SESSION_COOKIE_NAME, token, cookieOptions());
}

function clearSession(req, res) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE_NAME];
  if (token) db.deleteSession(hashToken(token));
  res.clearCookie(SESSION_COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
}

/* ------------------- REDEFINIÇÃO DE SENHA ------------------- */
// Mesmo desenho das sessões: token aleatório entregue por e-mail, só o
// HASH gravado no banco. Validade curta (1h) e uso único — um link que
// vaze depois (histórico do navegador, e-mail encaminhado) não serve mais.
// 30 min: janela curta o bastante para um link que vaze depois (histórico,
// e-mail encaminhado, caixa de entrada compartilhada) já não servir, e longa
// o bastante para quem lê o e-mail no celular e só volta ao computador
// depois. Era 1h.
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

function issuePasswordReset(userId) {
  // Um link válido por vez: pedir um novo invalida o anterior, então um
  // link antigo esquecido na caixa de entrada deixa de funcionar.
  db.deletePasswordResetsForUser(userId);
  const token = crypto.randomBytes(32).toString("hex");
  db.createPasswordReset({
    tokenHash: hashToken(token),
    userId,
    expiresAt: Date.now() + PASSWORD_RESET_TTL_MS,
  });
  return token;
}

// Devolve o userId ou null. O registro é apagado ANTES da checagem de
// validade, de propósito: mesmo um token expirado é consumido na primeira
// tentativa, então ninguém pode ficar testando o mesmo valor repetidamente.
function consumePasswordReset(token) {
  if (!token || typeof token !== "string") return null;
  const row = db.getPasswordReset(hashToken(token));
  if (!row) return null;
  db.deletePasswordReset(row.token_hash);
  if (row.expires_at < Date.now()) return null;
  return row.user_id;
}

/* ------------------- BLOQUEIO POR FORÇA BRUTA ------------------- */
// O express-rate-limit já limita requisições por IP, mas ele conta TODAS as
// chamadas à rota (inclusive as bem-sucedidas) e não sabe contra qual conta
// a tentativa foi feita. Este bloqueio é a camada específica contra adivinhar
// a senha de UMA conta: 5 erros seguidos, 30 minutos parado.
//
// A chave é o par (e-mail, IP), não o e-mail sozinho, de propósito: travar
// só por e-mail deixaria qualquer pessoa trancar a lojista fora do próprio
// painel de fora, só errando a senha dela 5 vezes. O par mantém o atacante
// com 5 tentativas, sem entregar esse botão de sabotagem.
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCKOUT_MS = 30 * 60 * 1000;

// req.ip depende do trust proxy configurado no server.js (ver o comentário
// lá) — sem ele, atrás do proxy da hospedagem todo mundo viraria o mesmo IP.
function clientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || "desconhecido");
}

function checkLoginLockout(email, ip) {
  return db.getLoginLockout({
    email,
    ip,
    maxFailures: LOGIN_MAX_FAILURES,
    windowMs: LOGIN_LOCKOUT_MS,
  });
}

/* ------------------- VERIFICAÇÃO EM DUAS ETAPAS (TOTP) ------------------- */
// TOTP escrito à mão (RFC 6238) em vez de uma biblioteca: o algoritmo inteiro
// são ~40 linhas sobre o crypto que já vem no Node, e uma dependência a mais
// num fluxo de autenticação é justamente onde menos se quer código de
// terceiro que ninguém revisa. Compatível com Google Authenticator, Authy,
// 1Password e afins — todos implementam este mesmo RFC.
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
// Aceita até 4 passos antes/depois do atual (~2min de folga garantida): o
// relógio do celular quase nunca bate exatamente com o do servidor, e uma
// janela de só ±1 passo (~30-60s) já foi curta demais na prática — um
// celular com "hora automática" desligada ou recém trocado de fuso ficava
// recusando o código certo o tempo todo. O custo em segurança é
// desprezível (9 códigos válidos por vez em vez de 3, entre 1 milhão de
// combinações, sempre atrás de senha + bloqueio por tentativas).
const TOTP_WINDOW = 4;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buffer) {
  let bits = 0, value = 0, out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const char of String(str).toUpperCase().replace(/=+$/, "")) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// 20 bytes = 160 bits, o tamanho recomendado pelo RFC 4226 para HMAC-SHA1.
function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function totpCodeAt(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  // Truncamento dinâmico do RFC 4226: os 4 bits finais escolhem de onde no
  // hash os 4 bytes do código saem, para não usar sempre a mesma posição.
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) |
                 ((hmac[offset + 1] & 0xff) << 16) |
                 ((hmac[offset + 2] & 0xff) << 8) |
                 (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

function verifyTotp(secret, code) {
  const clean = String(code || "").replace(/\D/g, "");
  if (!secret || clean.length !== TOTP_DIGITS) return false;
  const counter = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
  const expected = Buffer.from(clean);
  for (let drift = -TOTP_WINDOW; drift <= TOTP_WINDOW; drift++) {
    const candidate = Buffer.from(totpCodeAt(secret, counter + drift));
    // timingSafeEqual pelo mesmo motivo do isAdminEmail: não deixar o tempo
    // de resposta contar quantos dígitos bateram.
    if (candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)) {
      return true;
    }
  }
  return false;
}

// URI que o app de autenticação lê do QR code (padrão key-uri do Google).
function totpAuthUri({ secret, email, issuer }) {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({
    secret, issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* Códigos de recuperação: a única entrada se o celular sumir. São mostrados
   UMA vez, no momento da ativação, e só o hash bcrypt fica guardado — pelo
   mesmo motivo da senha, já que valem exatamente o mesmo acesso. */
const RECOVERY_CODE_COUNT = 8;

function generateRecoveryCodes() {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    // 5 bytes = 10 hex, quebrado em dois blocos para ficar legível na hora
    // de anotar no papel (é para isso que eles servem).
    crypto.randomBytes(5).toString("hex").toUpperCase().replace(/^(.{5})(.{5})$/, "$1-$2")
  );
}
async function hashRecoveryCodes(codes) {
  return Promise.all(codes.map(c => bcrypt.hash(c, BCRYPT_COST)));
}
/* Consome um código: devolve a lista de hashes restante (sem o usado) ou
   null se não bateu nenhum. Uso único — um código anotado e já gasto não
   abre a porta de novo. */
async function consumeRecoveryCode(code, hashes) {
  const clean = String(code || "").trim().toUpperCase();
  if (!clean) return null;
  for (let i = 0; i < hashes.length; i++) {
    if (await bcrypt.compare(clean, hashes[i])) {
      return hashes.filter((_, idx) => idx !== i);
    }
  }
  return null;
}

/* Desafio de 2ª etapa: entre "senha certa" e "código certo" o usuário ainda
   NÃO tem sessão. Este token curto (5 min) é o que liga as duas chamadas,
   sem nunca deixar um cookie de sessão válido ser emitido cedo demais. */
const TWO_FACTOR_CHALLENGE_TTL_MS = 5 * 60 * 1000;

function issueTwoFactorChallenge(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.createTwoFactorChallenge({
    tokenHash: hashToken(token),
    userId,
    expiresAt: Date.now() + TWO_FACTOR_CHALLENGE_TTL_MS,
  });
  return token;
}
// Não consome aqui: um código TOTP errado não pode queimar o desafio, senão
// um dígito digitado errado obrigaria a refazer o login inteiro.
function peekTwoFactorChallenge(token) {
  if (!token || typeof token !== "string") return null;
  const row = db.getTwoFactorChallenge(hashToken(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.deleteTwoFactorChallenge(row.token_hash);
    return null;
  }
  return row.user_id;
}
function consumeTwoFactorChallenge(token) {
  if (!token || typeof token !== "string") return;
  db.deleteTwoFactorChallenge(hashToken(token));
}

/* --------------- CÓDIGO POR E-MAIL (alternativa ao app) --------------- */
// Terceira porta de entrada do 2º fator, além do app e dos códigos de
// recuperação — pensada para quando a lojista perdeu o celular E não tem
// nenhum código de recuperação anotado. Fica presa ao MESMO desafio de
// login (nunca flutua sozinha), então um login abandonado não deixa um
// código válido perdido por aí.
const EMAIL_2FA_CODE_TTL_MS = 10 * 60 * 1000; // mais folga que os 5min do desafio: abrir e-mail demora mais que abrir o app já instalado
const EMAIL_2FA_RESEND_COOLDOWN_MS = 60 * 1000; // evita bombardear a caixa/SMTP num duplo-clique
const EMAIL_2FA_MAX_ATTEMPTS = 5; // tentativas contra ESTE código específico, além do bloqueio geral por (email, ip)

function generateEmailTwoFactorCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

// Gera e grava um código novo para o desafio, respeitando o cooldown de
// reenvio. O código em texto puro só existe no valor de retorno, para a
// chamadora mandar por e-mail — nunca é persistido, só o hash bcrypt (é um
// segredo curto/baixa entropia, como os códigos de recuperação — não um
// token de 256 bits, que dispensaria esse custo).
async function issueTwoFactorEmailCode(challengeToken) {
  const userId = peekTwoFactorChallenge(challengeToken);
  if (!userId) return { error: "expired" };
  const user = db.getUserById(userId);
  if (!user?.totp_secret) {
    consumeTwoFactorChallenge(challengeToken);
    return { error: "expired" };
  }
  const tokenHash = hashToken(challengeToken);
  const row = db.getTwoFactorChallenge(tokenHash);
  const now = Date.now();
  if (row.email_code_sent_at && now - row.email_code_sent_at < EMAIL_2FA_RESEND_COOLDOWN_MS) {
    return { error: "cooldown", retryAfterMs: EMAIL_2FA_RESEND_COOLDOWN_MS - (now - row.email_code_sent_at) };
  }
  const code = generateEmailTwoFactorCode();
  const codeHash = await bcrypt.hash(code, BCRYPT_COST);
  const codeExpiresAt = now + EMAIL_2FA_CODE_TTL_MS;
  db.setTwoFactorEmailCode({
    tokenHash, codeHash, codeExpiresAt, sentAt: now,
    challengeExpiresAt: Math.max(row.expires_at, codeExpiresAt),
  });
  return { code, user };
}

// Confere o código emailado para este desafio. Não consome sozinho — quem
// consome (apaga o desafio inteiro, código incluso) é o sucesso geral da
// rota de login, igual já acontece para TOTP e código de recuperação.
async function verifyTwoFactorEmailCode(challengeToken, code) {
  if (!challengeToken || typeof challengeToken !== "string") return false;
  const tokenHash = hashToken(challengeToken);
  const row = db.getTwoFactorChallenge(tokenHash);
  if (!row || !row.email_code_hash) return false;
  if (row.email_code_expires_at && row.email_code_expires_at < Date.now()) return false;
  if (row.email_code_attempts >= EMAIL_2FA_MAX_ATTEMPTS) return false;
  const clean = String(code || "").replace(/\D/g, "");
  if (clean.length !== 6) return false;
  const match = await bcrypt.compare(clean, row.email_code_hash);
  if (!match) {
    db.incrementTwoFactorEmailCodeAttempts(tokenHash);
    return false;
  }
  return true;
}

/* ------------------------------ ADMIN ------------------------------ */
// Não existe uma tabela/coluna "role": o acesso de administrador é dado por
// e-mail, via ADMIN_EMAIL_HASHES no .env (lista de hashes SHA-256,
// separados por vírgula — nunca o e-mail em texto puro). Isso evita uma
// migração de schema e uma tela de "promover usuário a admin" — quem tem
// acesso ao .env do servidor já é, por definição, de confiança.
//
// Por que hash em vez do e-mail direto: se o .env vazar por engano (log,
// captura de tela, backup mal guardado), quem ler não descobre de cara
// qual é o e-mail com acesso de admin — só um hash. Isso NÃO é o que
// impede um cliente comum de virar admin mexendo no DevTools (isso já é
// impossível por construção: o cookie de sessão é um token aleatório
// opaco, sem papel/role nenhum embutido, e o servidor recalcula
// isAdminEmail() a cada requisição a partir da sessão — nunca confia em
// nada que o navegador declare sobre si mesmo). O hash é uma camada a
// mais, especificamente contra vazamento do próprio arquivo .env.
function hashEmail(email) {
  return crypto.createHash("sha256").update(normalizeEmail(email)).digest("hex");
}
function isAdminEmail(email) {
  if (!email) return false;
  const candidate = Buffer.from(hashEmail(email), "hex");
  const adminHashes = String(process.env.ADMIN_EMAIL_HASHES || "")
    .split(",")
    .map(h => h.trim().toLowerCase())
    .filter(Boolean);
  // timingSafeEqual em vez de === / includes(): evita que o tempo de
  // resposta vaze informação sobre quantos bytes do hash bateram (mesmo
  // racional do DUMMY_HASH usado no login, acima).
  return adminHashes.some(stored => {
    const storedBuf = Buffer.from(stored, "hex");
    return storedBuf.length === candidate.length && crypto.timingSafeEqual(storedBuf, candidate);
  });
}

function getUserFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;
  const session = db.getSessionByTokenHash(hashToken(token));
  if (!session) return null;
  const user = db.getUserById(session.user_id);
  if (!user) return null;
  // cpf vai junto (mesmo padrão de cep): o carrinho usa para pré-preencher
  // o CPF do destinatário no checkout, poupando quem compra de digitar de
  // novo o que já deu no cadastro (continua editável — o pacote pode ser
  // presente para outra pessoa).
  return { id: user.id, name: user.name, email: user.email, cep: user.cep || null, cpf: user.cpf || null, isAdmin: isAdminEmail(user.email) };
}

/* ------------------------------ MIDDLEWARES ------------------------------ */
function attachUser(req, res, next) {
  req.user = getUserFromRequest(req);
  next();
}
function requireAuth(req, res, next) {
  req.user = getUserFromRequest(req);
  if (!req.user) {
    return res.status(401).json({ error: "Faça login para continuar." });
  }
  next();
}
// Painel administrativo e suas rotas de API (/api/admin/*): exige sessão
// válida E e-mail com hash cadastrado em ADMIN_EMAIL_HASHES. Resposta
// genérica 403 (não revela se a rota existiria para outro usuário).
function requireAdmin(req, res, next) {
  req.user = getUserFromRequest(req);
  if (!req.user) {
    return res.status(401).json({ error: "Faça login para continuar." });
  }
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: "Acesso restrito ao administrador da loja." });
  }
  next();
}

// 2FA obrigatório para admin. Fica separado de requireAdmin porque as rotas
// de CADASTRO do 2FA (/api/admin/2fa/setup e /activate) precisam passar só
// pelo requireAdmin — senão não haveria como ativar pela primeira vez: o
// acesso exigiria um 2FA que só se ativa com acesso.
//
// A saída de emergência é ADMIN_2FA_REQUIRED=false no .env, para o caso de
// perder o celular E os códigos de recuperação. Quem tem o .env já controla
// o servidor inteiro, então isso não afrouxa nada que já não estivesse nas
// mãos dessa pessoa.
const ADMIN_2FA_REQUIRED = String(process.env.ADMIN_2FA_REQUIRED || "true").toLowerCase() !== "false";

function requireAdminTwoFactor(req, res, next) {
  if (!ADMIN_2FA_REQUIRED) return next();
  const user = db.getUserById(req.user.id);
  if (!user?.totp_secret) {
    // 403 com uma marca que o painel entende: ele troca a tela pela de
    // cadastro do 2FA em vez de mostrar "acesso negado" sem saída.
    return res.status(403).json({
      error: "Ative a verificação em duas etapas para usar o painel.",
      needsTwoFactorSetup: true,
    });
  }
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  isValidEmail,
  normalizeEmail,
  isValidPassword,
  isValidName,
  normalizeCep,
  isValidCep,
  normalizeCpf,
  isValidCpf,
  isValidAddress,
  issueSession,
  clearSession,
  issuePasswordReset,
  consumePasswordReset,
  PASSWORD_RESET_TTL_MS,
  attachUser,
  requireAuth,
  requireAdmin,
  requireAdminTwoFactor,
  clientIp,
  checkLoginLockout,
  LOGIN_MAX_FAILURES,
  LOGIN_LOCKOUT_MS,
  generateTotpSecret,
  verifyTotp,
  totpAuthUri,
  generateRecoveryCodes,
  hashRecoveryCodes,
  consumeRecoveryCode,
  issueTwoFactorChallenge,
  peekTwoFactorChallenge,
  consumeTwoFactorChallenge,
  issueTwoFactorEmailCode,
  verifyTwoFactorEmailCode,
  EMAIL_2FA_CODE_TTL_MS,
  ADMIN_2FA_REQUIRED,
  // Exportado só para o login/cadastro poderem devolver `isAdmin` junto da
  // resposta (o front decide para onde redirecionar). Continua sendo o
  // servidor quem calcula — nada que o navegador mande é levado em conta.
  isAdminEmail,
};
