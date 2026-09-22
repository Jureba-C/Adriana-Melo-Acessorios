(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PLCProdutoUrl = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function apelido(nome) {
    const limpo = String(nome == null ? "" : nome)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "");
    return limpo || "laco";
  }

  function caminhoDoProduto(id, nome) {
    return "/laco/" + id + "-" + apelido(nome);
  }

  function idDoApelido(trecho) {
    const casou = /^([1-9][0-9]{0,8})(?:-|$)/.exec(String(trecho == null ? "" : trecho));
    return casou ? Number(casou[1]) : null;
  }

  return { apelido, caminhoDoProduto, idDoApelido };
});
