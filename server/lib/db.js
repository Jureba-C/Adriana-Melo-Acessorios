/**
 * =============================================================================
 *  BANCO DE DADOS — usuários, sessões e pedidos
 * =============================================================================
 *  Usa `node:sqlite` (nativo do Node 22.5+, sem dependência externa) em vez de
 *  um ORM ou um banco separado — é um arquivo único (`server/data.db`, fora do
 *  git, ver .gitignore) suficiente para o volume de uma loja pequena/média.
 *
 *  Todas as consultas usam parâmetros (`?`), nunca concatenação de string —
 *  isso é o que elimina a superfície de SQL Injection.
 * =============================================================================
 */
const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const crypto = require("crypto");
const { diasDoFrete } = require("./prazoFrete.js");

// ".." porque este arquivo mora em server/lib/ e o banco fica na raiz da
// aplicação (server/), ao lado do server.js — é lá que o data.db já existe
// nas instalações antigas. Em produção o caminho vem do DB_PATH, que aponta
// para fora da pasta publicada, para o banco sobreviver a cada deploy.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data.db");
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  -- Redefinição de senha: mesma ideia da tabela sessions — só o HASH do
  -- token fica gravado, então nem quem lê o banco consegue reconstruir um
  -- link de redefinição válido.
  CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    external_reference  TEXT NOT NULL UNIQUE,
    user_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status              TEXT NOT NULL DEFAULT 'pendente',
    items_json          TEXT NOT NULL,
    address_json        TEXT NOT NULL,
    shipping_json       TEXT NOT NULL,
    coupon_code         TEXT,
    subtotal            REAL NOT NULL,
    discount            REAL NOT NULL DEFAULT 0,
    -- Desconto do Pix guardado separado do desconto de cupom: são duas
    -- linhas diferentes no resumo do pedido ("Desconto (CUPOM)" e "Desconto
    -- Pix"), e somar os dois numa coluna só tornaria impossível remontar o
    -- recibo depois.
    pix_discount        REAL NOT NULL DEFAULT 0,
    promo_discount      REAL NOT NULL DEFAULT 0,
    payment_method      TEXT NOT NULL DEFAULT 'card',
    shipping_price      REAL NOT NULL,
    total               REAL NOT NULL,
    payment_id          TEXT,
    tracking_code       TEXT,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
  );

  -- Bytes das fotos de produto enviadas pelo painel. Guardadas aqui (e não
  -- em arquivo no disco) porque só data.db tem backup automático
  -- (server/scripts/backup-db.js) — uma pasta de upload em disco é apagada
  -- por qualquer redeploy que reinstale a aplicação do zero (ver comentário
  -- de UPLOAD DE FOTO DE PRODUTO em server.js). Cada linha é um upload;
  -- nunca é sobrescrita no lugar (um novo upload sempre ganha um id novo),
  -- então a rota que serve por id pode cachear como "immutable".
  CREATE TABLE IF NOT EXISTS product_photos (
    id          TEXT PRIMARY KEY,
    mime_type   TEXT NOT NULL,
    data        BLOB NOT NULL,
    created_at  INTEGER NOT NULL
  );

  -- Versões reduzidas de product_photos, gravadas no primeiro acesso àquela
  -- largura/formato. É cache, não fonte: apagar a tabela só custa ~35ms de
  -- sharp no próximo acesso. O CASCADE impede a variante de sobreviver à foto
  -- que a originou quando o painel troca a imagem de um produto.
  CREATE TABLE IF NOT EXISTS product_photo_variants (
    photo_id    TEXT NOT NULL REFERENCES product_photos(id) ON DELETE CASCADE,
    width       INTEGER NOT NULL,
    format      TEXT NOT NULL,
    mime_type   TEXT NOT NULL,
    data        BLOB NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (photo_id, width, format)
  );

  -- Edições feitas no painel administrativo (nome/preço/foto) por cima do
  -- catálogo estático em PRODUCTS (server.js). Uma linha por produto só
  -- quando ele foi editado; sem edição, o servidor usa o valor de PRODUCTS
  -- direto (ver effectiveProduct em server.js).
  CREATE TABLE IF NOT EXISTS product_overrides (
    product_id  INTEGER PRIMARY KEY,
    name        TEXT,
    price       REAL,
    photo_url   TEXT,
    category    TEXT,
    badges      TEXT,
    updated_at  INTEGER NOT NULL
  );

  -- Cupons criados pelo painel administrativo. BEMVINDA10 (o único cupom
  -- fixo que existia antes) é semeado aqui automaticamente na primeira
  -- vez que o servidor sobe com um banco novo/antigo sem essa tabela (ver
  -- seedDefaultCoupon logo abaixo) — depois disso, este banco é a única
  -- fonte da verdade pra cupom (nada mais fica hardcoded em server.js).
  -- Quem pediu o cupom de boas-vindas na home. Antes o e-mail só ia para o
  -- console e se perdia — a lista da loja nascia e morria no log.
  CREATE TABLE IF NOT EXISTS newsletter_subscribers (
    email      TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );

  -- Mensagens do formulário "Vamos criar seu laço?" da home. Antes iam só
  -- para o console: quem escrevesse enquanto o servidor estivesse fora do
  -- ar, ou quando ninguém lesse o log, era simplesmente perdida.
  CREATE TABLE IF NOT EXISTS contact_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    nome       TEXT NOT NULL,
    telefone   TEXT NOT NULL,
    ocasiao    TEXT,
    mensagem   TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  /* Fila de e-mails para a CLIENTE. Aviso para a lojista pode falhar calado
     (ela vê o pedido no painel de qualquer jeito); recibo de compra não pode.
     Uma falha de SMTP dentro do try/catch do webhook não deixava rastro
     nenhum, e o site promete rastreio por e-mail na própria página.
     Aqui a mensagem é gravada ANTES de tentar enviar: se a tentativa na hora
     falhar, o cron periódico reenvia. */
  CREATE TABLE IF NOT EXISTS email_outbox (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kind            TEXT NOT NULL,
    to_email        TEXT NOT NULL,
    subject         TEXT NOT NULL,
    text_body       TEXT NOT NULL,
    html_body       TEXT NOT NULL,
    order_reference TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    sent_at         INTEGER,
    last_error      TEXT,
    created_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS coupons (
    code         TEXT PRIMARY KEY,
    percent_off  REAL NOT NULL,
    description  TEXT,
    created_at   INTEGER NOT NULL
  );

  -- Produtos criados pelo painel administrativo (botão "Adicionar produto"),
  -- em vez de editados no catálogo fixo PRODUCTS (server.js). Diferente de
  -- product_overrides (que só sobrepõe nome/preço/foto por cima de uma base
  -- fixa), esta tabela é a base inteira: também guarda peso/dimensões,
  -- porque não existe entrada em PRODUCTS para herdar isso. O id é atribuído
  -- pelo código (ver nextCustomProductId), a partir de 1000, para nunca
  -- colidir com os ids 1-8 do catálogo fixo.
  CREATE TABLE IF NOT EXISTS custom_products (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    price       REAL NOT NULL,
    weight      REAL NOT NULL,
    width       REAL NOT NULL,
    height      REAL NOT NULL,
    length      REAL NOT NULL,
    category    TEXT,
    photo_url   TEXT,
    badges      TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  -- Categorias criadas pelo painel administrativo (botão "Nova categoria"),
  -- além das 5 fixas em PRODUCT_CATEGORIES (server.js). O slug é o valor
  -- salvo em product_overrides.category/custom_products.category e usado
  -- nos chips de filtro da vitrine; o label é só o texto exibido.
  CREATE TABLE IF NOT EXISTS custom_categories (
    slug        TEXT PRIMARY KEY,
    label       TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  -- Cores de laço criadas pelo painel administrativo ("+ Nova cor"), além
  -- das 6 fixas em js/colors.js (RIBBON_COLORS). Mesmo papel de
  -- custom_categories: o hex é o valor salvo em
  -- product_overrides.available_colors/custom_products.available_colors e
  -- escolhido pela cliente no Quick View; o label é só o texto exibido.
  CREATE TABLE IF NOT EXISTS custom_colors (
    hex         TEXT PRIMARY KEY,
    label       TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  /* Índices. Sem eles o SQLite varre a tabela inteira a cada consulta —
     imperceptível com centenas de pedidos, caro com dezenas de milhares.
     Só entram colunas que aparecem de fato em WHERE/ORDER BY das queries
     deste arquivo; índice que ninguém usa não acelera leitura nenhuma e
     ainda encarece toda escrita.

     Não estão aqui, de propósito: as colunas com UNIQUE ou PRIMARY KEY
     (users.email, orders.external_reference, coupons.code,
     sessions.token_hash, ...), porque o SQLite já cria um índice
     implícito para elas — declarar de novo seria duplicar. */
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);

  /* Painel filtrando por status e ordenando por data. As duas colunas
     no mesmo índice, nesta ordem: com um índice só de status o SQLite
     achava as linhas mas ainda ordenava tudo à parte (USE TEMP B-TREE);
     incluindo created_at DESC a ordem já sai pronta do índice.

     Não há índice de coupon_code: medindo com 20 mil pedidos, o
     otimizador sempre prefere user_id ou customer_phone na validação de
     cupom (são bem mais seletivos que um código repetido em milhares de
     pedidos). Um índice que nunca é escolhido não acelera leitura e
     encarece toda escrita. */
  CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at DESC);
  -- Histórico do cliente e listagens sem filtro, do mais recente ao mais antigo.
  CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
  -- Limpeza de sessões/tokens vencidos (WHERE expires_at < agora).
  -- O webhook do Mercado Pago reenvia notificação: sem esta trava a cliente
  -- receberia o mesmo recibo duas vezes.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_unico
    ON email_outbox(kind, order_reference) WHERE order_reference IS NOT NULL;
  -- Varredura do cron: só o que ainda não saiu e já pode ser tentado.
  CREATE INDEX IF NOT EXISTS idx_outbox_pendentes
    ON email_outbox(next_attempt_at) WHERE sent_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_resets_expires ON password_resets(expires_at);
`);

// `orders` já existia (com dados reais) antes da coluna `tracking_code` ser
// criada — `CREATE TABLE IF NOT EXISTS` acima não adiciona colunas a uma
// tabela que já existe, então garantimos aqui, em bancos antigos, do mesmo
// jeito que uma migração faria (nome de tabela/coluna são strings fixas
// definidas neste arquivo, nunca entrada externa, então não há risco de
// injeção no ALTER TABLE abaixo).
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn("orders", "tracking_code", "TEXT");
// Pedidos criados antes da forma de pagamento existir são todos de cartão
// (era a única opção), então o DEFAULT já deixa o histórico correto.
ensureColumn("orders", "pix_discount", "REAL NOT NULL DEFAULT 0");
ensureColumn("orders", "promo_discount", "REAL NOT NULL DEFAULT 0");
ensureColumn("orders", "payment_method", "TEXT NOT NULL DEFAULT 'card'");
ensureColumn("product_overrides", "category", "TEXT");
ensureColumn("product_overrides", "badges", "TEXT");
// NCM: a loja parou de emitir nota fiscal, então nada mais escreve aqui.
// As colunas ficam porque apagar coluna em SQLite é recriar a tabela, e
// o que já foi classificado continua guardado caso a nota volte um dia.
// ⚠️ Os dois ensureColumn continuam obrigatórios: os INSERT/UPDATE de
// produto mais abaixo ainda citam a coluna ncm, e sem ela um banco novo
// quebra no primeiro cadastro.
ensureColumn("product_overrides", "ncm", "TEXT");
ensureColumn("custom_products", "ncm", "TEXT");
// Cores em estoque (array JSON de hex da paleta em js/colors.js). NULL
// significa "nunca editado pela lojista" -> todas as cores disponíveis
// (effectiveProduct() aplica esse default). Diferente de badges: aqui um
// array VAZIO é um estado real ("esgotado em todas as cores"), então
// upsertProductOverride/updateCustomProduct NUNCA colapsam [] para NULL
// como fazem com badges.
ensureColumn("product_overrides", "available_colors", "TEXT");
ensureColumn("custom_products", "available_colors", "TEXT");
// Galeria de fotos (array JSON de URLs, na ordem de exibição — a primeira
// é a capa). NULL significa "nunca editado nesta coluna": effectiveProduct()
// nesse caso cai para a foto única antiga (photo_url), então produtos que já
// tinham uma foto salva antes desta coluna existir continuam funcionando sem
// migração. Mesmo cuidado de available_colors: [] explícito é um estado real
// ("removeu todas as fotos"), nunca colapsa para NULL.
ensureColumn("product_overrides", "photos", "TEXT");
ensureColumn("custom_products", "photos", "TEXT");
// "Vender em conjunto" — libera a 2ª cor opcional no Quick View (kits com
// mais de uma peça, onde a cliente pode querer metade numa cor e metade em
// outra). Booleano simples (0/1): diferente de available_colors/photos,
// NULL e 0 significam a MESMA coisa ("desligado") — não existe aqui a
// distinção "nunca editado" vs. "editado e vazio de propósito" que aquelas
// duas colunas precisam.
ensureColumn("product_overrides", "allow_second_color", "INTEGER");
ensureColumn("custom_products", "allow_second_color", "INTEGER");
// Descrição do produto. NULL = nunca customizada -> o front-end usa a
// descrição padrão (a dos 8 produtos fixos, ou o texto genérico para
// produto novo criado pelo painel) — mesmo racional de name/price:
// string vazia limpa de volta pro padrão, não há distinção NULL-vs-vazio
// especial como em available_colors/photos.
ensureColumn("product_overrides", "description", "TEXT");
ensureColumn("custom_products", "description", "TEXT");
// Posição do produto na vitrine, definida pela lojista no painel. Fica nas
// DUAS tabelas porque produto fixo do catálogo e produto criado no painel
// moram em lugares diferentes, e a ordem precisa valer para os dois na
// mesma lista. NULL = nunca ordenado: esses vão para o fim, preservando a
// ordem antiga (catálogo primeiro, criados depois) enquanto a lojista não
// mexer — e é também onde um produto novo entra, sem furar a fila.
ensureColumn("product_overrides", "sort_order", "INTEGER");
ensureColumn("custom_products", "sort_order", "INTEGER");
// Produto oculto da vitrine (a lojista quis "remover" um produto que não
// pode ser apagado de verdade, ou pausar temporariamente um produto criado
// no painel). Booleano simples, mesmo racional de allow_second_color — só
// esconde da listagem pública (/api/products) e do checkout; o painel
// continua mostrando e permitindo reativar.
ensureColumn("product_overrides", "hidden", "INTEGER");
ensureColumn("custom_products", "hidden", "INTEGER");
// Produto esgotado: continua aparecendo na vitrine (diferente de `hidden`),
// mas com selo "Esgotado" e sem poder ser comprado. Substitui o controle de
// estoque que antes era feito desmarcando todas as cores do produto — as
// cores saíram do site, e sem isto a loja ficaria sem nenhuma forma de
// marcar algo como indisponível.
ensureColumn("product_overrides", "sold_out", "INTEGER");
ensureColumn("custom_products", "sold_out", "INTEGER");
// Telefone só com dígitos, copiado do endereço na hora de gravar o pedido.
// É o único identificador que sobra para quem compra sem conta — sem uma
// coluna própria, casar "(61) 98274-9808" com "61982749808" dentro do JSON
// do endereço seria frágil demais para valer como controle de uso de cupom.
ensureColumn("orders", "customer_phone", "TEXT");
/* Cópia do e-mail no momento da compra, em vez de buscar em `users` na hora
   de enviar: conta apagada não pode quebrar o recibo de um pedido que
   existiu. Mesma lógica do address_json, que também é uma fotografia. */
ensureColumn("orders", "customer_email", "TEXT");
// O índice de customer_phone fica AQUI, e não junto dos demais lá em cima:
// a coluna é criada por este ensureColumn, então num banco antigo ela ainda
// não existiria no momento em que o bloco CREATE TABLE roda.
db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(customer_phone);`);
// Estado de produção/postagem — ORTOGONAL ao status de pagamento (`status`
// acima, que só fala de dinheiro: pago/pendente/recusado/etc). NULL até o
// pagamento ser aprovado (um pedido pendente não está "em produção" de
// nada); o webhook do Mercado Pago grava 'em_producao' assim que aprova;
// updateOrderTracking grava 'postado' assim que um código de rastreio é
// salvo (manual ou via etiqueta); um botão do painel grava 'entregue'.
// Sem CHECK/enum de propósito — mesmo racional do `status` de pagamento:
// validação de valor aceito vive no JS (server.js), não no schema.
ensureColumn("orders", "fulfillment_status", "TEXT");
// Marcados na mesma hora que fulfillment_status vira 'postado'/'entregue',
// respectivamente — dão a data para a linha do tempo da página de
// acompanhamento sem precisar reconsultar o Melhor Envio toda vez.
ensureColumn("orders", "shipped_at", "INTEGER");
ensureColumn("orders", "delivered_at", "INTEGER");
// Id do envio devolvido por POST /me/cart ao comprar a etiqueta
// (purchaseShippingLabel, em server.js) — antes descartado em memória assim
// que a etiqueta era gerada. Precisa ficar salvo porque a consulta de
// rastreio ao vivo (POST /me/shipment/tracking) acontece depois, numa
// requisição separada, feita quando a cliente abre a página de
// acompanhamento.
ensureColumn("orders", "melhor_envio_shipment_id", "TEXT");
// Nota fiscal — ver server/lib/notaFiscal.js. status começa "nao_emitida"
// em todo pedido antigo (a coluna nasce NULL; tratado como "não emitida"
// no código que lê, nunca aqui, para não ter que reescrever o histórico).
ensureColumn("orders", "nfe_status", "TEXT");
ensureColumn("orders", "nfe_number", "TEXT");
ensureColumn("orders", "nfe_url", "TEXT");
ensureColumn("orders", "nfe_error", "TEXT");
// Cupom de uso único por cliente (ex.: o de boas-vindas). Fica no cupom, e
// não no código, para a loja poder ter os dois tipos.
ensureColumn("coupons", "once_per_customer", "INTEGER NOT NULL DEFAULT 0");
// CEP informado no cadastro (só dígitos), usado para já preencher o frete
// e o endereço no carrinho. Fica nulo para quem criou conta antes disso
// existir — o carrinho simplesmente não pré-preenche nesse caso.
ensureColumn("users", "cep", "TEXT");
// CPF (só dígitos) — substituiu o CEP como campo de cadastro a partir daqui;
// contas criadas antes continuam com cep preenchido e cpf nulo, e vice-versa
// daqui pra frente. Sem UNIQUE de propósito: e-mail já é a chave de conta.
ensureColumn("users", "cpf", "TEXT");
// Endereço de entrega salvo (mesmo formato do address_json de orders, com
// cep incluído) para pré-preencher o checkout nas próximas compras. Um só
// endereço por cliente — não é histórico nem lista, é sobrescrito a cada
// compra em que a cliente deixa marcada a opção "salvar para próximas
// compras" (server.js: buildCheckoutDraft). Some junto quando a conta é
// excluída, por já viver na própria linha de users (deleteUserAccount).
ensureColumn("users", "saved_address_json", "TEXT");
// Descadastro da newsletter: token aleatório (mesmo padrão de sessions/
// password_resets) para o link do e-mail funcionar sem exigir login, e
// unsubscribed_at para parar de contar essa inscritа em qualquer envio
// futuro (hoje só o cupom de boas-vindas é enviado, mas a coluna já existe
// para quando houver um segundo envio para a lista).
ensureColumn("newsletter_subscribers", "unsubscribe_token", "TEXT");
ensureColumn("newsletter_subscribers", "unsubscribed_at", "INTEGER");
/* Separa quem PEDIU para receber (bloco dos 10% na home) de quem só ganhou
   uma linha aqui para ter link de descadastro válido — o lembrete de
   carrinho esquecido precisa de um, e sem linha o token some no vazio e o
   link não descadastra ninguém. Só quem tem opt_in_at entra em envio de
   novidades. Linha antiga é toda do bloco dos 10%, por isso o backfill. */
ensureColumn("newsletter_subscribers", "opt_in_at", "INTEGER");
db.exec(`UPDATE newsletter_subscribers SET opt_in_at = created_at WHERE opt_in_at IS NULL`);

// Verificação em duas etapas (TOTP) — só para quem é admin, mas as colunas
// ficam em `users` porque é onde a identidade mora. Ficam nulas para todo
// mundo que não ativou. O segredo é gravado em base32 puro de propósito:
// cifrá-lo aqui não protegeria nada, já que a chave da cifra teria que
// ficar no mesmo servidor que o banco — quem consegue ler data.db também
// leria a chave. A defesa real do segredo é o acesso ao arquivo.
ensureColumn("users", "totp_secret", "TEXT");
ensureColumn("users", "totp_enabled_at", "INTEGER");
// Códigos de recuperação, um array JSON de hashes bcrypt (nunca em texto):
// são a única saída se a lojista perder o celular, então valem tanto quanto
// a senha e recebem o mesmo tratamento.
ensureColumn("users", "totp_recovery_json", "TEXT");
// Perfil editável em "Minha conta". phone só com dígitos; birth_date em
// YYYY-MM-DD (opcional — usado só para o cupom de aniversário).
ensureColumn("users", "phone", "TEXT");
ensureColumn("users", "birth_date", "TEXT");

/* Entrar com o Google. `google_id` é o `sub` do token — o identificador
   estável da conta Google, que não muda nem quando a pessoa troca o e-mail
   lá. Índice parcial porque quase toda linha é NULL.

   `sem_senha` marca quem nasceu pelo Google e nunca escolheu senha. É um
   sinalizador invertido de propósito: uma coluna "tem_senha" precisaria de
   backfill a cada boot (como o opt_in_at acima) e um dia marcaria como
   "tem senha" justamente quem não tem. NULL/0 = todo mundo que já existia.

   ⚠️ password_hash é NOT NULL e o SQLite não afrouxa isso sem reconstruir a
   tabela. Conta criada pelo Google recebe hash de um segredo aleatório que
   ninguém conhece — ninguém entra com ele, e "esqueci a senha" continua
   sendo o caminho para definir uma de verdade. */
ensureColumn("users", "google_id", "TEXT");
ensureColumn("users", "sem_senha", "INTEGER");
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google
           ON users(google_id) WHERE google_id IS NOT NULL`);

// Auditoria de login: toda tentativa entra aqui, com sucesso ou sem. Serve
// para duas coisas distintas — o bloqueio por força bruta (contar falhas
// recentes) e o registro de "quem tentou entrar, de onde, quando", que
// antes não existia em lugar nenhum.
db.exec(`
  CREATE TABLE IF NOT EXISTS login_attempts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT    NOT NULL,
    ip         TEXT    NOT NULL,
    ok         INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_login_attempts_lookup
    ON login_attempts(email, ip, created_at);
  CREATE INDEX IF NOT EXISTS idx_login_attempts_time
    ON login_attempts(created_at);

  CREATE TABLE IF NOT EXISTS two_factor_challenges (
    token_hash TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// Token de acesso do Instagram (Instagram API with Instagram Login,
// graph.instagram.com) usado pelo feed automático da seção "nossa
// história" (GET /api/instagram/feed, server/lib/instagram.js). Linha
// única (id sempre 1, CHECK garante isso): só existe UM token vigente da
// loja; refreshed_at diz quando foi renovado pela última vez, pra saber
// quando pedir um novo antes dos 60 dias de validade vencerem.
db.exec(`
  CREATE TABLE IF NOT EXISTS instagram_tokens (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    access_token TEXT    NOT NULL,
    refreshed_at INTEGER NOT NULL
  );
`);

// Retorno por e-mail do 2FA: colunas extras na PRÓPRIA linha do desafio
// (não uma tabela nova) — o código emailado só pode valer para ESTE
// desafio específico, e como token_hash já é a chave desse desafio, essas
// colunas amarram os dois de graça, sem FK/join. NULL = nenhum código
// pedido ainda para este desafio.
ensureColumn("two_factor_challenges", "email_code_hash", "TEXT");
ensureColumn("two_factor_challenges", "email_code_expires_at", "INTEGER");
ensureColumn("two_factor_challenges", "email_code_attempts", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("two_factor_challenges", "email_code_sent_at", "INTEGER");
/* Quantos códigos por e-mail já foram pedidos neste desafio, e quando ele
   nasceu. Sem os dois, cada reenvio zerava as tentativas e empurrava a
   validade: o desafio de 5 minutos virava eterno e o código de 6 dígitos
   ganhava chances infinitas. */
ensureColumn("two_factor_challenges", "email_code_resends", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("two_factor_challenges", "created_at", "INTEGER");

/* =========================================================================
   AVALIAÇÕES DE PRODUTO
   -------------------------------------------------------------------------
   Uma avaliação por produto por pedido (índice único) — reenviar o
   formulário substitui a pendente em vez de duplicar.

   ⚠️ Nasce SEMPRE 'pendente' e só aparece no site depois que a lojista
   publica pelo painel: é texto (e às vezes foto de criança) enviado por
   qualquer pessoa com o link.

   Nome exibido é só o primeiro nome + cidade/UF, COPIADOS do pedido na hora
   de gravar: a vitrine nunca precisa ler address_json (que tem CPF,
   telefone e endereço completo) para montar a seção da home.

   Fotos em tabela própria, e não em product_photos: a rota pública de foto
   de produto serve qualquer id, e foto de avaliação não pode ser acessível
   por link antes de publicada.
========================================================================= */
db.exec(`
  CREATE TABLE IF NOT EXISTS review_photos (
    id          TEXT PRIMARY KEY,
    mime_type   TEXT NOT NULL,
    data        BLOB NOT NULL,
    created_at  INTEGER NOT NULL
  );

  -- Tamanhos reduzidos (160/640) das fotos de avaliação. É cache: apagar
  -- custa só um sharp no próximo pedido. CASCADE: excluir a foto (recusa da
  -- lojista) leva as variantes junto — foto recusada não sobra em tamanho
  -- nenhum.
  CREATE TABLE IF NOT EXISTS review_photo_variants (
    photo_id    TEXT NOT NULL REFERENCES review_photos(id) ON DELETE CASCADE,
    width       INTEGER NOT NULL,
    format      TEXT NOT NULL,
    mime_type   TEXT NOT NULL,
    data        BLOB NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (photo_id, width, format)
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    order_reference     TEXT NOT NULL,
    product_id          INTEGER NOT NULL,
    rating              INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment             TEXT,
    photo_id            TEXT REFERENCES review_photos(id) ON DELETE SET NULL,
    photo_consent_at    INTEGER,
    status              TEXT NOT NULL DEFAULT 'pendente'
                        CHECK (status IN ('pendente', 'publicada', 'oculta')),
    customer_first_name TEXT,
    customer_city       TEXT,
    created_at          INTEGER NOT NULL,
    published_at        INTEGER
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_pedido_produto
    ON reviews(order_reference, product_id);
  CREATE INDEX IF NOT EXISTS idx_reviews_publicadas
    ON reviews(status, published_at DESC);

  -- Fotos do carrossel do topo da home, trocadas pelo painel. A coluna data
  -- guarda o original recebido (só reorientado e limitado a 1600px); o recorte
  -- 4:5 que a home usa é feito na variante, para a lojista poder mudar o
  -- enquadramento sem reenviar o arquivo.
  --
  -- Tabela própria, e não product_photos: a rota pública de foto de produto
  -- serve qualquer id no tamanho do catálogo, e aqui o que sai é sempre
  -- recortado em 4:5 — misturar os dois faria uma foto de topo aparecer
  -- esticada como se fosse de produto.
  --
  -- Zero linhas é um estado normal, não um erro: a home volta para as fotos
  -- fixas de img/hero-*, que é como o site nasceu.
  CREATE TABLE IF NOT EXISTS hero_photos (
    id          TEXT PRIMARY KEY,
    position    INTEGER NOT NULL,
    alt         TEXT NOT NULL,
    legenda     TEXT NOT NULL,
    focus       TEXT NOT NULL DEFAULT 'center'
                CHECK (focus IN ('top', 'center', 'bottom')),
    mime_type   TEXT NOT NULL,
    data        BLOB NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_hero_photos_ordem ON hero_photos(position);

  -- Recortes 4:5 (480/960, webp e jpeg) gerados no primeiro acesso. É cache:
  -- CASCADE porque trocar a foto ou o enquadramento tem de invalidar todos
  -- os tamanhos — variante velha sobrevivendo seria a foto antiga servida
  -- para quem pedisse aquela largura.
  CREATE TABLE IF NOT EXISTS hero_photo_variants (
    photo_id    TEXT NOT NULL REFERENCES hero_photos(id) ON DELETE CASCADE,
    width       INTEGER NOT NULL,
    format      TEXT NOT NULL,
    mime_type   TEXT NOT NULL,
    data        BLOB NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (photo_id, width, format)
  );

  -- Elogios que a cliente mandou POR FORA do site (WhatsApp, Instagram) e
  -- autorizou publicar. Tabela separada de reviews de propósito, e o motivo
  -- não é o formato: é que toda linha de reviews hoje é compra verificada, e
  -- o site afirma isso em cada card ("Compra verificada"). Guardar aqui o que
  -- não passou por pedido mantém aquela afirmação verdadeira por construção,
  -- e mantém notaMedia() contando só o que pode virar nota.
  --
  -- Não tem coluna de nota, e isso é deliberado: mensagem de WhatsApp não vem
  -- com estrela. Atribuir uma seria inventar exatamente o dado que separar as
  -- duas tabelas existe para não inventar. No lugar das estrelas o card mostra
  -- de onde a mensagem veio.
  --
  -- consentimento_em é obrigatório: sem a lojista confirmar que a cliente
  -- autorizou, a rota recusa. É a linha entre publicar elogio real e inventar.
  CREATE TABLE IF NOT EXISTS depoimentos (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    texto            TEXT NOT NULL,
    cliente_nome     TEXT NOT NULL,
    cliente_cidade   TEXT,
    origem           TEXT NOT NULL CHECK (origem IN ('whatsapp', 'instagram')),
    photo_id         TEXT REFERENCES review_photos(id) ON DELETE SET NULL,
    consentimento_em INTEGER NOT NULL,
    posicao          INTEGER NOT NULL,
    status           TEXT NOT NULL DEFAULT 'publicado'
                     CHECK (status IN ('publicado', 'oculto')),
    created_at       INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_depoimentos_ordem ON depoimentos(status, posicao);

  -- Campanhas de novidades para quem deixou o e-mail no bloco dos 10%.
  -- O corpo é TEXTO, nunca HTML: quem escreve é a lojista, o HTML é montado
  -- por lib/email.js a partir dele, e assim não existe a pergunta "e se ela
  -- colar um <script>".
  CREATE TABLE IF NOT EXISTS campanhas (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    assunto      TEXT NOT NULL,
    chamada      TEXT,
    corpo        TEXT NOT NULL,
    produtos     TEXT,
    status       TEXT NOT NULL DEFAULT 'rascunho'
                 CHECK (status IN ('rascunho', 'enviando', 'concluida', 'cancelada')),
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    iniciada_em  INTEGER,
    concluida_em INTEGER
  );

  -- Retrato da lista no momento do disparo: quem se inscrever depois não
  -- recebe esta campanha, e quem se descadastrar entre o disparo e o envio
  -- é checado de novo na hora de enfileirar (é a checagem que importa).
  CREATE TABLE IF NOT EXISTS campanha_destinatarios (
    campanha_id  INTEGER NOT NULL REFERENCES campanhas(id) ON DELETE CASCADE,
    email        TEXT NOT NULL,
    enfileirado_em INTEGER,
    PRIMARY KEY (campanha_id, email)
  );

  CREATE INDEX IF NOT EXISTS idx_campanha_fila
    ON campanha_destinatarios(campanha_id) WHERE enfileirado_em IS NULL;

  -- Uma linha por chave. Hoje só guarda a última rodada do cron
  -- (tarefas_periodicas_em), para o painel denunciar quando o agendamento
  -- no hPanel não existe ou parou.
  CREATE TABLE IF NOT EXISTS app_state (
    chave       TEXT PRIMARY KEY,
    valor       TEXT,
    updated_at  INTEGER NOT NULL
  );
`);
// Token do link "avaliar / confirmar recebimento" mandado por e-mail. Vale
// sem login de propósito: quem recebe o e-mail do pedido é quem comprou, e
// pedir login ali derruba a taxa de resposta. Criado sob demanda
// (garantirTokenDeAvaliacao), nunca junto com o pedido.
ensureColumn("orders", "review_token", "TEXT");

// Garante que o cupom que já existia fixo no código (BEMVINDA10) continua
// funcionando depois da migração pra banco — só insere se a tabela
// coupons estiver vazia (banco novo, ou banco de antes dessa tabela
// existir), nunca sobrescreve um cupom que a lojista já tenha editado/
// apagado de propósito pelo painel.
function seedDefaultCoupon() {
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM coupons`).get();
  if (count === 0) {
    db.prepare(
      `INSERT INTO coupons (code, percent_off, description, created_at, once_per_customer)
       VALUES (?, ?, ?, ?, 1)`
    ).run("BEMVINDA10", 10, "10% de desconto — primeira compra", Date.now());
  }
  // Bancos criados antes da coluna existir têm BEMVINDA10 com o DEFAULT 0.
  // Ele é o cupom de "primeira compra": tem que ser de uso único mesmo em
  // quem já rodava o site antes desta versão.
  db.prepare(`UPDATE coupons SET once_per_customer = 1 WHERE code = 'BEMVINDA10'`).run();
}
seedDefaultCoupon();

/* Cupom de aniversário: semeado UMA vez (marca em app_state). Se a lojista
   apagar pelo painel, não volta sozinho — e o cron para de mandar o e-mail.
   once_per_customer fica 0 porque a regra dele é por ANO, não para sempre:
   quem trava é regraDoCupomDeAniversario (server.js) + hasUsedCouponSince. */
const CUPOM_ANIVERSARIO = "ANIVERSARIO10";
function seedBirthdayCoupon() {
  const marca = db.prepare(`SELECT 1 FROM app_state WHERE chave = 'cupom_aniversario_semeado'`).get();
  if (marca) return;
  db.prepare(
    `INSERT OR IGNORE INTO coupons (code, percent_off, description, created_at, once_per_customer)
     VALUES (?, ?, ?, ?, 0)`
  ).run(CUPOM_ANIVERSARIO, 10, "Aniversário — só a aniversariante logada, até 30 dias após a data", Date.now());
  db.prepare(`INSERT OR REPLACE INTO app_state (chave, valor, updated_at) VALUES ('cupom_aniversario_semeado', '1', ?)`).run(Date.now());
}
seedBirthdayCoupon();

/* ---------------------------- USERS ---------------------------- */
const stmtInsertUser = db.prepare(
  `INSERT INTO users (name, email, password_hash, cpf, google_id, sem_senha, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const stmtGetUserByEmail = db.prepare(`SELECT * FROM users WHERE email = ?`);
const stmtGetUserById = db.prepare(`SELECT * FROM users WHERE id = ?`);

function createUser({ name, email, passwordHash, cpf, googleId, semSenha }) {
  const info = stmtInsertUser.run(
    name, email, passwordHash, cpf || null,
    googleId || null, semSenha ? 1 : 0, Date.now()
  );
  return getUserById(Number(info.lastInsertRowid));
}

const stmtGetUserByGoogleId = db.prepare(`SELECT * FROM users WHERE google_id = ?`);
function getUserByGoogleId(googleId) {
  return googleId ? (stmtGetUserByGoogleId.get(googleId) || null) : null;
}

const stmtSetUserGoogleId = db.prepare(
  `UPDATE users SET google_id = ? WHERE id = ? AND google_id IS NULL`
);
// Só grava se ainda estiver vazio: duas contas Google diferentes apontando
// para o mesmo usuário seria uma porta de entrada, não uma conveniência.
function setUserGoogleId(userId, googleId) {
  return stmtSetUserGoogleId.run(googleId, userId).changes > 0;
}
function getUserByEmail(email) {
  return stmtGetUserByEmail.get(email) || null;
}
function getUserById(id) {
  return stmtGetUserById.get(id) || null;
}

const stmtSaveAddress = db.prepare(`UPDATE users SET saved_address_json = ? WHERE id = ?`);
function getSavedAddress(userId) {
  const user = getUserById(userId);
  if (!user || !user.saved_address_json) return null;
  try {
    return JSON.parse(user.saved_address_json);
  } catch {
    return null;
  }
}
function saveAddress(userId, address) {
  stmtSaveAddress.run(JSON.stringify(address), userId);
}

const stmtUpdatePerfil = db.prepare(`UPDATE users SET name = ?, phone = ?, birth_date = ? WHERE id = ?`);
function updatePerfil(userId, { name, phone, birthDate }) {
  stmtUpdatePerfil.run(name, phone || null, birthDate || null, userId);
}
const stmtUpdateUserEmail = db.prepare(`UPDATE users SET email = ? WHERE id = ?`);
function updateUserEmail(userId, email) {
  stmtUpdateUserEmail.run(email, userId);
}

// Aniversariantes do dia (mês-dia), com e-mail. O ano entra na chave de
// deduplicação da fila, não aqui.
const stmtAniversariantes = db.prepare(
  `SELECT id, name, email FROM users WHERE birth_date IS NOT NULL AND substr(birth_date, 6, 5) = ?`
);
function aniversariantesDoDia(mesDia) {
  return stmtAniversariantes.all(mesDia);
}

// Usuários para a exportação em planilha (painel admin). Traz SÓ colunas
// não sensíveis — nunca password_hash, totp_secret nem totp_recovery_json —
// e expõe apenas se o 2FA está ligado (booleano), não o segredo em si.
const stmtListUsersForExport = db.prepare(
  `SELECT id, name, email, cpf, created_at,
          CASE WHEN totp_enabled_at IS NOT NULL THEN 1 ELSE 0 END AS has_2fa
     FROM users ORDER BY id`
);
function listUsersForExport() {
  return stmtListUsersForExport.all();
}

/* Contas para o painel saber quem CRIOU CONTA e nunca comprou — o
   /api/admin/customers monta a lista a partir dos pedidos, então quem nunca
   chegou ao checkout não aparecia em lugar nenhum.

   saved_address_json entra junto só pelo telefone: é o único lugar onde existe
   telefone de quem nunca fez pedido, e é o que permite o botão de WhatsApp.
   Nada de password_hash, totp_secret nem totp_recovery_json — mesma regra do
   stmtListUsersForExport acima. */
const stmtListAccountsForAdmin = db.prepare(
  `SELECT id, name, email, created_at, saved_address_json, phone, birth_date
     FROM users ORDER BY created_at DESC`
);
// "15/03" — o painel mostra só dia/mês: o ano (idade) não serve para nada
// ali e é dado a mais exposto.
function aniversarioCurto(birthDate) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(birthDate || ""));
  return m ? `${m[2]}/${m[1]}` : null;
}
function listAccountsForAdmin() {
  return stmtListAccountsForAdmin.all().map((u) => {
    let telefone = null;
    try {
      telefone = u.saved_address_json ? JSON.parse(u.saved_address_json)?.telefone || null : null;
    } catch {
      telefone = null;
    }
    return {
      id: u.id, name: u.name, email: u.email, createdAt: u.created_at,
      telefone: u.phone || telefone,
      aniversario: aniversarioCurto(u.birth_date),
    };
  });
}

/* --------------------------- SESSIONS --------------------------- */
const stmtInsertSession = db.prepare(
  `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`
);
const stmtGetSession = db.prepare(`SELECT * FROM sessions WHERE token_hash = ?`);
const stmtDeleteSession = db.prepare(`DELETE FROM sessions WHERE token_hash = ?`);
const stmtDeleteExpiredSessions = db.prepare(`DELETE FROM sessions WHERE expires_at < ?`);
const stmtDeleteUserSessions = db.prepare(`DELETE FROM sessions WHERE user_id = ?`);

function createSession({ tokenHash, userId, expiresAt }) {
  stmtInsertSession.run(tokenHash, userId, Date.now(), expiresAt);
}
function getSessionByTokenHash(tokenHash) {
  stmtDeleteExpiredSessions.run(Date.now());
  return stmtGetSession.get(tokenHash) || null;
}
function deleteSession(tokenHash) {
  stmtDeleteSession.run(tokenHash);
}
function deleteAllSessionsForUser(userId) {
  stmtDeleteUserSessions.run(userId);
}
const stmtDeleteOtherSessions = db.prepare(`DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?`);
function deleteOtherSessions(userId, tokenHashAtual) {
  return stmtDeleteOtherSessions.run(userId, tokenHashAtual).changes;
}

/* --------------------- REDEFINIÇÃO DE SENHA --------------------- */
const stmtInsertPasswordReset = db.prepare(
  `INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`
);
const stmtGetPasswordReset = db.prepare(`SELECT * FROM password_resets WHERE token_hash = ?`);
const stmtDeletePasswordReset = db.prepare(`DELETE FROM password_resets WHERE token_hash = ?`);
const stmtDeleteUserPasswordResets = db.prepare(`DELETE FROM password_resets WHERE user_id = ?`);
const stmtDeleteExpiredPasswordResets = db.prepare(`DELETE FROM password_resets WHERE expires_at < ?`);
const stmtUpdateUserPassword = db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`);

function createPasswordReset({ tokenHash, userId, expiresAt }) {
  stmtInsertPasswordReset.run(tokenHash, userId, Date.now(), expiresAt);
}
function getPasswordReset(tokenHash) {
  // Mesmo padrão de getSessionByTokenHash: a limpeza dos expirados acontece
  // na leitura, então não é preciso uma rotina agendada só para isso.
  stmtDeleteExpiredPasswordResets.run(Date.now());
  return stmtGetPasswordReset.get(tokenHash) || null;
}
function deletePasswordReset(tokenHash) {
  stmtDeletePasswordReset.run(tokenHash);
}
function deletePasswordResetsForUser(userId) {
  stmtDeleteUserPasswordResets.run(userId);
}
function updateUserPassword(userId, passwordHash) {
  stmtUpdateUserPassword.run(passwordHash, userId);
  // Definiu senha de verdade: deixa de ser conta só-Google, e as telas que
  // dependem disso (trocar senha, excluir conta) voltam ao normal.
  stmtLimpaSemSenha.run(userId);
}
const stmtLimpaSemSenha = db.prepare(`UPDATE users SET sem_senha = 0 WHERE id = ?`);

/* --------------------- EXCLUSÃO DE CONTA (LGPD art. 18) --------------------- */
// Apaga a conta e os dados pessoais do titular, MAS mantém o histórico
// financeiro dos pedidos (valores, datas, itens) — que a legislação fiscal
// exige reter — de forma ANONIMIZADA: o endereço e o telefone (PII) são
// removidos de cada pedido e o vínculo com o usuário é desfeito. Assim,
// atende ao direito de exclusão sem violar a obrigação de guarda contábil.
const stmtAnonymizeUserOrders = db.prepare(
  `UPDATE orders SET address_json = '{"anonimizado":true}', customer_phone = NULL WHERE user_id = ?`
);
const stmtDeleteNewsletterByEmail = db.prepare(`DELETE FROM newsletter_subscribers WHERE email = ?`);
const stmtDeleteLoginAttemptsByEmail = db.prepare(`DELETE FROM login_attempts WHERE email = ?`);
const stmtDeleteUserById = db.prepare(`DELETE FROM users WHERE id = ?`);

const stmtDeleteAniversarioPendente = db.prepare(
  `DELETE FROM email_outbox WHERE kind = 'aniversario' AND sent_at IS NULL AND order_reference LIKE ?`
);
function deleteUserAccount(userId) {
  const user = getUserById(userId);
  if (!user) return false;
  db.exec("BEGIN");
  try {
    // 1) Anonimiza os pedidos ANTES de apagar o usuário (enquanto user_id
    //    ainda aponta para ele). Remove PII, preserva o financeiro.
    stmtAnonymizeUserOrders.run(userId);
    // 2) Remove tudo que é identidade/credencial/rastreio do titular.
    deleteAllSessionsForUser(userId);
    deletePasswordResetsForUser(userId);
    stmtDeleteNewsletterByEmail.run(user.email);
    stmtDeleteLoginAttemptsByEmail.run(user.email);
    // Cupom de aniversário ainda na fila não pode sair para quem apagou a conta.
    stmtDeleteAniversarioPendente.run(`aniversario:${userId}:%`);
    // 3) Apaga o usuário. orders.user_id vira NULL (ON DELETE SET NULL) e
    //    two_factor_challenges some (ON DELETE CASCADE).
    stmtDeleteUserById.run(userId);
    db.exec("COMMIT");
    return true;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/* ------------------- AUDITORIA DE LOGIN / FORÇA BRUTA ------------------- */
const stmtInsertLoginAttempt = db.prepare(
  `INSERT INTO login_attempts (email, ip, ok, created_at) VALUES (?, ?, ?, ?)`
);
// Só as falhas POSTERIORES ao último sucesso contam para o bloqueio: quem
// acertou a senha zera o contador, senão um acerto no meio de tentativas
// erradas (typo, typo, senha certa) deixaria o cadeado armado à toa.
const stmtLastSuccessAt = db.prepare(
  `SELECT MAX(created_at) AS at FROM login_attempts WHERE email = ? AND ip = ? AND ok = 1`
);
const stmtRecentFailures = db.prepare(
  `SELECT created_at FROM login_attempts
    WHERE email = ? AND ip = ? AND ok = 0 AND created_at > ?
    ORDER BY created_at ASC`
);
const stmtListLoginAttempts = db.prepare(
  `SELECT email, ip, ok, created_at FROM login_attempts
    WHERE created_at > ? ORDER BY created_at DESC LIMIT ?`
);
// A auditoria não precisa virar histórico eterno num banco de arquivo único.
const stmtPruneLoginAttempts = db.prepare(`DELETE FROM login_attempts WHERE created_at < ?`);

function recordLoginAttempt({ email, ip, ok }) {
  stmtInsertLoginAttempt.run(String(email || ""), String(ip || ""), ok ? 1 : 0, Date.now());
}

/* Devolve { locked, failures, retryAfterMs }.
   A janela é deslizante: as falhas antigas saem sozinhas dela conforme o
   tempo passa, então o bloqueio se desfaz sem precisar de rotina agendada
   nem de uma coluna "bloqueado até". */
function getLoginLockout({ email, ip, maxFailures, windowMs }) {
  const now = Date.now();
  const since = Math.max(
    now - windowMs,
    Number(stmtLastSuccessAt.get(String(email || ""), String(ip || ""))?.at) || 0
  );
  const failures = stmtRecentFailures.all(String(email || ""), String(ip || ""), since);
  if (failures.length < maxFailures) {
    return { locked: false, failures: failures.length, retryAfterMs: 0 };
  }
  // Destranca quando a falha mais antiga do lote sair da janela.
  const oldest = failures[failures.length - maxFailures].created_at;
  return {
    locked: true,
    failures: failures.length,
    retryAfterMs: Math.max(0, oldest + windowMs - now),
  };
}

function listRecentLoginAttempts({ sinceMs, limit = 200 }) {
  return stmtListLoginAttempts.all(Date.now() - sinceMs, limit);
}
function pruneLoginAttempts(olderThanMs) {
  stmtPruneLoginAttempts.run(Date.now() - olderThanMs);
}

/* ------------------- VERIFICAÇÃO EM DUAS ETAPAS (TOTP) ------------------- */
const stmtSetTotp = db.prepare(
  `UPDATE users SET totp_secret = ?, totp_enabled_at = ?, totp_recovery_json = ? WHERE id = ?`
);
const stmtInsertChallenge = db.prepare(
  `INSERT INTO two_factor_challenges (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`
);
const stmtGetChallenge = db.prepare(`SELECT * FROM two_factor_challenges WHERE token_hash = ?`);
const stmtDeleteChallenge = db.prepare(`DELETE FROM two_factor_challenges WHERE token_hash = ?`);
const stmtDeleteExpiredChallenges = db.prepare(
  `DELETE FROM two_factor_challenges WHERE expires_at < ?`
);
const stmtSetTwoFactorEmailCode = db.prepare(`
  UPDATE two_factor_challenges
  SET email_code_hash = ?, email_code_expires_at = ?, email_code_attempts = 0,
      email_code_sent_at = ?, expires_at = ?, email_code_resends = ?
  WHERE token_hash = ?
`);
const stmtIncrementEmailCodeAttempts = db.prepare(
  `UPDATE two_factor_challenges SET email_code_attempts = email_code_attempts + 1 WHERE token_hash = ?`
);

// secret/recoveryJson nulos = 2FA desligado (é assim que a desativação passa).
function setUserTotp(userId, { secret, recoveryJson }) {
  stmtSetTotp.run(secret || null, secret ? Date.now() : null, recoveryJson || null, userId);
}
function createTwoFactorChallenge({ tokenHash, userId, expiresAt }) {
  stmtInsertChallenge.run(tokenHash, userId, expiresAt, Date.now());
}
function getTwoFactorChallenge(tokenHash) {
  stmtDeleteExpiredChallenges.run(Date.now());
  return stmtGetChallenge.get(tokenHash) || null;
}
function deleteTwoFactorChallenge(tokenHash) {
  stmtDeleteChallenge.run(tokenHash);
}
// Grava um código novo (substitui qualquer código anterior do mesmo
// desafio) e estende expires_at do desafio para acompanhar o prazo do
// código, já que pedir por e-mail pode levar mais tempo que os 5min padrão.
function setTwoFactorEmailCode({ tokenHash, codeHash, codeExpiresAt, sentAt, challengeExpiresAt, resends }) {
  stmtSetTwoFactorEmailCode.run(codeHash, codeExpiresAt, sentAt, challengeExpiresAt, resends ?? 0, tokenHash);
}
function incrementTwoFactorEmailCodeAttempts(tokenHash) {
  stmtIncrementEmailCodeAttempts.run(tokenHash);
}

/* ---------------------------- ORDERS ---------------------------- */
const stmtInsertOrder = db.prepare(`
  INSERT INTO orders (
    external_reference, user_id, status, items_json, address_json, shipping_json,
    coupon_code, subtotal, discount, pix_discount, promo_discount, payment_method,
    shipping_price, total, customer_phone, customer_email, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtGetOrderByRef = db.prepare(`SELECT * FROM orders WHERE external_reference = ?`);
const stmtUpdateOrderStatus = db.prepare(
  `UPDATE orders SET status = ?, payment_id = ?, updated_at = ? WHERE external_reference = ?`
);
const stmtListOrdersByUser = db.prepare(
  `SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC`
);
const stmtListAllOrders = db.prepare(`SELECT * FROM orders ORDER BY created_at DESC`);
const stmtPedidosAguardandoEntrega = db.prepare(
  `SELECT * FROM orders WHERE fulfillment_status = 'postado' AND tracking_code IS NOT NULL AND tracking_code <> '' ORDER BY shipped_at ASC`
);
function listOrdersAwaitingDelivery(){
  return stmtPedidosAguardandoEntrega.all();
}
// Grava o código de rastreio e, se ele não for vazio, também avança
// fulfillment_status para 'postado' — cobre os dois pontos que hoje chamam
// updateOrderTracking (PATCH manual da lojista e geração de etiqueta no
// Melhor Envio, ambos em server.js) sem precisar duplicar essa regra nos
// dois lugares. `shipped_at` só é gravado da primeira vez (WHEN shipped_at
// IS NULL): reenviar/corrigir o código depois não deve reiniciar a linha
// do tempo da cliente. Limpar o código (trackingCode vazio) NÃO reverte
// fulfillment_status/shipped_at — não existe hoje um fluxo de "despostar".
const stmtUpdateOrderTracking = db.prepare(`
  UPDATE orders SET
    tracking_code = ?,
    updated_at = ?,
    fulfillment_status = CASE WHEN ? IS NOT NULL THEN 'postado' ELSE fulfillment_status END,
    shipped_at = CASE WHEN ? IS NOT NULL AND shipped_at IS NULL THEN ? ELSE shipped_at END
  WHERE external_reference = ?
`);
const stmtMarkOrderInProduction = db.prepare(
  `UPDATE orders SET fulfillment_status = 'em_producao', updated_at = ? WHERE external_reference = ?`
);
const stmtMarkOrderDelivered = db.prepare(
  `UPDATE orders SET fulfillment_status = 'entregue', delivered_at = ?, updated_at = ? WHERE external_reference = ?`
);
const stmtSetMelhorEnvioShipmentId = db.prepare(
  `UPDATE orders SET melhor_envio_shipment_id = ?, updated_at = ? WHERE external_reference = ?`
);
// "Vendas" = pedidos com pagamento confirmado — pendente/recusado/cancelado
// não contam como venda na Visão Geral do painel administrativo.
const stmtOrderStats = db.prepare(
  `SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS revenue FROM orders WHERE status = 'pago'`
);
const stmtDeleteOrder = db.prepare(`DELETE FROM orders WHERE external_reference = ?`);

function createOrder(order) {
  const now = Date.now();
  stmtInsertOrder.run(
    order.externalReference,
    order.userId ?? null,
    order.status ?? "pendente",
    JSON.stringify(order.items),
    JSON.stringify(order.address),
    JSON.stringify(order.shipping),
    order.couponCode ?? null,
    order.subtotal,
    order.discount ?? 0,
    order.pixDiscount ?? 0,
    order.promoDiscount ?? 0,
    order.paymentMethod ?? "card",
    order.shippingPrice,
    order.total,
    order.customerPhone ?? null,
    order.customerEmail ?? null,
    now,
    now
  );
  return getOrderByExternalReference(order.externalReference);
}

/* Já existe pedido PAGO desta cliente usando este cupom?
   Só conta status 'pago' de propósito: um carrinho abandonado (que fica
   'pendente' para sempre) não pode queimar o cupom de quem nunca chegou a
   comprar. `userId` e `phone` são checados em OR — quem comprou logada e
   depois volta sem entrar na conta continua sendo reconhecida pelo
   telefone, e vice-versa. */
const stmtCouponUsedByUser = db.prepare(
  `SELECT 1 FROM orders WHERE coupon_code = ? AND status = 'pago' AND user_id = ? LIMIT 1`
);
const stmtCouponUsedByPhone = db.prepare(
  `SELECT 1 FROM orders WHERE coupon_code = ? AND status = 'pago' AND customer_phone = ? LIMIT 1`
);
// Pedidos PENDENTES recentes com o mesmo cupom também contam, para fechar uma
// brecha de tempo (TOCTOU): sem isto, o cliente podia gerar vários QRs/links
// de pagamento com um cupom de uso único ANTES de pagar qualquer um (nenhum
// estava "pago" ainda), e depois pagar todos. A janela de tempo faz um pedido
// pendente abandonado deixar de bloquear o cupom após COUPON_PENDING_WINDOW_MS,
// evitando travar um cliente legítimo que só desistiu no meio do caminho.
const COUPON_PENDING_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 horas
const stmtCouponPendingByUser = db.prepare(
  `SELECT 1 FROM orders WHERE coupon_code = ? AND status = 'pendente' AND user_id = ? AND created_at > ? LIMIT 1`
);
const stmtCouponPendingByPhone = db.prepare(
  `SELECT 1 FROM orders WHERE coupon_code = ? AND status = 'pendente' AND customer_phone = ? AND created_at > ? LIMIT 1`
);

// Uso do cupom pela conta desde uma data (cupom de aniversário: um por ano).
// Pendente recente também conta, pelo mesmo motivo do hasUsedCoupon.
const stmtCouponUsedByUserSince = db.prepare(
  `SELECT 1 FROM orders WHERE coupon_code = ? AND user_id = ? AND created_at >= ?
     AND (status = 'pago' OR (status = 'pendente' AND created_at > ?)) LIMIT 1`
);
function hasUsedCouponSince({ code, userId, since }) {
  if (!code || !userId) return false;
  return Boolean(stmtCouponUsedByUserSince.get(code, userId, since, Date.now() - COUPON_PENDING_WINDOW_MS));
}

function hasUsedCoupon({ code, userId, phone }) {
  if (!code) return false;
  if (userId && stmtCouponUsedByUser.get(code, userId)) return true;
  if (phone && stmtCouponUsedByPhone.get(code, phone)) return true;
  const cutoff = Date.now() - COUPON_PENDING_WINDOW_MS;
  if (userId && stmtCouponPendingByUser.get(code, userId, cutoff)) return true;
  if (phone && stmtCouponPendingByPhone.get(code, phone, cutoff)) return true;
  return false;
}
function getOrderByExternalReference(ref) {
  return stmtGetOrderByRef.get(ref) || null;
}
function updateOrderStatus(ref, status, paymentId) {
  stmtUpdateOrderStatus.run(status, paymentId ?? null, Date.now(), ref);
}
// Usada só por "continuar pagamento" (POST /api/orders/:reference/resume-payment):
// o pedido pendente já existe, mas frete/cupom/preço foram revalidados de novo
// (podem ter mudado desde a tentativa original) — regrava o rascunho no MESMO
// pedido em vez de criar um novo. Mantém external_reference, user_id, status,
// payment_method e created_at intactos.
const stmtUpdateOrderDraft = db.prepare(`
  UPDATE orders SET
    items_json = ?, address_json = ?, shipping_json = ?, coupon_code = ?,
    subtotal = ?, discount = ?, pix_discount = ?, promo_discount = ?, shipping_price = ?, total = ?,
    customer_phone = ?, updated_at = ?
  WHERE external_reference = ?
`);
function updateOrderDraft(ref, order) {
  stmtUpdateOrderDraft.run(
    JSON.stringify(order.items),
    JSON.stringify(order.address),
    JSON.stringify(order.shipping),
    order.couponCode ?? null,
    order.subtotal,
    order.discount ?? 0,
    order.pixDiscount ?? 0,
    order.promoDiscount ?? 0,
    order.shippingPrice,
    order.total,
    order.customerPhone ?? null,
    Date.now(),
    ref
  );
  return getOrderByExternalReference(ref);
}
function listOrdersByUser(userId) {
  return stmtListOrdersByUser.all(userId);
}
function listAllOrders() {
  return stmtListAllOrders.all();
}
function updateOrderTracking(ref, trackingCode) {
  const code = trackingCode || null;
  const now = Date.now();
  stmtUpdateOrderTracking.run(code, now, code, code, now, ref);
  return getOrderByExternalReference(ref);
}
function markOrderInProduction(ref) {
  stmtMarkOrderInProduction.run(Date.now(), ref);
}
function markOrderDelivered(ref, quando) {
  const now = Date.now();
  stmtMarkOrderDelivered.run(quando || now, now, ref);
}
function setMelhorEnvioShipmentId(ref, shipmentId) {
  stmtSetMelhorEnvioShipmentId.run(shipmentId, Date.now(), ref);
}
function getOrderStats() {
  return stmtOrderStats.get();
}
// Quem chama decide SE pode apagar (nunca um pedido "pago" — ver checagem
// de status na rota /api/admin/orders/:reference em server.js); esta
// função só executa o DELETE, sem regra de negócio nenhuma, igual ao
// resto deste arquivo.
function deleteOrder(ref) {
  stmtDeleteOrder.run(ref);
}

/* ------------------------- PRODUCT PHOTOS (BLOB) ------------------------- */
// Sem FK para product_overrides/custom_products de propósito: photo_url/
// photos, nessas duas tabelas, são só strings apontando para uma rota (ou
// para uma URL http(s) externa, colada à mão) — nunca houve uma relação de
// banco entre "produto" e "onde a foto mora", e continuar assim evita ter
// que popular product_id aqui para um upload que ainda nem foi salvo em
// nenhum produto (ver comentário de UPLOAD DE FOTO DE PRODUTO em server.js:
// a rota de upload só grava a foto e devolve o id — quem decide se aquilo
// vira o photoUrl de algum produto é o PATCH seguinte).
const stmtInsertProductPhoto = db.prepare(
  `INSERT INTO product_photos (id, mime_type, data, created_at) VALUES (?, ?, ?, ?)`
);
const stmtGetProductPhoto = db.prepare(`SELECT mime_type, data FROM product_photos WHERE id = ?`);
const stmtDeleteProductPhoto = db.prepare(`DELETE FROM product_photos WHERE id = ?`);

function insertProductPhoto(id, mimeType, buffer) {
  stmtInsertProductPhoto.run(id, mimeType, buffer, Date.now());
}
// node:sqlite devolve BLOB como Uint8Array, não Buffer — quem serve isso
// numa resposta HTTP precisa envolver em Buffer.from(...) antes.
function getProductPhoto(id) {
  return stmtGetProductPhoto.get(id) || null;
}
function deleteProductPhoto(id) {
  stmtDeleteProductPhoto.run(id);
}

/* ---- Variantes reduzidas (cache preenchido pela rota, sob demanda) ---- */
const stmtGetProductPhotoVariant = db.prepare(
  `SELECT mime_type, data FROM product_photo_variants
    WHERE photo_id = ? AND width = ? AND format = ?`
);
const stmtInsertProductPhotoVariant = db.prepare(
  `INSERT OR REPLACE INTO product_photo_variants
     (photo_id, width, format, mime_type, data, created_at)
   VALUES (?, ?, ?, ?, ?, ?)`
);

function getProductPhotoVariant(photoId, width, format) {
  return stmtGetProductPhotoVariant.get(photoId, width, format) || null;
}
// INSERT OR REPLACE, e não INSERT: dois pedidos simultâneos da mesma variante
// geram os mesmos bytes, e perder a corrida não pode virar erro 500.
function saveProductPhotoVariant(photoId, width, format, mimeType, buffer) {
  stmtInsertProductPhotoVariant.run(photoId, width, format, mimeType, buffer, Date.now());
}

/* --------------------- FOTOS DO TOPO DA HOME ---------------------- */
// listHeroPhotos NÃO traz a coluna `data`: é chamada a cada visita da home
// para montar o carrossel, e arrastar ~6 blobs do disco só para descartá-los
// seria o custo mais caro da página.
const stmtListHeroPhotos = db.prepare(
  `SELECT id, position, alt, legenda, focus, created_at
     FROM hero_photos ORDER BY position, created_at`
);
const stmtGetHeroPhoto = db.prepare(`SELECT mime_type, data, focus FROM hero_photos WHERE id = ?`);
const stmtInsertHeroPhoto = db.prepare(
  `INSERT INTO hero_photos (id, position, alt, legenda, focus, mime_type, data, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtUpdateHeroPhoto = db.prepare(
  `UPDATE hero_photos SET alt = ?, legenda = ?, focus = ? WHERE id = ?`
);
const stmtDeleteHeroPhoto = db.prepare(`DELETE FROM hero_photos WHERE id = ?`);
const stmtPosicaoLivreHero = db.prepare(`SELECT IFNULL(MAX(position), -1) + 1 AS n FROM hero_photos`);
const stmtContarHeroPhotos = db.prepare(`SELECT COUNT(*) AS n FROM hero_photos`);
const stmtMoverHeroPhoto = db.prepare(`UPDATE hero_photos SET position = ? WHERE id = ?`);
const stmtApagarVariantesHero = db.prepare(`DELETE FROM hero_photo_variants WHERE photo_id = ?`);

function listHeroPhotos(){
  return stmtListHeroPhotos.all();
}
function countHeroPhotos(){
  return stmtContarHeroPhotos.get().n;
}
function getHeroPhoto(id){
  return stmtGetHeroPhoto.get(id) || null;
}
function insertHeroPhoto(id, alt, legenda, focus, mimeType, buffer){
  stmtInsertHeroPhoto.run(
    id, stmtPosicaoLivreHero.get().n, alt, legenda, focus, mimeType, buffer, Date.now()
  );
}
// Mudar o enquadramento reaproveita o original já gravado, mas os recortes
// em cache viraram lixo: sem apagá-los a home continuaria servindo o corte
// antigo até alguém trocar o arquivo.
function updateHeroPhoto(id, alt, legenda, focus){
  const antes = stmtGetHeroPhoto.get(id);
  if(!antes) return false;
  stmtUpdateHeroPhoto.run(alt, legenda, focus, id);
  if(antes.focus !== focus) stmtApagarVariantesHero.run(id);
  return true;
}
function deleteHeroPhoto(id){
  stmtDeleteHeroPhoto.run(id);
}
// Renumera de 0 em diante na ordem recebida, numa transação só: a home lê
// `position` sem desempate estável, então dois pedidos concorrentes deixando
// posições repetidas no meio do caminho trocariam a ordem do carrossel.
function setHeroPhotoOrder(ids){
  db.exec("BEGIN");
  try{
    ids.forEach((id, i) => stmtMoverHeroPhoto.run(i, id));
    db.exec("COMMIT");
  }catch(err){
    db.exec("ROLLBACK");
    throw err;
  }
}

/* ---- Recortes 4:5 em cache (mesmo racional das variantes de produto) ---- */
const stmtGetHeroVariant = db.prepare(
  `SELECT mime_type, data FROM hero_photo_variants
    WHERE photo_id = ? AND width = ? AND format = ?`
);
const stmtInsertHeroVariant = db.prepare(
  `INSERT OR REPLACE INTO hero_photo_variants
     (photo_id, width, format, mime_type, data, created_at)
   VALUES (?, ?, ?, ?, ?, ?)`
);
function getHeroPhotoVariant(photoId, width, format){
  return stmtGetHeroVariant.get(photoId, width, format) || null;
}
function saveHeroPhotoVariant(photoId, width, format, mimeType, buffer){
  stmtInsertHeroVariant.run(photoId, width, format, mimeType, buffer, Date.now());
}

// Assinatura do carrossel, para o server.js só remontar o HTML do topo
// quando algo mudou. Cobre id, ordem, textos e enquadramento — tudo que
// entra no markup.
function heroVersion(){
  const linhas = stmtListHeroPhotos.all();
  if(!linhas.length) return "0";
  return linhas.map(f => `${f.id}:${f.position}:${f.focus}:${f.alt.length}:${f.legenda.length}`).join("|");
}

/* ------------------------- DEPOIMENTOS ---------------------------- */
// Elogios recebidos por fora do site. Ver o comentário da tabela, acima, para
// o porquê de não morarem em `reviews` e de não terem nota.
const stmtListDepoimentos = db.prepare(
  `SELECT id, texto, cliente_nome, cliente_cidade, origem, photo_id,
          consentimento_em, posicao, status, created_at
     FROM depoimentos ORDER BY posicao, created_at`
);
const stmtDepoimentosPublicados = db.prepare(
  `SELECT id, texto, cliente_nome, cliente_cidade, origem, photo_id
     FROM depoimentos WHERE status = 'publicado' ORDER BY posicao, created_at LIMIT ?`
);
const stmtGetDepoimento = db.prepare(`SELECT * FROM depoimentos WHERE id = ?`);
const stmtInsertDepoimento = db.prepare(
  `INSERT INTO depoimentos
     (texto, cliente_nome, cliente_cidade, origem, photo_id, consentimento_em, posicao, status, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'publicado', ?)`
);
const stmtUpdateDepoimento = db.prepare(
  `UPDATE depoimentos SET texto = ?, cliente_nome = ?, cliente_cidade = ?, origem = ?, status = ?
    WHERE id = ?`
);
const stmtDeleteDepoimento = db.prepare(`DELETE FROM depoimentos WHERE id = ?`);
const stmtPosicaoLivreDepoimento = db.prepare(`SELECT IFNULL(MAX(posicao), -1) + 1 AS n FROM depoimentos`);
const stmtContarDepoimentos = db.prepare(`SELECT COUNT(*) AS n FROM depoimentos WHERE status = 'publicado'`);
const stmtMoverDepoimento = db.prepare(`UPDATE depoimentos SET posicao = ? WHERE id = ?`);
const stmtFotoDeDepoimentoPublicado = db.prepare(
  `SELECT p.mime_type, p.data FROM review_photos p
     JOIN depoimentos d ON d.photo_id = p.id AND d.status = 'publicado'
    WHERE p.id = ?`
);

function listarDepoimentos(){
  return stmtListDepoimentos.all();
}
function depoimentosPublicados(limite){
  return stmtDepoimentosPublicados.all(limite);
}
function contarDepoimentosPublicados(){
  return stmtContarDepoimentos.get().n;
}
function getDepoimento(id){
  return stmtGetDepoimento.get(id) || null;
}
function criarDepoimento({ texto, nome, cidade, origem, photoId, consentimentoEm }){
  const agora = Date.now();
  const r = stmtInsertDepoimento.run(
    texto, nome, cidade || null, origem, photoId || null,
    consentimentoEm, stmtPosicaoLivreDepoimento.get().n, agora
  );
  return Number(r.lastInsertRowid);
}
function atualizarDepoimento(id, { texto, nome, cidade, origem, status }){
  if(!stmtGetDepoimento.get(id)) return false;
  stmtUpdateDepoimento.run(texto, nome, cidade || null, origem, status, id);
  return true;
}
// A foto só é apagada se mais ninguém apontar para ela — mesmo cuidado de
// apagarFotoOrfaDeAvaliacao, já que review_photos é compartilhada.
function removerDepoimento(id){
  const antes = stmtGetDepoimento.get(id);
  if(!antes) return false;
  stmtDeleteDepoimento.run(id);
  if(antes.photo_id) apagarFotoOrfaDeAvaliacao(antes.photo_id);
  return true;
}
function setOrdemDepoimentos(ids){
  db.exec("BEGIN");
  try{
    ids.forEach((id, i) => stmtMoverDepoimento.run(i, id));
    db.exec("COMMIT");
  }catch(err){
    db.exec("ROLLBACK");
    throw err;
  }
}
// Serve a foto só enquanto o depoimento estiver publicado, igual à regra da
// foto de avaliação: ocultar no painel tem de tirar a imagem do ar também.
function getFotoDeDepoimentoPublicado(photoId){
  return stmtFotoDeDepoimentoPublicado.get(photoId) || null;
}

/* ------------------------- PRODUCT OVERRIDES ------------------------- */
const stmtGetProductOverride = db.prepare(`SELECT * FROM product_overrides WHERE product_id = ?`);
const stmtListProductOverrides = db.prepare(`SELECT * FROM product_overrides`);
const stmtUpsertProductOverride = db.prepare(`
  INSERT INTO product_overrides (product_id, name, price, photo_url, category, badges, available_colors, photos, allow_second_color, description, ncm, hidden, sold_out, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(product_id) DO UPDATE SET
    name = excluded.name, price = excluded.price, photo_url = excluded.photo_url,
    category = excluded.category, badges = excluded.badges,
    available_colors = excluded.available_colors, photos = excluded.photos,
    allow_second_color = excluded.allow_second_color, description = excluded.description,
    ncm = excluded.ncm,
    hidden = excluded.hidden, sold_out = excluded.sold_out, updated_at = excluded.updated_at
`);

/* Ordem da vitrine. Statements próprios, que tocam SÓ sort_order: passar
   pelo upsertProductOverride abaixo obrigaria a reenviar nome/preço/foto a
   cada reordenação, e qualquer descuido ali apagaria customização. */
const stmtSetOverrideSortOrder = db.prepare(`
  INSERT INTO product_overrides (product_id, sort_order, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(product_id) DO UPDATE SET sort_order = excluded.sort_order, updated_at = excluded.updated_at
`);
const stmtSetCustomProductSortOrder = db.prepare(
  `UPDATE custom_products SET sort_order = ? WHERE id = ?`
);
/* Recebe os ids JÁ na ordem desejada e grava 0,1,2... em todos de uma vez.
   Numa transação porque uma gravação parcial deixaria a vitrine com duas
   posições iguais ou um buraco — ordem é um estado do conjunto, não de
   cada produto isolado. `customIds` diz quais ids são de produto criado no
   painel (moram em custom_products); o resto é catálogo fixo. */
function setProductsOrder(orderedIds, customIds) {
  const now = Date.now();
  const custom = new Set(customIds);
  db.exec("BEGIN");
  try {
    orderedIds.forEach((id, index) => {
      if (custom.has(id)) stmtSetCustomProductSortOrder.run(index, id);
      else stmtSetOverrideSortOrder.run(id, index, now);
    });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function getProductOverride(productId) {
  return stmtGetProductOverride.get(productId) || null;
}
function listProductOverrides() {
  return stmtListProductOverrides.all();
}
// Merge parcial de propósito: `fields` só traz as chaves que o painel
// administrativo realmente alterou (ver PATCH /api/admin/products/:id em
// server.js — payload compacto, não manda o produto inteiro a cada
// edição). Uma chave AUSENTE em `fields` preserva o valor já salvo; só uma
// chave presente com valor vazio ("", null) apaga o override daquele campo
// (volta a usar o padrão de PRODUCTS). Sem esse cuidado, salvar só um selo
// novo apagaria silenciosamente nome/preço/foto já customizados.
function upsertProductOverride(productId, fields) {
  const current = getProductOverride(productId) || {};
  const name = "name" in fields ? (fields.name || null) : (current.name ?? null);
  const price = "price" in fields ? (fields.price ?? null) : (current.price ?? null);
  const photoUrl = "photoUrl" in fields ? (fields.photoUrl || null) : (current.photo_url ?? null);
  const category = "category" in fields ? (fields.category || null) : (current.category ?? null);
  const badges = "badges" in fields
    ? (fields.badges && fields.badges.length ? JSON.stringify(fields.badges) : null)
    : (current.badges ?? null);
  // Diferente de badges: um array VAZIO é um estado real ("esgotado em
  // todas as cores"), não pode ser colapsado para NULL como acima — NULL
  // significa "nunca editado" (todas as cores disponíveis), [] significa
  // "editado e zero cores em estoque". Grava sempre o array como veio.
  const availableColors = "availableColors" in fields
    ? JSON.stringify(Array.isArray(fields.availableColors) ? fields.availableColors : [])
    : (current.available_colors ?? null);
  // Mesma regra de availableColors: [] é "removeu todas as fotos", um
  // estado real — nunca colapsa para NULL (que significaria "nunca mexeu
  // nesta coluna", caindo de volta para a foto única antiga em photo_url).
  const photos = "photos" in fields
    ? JSON.stringify(Array.isArray(fields.photos) ? fields.photos : [])
    : (current.photos ?? null);
  // Booleano simples — NULL e 0 significam a mesma coisa ("desligado"),
  // então não precisa da distinção NULL-vs-explícito de availableColors/photos.
  const allowSecondColor = "allowSecondColor" in fields
    ? (fields.allowSecondColor ? 1 : 0)
    : (current.allow_second_color ?? 0);
  // Mesmo racional de name: string vazia limpa de volta pro padrão
  // (descrição dos 8 produtos fixos, ou o texto genérico de produto
  // novo) — sem a distinção NULL-vs-vazio que available_colors/photos
  // precisam, já que aqui não existe um "descrição vazia de propósito".
  const description = "description" in fields ? (fields.description || null) : (current.description ?? null);
  const ncm = "ncm" in fields ? (fields.ncm || null) : (current.ncm ?? null);
  const hidden = "hidden" in fields ? (fields.hidden ? 1 : 0) : (current.hidden ?? 0);
  const soldOut = "soldOut" in fields ? (fields.soldOut ? 1 : 0) : (current.sold_out ?? 0);
  stmtUpsertProductOverride.run(productId, name, price, photoUrl, category, badges, availableColors, photos, allowSecondColor, description, ncm, hidden, soldOut, Date.now());
  return getProductOverride(productId);
}

/* ------------------------- CUSTOM PRODUCTS ------------------------- */
const stmtListCustomProducts = db.prepare(`SELECT * FROM custom_products ORDER BY id`);
const stmtGetCustomProduct = db.prepare(`SELECT * FROM custom_products WHERE id = ?`);
const stmtMaxCustomProductId = db.prepare(`SELECT MAX(id) AS maxId FROM custom_products`);
const stmtInsertCustomProduct = db.prepare(`
  INSERT INTO custom_products
    (id, name, price, weight, width, height, length, category, photo_url, badges, available_colors, photos, allow_second_color, description, ncm, hidden, sold_out, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtUpdateCustomProduct = db.prepare(`
  UPDATE custom_products SET
    name = ?, price = ?, category = ?, photo_url = ?, badges = ?, available_colors = ?, photos = ?, allow_second_color = ?, description = ?, ncm = ?, hidden = ?, sold_out = ?, updated_at = ?
  WHERE id = ?
`);
const stmtDeleteCustomProduct = db.prepare(`DELETE FROM custom_products WHERE id = ?`);

function listCustomProducts() {
  return stmtListCustomProducts.all();
}
function getCustomProduct(id) {
  return stmtGetCustomProduct.get(id) || null;
}
// ids >= CUSTOM_PRODUCT_ID_START (server.js) — nunca reaproveita um id
// apagado, então o histórico de pedidos antigos continua apontando para o
// produto certo mesmo que ele não exista mais no catálogo hoje.
function nextCustomProductId(startAt) {
  const { maxId } = stmtMaxCustomProductId.get();
  return Math.max(startAt - 1, maxId || 0) + 1;
}
function insertCustomProduct({ startAt, name, price, weight, width, height, length, category, badges, description }) {
  const id = nextCustomProductId(startAt);
  const now = Date.now();
  stmtInsertCustomProduct.run(
    id, name, price, weight, width, height, length, category || null, null,
    badges && badges.length ? JSON.stringify(badges) : null,
    null, // available_colors: produto novo começa sem customização = todas as cores
    null, // photos: produto novo começa sem foto — mesmo estado de photo_url null
    0,    // allow_second_color: produto novo começa sem a 2ª cor liberada
    description || null,
    null, // ncm: produto novo começa sem classificação fiscal
    0,    // hidden: produto novo começa visível na vitrine
    0,    // sold_out: produto novo começa disponível para compra
    now, now
  );
  return getCustomProduct(id);
}
// Mesmo racional parcial de upsertProductOverride: só grava as chaves
// presentes em `fields`, preservando as demais. Diferente dele, exige que o
// produto já exista — não há "base" para criar um registro do zero aqui.
function updateCustomProduct(id, fields) {
  const current = getCustomProduct(id);
  if (!current) return null;
  const name = "name" in fields ? fields.name : current.name;
  const price = "price" in fields ? fields.price : current.price;
  const category = "category" in fields ? (fields.category || null) : current.category;
  const photoUrl = "photoUrl" in fields ? (fields.photoUrl || null) : current.photo_url;
  const badges = "badges" in fields
    ? (fields.badges && fields.badges.length ? JSON.stringify(fields.badges) : null)
    : current.badges;
  // Mesmo cuidado de upsertProductOverride: [] é um estado real, nunca
  // colapsa para NULL.
  const availableColors = "availableColors" in fields
    ? JSON.stringify(Array.isArray(fields.availableColors) ? fields.availableColors : [])
    : (current.available_colors ?? null);
  const photos = "photos" in fields
    ? JSON.stringify(Array.isArray(fields.photos) ? fields.photos : [])
    : (current.photos ?? null);
  const allowSecondColor = "allowSecondColor" in fields
    ? (fields.allowSecondColor ? 1 : 0)
    : (current.allow_second_color ?? 0);
  const description = "description" in fields ? (fields.description || null) : (current.description ?? null);
  const ncm = "ncm" in fields ? (fields.ncm || null) : (current.ncm ?? null);
  const hidden = "hidden" in fields ? (fields.hidden ? 1 : 0) : (current.hidden ?? 0);
  const soldOut = "soldOut" in fields ? (fields.soldOut ? 1 : 0) : (current.sold_out ?? 0);
  stmtUpdateCustomProduct.run(name, price, category, photoUrl, badges, availableColors, photos, allowSecondColor, description, ncm, hidden, soldOut, Date.now(), id);
  return getCustomProduct(id);
}
// Não apaga a foto em disco — quem chama (server.js) já leu photo_url ANTES
// de chamar isto, e cuida do arquivo separado, do mesmo jeito que o PATCH
// de troca de foto já faz (deleteOldLocalPhoto). Pedidos antigos que
// referenciam este id continuam funcionando: effectiveProduct() devolve
// null e quem monta nome/preço para exibição já trata isso com um
// "Produto #<id>" de reserva (ver server.js).
function deleteCustomProduct(id) {
  stmtDeleteCustomProduct.run(id);
}

/* ------------------------- CUSTOM CATEGORIES ------------------------- */
const stmtListCustomCategories = db.prepare(`SELECT * FROM custom_categories ORDER BY created_at`);
const stmtInsertCustomCategory = db.prepare(
  `INSERT INTO custom_categories (slug, label, created_at) VALUES (?, ?, ?)`
);
const stmtUpdateCustomCategoryLabel = db.prepare(
  `UPDATE custom_categories SET label = ? WHERE slug = ?`
);
const stmtDeleteCustomCategory = db.prepare(`DELETE FROM custom_categories WHERE slug = ?`);
// Conta em quantos produtos (fixos com override ou criados pelo painel) a
// categoria está em uso agora — usado para bloquear a exclusão, já que
// apagar a linha em custom_categories não muda o texto já gravado em
// product_overrides.category/custom_products.category, e o produto ficaria
// com um slug sem rótulo correspondente.
const stmtCountProductsUsingCategory = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM product_overrides WHERE category = ?) +
    (SELECT COUNT(*) FROM custom_products WHERE category = ?) AS total
`);

function listCustomCategories() {
  return stmtListCustomCategories.all();
}
function insertCustomCategory({ slug, label }) {
  stmtInsertCustomCategory.run(slug, label, Date.now());
  return { slug, label };
}
function updateCustomCategoryLabel(slug, label) {
  stmtUpdateCustomCategoryLabel.run(label, slug);
}
function deleteCustomCategory(slug) {
  stmtDeleteCustomCategory.run(slug);
}
function countProductsUsingCategory(slug) {
  return stmtCountProductsUsingCategory.get(slug, slug).total;
}

/* --------------------------- CUSTOM COLORS --------------------------- */
const stmtListCustomColors = db.prepare(`SELECT * FROM custom_colors ORDER BY created_at`);
const stmtInsertCustomColor = db.prepare(
  `INSERT INTO custom_colors (hex, label, created_at) VALUES (?, ?, ?)`
);

const stmtDeleteCustomColor = db.prepare(`DELETE FROM custom_colors WHERE hex = ?`);

function listCustomColors() {
  return stmtListCustomColors.all();
}
function insertCustomColor({ hex, label }) {
  stmtInsertCustomColor.run(hex, label, Date.now());
  return { hex, label };
}
// Não limpa o hex de dentro de available_colors de produto nenhum — mesmo
// racional de deleteCustomProduct: um produto que ainda referencia esta cor
// simplesmente para de conseguir mostrá-la (isValidColorHex/getAllColors()
// não a reconhecem mais), sem quebrar nada.
function deleteCustomColor(hex) {
  stmtDeleteCustomColor.run(hex);
}

/* ------------------------------ COUPONS ------------------------------ */
/* ------------------------- NEWSLETTER ------------------------- */
// OR IGNORE: pedir o cupom de novo com o mesmo e-mail não é erro — só não
// duplica a linha (e a data original de inscrição é preservada).
const stmtInsertSubscriber = db.prepare(
  `INSERT OR IGNORE INTO newsletter_subscribers (email, created_at, opt_in_at) VALUES (?, ?, ?)`
);
// Quem já tinha linha só por causa do descadastro (carrinho esquecido) e
// agora pediu o cupom passa a ser inscrita de verdade.
const stmtMarcaOptIn = db.prepare(
  `UPDATE newsletter_subscribers SET opt_in_at = ? WHERE email = ? AND opt_in_at IS NULL`
);
// Linha mínima só para o link de descadastro existir: sem opt_in_at, não
// entra em envio de novidades.
const stmtInsertContato = db.prepare(
  `INSERT OR IGNORE INTO newsletter_subscribers (email, created_at) VALUES (?, ?)`
);
const stmtListSubscribers = db.prepare(
  `SELECT * FROM newsletter_subscribers ORDER BY created_at DESC`
);

function addNewsletterSubscriber(email) {
  const agora = Date.now();
  stmtInsertSubscriber.run(email, agora, agora);
  stmtMarcaOptIn.run(agora, email);
}

/* Garante linha para um e-mail que NUNCA se inscreveu, só para o token de
   descadastro ter onde morar. Sem isto, getOrCreateUnsubscribeToken devolve
   um token que o UPDATE não gravou em lugar nenhum (zero linhas afetadas) e
   o link do e-mail não descadastra — falha silenciosa justamente no botão
   que existe para respeitar quem não quer mais receber. */
function garantirTokenDeContato(email) {
  stmtInsertContato.run(email, Date.now());
  return getOrCreateUnsubscribeToken(email);
}
function listNewsletterSubscribers() {
  return stmtListSubscribers.all();
}

// Gera (ou reaproveita) o token de descadastro de uma inscrita, para colocar
// no link "List-Unsubscribe" do e-mail. Preso ao e-mail em vez de à data de
// inscrição — assim continua válido mesmo que o e-mail seja enviado de novo.
const stmtGetSubscriberToken = db.prepare(
  `SELECT unsubscribe_token FROM newsletter_subscribers WHERE email = ?`
);
const stmtSetSubscriberToken = db.prepare(
  `UPDATE newsletter_subscribers SET unsubscribe_token = ? WHERE email = ?`
);
function getOrCreateUnsubscribeToken(email) {
  const existing = stmtGetSubscriberToken.get(email)?.unsubscribe_token;
  if (existing) return existing;
  const token = crypto.randomBytes(24).toString("hex");
  stmtSetSubscriberToken.run(token, email);
  return token;
}

// Confere o token do link/POST de descadastro e marca unsubscribed_at.
// Comparação em tempo constante (mesmo padrão de auth.js) — não é um dado
// sigiloso como senha, mas evita que alguém descubra o token por tentativa.
const stmtMarkUnsubscribed = db.prepare(
  `UPDATE newsletter_subscribers SET unsubscribed_at = ? WHERE email = ?`
);
function unsubscribeNewsletter(email, token) {
  const stored = stmtGetSubscriberToken.get(email)?.unsubscribe_token;
  if (!stored || !token) return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(String(token));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  stmtMarkUnsubscribed.run(Date.now(), email);
  return true;
}

/* ---------------------- CONTATOS ---------------------- */
const stmtInsertContactMessage = db.prepare(
  `INSERT INTO contact_messages (nome, telefone, ocasiao, mensagem, created_at)
   VALUES (?, ?, ?, ?, ?)`
);
const stmtListContactMessages = db.prepare(
  `SELECT * FROM contact_messages ORDER BY created_at DESC`
);
const stmtGetContactMessage = db.prepare(`SELECT * FROM contact_messages WHERE id = ?`);
const stmtDeleteContactMessage = db.prepare(`DELETE FROM contact_messages WHERE id = ?`);

function createContactMessage({ nome, telefone, ocasiao, mensagem }) {
  stmtInsertContactMessage.run(nome, telefone, ocasiao || null, mensagem, Date.now());
}
function listContactMessages() {
  return stmtListContactMessages.all();
}
function getContactMessage(id) {
  return stmtGetContactMessage.get(id) || null;
}
function deleteContactMessage(id) {
  stmtDeleteContactMessage.run(id);
}

/* -------------------------- CUPONS -------------------------- */
const stmtGetCoupon = db.prepare(`SELECT * FROM coupons WHERE code = ?`);
const stmtListCoupons = db.prepare(`SELECT * FROM coupons ORDER BY created_at DESC`);
const stmtInsertCoupon = db.prepare(
  `INSERT INTO coupons (code, percent_off, description, created_at) VALUES (?, ?, ?, ?)`
);
const stmtDeleteCoupon = db.prepare(`DELETE FROM coupons WHERE code = ?`);
const stmtUpdateCoupon = db.prepare(
  `UPDATE coupons SET percent_off = ?, description = ? WHERE code = ?`
);

function getCoupon(code) {
  return stmtGetCoupon.get(code) || null;
}
function listCoupons() {
  return stmtListCoupons.all();
}
function createCoupon({ code, percentOff, description }) {
  stmtInsertCoupon.run(code, percentOff, description ?? null, Date.now());
  return getCoupon(code);
}
// Só percentOff/description são editáveis — code é a chave primária e
// outras tabelas guardam o valor por string (orders.coupon_code), então
// "renomear" um cupom existente seria trocar a chave que tudo mais
// referencia. Quem quiser um código diferente apaga e cria de novo.
// Parcial (mesmo padrão de upsertProductOverride): campo ausente em
// `fields` mantém o valor atual em vez de apagar.
function updateCoupon(code, fields) {
  const current = getCoupon(code);
  if (!current) return null;
  const percentOff = "percentOff" in fields ? fields.percentOff : current.percent_off;
  const description = "description" in fields ? (fields.description || null) : current.description;
  stmtUpdateCoupon.run(percentOff, description, code);
  return getCoupon(code);
}
function deleteCoupon(code) {
  stmtDeleteCoupon.run(code);
}

/* -------------------------- INSTAGRAM -------------------------- */
const stmtGetInstagramToken = db.prepare(`SELECT access_token, refreshed_at FROM instagram_tokens WHERE id = 1`);
const stmtUpsertInstagramToken = db.prepare(`
  INSERT INTO instagram_tokens (id, access_token, refreshed_at) VALUES (1, ?, ?)
  ON CONFLICT(id) DO UPDATE SET access_token = excluded.access_token, refreshed_at = excluded.refreshed_at
`);
const stmtDeleteInstagramToken = db.prepare(`DELETE FROM instagram_tokens WHERE id = 1`);

function getInstagramToken() {
  const row = stmtGetInstagramToken.get();
  return row ? { accessToken: row.access_token, refreshedAt: row.refreshed_at } : null;
}
function saveInstagramToken({ accessToken, refreshedAt }) {
  stmtUpsertInstagramToken.run(accessToken, refreshedAt);
}
// Usada pelo botão "Reconectar" do painel: sem isto, trocar o token no .env
// não tem efeito nenhum depois da primeira vez — ensureFreshToken() só volta
// a olhar o .env quando não encontra nada salvo aqui.
function deleteInstagramToken() {
  stmtDeleteInstagramToken.run();
}

/* -------------------- FILA DE E-MAIL PARA A CLIENTE --------------------
   Enfileirar antes de enviar é o que separa "o e-mail não saiu" de "ninguém
   nunca vai saber que não saiu". A tentativa imediata cobre o caso normal; o
   que falhar fica gravado com o erro e é retentado pelo cron. */
/* ---------- Avaliações ---------- */
const stmtGetReviewToken = db.prepare(`SELECT review_token FROM orders WHERE external_reference = ?`);
const stmtSetReviewToken = db.prepare(
  `UPDATE orders SET review_token = ? WHERE external_reference = ? AND review_token IS NULL`
);
function garantirTokenDeAvaliacao(ref){
  const atual = stmtGetReviewToken.get(ref)?.review_token;
  if(atual) return atual;
  stmtSetReviewToken.run(crypto.randomBytes(32).toString("hex"), ref);
  // Relê em vez de devolver o que gerou: se duas chamadas correrem juntas,
  // o `AND review_token IS NULL` deixa só a primeira gravar, e as duas
  // precisam devolver o MESMO token.
  return stmtGetReviewToken.get(ref)?.review_token || null;
}

/* ⚠️ Tamanho em BYTES: timingSafeEqual exige buffers iguais, e um token com
   caractere acentuado tem o mesmo `length` de string e mais bytes — estourava
   RangeError, virava 500, e quebrava a propriedade de "token errado responde
   igual a pedido inexistente". */
function tokenDeAvaliacaoConfere(ref, token){
  const certo = stmtGetReviewToken.get(ref)?.review_token;
  if(!certo || typeof token !== "string") return false;
  const recebido = Buffer.from(token);
  const esperado = Buffer.from(certo);
  if(recebido.length !== esperado.length) return false;
  return crypto.timingSafeEqual(recebido, esperado);
}

const stmtUpsertReview = db.prepare(`
  INSERT INTO reviews
    (order_reference, product_id, rating, comment, photo_id, photo_consent_at,
     status, customer_first_name, customer_city, created_at)
  VALUES (?, ?, ?, ?, ?, ?, 'pendente', ?, ?, ?)
  ON CONFLICT(order_reference, product_id) DO UPDATE SET
    rating = excluded.rating,
    comment = excluded.comment,
    photo_id = excluded.photo_id,
    photo_consent_at = excluded.photo_consent_at,
    created_at = excluded.created_at
  WHERE reviews.status = 'pendente'
`);
/* Devolve true se gravou. Avaliação já publicada ou oculta NÃO é
   reescrita: senão a cliente trocaria, pelo mesmo link, um texto que a
   lojista já aprovou por outro que ela nunca leu. */
function salvarAvaliacao({ orderReference, productId, rating, comment, photoId, photoConsentAt, firstName, city }){
  const r = stmtUpsertReview.run(
    orderReference, productId, rating, comment || null, photoId || null,
    photoConsentAt || null, firstName || null, city || null, Date.now()
  );
  return r.changes > 0;
}

const stmtAvaliacoesDoPedido = db.prepare(
  `SELECT product_id, rating, comment, status, photo_id, photo_consent_at FROM reviews WHERE order_reference = ?`
);
function avaliacoesDoPedido(ref){ return stmtAvaliacoesDoPedido.all(ref); }

const stmtInsertReviewPhoto = db.prepare(
  `INSERT INTO review_photos (id, mime_type, data, created_at) VALUES (?, ?, ?, ?)`
);
function insertReviewPhoto(id, mimeType, buffer){ stmtInsertReviewPhoto.run(id, mimeType, buffer, Date.now()); }

// Pública: só entrega a foto se ALGUMA avaliação publicada a usa.
const stmtFotoPublicada = db.prepare(`
  SELECT p.mime_type, p.data FROM review_photos p
    JOIN reviews r ON r.photo_id = p.id AND r.status = 'publicada'
   WHERE p.id = ? LIMIT 1
`);
function getReviewPhotoPublicada(id){ return stmtFotoPublicada.get(id) || null; }

const stmtGetReviewVariant = db.prepare(
  `SELECT mime_type, data FROM review_photo_variants WHERE photo_id = ? AND width = ? AND format = ?`
);
const stmtSaveReviewVariant = db.prepare(`
  INSERT OR REPLACE INTO review_photo_variants (photo_id, width, format, mime_type, data, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
function getReviewPhotoVariant(photoId, width, format){ return stmtGetReviewVariant.get(photoId, width, format) || null; }
function saveReviewPhotoVariant(photoId, width, format, mimeType, buffer){
  stmtSaveReviewVariant.run(photoId, width, format, mimeType, buffer, Date.now());
}

// Painel: a lojista precisa ver a foto antes de decidir publicar.
const stmtFotoQualquer = db.prepare(`SELECT mime_type, data FROM review_photos WHERE id = ?`);
function getReviewPhoto(id){ return stmtFotoQualquer.get(id) || null; }

const stmtListaAvaliacoesPainel = db.prepare(`
  SELECT id, order_reference, product_id, rating, comment, photo_id, photo_consent_at,
         status, customer_first_name, customer_city, created_at, published_at
    FROM reviews
   ORDER BY CASE status WHEN 'pendente' THEN 0 ELSE 1 END, created_at DESC
   LIMIT 500
`);
function listarAvaliacoesPainel(){ return stmtListaAvaliacoesPainel.all(); }

const stmtStatusAvaliacao = db.prepare(`
  UPDATE reviews SET status = ?,
         published_at = CASE WHEN ? = 'publicada' THEN COALESCE(published_at, ?) ELSE published_at END
   WHERE id = ?
`);
function mudarStatusAvaliacao(id, status){
  return stmtStatusAvaliacao.run(status, status, Date.now(), id).changes > 0;
}

const stmtTiraFotoDaAvaliacao = db.prepare(`UPDATE reviews SET photo_id = NULL WHERE id = ?`);
const stmtFotoDaAvaliacao = db.prepare(`SELECT photo_id FROM reviews WHERE id = ?`);
/* ⚠️ Checa as DUAS tabelas que apontam para review_photos. Desde que os
   depoimentos passaram a reusar esta tabela, olhar só reviews apagaria a foto
   de um depoimento quando a lojista excluísse uma avaliação que por acaso
   apontasse para o mesmo id — e vice-versa. */
const stmtApagaFotoOrfa = db.prepare(`
  DELETE FROM review_photos WHERE id = ?1
     AND NOT EXISTS (SELECT 1 FROM reviews WHERE photo_id = ?1)
     AND NOT EXISTS (SELECT 1 FROM depoimentos WHERE photo_id = ?1)
`);
/* "Publicar sem a foto" e "Excluir" apagam os bytes de verdade, não só o
   vínculo: foto de criança recusada pela lojista não fica guardada no banco
   (nem no backup) sem motivo. */
function tirarFotoDaAvaliacao(id){
  const photoId = stmtFotoDaAvaliacao.get(id)?.photo_id;
  stmtTiraFotoDaAvaliacao.run(id);
  if(photoId) stmtApagaFotoOrfa.run(photoId);
}
function apagarFotoOrfaDeAvaliacao(photoId){ stmtApagaFotoOrfa.run(photoId); }
const stmtApagaAvaliacao = db.prepare(`DELETE FROM reviews WHERE id = ?`);
function excluirAvaliacao(id){
  const photoId = stmtFotoDaAvaliacao.get(id)?.photo_id;
  const apagou = stmtApagaAvaliacao.run(id).changes > 0;
  if(photoId) stmtApagaFotoOrfa.run(photoId);
  return apagou;
}

const stmtAvaliacoesPublicadas = db.prepare(`
  SELECT id, product_id, rating, comment, photo_id, customer_first_name, customer_city, published_at
    FROM reviews WHERE status = 'publicada'
   ORDER BY published_at DESC LIMIT ?
`);
function avaliacoesPublicadas(limite = 6){ return stmtAvaliacoesPublicadas.all(limite); }

const stmtNotaMedia = db.prepare(
  `SELECT COUNT(*) AS total, AVG(rating) AS media FROM reviews WHERE status = 'publicada'`
);
function notaMedia(){
  const r = stmtNotaMedia.get();
  return { total: r?.total || 0, media: r?.total ? r.media : null };
}

const stmtNotaPorPedido = db.prepare(`
  SELECT order_reference, ROUND(AVG(rating), 1) AS media, COUNT(*) AS total
    FROM reviews GROUP BY order_reference
`);
function notasPorPedido(){
  const mapa = new Map();
  for(const r of stmtNotaPorPedido.all()) mapa.set(r.order_reference, { media: r.media, total: r.total });
  return mapa;
}

const stmtContaPendentes = db.prepare(`SELECT COUNT(*) AS n FROM reviews WHERE status = 'pendente'`);
function contarAvaliacoesPendentes(){ return stmtContaPendentes.get()?.n || 0; }

/* ---------- Seleção do cron ---------- */
const DIA_MS = 24 * 60 * 60 * 1000;

/* Postados há mais que o prazo do frete + folga, e ainda não entregues.
   ⚠️ A janela de 45 dias é a trava contra disparo em massa no primeiro
   deploy: sem ela, todo pedido antigo "esquecido" como postado receberia um
   "seu pedido chegou?" meses depois. */
const stmtPostadosAntigos = db.prepare(`
  SELECT external_reference, customer_email, shipping_json, shipped_at, address_json
    FROM orders
   WHERE status = 'pago' AND fulfillment_status = 'postado'
     AND customer_email IS NOT NULL AND customer_email <> ''
     AND shipped_at IS NOT NULL AND shipped_at >= ?
`);
function pedidosParaConfirmarRecebimento(agora = Date.now(), folgaDias = 3){
  return stmtPostadosAntigos.all(agora - 45 * DIA_MS).filter(p => {
    let prazo = 7;
    try{
      const dias = diasDoFrete(JSON.parse(p.shipping_json));
      if(dias) prazo = dias;
    }catch{}
    return p.shipped_at + (prazo + folgaDias) * DIA_MS <= agora;
  });
}

// Mesma trava, 30 dias: só pede avaliação de quem recebeu há pouco.
const stmtEntreguesSemAvaliacao = db.prepare(`
  SELECT o.external_reference, o.customer_email, o.items_json, o.address_json
    FROM orders o
   WHERE o.status = 'pago' AND o.fulfillment_status = 'entregue'
     AND o.customer_email IS NOT NULL AND o.customer_email <> ''
     AND COALESCE(o.delivered_at, o.updated_at) BETWEEN ? AND ?
     AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.order_reference = o.external_reference)
`);
function pedidosParaPedirAvaliacao(agora = Date.now(), esperaDias = 2){
  return stmtEntreguesSemAvaliacao.all(agora - 30 * DIA_MS, agora - esperaDias * DIA_MS);
}

/* Carrinhos esquecidos: pedido criado no checkout e nunca pago.
   ⚠️ A espera de 8 horas não é delicadeza, é correção: o Pix fica válido
   por horas, e lembrar antes disso é cobrar quem ainda ia pagar. O teto de
   3 dias é a trava contra disparo em massa no primeiro deploy (mesma ideia
   das janelas de 45/30 dias acima).

   Três exclusões, cada uma por um motivo diferente:
   - já pagou depois (no mesmo carrinho ou em outro pedido): não é mais
     carrinho esquecido, e lembrar seria constrangedor;
   - já recebeu um lembrete nos últimos 30 dias: o índice único do outbox
     impede repetir para o MESMO pedido, mas não para a mesma pessoa com
     dois carrinhos;
   - pediu descadastro: vale também para este e-mail, que é promocional. */
const stmtCarrinhosEsquecidos = db.prepare(`
  SELECT o.external_reference, o.customer_email, o.items_json, o.address_json,
         o.total, o.created_at
    FROM orders o
   WHERE o.status = 'pendente'
     AND o.customer_email IS NOT NULL AND o.customer_email <> ''
     AND o.created_at BETWEEN ? AND ?
     AND NOT EXISTS (
       SELECT 1 FROM orders pago
        WHERE pago.status = 'pago' AND pago.created_at >= o.created_at
          AND (pago.customer_email = o.customer_email
               OR (o.user_id IS NOT NULL AND pago.user_id = o.user_id))
     )
     AND NOT EXISTS (
       SELECT 1 FROM email_outbox e
        WHERE e.kind = 'carrinho_esquecido'
          AND e.to_email = o.customer_email
          AND e.created_at >= ?
     )
     AND NOT EXISTS (
       SELECT 1 FROM newsletter_subscribers n
        WHERE n.email = o.customer_email AND n.unsubscribed_at IS NOT NULL
     )
   ORDER BY o.created_at
`);
function pedidosParaLembrarCarrinho(agora = Date.now(), esperaHoras = 8, janelaDias = 3, capDias = 30){
  return stmtCarrinhosEsquecidos.all(
    agora - janelaDias * DIA_MS,
    agora - esperaHoras * 60 * 60 * 1000,
    agora - capDias * DIA_MS
  );
}

/* Itens de um carrinho abandonado, para o link do lembrete reencher o
   carrinho sozinho. Devolve SÓ o que a pessoa já sabe (o que ela mesma
   escolheu), nunca endereço ou telefone: a referência é um UUID que veio
   no e-mail dela, mas quem tiver o link não precisa ver dado pessoal. */
const stmtCarrinhoPendente = db.prepare(`
  SELECT items_json FROM orders
   WHERE external_reference = ? AND status = 'pendente' AND created_at >= ?
`);
function itensDoCarrinhoEsquecido(referencia, agora = Date.now(), janelaDias = 14){
  const linha = stmtCarrinhoPendente.get(referencia, agora - janelaDias * DIA_MS);
  if(!linha) return null;
  try{
    return JSON.parse(linha.items_json)
      .map(i => ({ id: Number(i.id), qty: Number(i.qty) }))
      .filter(i => Number.isInteger(i.id) && Number.isInteger(i.qty) && i.qty > 0);
  }catch{
    return null;
  }
}

/* ------------------------------ CAMPANHAS ------------------------------ */
const stmtCriaCampanha = db.prepare(`
  INSERT INTO campanhas (assunto, chamada, corpo, produtos, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const stmtListaCampanhas = db.prepare(`SELECT * FROM campanhas ORDER BY created_at DESC`);
const stmtGetCampanha = db.prepare(`SELECT * FROM campanhas WHERE id = ?`);
const stmtAtualizaCampanha = db.prepare(`
  UPDATE campanhas SET assunto = ?, chamada = ?, corpo = ?, produtos = ?, updated_at = ?
   WHERE id = ? AND status = 'rascunho'
`);
const stmtApagaCampanha = db.prepare(`DELETE FROM campanhas WHERE id = ? AND status IN ('rascunho', 'cancelada')`);
const stmtMudaStatusCampanha = db.prepare(`
  UPDATE campanhas SET status = ?, updated_at = ?,
         iniciada_em = COALESCE(iniciada_em, ?),
         concluida_em = CASE WHEN ? IN ('concluida', 'cancelada') THEN ? ELSE concluida_em END
   WHERE id = ?
`);

function criarCampanha({ assunto, chamada, corpo, produtos }){
  const agora = Date.now();
  const r = stmtCriaCampanha.run(assunto, chamada ?? null, corpo,
    JSON.stringify(Array.isArray(produtos) ? produtos : []), agora, agora);
  return getCampanha(Number(r.lastInsertRowid));
}
function listarCampanhas(){ return stmtListaCampanhas.all(); }
function getCampanha(id){ return stmtGetCampanha.get(id) || null; }
function atualizarCampanha(id, { assunto, chamada, corpo, produtos }){
  stmtAtualizaCampanha.run(assunto, chamada ?? null, corpo,
    JSON.stringify(Array.isArray(produtos) ? produtos : []), Date.now(), id);
  return getCampanha(id);
}
function removerCampanha(id){ return stmtApagaCampanha.run(id).changes > 0; }
function mudarStatusCampanha(id, status){
  const agora = Date.now();
  stmtMudaStatusCampanha.run(status, agora, agora, status, agora, id);
  return getCampanha(id);
}

/* Inscritas de verdade: pediram o cupom (opt_in_at) e não se descadastraram.
   Linha criada só para hospedar token de descadastro (garantirTokenDeContato)
   fica de fora — nunca pediu para receber novidade nenhuma. */
const stmtAssinantesAtivas = db.prepare(`
  SELECT email FROM newsletter_subscribers
   WHERE unsubscribed_at IS NULL AND opt_in_at IS NOT NULL
   ORDER BY created_at
`);
function assinantesAtivas(){ return stmtAssinantesAtivas.all().map(r => r.email); }

const stmtEstaDescadastrada = db.prepare(
  `SELECT 1 FROM newsletter_subscribers WHERE email = ? AND unsubscribed_at IS NOT NULL`
);
function pediuDescadastro(email){ return Boolean(stmtEstaDescadastrada.get(email)); }

const stmtInsereDestinatario = db.prepare(
  `INSERT OR IGNORE INTO campanha_destinatarios (campanha_id, email) VALUES (?, ?)`
);
function prepararEnvioDaCampanha(id){
  const emails = assinantesAtivas();
  // Numa transação: metade da lista gravada seria uma campanha que sai pela
  // metade sem ninguém perceber.
  db.exec("BEGIN");
  try {
    for(const email of emails) stmtInsereDestinatario.run(id, email);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  mudarStatusCampanha(id, "enviando");
  return emails.length;
}

const stmtDestinatariosPendentes = db.prepare(`
  SELECT email FROM campanha_destinatarios
   WHERE campanha_id = ? AND enfileirado_em IS NULL
   ORDER BY email
   LIMIT ?
`);
function destinatariosPendentes(id, limite){
  return stmtDestinatariosPendentes.all(id, limite).map(r => r.email);
}

const stmtMarcaDestinatario = db.prepare(`
  UPDATE campanha_destinatarios SET enfileirado_em = ?
   WHERE campanha_id = ? AND email = ?
`);
function marcarDestinatarioEnfileirado(id, email){
  stmtMarcaDestinatario.run(Date.now(), id, email);
}

const stmtCampanhasEnviando = db.prepare(
  `SELECT * FROM campanhas WHERE status = 'enviando' ORDER BY iniciada_em`
);
function campanhasEnviando(){ return stmtCampanhasEnviando.all(); }

/* Progresso mostrado no painel. `enviados` e `falharam` saem do próprio
   email_outbox, ligado pela chave "campanha:<id>:<email>" — sem tabela
   paralela de estado que pudesse divergir da fila real. */
const stmtContagemCampanha = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM campanha_destinatarios WHERE campanha_id = :id) AS total,
    (SELECT COUNT(*) FROM campanha_destinatarios WHERE campanha_id = :id AND enfileirado_em IS NOT NULL) AS enfileirados,
    (SELECT COUNT(*) FROM email_outbox WHERE kind = 'campanha' AND order_reference LIKE :prefixo AND sent_at IS NOT NULL) AS enviados,
    (SELECT COUNT(*) FROM email_outbox WHERE kind = 'campanha' AND order_reference LIKE :prefixo AND sent_at IS NULL AND attempts >= :maxTentativas) AS falharam,
    (SELECT MAX(last_error) FROM email_outbox WHERE kind = 'campanha' AND order_reference LIKE :prefixo AND sent_at IS NULL) AS ultimo_erro
`);
function contagemDaCampanha(id){
  return stmtContagemCampanha.get({
    id, prefixo: `campanha:${id}:%`, maxTentativas: MAX_TENTATIVAS_EMAIL,
  });
}

const stmtApagaFilaDaCampanha = db.prepare(`
  DELETE FROM email_outbox
   WHERE kind = 'campanha' AND sent_at IS NULL AND order_reference LIKE ?
`);
function apagarFilaDaCampanha(id){
  return stmtApagaFilaDaCampanha.run(`campanha:${id}:%`).changes;
}

/* Trava de rodada das tarefas periódicas, no BANCO e não na memória: a
   hospedagem pode subir mais de um processo, e dois processos com uma
   variável cada um não se enxergam. Vale por tempo (não é preciso
   destravar à mão se o processo morrer) e usa o app_state que já existe. */
const stmtPegaTrava = db.prepare(`
  INSERT INTO app_state (chave, valor, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, updated_at = excluded.updated_at
   WHERE CAST(app_state.valor AS INTEGER) <= ?
`);
function tentarTravarRodada(chave, duracaoMs = 10 * 60 * 1000){
  const agora = Date.now();
  return stmtPegaTrava.run(chave, String(agora + duracaoMs), agora, agora).changes > 0;
}
const stmtSoltaTrava = db.prepare(`DELETE FROM app_state WHERE chave = ?`);
function destravarRodada(chave){ stmtSoltaTrava.run(chave); }

/* ---------- Estado da aplicação ---------- */
const stmtGravaEstado = db.prepare(`
  INSERT INTO app_state (chave, valor, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, updated_at = excluded.updated_at
`);
const stmtLeEstado = db.prepare(`SELECT valor, updated_at FROM app_state WHERE chave = ?`);
function gravarEstado(chave, valor){ stmtGravaEstado.run(chave, valor == null ? null : String(valor), Date.now()); }
function lerEstado(chave){ return stmtLeEstado.get(chave) || null; }

const MAX_TENTATIVAS_EMAIL = 5;

const stmtEnfileiraEmail = db.prepare(`
  INSERT OR IGNORE INTO email_outbox
    (kind, to_email, subject, text_body, html_body, order_reference, next_attempt_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
/* Devolve o id da linha criada, ou null quando o índice único barrou —
   barrar aqui é o comportamento certo, não um erro: significa que este
   e-mail já foi enfileirado para este pedido (webhook reenviado). */
function enqueueEmail({ kind, toEmail, subject, textBody, htmlBody, orderReference }){
  const agora = Date.now();
  const r = stmtEnfileiraEmail.run(
    kind, toEmail, subject, textBody, htmlBody, orderReference ?? null, agora, agora
  );
  return r.changes > 0 ? Number(r.lastInsertRowid) : null;
}

const stmtEmailDoPedido = db.prepare(
  `SELECT * FROM email_outbox WHERE kind = ? AND order_reference = ?`
);
function getOutboxEntry(kind, orderReference){
  if(!orderReference) return null;
  return stmtEmailDoPedido.get(kind, orderReference) || null;
}

const stmtApagaEmailDoPedido = db.prepare(
  `DELETE FROM email_outbox WHERE kind = ? AND order_reference = ?`
);
/* Só para quando o CONTEÚDO do aviso mudou (a lojista corrigiu um código de
   rastreio digitado errado). Sem isto o índice único barraria o reenvio e a
   cliente ficaria para sempre com o código errado. */
function deleteOutboxEntry(kind, orderReference){
  if(!orderReference) return 0;
  return stmtApagaEmailDoPedido.run(kind, orderReference).changes;
}

/* ⚠️ Campanha por último, sempre. Uma campanha enfileira dezenas de linhas
   de uma vez; ordenando só por id, o recibo de uma compra feita no meio do
   disparo ficaria atrás de toda a lista de novidades. */
const stmtEmailsPendentes = db.prepare(`
  SELECT * FROM email_outbox
   WHERE sent_at IS NULL AND attempts < ? AND next_attempt_at <= ?
   ORDER BY (kind = 'campanha') ASC, id ASC
   LIMIT ?
`);
/* ⚠️ REIVINDICA as linhas antes de devolver, numa transação. Sem isto,
   duas rodadas simultâneas — dois workers do Passenger, ou o cron externo
   batendo de novo enquanto a rodada anterior ainda envia — liam a MESMA
   linha pendente e mandavam o mesmo e-mail duas vezes para a cliente.
   Empurrar next_attempt_at para frente funciona como aluguel: quem pegou
   tem esse tempo para enviar, e se o processo morrer no meio a linha
   volta sozinha para a fila quando o aluguel vence, sem precisar de
   ninguém destravando nada à mão. */
const ALUGUEL_DE_ENVIO_MS = 10 * 60 * 1000;
const stmtReivindicaEmail = db.prepare(
  `UPDATE email_outbox SET next_attempt_at = ? WHERE id = ? AND sent_at IS NULL AND next_attempt_at <= ?`
);
function pendingEmails(limite = 20){
  const agora = Date.now();
  const candidatos = stmtEmailsPendentes.all(MAX_TENTATIVAS_EMAIL, agora, limite);
  const meus = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for(const linha of candidatos){
      if(stmtReivindicaEmail.run(agora + ALUGUEL_DE_ENVIO_MS, linha.id, agora).changes > 0){
        meus.push(linha);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return meus;
}

// Saúde dos avisos que vão para a LOJISTA (venda nova, contato). Serve ao
// card do painel: sem isto, um aviso preso na fila só aparece para quem lê o
// log do servidor — ou seja, para ninguém.
const stmtAvisosPresos = db.prepare(`
  SELECT COUNT(*) AS presos,
         MAX(last_error) AS ultimo_erro,
         MAX(created_at) AS mais_recente
    FROM email_outbox
   WHERE sent_at IS NULL AND kind IN ('aviso_venda', 'aviso_contato')
`);
const stmtUltimoAvisoEnviado = db.prepare(`
  SELECT sent_at FROM email_outbox
   WHERE sent_at IS NOT NULL AND kind IN ('aviso_venda', 'aviso_contato')
   ORDER BY sent_at DESC LIMIT 1
`);
function avisosDaLojista(){
  const fila = stmtAvisosPresos.get() || {};
  return {
    presos: fila.presos || 0,
    ultimoErro: fila.ultimo_erro || null,
    ultimoEnviadoEm: stmtUltimoAvisoEnviado.get()?.sent_at || null,
  };
}

const stmtEmailPorId = db.prepare(`SELECT * FROM email_outbox WHERE id = ?`);
function getOutboxEmail(id){ return stmtEmailPorId.get(id) || null; }

const stmtEmailEnviado = db.prepare(
  `UPDATE email_outbox SET sent_at = ?, last_error = NULL WHERE id = ?`
);
function markEmailSent(id){ stmtEmailEnviado.run(Date.now(), id); }

const stmtEmailFalhou = db.prepare(
  `UPDATE email_outbox
      SET attempts = attempts + 1, next_attempt_at = ?, last_error = ?
    WHERE id = ?`
);
/* Espera crescente entre tentativas (5min, 15, 45, 2h15, 6h45): provedor de
   SMTP fora do ar costuma voltar sozinho, e insistir de minuto em minuto só
   ajuda a ser marcado como spam. */
/* Só para teste: força a hora da próxima tentativa, para simular aluguel
   vencido sem esperar 10 minutos de relógio. */
const stmtAdiaEmail = db.prepare(`UPDATE email_outbox SET next_attempt_at = ? WHERE id = ?`);
function adiarEmail(id, quando){ stmtAdiaEmail.run(quando, id); }

function markEmailFailed(id, erro){
  const linha = getOutboxEmail(id);
  const tentativas = (linha ? linha.attempts : 0) + 1;
  // A espera é recontada do zero a partir de agora, substituindo o aluguel
  // que pendingEmails gravou ao reivindicar a linha.
  const espera = 5 * 60 * 1000 * Math.pow(3, tentativas - 1);
  stmtEmailFalhou.run(Date.now() + espera, String(erro).slice(0, 500), id);
}

/* Assinatura do catálogo — usada pelo cache de HTML do server.js para saber
   se o JSON-LD precisa ser refeito. Precisa cobrir TUDO que dadosEstruturados()
   lê: os dois lados do catálogo e os rótulos de categoria.
   COUNT junto de MAX(updated_at) porque apagar uma linha não move o MAX; e
   custom_categories não tem updated_at, então vai o conteúdo mesmo (são poucas
   linhas) para que renomear uma categoria também conte. */
function catalogVersion(){
  const p = db.prepare("SELECT COUNT(*) AS n, IFNULL(MAX(updated_at), 0) AS t FROM product_overrides").get();
  const c = db.prepare("SELECT COUNT(*) AS n, IFNULL(MAX(updated_at), 0) AS t FROM custom_products").get();
  const k = db.prepare("SELECT IFNULL(GROUP_CONCAT(slug || ':' || label), '') AS s FROM custom_categories").get();
  return `${p.n}.${p.t}|${c.n}.${c.t}|${k.s.length}.${hashCurto(k.s)}`;
}

function hashCurto(texto){
  let h = 5381;
  for(let i = 0; i < texto.length; i++) h = ((h * 33) ^ texto.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

module.exports = {
  garantirTokenDeAvaliacao,
  tokenDeAvaliacaoConfere,
  salvarAvaliacao,
  avaliacoesDoPedido,
  insertReviewPhoto,
  getReviewPhotoPublicada,
  getReviewPhotoVariant,
  saveReviewPhotoVariant,
  getReviewPhoto,
  listarAvaliacoesPainel,
  mudarStatusAvaliacao,
  tirarFotoDaAvaliacao,
  excluirAvaliacao,
  apagarFotoOrfaDeAvaliacao,
  avaliacoesPublicadas,
  notaMedia,
  notasPorPedido,
  contarAvaliacoesPendentes,
  pedidosParaConfirmarRecebimento,
  pedidosParaPedirAvaliacao,
  pedidosParaLembrarCarrinho,
  criarCampanha,
  listarCampanhas,
  getCampanha,
  atualizarCampanha,
  removerCampanha,
  mudarStatusCampanha,
  assinantesAtivas,
  pediuDescadastro,
  prepararEnvioDaCampanha,
  destinatariosPendentes,
  marcarDestinatarioEnfileirado,
  campanhasEnviando,
  contagemDaCampanha,
  apagarFilaDaCampanha,
  itensDoCarrinhoEsquecido,
  tentarTravarRodada,
  destravarRodada,
  gravarEstado,
  lerEstado,
  catalogVersion,
  enqueueEmail,
  deleteOutboxEntry,
  getOutboxEntry,
  pendingEmails,
  avisosDaLojista,
  getOutboxEmail,
  markEmailSent,
  markEmailFailed,
  adiarEmail,
  createUser,
  getUserByEmail,
  getUserByGoogleId,
  setUserGoogleId,
  getUserById,
  getSavedAddress,
  saveAddress,
  listUsersForExport,
  listAccountsForAdmin,
  createSession,
  getSessionByTokenHash,
  deleteSession,
  deleteAllSessionsForUser,
  createPasswordReset,
  getPasswordReset,
  deletePasswordReset,
  deletePasswordResetsForUser,
  updateUserPassword,
  updatePerfil,
  hasUsedCouponSince,
  CUPOM_ANIVERSARIO,
  updateUserEmail,
  aniversariantesDoDia,
  deleteOtherSessions,
  deleteUserAccount,
  recordLoginAttempt,
  getLoginLockout,
  listRecentLoginAttempts,
  pruneLoginAttempts,
  setUserTotp,
  createTwoFactorChallenge,
  getTwoFactorChallenge,
  deleteTwoFactorChallenge,
  setTwoFactorEmailCode,
  incrementTwoFactorEmailCodeAttempts,
  createOrder,
  getOrderByExternalReference,
  updateOrderStatus,
  updateOrderDraft,
  listOrdersByUser,
  listAllOrders,
  updateOrderTracking,
  markOrderInProduction,
  listOrdersAwaitingDelivery,
  markOrderDelivered,
  setMelhorEnvioShipmentId,
  getOrderStats,
  deleteOrder,
  hasUsedCoupon,
  insertProductPhoto,
  getProductPhoto,
  deleteProductPhoto,
  getProductPhotoVariant,
  listHeroPhotos,
  countHeroPhotos,
  getHeroPhoto,
  insertHeroPhoto,
  updateHeroPhoto,
  deleteHeroPhoto,
  setHeroPhotoOrder,
  getHeroPhotoVariant,
  saveHeroPhotoVariant,
  heroVersion,
  listarDepoimentos,
  depoimentosPublicados,
  contarDepoimentosPublicados,
  getDepoimento,
  criarDepoimento,
  atualizarDepoimento,
  removerDepoimento,
  setOrdemDepoimentos,
  getFotoDeDepoimentoPublicado,
  saveProductPhotoVariant,
  // getProductOverride não é exportada de propósito: ninguém fora daqui lê
  // um override isolado — quem consome sempre quer o mapa inteiro
  // (listProductOverrides) para montar o catálogo de uma vez.
  listProductOverrides,
  upsertProductOverride,
  setProductsOrder,
  listCustomProducts,
  getCustomProduct,
  insertCustomProduct,
  updateCustomProduct,
  deleteCustomProduct,
  listCustomCategories,
  insertCustomCategory,
  updateCustomCategoryLabel,
  deleteCustomCategory,
  countProductsUsingCategory,
  listCustomColors,
  insertCustomColor,
  deleteCustomColor,
  addNewsletterSubscriber,
  listNewsletterSubscribers,
  getOrCreateUnsubscribeToken,
  garantirTokenDeContato,
  unsubscribeNewsletter,
  createContactMessage,
  listContactMessages,
  getContactMessage,
  deleteContactMessage,
  getCoupon,
  listCoupons,
  createCoupon,
  updateCoupon,
  deleteCoupon,
  getInstagramToken,
  saveInstagramToken,
  deleteInstagramToken,
};
