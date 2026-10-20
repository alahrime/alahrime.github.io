// Motion layer: text effects, scroll reveals and pointer effects. Purely decorative: the page reads
// fine without it, and it stands down for visitors who ask their system for reduced motion.
(() => {
  const root = document.documentElement;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(pointer: fine)').matches;
  const raf = fn => { let q = 0; return (...a) => q || (q = requestAnimationFrame(() => { q = 0; fn(...a); })); };

  // ---- hero title: split into per-letter spans (words stay unbroken) so the intro can stagger them ----
  const h1 = document.querySelector('.hero h1');
  h1.setAttribute('aria-label', h1.textContent.replace(/\s+/g, ' ').trim());
  let ci = 0;
  (function split(node) {
    for (const n of [...node.childNodes]) {
      if (n.nodeType !== 3) { split(n); continue; }
      const frag = document.createDocumentFragment();
      for (const part of n.textContent.split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) { frag.append(part); continue; }
        const word = document.createElement('span');
        word.className = 'word';
        for (const ch of part) {
          const s = document.createElement('span');
          s.className = 'ch'; s.textContent = ch; s.style.setProperty('--ci', ci++);
          word.append(s);
        }
        frag.append(word);
      }
      n.replaceWith(frag);
    }
  })(h1);
  for (const c of h1.children) c.setAttribute('aria-hidden', 'true');

  // the name's gradient is shared across letters: give each letter its x offset inside the name
  const name = h1.querySelector('.name');
  const measure = () => {
    const chs = [...name.querySelectorAll('.ch')], x0 = chs[0].offsetLeft;
    chs.forEach(c => c.style.setProperty('--x', c.offsetLeft - x0 + 'px'));
    name.style.setProperty('--w', name.offsetWidth + 'px');
  };
  measure();
  document.fonts?.ready.then(measure);
  addEventListener('resize', raf(measure));

  // ---- decode effect: text resolves left to right out of random glyphs ----
  const GLYPHS = '!<>-_/[]{}=+*^?#01ΣλΔ∂∞';
  function scramble(el, to, dur = 700) {
    if (still) { el.textContent = to; return; }
    const from = el.textContent, len = Math.max(from.length, to.length), t0 = performance.now();
    cancelAnimationFrame(el._raf);
    const step = now => {
      const p = Math.min((now - t0) / dur, 1);
      let out = '';
      for (let i = 0; i < len; i++) {
        const at = i / len * .75;                  // when this letter starts scrambling; it settles .25 later
        out += p >= at + .25 ? (to[i] ?? '') : p > at ? GLYPHS[Math.random() * GLYPHS.length | 0] : (from[i] ?? '');
      }
      el.textContent = p < 1 ? out : to;
      if (p < 1) el._raf = requestAnimationFrame(step);
    };
    el._raf = requestAnimationFrame(step);
  }

  // eyebrow role cycles through what I do
  const role = document.getElementById('role');
  const ROLES = ['frontend engineer', 'full-stack developer', 'design-system builder', 'creative coder'];
  let ri = 0;
  if (!still) setTimeout(() => setInterval(() => scramble(role, ROLES[ri = (ri + 1) % ROLES.length], 900), 3200), 1800);

  // ---- scroll reveal: in on enter, out on leave; section titles decode as they arrive ----
  for (const sec of document.querySelectorAll('section'))
    sec.querySelectorAll('[data-reveal]').forEach((el, i) => el.style.setProperty('--i', Math.min(i, 7)));
  for (const ttl of document.querySelectorAll('h2 .ttl')) ttl.dataset.t = ttl.textContent;
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      const was = e.target.classList.contains('in');
      e.target.classList.toggle('in', e.isIntersecting);
      if (e.isIntersecting && !was && e.target.tagName === 'H2') {
        const ttl = e.target.querySelector('.ttl');
        scramble(ttl, ttl.dataset.t, 650);
      }
    }
  }, { threshold: .12, rootMargin: '0px 0px -6% 0px' });
  document.querySelectorAll('[data-reveal]').forEach(el => io.observe(el));

  // ---- scroll-linked: progress bar, timeline fill, lit milestones ----
  const tl = document.querySelector('.timeline'), stops = [...tl.children];
  const onScroll = () => {
    const vh = innerHeight, line = vh * .65, r = tl.getBoundingClientRect();
    tl.style.setProperty('--p', Math.min(Math.max((line - r.top) / r.height, 0), 1));
    for (const li of stops) li.classList.toggle('lit', li.getBoundingClientRect().top + 10 < line);
    root.style.setProperty('--sp', scrollY / Math.max(1, root.scrollHeight - vh));
  };
  addEventListener('scroll', raf(onScroll), { passive: true });
  addEventListener('resize', raf(onScroll));
  onScroll();

  // ---- nav: underline the section in view ----
  const links = new Map([...document.querySelectorAll('.links a[href^="#"]:not(.brand)')].map(a => [a.hash.slice(1), a]));
  const spy = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) links.forEach((a, id) => a.classList.toggle('active', id === e.target.id));
  }, { rootMargin: '-45% 0px -50% 0px' });
  document.querySelectorAll('section[id]').forEach(s => spy.observe(s));
  new IntersectionObserver(([e]) => { if (e.isIntersecting) links.forEach(a => a.classList.remove('active')); },
                           { rootMargin: '-45% 0px -50% 0px' }).observe(document.querySelector('.hero'));

  if (still || !fine) return;   // the rest follows a mouse

  // ---- cursor glow behind the page ----
  const glow = raf(e => { root.style.setProperty('--cx', e.clientX + 'px'); root.style.setProperty('--cy', e.clientY + 'px'); });
  addEventListener('pointermove', e => { root.style.setProperty('--glow', 1); glow(e); }, { passive: true });
  document.addEventListener('pointerleave', () => root.style.setProperty('--glow', 0));

  // ---- project cards: tilt toward the pointer, spotlight and edge glow follow it ----
  for (const card of document.querySelectorAll('.card')) {
    card.addEventListener('pointermove', e => {
      const r = card.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      card.style.setProperty('--mx', x * 100 + '%'); card.style.setProperty('--my', y * 100 + '%');
      card.style.setProperty('--rx', (.5 - y) * 7 + 'deg'); card.style.setProperty('--ry', (x - .5) * 9 + 'deg');
    });
    card.addEventListener('pointerleave', () => { card.style.setProperty('--rx', '0deg'); card.style.setProperty('--ry', '0deg'); });
  }

  // ---- magnetic buttons: drift toward the cursor, spring back on leave ----
  for (const b of document.querySelectorAll('.btn')) {
    b.addEventListener('pointermove', e => {
      const r = b.getBoundingClientRect();
      b.style.setProperty('--tx', (e.clientX - r.left - r.width / 2) * .22 + 'px');
      b.style.setProperty('--ty', (e.clientY - r.top - r.height / 2) * .35 + 'px');
    });
    b.addEventListener('pointerleave', () => { b.style.setProperty('--tx', '0px'); b.style.setProperty('--ty', '0px'); });
  }
})();
