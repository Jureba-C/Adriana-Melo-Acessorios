(function () {
  "use strict";

  var STORAGE_KEY = "plc_cookie_consent";

  var prev = null;
  try { prev = localStorage.getItem(STORAGE_KEY); } catch (e) { }
  if (prev === "seen" || prev === "accepted" || prev === "rejected") return;

  function save(decision) {
    try {
      localStorage.setItem(STORAGE_KEY, decision);
      localStorage.setItem(STORAGE_KEY + "_at", new Date().toISOString());
    } catch (e) { }
  }

  function build() {
    var banner = document.createElement("div");
    banner.className = "cookie-consent";
    banner.setAttribute("role", "region");
    banner.setAttribute("aria-live", "polite");
    banner.setAttribute("aria-label", "Aviso de privacidade e cookies");
    banner.innerHTML =
      '<div class="cookie-consent-main">' +
        '<div class="cookie-consent-head">' +
          '<span class="cookie-consent-icon" aria-hidden="true"><i class="bi bi-cookie"></i></span>' +
          '<h2 class="cookie-consent-title">Sua privacidade importa</h2>' +
        '</div>' +
        '<p class="cookie-consent-text">Usamos só o cookie do login e guardamos o carrinho no seu próprio navegador. ' +
          'Nada de rastreamento. Veja mais na nossa ' +
          '<a href="/politica.html#privacidade">Política de Privacidade</a>.</p>' +
      '</div>' +
      '<div class="cookie-consent-actions">' +
        '<button type="button" class="btn-blush cookie-consent-btn" data-consent="seen">Entendi</button>' +
      '</div>';
    return banner;
  }

  function dismiss(banner, decision, resizeObserver) {
    save(decision);
    if (resizeObserver) resizeObserver.disconnect();
    document.body.classList.remove("has-cookie-consent");
    document.body.style.removeProperty("--cookie-consent-space");
    banner.classList.add("is-leaving");
    var done = function () { banner.remove(); };
    banner.addEventListener("animationend", done, { once: true });
    setTimeout(done, 400);
  }

  function mount() {
    var banner = build();
    document.body.appendChild(banner);
    document.body.classList.add("has-cookie-consent");

    var resizeObserver = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(function () {
        document.body.style.setProperty("--cookie-consent-space", banner.offsetHeight + "px");
      });
      resizeObserver.observe(banner);
    } else {
      document.body.style.setProperty("--cookie-consent-space", banner.offsetHeight + "px");
    }

    banner.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-consent]");
      if (btn) dismiss(banner, btn.getAttribute("data-consent"), resizeObserver);
    });
    requestAnimationFrame(function () {
      banner.classList.add("is-visible");
      var firstBtn = banner.querySelector(".cookie-consent-btn");
      if (firstBtn) firstBtn.focus({ preventScroll: true });
    });
  }

  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
