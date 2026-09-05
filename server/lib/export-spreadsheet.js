/**
 * =============================================================================
 *  EXPORTAÇÃO DA LOJA EM PLANILHA (.xlsx) — para Excel / Google Sheets
 * =============================================================================
 *  Monta um único arquivo .xlsx com uma aba por entidade, a partir do banco:
 *
 *    Usuários   — contas de clientes (sem senha, sem segredo de 2FA)
 *    Compras    — pedidos (uma linha por pedido, itens em texto legível)
 *    Pagamentos — visão de pagamento derivada de cada pedido
 *    Endereços  — endereço de entrega usado em cada pedido
 *    Mensagens  — contatos do formulário "Vamos criar seu laço?"
 *
 *  O projeto guarda pagamento e endereço embutidos no próprio pedido
 *  (orders.payment_method / orders.address_json), não em tabelas separadas —
 *  então as abas Pagamentos e Endereços são projeções derivadas de Compras,
 *  não tabelas independentes. Para a lojista, na planilha, o efeito é o mesmo.
 *
 *  NUNCA sai daqui: hash de senha, segredo de 2FA, token de sessão, número de
 *  cartão (que o site nem chega a receber — o Mercado Pago trata o cartão no
 *  lado deles; ver README/Checkout Pro).
 * =============================================================================
 */
const db = require("./db");
const { buildXlsx } = require("./xlsx");

// Epoch (ms) -> "DD/MM/AAAA HH:MM" no fuso de Brasília, independente do fuso
// em que o servidor roda (a Hostinger pode estar em UTC).
function formatDateTime(ms) {
  if (!ms && ms !== 0) return "";
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(d);
  const get = t => parts.find(p => p.type === t)?.value || "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}

function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Number(v.toFixed(2)) : 0;
}

function safeParse(json, fallback) {
  try { return JSON.parse(json); } catch { return fallback; }
}

// Pedido não tem uma coluna de "status de pagamento" própria — derivamos do
// status do pedido, que é o que a lojista enxerga no painel.
function paymentStatusFor(orderStatus) {
  switch (orderStatus) {
    case "pago":
    case "enviado":
    case "entregue":
      return "aprovado";
    case "cancelado":
      return "cancelado";
    default:
      return "pendente";
  }
}

const PAYMENT_METHOD_LABELS = { pix: "PIX", card: "Cartão", boleto: "Boleto" };

function buildSheets({ resolveProductName } = {}) {
  const nameOf = typeof resolveProductName === "function"
    ? resolveProductName
    : (id) => `Produto #${id}`;

  const users = db.listUsersForExport();
  const orders = db.listAllOrders();
  const messages = db.listContactMessages();

  /* ------------------------------------------------------------ Usuários -- */
  const usuarios = {
    name: "Usuários",
    columns: [
      { header: "ID", key: "id", width: 8 },
      { header: "Nome", key: "nome", width: 28 },
      { header: "E-mail", key: "email", width: 32 },
      { header: "CPF", key: "cpf", width: 16 },
      { header: "2FA ativo", key: "twofa", width: 11 },
      { header: "Data de criação", key: "criado", width: 20 },
    ],
    rows: users.map(u => ({
      id: u.id,
      nome: u.name,
      email: u.email,
      cpf: u.cpf || "",
      twofa: u.has_2fa ? "Sim" : "Não",
      criado: formatDateTime(u.created_at),
    })),
  };

  /* ------------------------------------------------------------- Compras -- */
  const compras = {
    name: "Compras",
    columns: [
      { header: "ID", key: "id", width: 8 },
      { header: "Referência", key: "ref", width: 26 },
      { header: "Usuário ID", key: "usuario", width: 11 },
      { header: "Status", key: "status", width: 12 },
      { header: "Itens", key: "itens", width: 40 },
      { header: "Subtotal (R$)", key: "subtotal", width: 14 },
      { header: "Desconto (R$)", key: "desconto", width: 14 },
      { header: "Desconto Pix (R$)", key: "pix", width: 16 },
      { header: "Frete (R$)", key: "frete", width: 12 },
      { header: "Total (R$)", key: "total", width: 12 },
      { header: "Cupom", key: "cupom", width: 14 },
      { header: "Forma de pagamento", key: "forma", width: 18 },
      { header: "Cód. rastreio", key: "rastreio", width: 18 },
      { header: "Data da compra", key: "data", width: 20 },
    ],
    rows: orders.map(o => {
      const items = safeParse(o.items_json, []);
      const itensTxt = Array.isArray(items)
        ? items.map(it => `${nameOf(it.id)} x${it.qty}`).join("; ")
        : "";
      return {
        id: o.id,
        ref: o.external_reference,
        usuario: o.user_id ?? "",
        status: o.status,
        itens: itensTxt,
        subtotal: money(o.subtotal),
        desconto: money(o.discount),
        pix: money(o.pix_discount),
        frete: money(o.shipping_price),
        total: money(o.total),
        cupom: o.coupon_code || "",
        forma: PAYMENT_METHOD_LABELS[o.payment_method] || o.payment_method || "",
        rastreio: o.tracking_code || "",
        data: formatDateTime(o.created_at),
      };
    }),
  };

  /* ---------------------------------------------------------- Pagamentos -- */
  const pagamentos = {
    name: "Pagamentos",
    columns: [
      { header: "Compra ID", key: "compra", width: 10 },
      { header: "Referência", key: "ref", width: 26 },
      { header: "Método", key: "metodo", width: 12 },
      { header: "Status pagamento", key: "status", width: 16 },
      { header: "Valor (R$)", key: "valor", width: 12 },
      { header: "ID transação (gateway)", key: "transacao", width: 26 },
      { header: "Data", key: "data", width: 20 },
    ],
    rows: orders.map(o => ({
      compra: o.id,
      ref: o.external_reference,
      metodo: PAYMENT_METHOD_LABELS[o.payment_method] || o.payment_method || "",
      status: paymentStatusFor(o.status),
      valor: money(o.total),
      transacao: o.payment_id || "",
      data: formatDateTime(o.updated_at || o.created_at),
    })),
  };

  /* ----------------------------------------------------------- Endereços -- */
  const enderecos = {
    name: "Endereços",
    columns: [
      { header: "Compra ID", key: "compra", width: 10 },
      { header: "Referência", key: "ref", width: 26 },
      { header: "Usuário ID", key: "usuario", width: 11 },
      { header: "Destinatário", key: "nome", width: 26 },
      { header: "Telefone", key: "telefone", width: 18 },
      { header: "CPF", key: "cpf", width: 16 },
      { header: "Rua", key: "rua", width: 30 },
      { header: "Número", key: "numero", width: 10 },
      { header: "Complemento", key: "complemento", width: 18 },
      { header: "Bairro", key: "bairro", width: 20 },
      { header: "Cidade", key: "cidade", width: 20 },
      { header: "Estado", key: "estado", width: 8 },
      { header: "CEP", key: "cep", width: 12 },
    ],
    rows: orders.map(o => {
      const a = safeParse(o.address_json, {}) || {};
      return {
        compra: o.id,
        ref: o.external_reference,
        usuario: o.user_id ?? "",
        nome: a.nome || "",
        telefone: a.telefone || "",
        cpf: a.cpf || "",
        rua: a.rua || "",
        numero: a.numero || "",
        complemento: a.complemento || "",
        bairro: a.bairro || "",
        cidade: a.cidade || "",
        estado: a.uf || a.estado || "",
        cep: a.cep || "",
      };
    }),
  };

  /* ------------------------------------------------------------ Mensagens -- */
  const mensagens = {
    name: "Mensagens",
    columns: [
      { header: "ID", key: "id", width: 8 },
      { header: "Nome", key: "nome", width: 26 },
      { header: "Telefone", key: "telefone", width: 18 },
      { header: "Ocasião", key: "ocasiao", width: 20 },
      { header: "Mensagem", key: "mensagem", width: 50 },
      { header: "Data de envio", key: "data", width: 20 },
    ],
    rows: messages.map(m => ({
      id: m.id,
      nome: m.nome,
      telefone: m.telefone,
      ocasiao: m.ocasiao || "",
      mensagem: m.mensagem,
      data: formatDateTime(m.created_at),
    })),
  };

  return [usuarios, compras, pagamentos, enderecos, mensagens];
}

// Retorna o Buffer do .xlsx pronto para download.
function buildStoreWorkbook(deps) {
  return buildXlsx(buildSheets(deps));
}

module.exports = { buildStoreWorkbook, buildSheets };
