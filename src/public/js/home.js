// Home comercial — sin lógica de negocio acá, es 100% presentación.
// El login/workspace real vive en /app (js/app.js).

// ---------- Scroll reveal ----------
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15 }
  );
  document.querySelectorAll('.reveal').forEach((el) => observer.observe(el));
} else {
  // Sin soporte de IntersectionObserver: mostrar todo directamente, sin animación.
  document.querySelectorAll('.reveal').forEach((el) => el.classList.add('is-visible'));
}

// ---------- Before/After slider ----------
// Funciona con mouse y con touch (móvil) — el <input type="range"> maneja el
// arrastre real (accesible, funciona con teclado), y actualizamos el clip-path
// del panel "después" y la posición de la manija en cada cambio.
// Genérico: recorre todas las tarjetas .ba-slider presentes en la página, sin
// necesidad de listar IDs a mano — agregar una tarjeta nueva en el HTML alcanza.
document.querySelectorAll('.ba-slider').forEach((slider) => {
  const range = slider.querySelector('.ba-range');
  const after = slider.querySelector('.ba-after');
  const handle = slider.querySelector('.ba-handle');
  if (!range || !after || !handle) return;

  function update() {
    const pct = range.value;
    after.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    handle.style.left = `${pct}%`;
  }

  range.addEventListener('input', update);
  update();
});
