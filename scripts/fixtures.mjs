// Fixtures locais genéricas para a auditoria (nenhuma depende do Nexus nem de GSAP, exceto a que
// testa GSAP de propósito). Cada página tem blocos de cor sólida em posições conhecidas, o que
// permite medir a fidelidade por pixel: `expected(name, query, ctx)` devolve os blocos que
// DEVEM aparecer na captura final. Para navegar manualmente: node scripts/fixtures.mjs [porta]
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";
import { pathToFileURL } from "node:url";

export const COLORS = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#00a0a0", "#f032e6", "#b0d000", "#008080", "#9a6324", "#800000", "#000075"];
const SEC = 600; // altura de cada seção
const BLK = 300; // altura de cada bloco colorido
const blockTop = (i) => i * SEC + (SEC - BLK) / 2;
const blocks = (n, label = "s") => Array.from({ length: n }, (_, i) => ({ y: blockTop(i), h: BLK, color: COLORS[i % 12], label: `${label}${i}` }));

const page = (title, css, body, script = "", head = "") => `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;font:16px system-ui}.sec{height:${SEC}px;position:relative;overflow:hidden}.blk{position:absolute;left:0;right:0;top:${(SEC - BLK) / 2}px;height:${BLK}px;display:block;width:100%}
.lbl{position:absolute;left:12px;top:8px;color:#fff;font-weight:700;background:rgba(0,0,0,.4);padding:2px 6px;z-index:1}${css}</style>${head}</head>
<body>${body}<script>${script}</script></body></html>`;

const section = (i, extra = "", inner = "") =>
  `<section class="sec" data-i="${i}"><div class="blk" style="background:${COLORS[i % 12]}" ${extra}><span class="lbl">s${i}</span>${inner}</div></section>`;

const svg = (hex) => `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300" viewBox="0 0 800 300" preserveAspectRatio="none"><rect width="800" height="300" fill="${hex}"/></svg>`;

const PAGES = {
  // 1) Página estática simples, sem JS.
  static: () => page("estática", "", Array.from({ length: 6 }, (_, i) => section(i)).join("")),

  // 2) Página longa com lazy loading nativo, carregamento por IntersectionObserver e rolagem infinita.
  "lazy-long": () => page("lazy longa", ".blk{object-fit:fill}", "<main id=m></main>", `
    const COLORS = ${JSON.stringify(COLORS)}, TOTAL = 24;
    let count = 0;
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.src = e.target.dataset.src; io.unobserve(e.target); } }), { rootMargin: '200px' });
    function add(n) {
      for (let k = 0; k < n && count < TOTAL; k++, count++) {
        const i = count, hex = COLORS[i % 12].slice(1);
        const s = document.createElement('section'); s.className = 'sec';
        const img = document.createElement('img'); img.className = 'blk'; img.alt = '';
        const url = '/img/' + hex + '.svg?delay=150';
        if (i % 5 === 3) { img.dataset.src = url; io.observe(img); } else { img.loading = 'lazy'; img.src = url; }
        s.append(img); document.getElementById('m').append(s);
      }
    }
    add(20);
    addEventListener('scroll', () => { if (scrollY + innerHeight > document.documentElement.scrollHeight - 400) add(4); }, { passive: true });
  `),

  // 3) GSAP + ScrollTrigger (replay com reset, scrub e pin).
  "gsap-st": () => page("gsap", "", Array.from({ length: 10 }, (_, i) => section(i)).join(""), `
    if (window.gsap && window.ScrollTrigger) {
      gsap.registerPlugin(ScrollTrigger);
      document.querySelectorAll('.sec').forEach((sec, i) => {
        const blk = sec.querySelector('.blk');
        if (i <= 7) gsap.fromTo(blk, { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.8, scrollTrigger: { trigger: sec, start: 'top 85%', toggleActions: 'play none none reset' } });
        else if (i === 8) gsap.fromTo(blk, { opacity: 0.1 }, { opacity: 1, scrollTrigger: { trigger: sec, start: 'top bottom', end: 'top 30%', scrub: true } });
        else ScrollTrigger.create({ trigger: sec, start: 'top top', end: '+=500', pin: true });
      });
    }
  `, '<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script><script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/ScrollTrigger.min.js"></script>'),

  // 4) IntersectionObserver (uma vez / replay), CSS animations finitas e infinitas, scroll-driven CSS.
  "io-css": () => page("io+css", `
    .rv{opacity:0;transform:translateY(24px);transition:opacity .6s,transform .6s}.rv.in{opacity:1;transform:none}
    @keyframes fade{from{opacity:0}to{opacity:1}}.fin{opacity:0;animation:fade 1.2s .3s forwards}
    @keyframes pulse{50%{transform:scale(.98)}}.inf{animation:pulse 1s infinite}
    @keyframes reveal{from{opacity:0;transform:translateY(40px)}to{opacity:1;transform:none}}
    .sd{animation:reveal linear both;animation-timeline:view();animation-range:entry 0% entry 60%}`,
    Array.from({ length: 12 }, (_, i) => {
      const cls = i < 4 ? "rv once" : i < 8 ? "rv toggle" : i === 8 ? "fin" : i === 9 ? "inf" : "sd";
      return section(i).replace('class="blk"', `class="blk ${cls}"`);
    }).join(""), `
    const once = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); once.unobserve(e.target); } }), { threshold: 0.2 });
    const toggle = new IntersectionObserver((es) => es.forEach((e) => e.target.classList.toggle('in', e.isIntersecting)), { threshold: 0.2 });
    document.querySelectorAll('.once').forEach((el) => once.observe(el));
    document.querySelectorAll('.toggle').forEach((el) => toggle.observe(el));
  `),

  // 5) SPA com Vue 3: renderiza após uma "busca" e monta blocos só quando entram na viewport.
  "spa-vue": () => page("spa vue", "", '<div id="app"></div>', `
    Vue.createApp({
      template: '<main v-if="ready"><section v-for="i in 10" :key="i" class="sec" :data-i="i - 1"><div v-if="seen[i - 1]" class="blk" :style="{ background: colors[(i - 1) % 12] }"><span class="lbl">s{{ i - 1 }}</span></div></section></main><p v-else style="padding:20px">Carregando…</p>',
      data() { return { ready: false, seen: Array(10).fill(false), colors: ${JSON.stringify(COLORS)} }; },
      mounted() {
        setTimeout(() => { this.ready = true; this.$nextTick(() => {
          const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { this.seen[+e.target.dataset.i] = true; io.unobserve(e.target); } }), { rootMargin: '100px' });
          document.querySelectorAll('section.sec').forEach((s) => io.observe(s));
        }); }, 500);
      },
    }).mount('#app');
  `, '<script src="https://cdnjs.cloudflare.com/ajax/libs/vue/3.4.21/vue.global.prod.min.js"></script>'),

  // 6) Elementos fixed e sticky.
  "sticky-fixed": () => page("sticky/fixed", `
    .hd{position:fixed;top:0;left:0;right:0;height:60px;background:#222;color:#fff;z-index:10;padding:18px 12px;box-sizing:border-box}
    .ft{position:fixed;bottom:0;left:0;right:0;height:80px;background:#ff00ff;z-index:10}
    .wrap{display:flex}.side{width:200px;position:sticky;top:80px;height:200px;background:#00ffff;align-self:flex-start;flex:none}.main{flex:1;position:relative;min-width:0}`,
    `<div class="hd">header fixo</div><div class="ft"></div><div class="wrap"><aside class="side"></aside><div class="main">${Array.from({ length: 8 }, (_, i) => section(i)).join("")}</div></div>`),

  // 8) Página muito longa (?h=px de altura total, seções de 600 px).
  "very-long": (q) => {
    const n = Math.max(1, Math.round(Number(q.get("h") ?? 20000) / SEC));
    return page("muito longa", "", Array.from({ length: n }, (_, i) => section(i)).join(""));
  },

  // 9) Seções em unidades de viewport (100vh): sensível a redimensionamento da janela virtual.
  vh: () => page("vh", ".sec{height:100vh}.blk{top:20vh;height:60vh}", Array.from({ length: 6 }, (_, i) => section(i)).join("")),
};

// Iframes: mesma origem, srcdoc, cross-origin (host diferente) e lazy. Cada iframe tem 400 px de
// altura e um bloco sólido de 300 px a partir de y=50 dentro dele.
const frameDoc = (c) => `<!doctype html><html><body style="margin:0;height:1200px;background:#fff"><div style="margin-top:50px;height:300px;background:${COLORS[c % 12]}"></div></body></html>`;
PAGES.iframes = (q, ctx) => {
  const cross = `http://localhost:${ctx.port}/frame?c=2`;
  const frames = [
    `<iframe src="/frame?c=0" style="position:absolute;left:0;top:100px;width:100%;height:400px;border:0"></iframe>`,
    `<iframe srcdoc="${frameDoc(1).replace(/"/g, "&quot;")}" style="position:absolute;left:0;top:100px;width:100%;height:400px;border:0"></iframe>`,
    `<iframe src="${cross}" style="position:absolute;left:0;top:100px;width:100%;height:400px;border:0"></iframe>`,
    `<iframe loading="lazy" src="/frame?c=3" style="position:absolute;left:0;top:100px;width:100%;height:400px;border:0"></iframe>`,
  ];
  const body = Array.from({ length: 8 }, (_, i) => `<section class="sec" data-i="${i}">${[0, 2, 4, 6].includes(i) ? frames[i / 2] : `<div class="blk" style="background:${COLORS[(i + 6) % 12]}"></div>`}</section>`).join("");
  return page("iframes", "", body);
};

// ---- Fixtures de QA da v0.5.0 (Capture Strategy Engine). Nenhuma depende de biblioteca externa.
const hide = (html, cls) => html.replace('class="blk"', `class="blk ${cls}"`);
const sections = (n, fn) => Array.from({ length: n }, (_, i) => fn(i)).join("");

// Animações CSS finitas que terminam logo após o load + uma infinita decorativa (não deve impedir captura direta).
PAGES["css-anim"] = () => page("css anim", `@keyframes fade{from{opacity:0}to{opacity:1}}.fin{animation:fade .6s both}
  @keyframes pulse{50%{transform:scale(.99)}}.inf{animation:pulse 1.2s infinite}`,
  sections(6, (i) => hide(section(i), i === 5 ? "inf" : "fin")));

// Reveal por Web Animations API disparado por IntersectionObserver (sem classes, sem biblioteca).
PAGES["waapi-reveal"] = () => page("waapi", ".h{opacity:0}", sections(8, (i) => hide(section(i), i === 0 ? "" : "h")), `
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.animate([{ opacity: 0, transform: 'translateY(30px)' }, { opacity: 1, transform: 'none' }], { duration: 500, fill: 'forwards' }); io.unobserve(e.target); } }), { threshold: 0.2 });
  document.querySelectorAll('.h').forEach((el) => io.observe(el));`);

// Estilo "AOS": atributo data-aos + classe aos-animate; ?mode=once|toggle (toggle = reaparece/esconde ao sair).
PAGES["aos-like"] = (q) => page("aos-like", `[data-aos]{opacity:0;transform:translateY(40px);transition:opacity .6s,transform .6s}[data-aos].aos-animate{opacity:1;transform:none}`,
  sections(10, (i) => section(i, `data-aos="fade-up"`)), `
  const toggle = ${JSON.stringify(q.get("mode") === "toggle")};
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('aos-animate'); if (!toggle) io.unobserve(e.target); } else if (toggle) e.target.classList.remove('aos-animate'); }), { threshold: 0.15 });
  document.querySelectorAll('[data-aos]').forEach((el) => io.observe(el));`);

// Conteúdo que só reage numa posição intermediária (sentinela a ~60% da página): testa a cobertura da sonda.
PAGES["late-lazy"] = () => page("late lazy", "", `<main id=m>${sections(10, (i) => (i === 7 ? `<section class="sec" data-i="7"><div id="slot" class="blk" style="background:#fff"></div></section>` : section(i)))}</main><div id="sent" style="position:absolute;top:${6 * SEC}px;height:10px;width:10px"></div>`, `
  new IntersectionObserver((es, o) => { if (es[0].isIntersecting) { document.getElementById('slot').style.background = ${JSON.stringify(COLORS[7])}; o.disconnect(); } }).observe(document.getElementById('sent'));`);

// Conteúdo dinâmico (fetch/timer) que aparece alguns instantes após o load, sem depender de rolagem.
PAGES.dynamic = () => page("dinâmico", "", `<main id=m>${sections(4, (i) => section(i))}</main>`, `
  setTimeout(() => { const m = document.getElementById('m'); m.insertAdjacentHTML('beforeend', ${JSON.stringify(sections(2, (k) => section(k + 4)))}); }, 2300);`);

// Página estática com cabeçalho que muda de classe ao rolar (padrão comum): esperado "falso positivo" (completa sem necessidade).
PAGES["header-scroll"] = () => page("header scroll", `.hd{position:fixed;top:0;left:0;right:0;height:40px;background:#222;z-index:5}.hd.sm{height:30px}`,
  `<div class="hd" id="hd"></div>${sections(6, (i) => section(i))}`, `addEventListener('scroll', () => document.getElementById('hd').classList.toggle('sm', scrollY > 100), { passive: true });`);

// Animação finita muito longa (60 s) em elemento minúsculo: o settle nunca assenta (caso gsap.com); mede o teto global de espera.
PAGES.endless = () => page("endless", `@keyframes slow{from{opacity:.5}to{opacity:1}}.dot{position:fixed;right:4px;bottom:4px;width:10px;height:10px;background:#888;animation:slow 60s linear both}`, `<i class="dot"></i>${sections(4, (i) => section(i))}`);

// Reveal por handler de scroll (sem IntersectionObserver): opacidade inline; sem reset.
PAGES["scroll-js"] = () => page("scroll js", ".r{opacity:0}", sections(8, (i) => hide(section(i), i ? "r" : "")), `
  const f = () => document.querySelectorAll('.r').forEach((el) => { if (el.getBoundingClientRect().top < innerHeight * 0.9) { el.style.transition = 'opacity .4s'; el.style.opacity = 1; el.classList.remove('r'); } });
  addEventListener('scroll', f, { passive: true });`);


export function expected(name, query, ctx = {}) {
  switch (name) {
    case "static": return blocks(6);
    case "lazy-long": return blocks(24);
    case "gsap-st": return blocks(8); // 0–7 (reveals); scrub/pin não pontuam
    case "io-css": return blocks(12);
    case "spa-vue": return blocks(10);
    case "sticky-fixed": return blocks(8).map((b) => ({ ...b, y: b.y }));
    case "very-long": return blocks(Math.max(1, Math.round(Number(query.get("h") ?? 20000) / SEC)));
    case "vh": return Array.from({ length: 6 }, (_, i) => ({ y: i * ctx.vh + 0.2 * ctx.vh, h: 0.6 * ctx.vh, color: COLORS[i % 12], label: `s${i}` }));
    case "iframes": return [0, 1, 2, 3].map((k) => ({ y: k * 2 * SEC + 100 + 50, h: 300, color: COLORS[k % 12], label: ["same-origin", "srcdoc", "cross-origin", "lazy"][k] }));
    case "css-anim": return blocks(6);
    case "waapi-reveal": return blocks(8);
    case "aos-like": return blocks(10);
    case "late-lazy": return blocks(10);
    case "dynamic": return blocks(6);
    case "header-scroll": return blocks(6);
    case "scroll-js": return blocks(8);
    case "endless": return blocks(4);
    default: return [];
  }
}

// Imagem de teste (1600×1200, quatro quadrantes coloridos) para "imagem aberta direto no navegador".
export function testPng() {
  const W = 1600, H = 1200, row = W * 3 + 1;
  const raw = Buffer.alloc(row * H);
  const quad = [[230, 25, 75], [60, 180, 75], [67, 99, 216], [245, 130, 49]];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = quad[(y < H / 2 ? 0 : 2) + (x < W / 2 ? 0 : 1)];
      raw.set(c, y * row + 1 + x * 3);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export function startFixtureServer(port = 0) {
  const png = testPng();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const ctx = { port: server.address().port };
    if (url.pathname.startsWith("/p/")) {
      const gen = PAGES[url.pathname.slice(3)];
      if (gen) return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(gen(url.searchParams, ctx));
    }
    if (url.pathname.startsWith("/img/")) {
      await new Promise((r) => setTimeout(r, Number(url.searchParams.get("delay") ?? 0)));
      return res.writeHead(200, { "content-type": "image/svg+xml" }).end(svg(`#${url.pathname.slice(5, 11)}`));
    }
    if (url.pathname === "/frame") return res.writeHead(200, { "content-type": "text/html" }).end(frameDoc(Number(url.searchParams.get("c") ?? 0)));
    if (url.pathname === "/photo.png") return res.writeHead(200, { "content-type": "image/png" }).end(png);
    res.writeHead(404).end("não encontrado");
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  const { port } = await startFixtureServer(Number(process.argv[2] ?? 8765));
  console.log(`Fixtures em http://127.0.0.1:${port}/p/<nome> — nomes: ${Object.keys(PAGES).join(", ")}; imagem: /photo.png`);
}
