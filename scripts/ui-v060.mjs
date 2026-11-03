// Verificação automática do redesign v0.6.0 (barra de prévia + popup) em Chrome headless, servindo dist/.
// NÃO testa a extensão instalada: o popup usa um stub de chrome.*; a prévia roda de verdade (IndexedDB).
// Cobre: temas claro/escuro, larguras (zoom), logotipo por tema/largura, estados dos botões, microinteração de copiar,
// teclado/foco, contraste (WCAG) dos tokens, prefers-reduced-motion, regras do percentual. Gera capturas de tela em <pasta>.
//
// Uso: node scripts/ui-v060.mjs <pasta-saida>
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { initialViewState, toView } from "../src/popup/progress-view.ts";
import { testPng } from "./fixtures.mjs";
import { evalIn, launch, navigate, newPage, setDisplay, sleep } from "./lib/browser.mjs";

const [outDir] = process.argv.slice(2);
if (!outDir) { console.error("Uso: node scripts/ui-v060.mjs <pasta-saida>"); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const dist = join(import.meta.dirname, "..", "dist");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const server = createServer((req, res) => {
  const path = normalize(new URL(req.url, "http://x").pathname).replace(/^(\.\.[/\\])+/, "");
  let body; try { body = readFileSync(join(dist, path)); } catch { res.writeHead(404).end("nf"); return; }
  res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await launch({ width: 1280, height: 800 });
const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "OK   " : "FALHA"} ${name}${detail ? " — " + detail : ""}`); };

// ---------- contraste WCAG ----------
const parse = (v) => {
  v = v.trim();
  if (v.startsWith("#")) { const n = parseInt(v.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]; }
  const m = /rgba?\(([^)]+)\)/.exec(v); const p = m[1].replace("/", " ").split(/[\s,]+/).filter(Boolean);
  const a = p[3] === undefined ? 1 : p[3].endsWith("%") ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
  return [+p[0], +p[1], +p[2], a];
};
const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const png = testPng();
const seed = `(async () => {
  const bin = atob("${png.toString("base64")}"); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const db = await new Promise((res, rej) => { const r = indexedDB.open("full-print", 1); r.onupgradeneeded = () => r.result.createObjectStore("captures", { keyPath: "id" }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  await new Promise((res, rej) => { const tx = db.transaction("captures", "readwrite"); tx.objectStore("captures").put({ id: "t1", createdAt: Date.now(), pageUrl: "https://exemplo.com.br/pagina", width: 1600, height: 1200, cssWidth: 800, cssHeight: 600, dpr: 1, blob: new Blob([bytes], { type: "image/png" }) }); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  db.close(); return true; })()`;

async function open(path, { scheme = "dark", width = 1280, height = 700, reduced = false, stub } = {}) {
  const page = await newPage(browser);
  const { cdp } = page;
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }, { name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" }] });
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await setDisplay(cdp, { width, height, dpr: 1 });
  if (stub) await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: stub });
  await navigate(cdp, `${origin}${path}`, { settleMs: 500 });
  return page;
}
const shot = async (page, name) => writeFileSync(join(outDir, name), Buffer.from((await page.cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
const key = (cdp, k, extra = {}) => cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: k === "Tab" ? 9 : 0, ...extra }).then(() => cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: k === "Tab" ? 9 : 0, ...extra }));

// seed (uma vez, mesma origem)
{ const p = await open("/preview/preview.html?id=nenhum"); await evalIn(p.cdp, seed); await p.close(); }

// ================= A. regras do percentual (módulo puro) =================
console.log("\n== A: regras do percentual (progress-view.ts)");
{
  const st = initialViewState(); const seq = [];
  const feed = (phase, progress, detail) => seq.push(toView({ tabId: 1, phase, progress, detail }, st));
  feed("preparing", 10, "Preparando a página"); feed("scrolling", 40, "Rolando a página (60%)"); feed("scrolling", 8, "Rolando a página (0%)"); // regressão do motor (nova rolagem)
  check("A1 percentual nunca regride (40 → 8 continua 40)", seq[2].percent === 40, seq.map((s) => s.percent).join(","));
  check("A2 etapa sem percentual embutido", !/\d+%/.test(seq[1].phase), seq[1].phase);
  feed("saving", 100, undefined);
  check("A3 100% fora de 'concluído' é limitado a 99%", seq[3].percent === 99);
  feed("done", 100, undefined);
  check("A4 100% somente em 'concluído'", seq[4].percent === 100 && seq[4].title === "captura concluída");
  feed("preparing", 1, "Iniciando");
  check("A5 nova captura depois de concluir recomeça do zero", seq[5].percent === 1);
  feed("error", 30, undefined); feed("preparing", 1, "Iniciando");
  check("A6 tentar novamente depois de erro recomeça do zero", seq[7].percent === 1);
  feed("capturing", 75, "Capturando faixa 2 de 5");
  check("A7 faixa N de M é exibida sem percentual", seq[8].phase === "capturando faixa 2 de 5");
  check("A8 textos em minúsculas", [seq[0].phase, seq[0].title, seq[4].title].every((t) => t === t.toLowerCase()));
}

// ================= B. contraste dos tokens (claro e escuro) =================
console.log("\n== B: contraste dos tokens (WCAG)");
for (const scheme of ["dark", "light"]) {
  const p = await open("/preview/preview.html?id=t1", { scheme });
  const v = await evalIn(p.cdp, `(() => { const cs = getComputedStyle(document.documentElement); const o = {}; for (const n of ["surface","canvas","text","text-muted","btn-fg","btn-border","btn-hover-bg","btn-active-bg","primary-bg","primary-fg","primary-hover-bg","primary-active-bg","focus","track","fill","success","success-bg","danger","danger-bg"]) o[n] = cs.getPropertyValue("--fp-" + n); return o; })()`, false);
  const c = Object.fromEntries(Object.entries(v).map(([k, s]) => [k, parse(s)]));
  const S = c.surface;
  const pairs = [
    ["texto / superfície", c.text, S, 4.5], ["texto secundário / superfície", c["text-muted"], S, 4.5],
    ["botão secundário (texto) / superfície", c["btn-fg"], S, 4.5], ["botão secundário em hover", c["btn-fg"], over(c["btn-hover-bg"], S), 4.5], ["botão secundário em active", c["btn-fg"], over(c["btn-active-bg"], S), 4.5],
    ["botão primário (texto / fundo)", c["primary-fg"], over(c["primary-bg"], S), 4.5], ["botão primário em hover", c["primary-fg"], c["primary-hover-bg"], 4.5], ["botão primário em active", c["primary-fg"], c["primary-active-bg"], 4.5],
    ["feedback de sucesso", c.success, over(c["success-bg"], S), 4.5], ["feedback de erro", c.danger, over(c["danger-bg"], S), 4.5],
    ["anel de foco / superfície (UI ≥3)", c.focus, S, 3], ["contorno do botão / superfície (UI ≥3)", c["btn-border"], S, 3], ["barra: preenchimento / trilho (UI ≥3)", c.fill, c.track, 3],
    ["texto / canvas da prévia", c.text, c.canvas, 4.5],
  ];
  for (const [name, fg, bg, min] of pairs) { const r = ratio(fg, bg); check(`B ${scheme}: ${name} ≥ ${min}`, r >= min, r.toFixed(2) + ":1"); }
  await p.close();
}

// ================= C. barra de prévia =================
console.log("\n== C: barra de prévia (temas, larguras, logotipo, estados)");
for (const scheme of ["dark", "light"]) {
  for (const width of [1904, 1280, 1000, 760, 560, 400, 320]) {
    const p = await open("/preview/preview.html?id=t1", { scheme, width });
    const m = await evalIn(p.cdp, `(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      const logo = document.querySelector('.brand img');
      const bt = ['copy','save-pdf','save-png'].map((id) => r(id));
      const bar = r('toolbar');
      const overlap = bt.some((a, i) => bt.some((b, j) => i < j && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5));
      return { overflow: document.documentElement.scrollWidth - innerWidth, logo: logo.currentSrc.split('/').pop().replace(/-[\\w-]{8}\\.svg$/, ''), logoW: Math.round(logo.getBoundingClientRect().width), logoH: Math.round(logo.getBoundingClientRect().height),
        barH: Math.round(bar.height), btnH: bt.map((b) => Math.round(b.height)), btnW: bt.map((b) => Math.round(b.width)), overlap,
        inside: bt.every((b) => b.left >= 0 && b.right <= innerWidth + 0.5), metaCenter: Math.round(r('meta').left + r('meta').width / 2), pageCenter: Math.round(document.documentElement.clientWidth / 2), meta: document.getElementById('meta').textContent,
        github: !document.getElementById('github').offsetParent, ghHref: document.getElementById('github').href, ghTarget: document.getElementById('github').target, ghRel: document.getElementById('github').rel, ghW: Math.round(r('github').width), ghH: Math.round(r('github').height) };
    })()`, false);
    const wantLogo = width <= 560 ? `logo-minimal-${scheme}` : `logo-${scheme}`;
    const fits = m.overflow <= 0 && m.inside && !m.overlap;
    check(`C ${scheme} ${width}px: sem rolagem horizontal, botões visíveis e sem sobreposição`, fits, `barra ${m.barH}px, botões ${m.btnW.join("/")}×${m.btnH[0]}`);
    check(`C ${scheme} ${width}px: logotipo correto (${wantLogo})`, m.logo === wantLogo, `${m.logo} ${m.logoW}×${m.logoH}`);
    if (width === 1904) {
      check(`C ${scheme} 1904px: dimensões do Figma (botões 149×32, logotipo 204×43; barra 67px = 12px + 43px + 12px, mais baixa que os 99px do Figma por pedido)`, m.btnW.every((w) => w === 149) && m.btnH.every((h) => h === 32) && m.logoW === 204 && Math.abs(m.logoH - 43) <= 1 && Math.abs(m.barH - 67) <= 2, JSON.stringify({ btnW: m.btnW, btnH: m.btnH, logo: [m.logoW, m.logoH], barH: m.barH }));
      check(`C ${scheme} 1904px: metadados centralizados na barra`, Math.abs(m.metaCenter - m.pageCenter) <= 2, `centro=${m.metaCenter} (página ${m.pageCenter}; descontada a barra de rolagem)`);
      check(`C ${scheme}: botão do github visível (53×32), abre https://github.com/barbaragianazi/full-print em nova aba com noopener`, !m.github && m.ghW === 53 && m.ghH === 32 && m.ghHref === "https://github.com/barbaragianazi/full-print" && m.ghTarget === "_blank" && m.ghRel.includes("noopener"), JSON.stringify({ w: m.ghW, h: m.ghH, href: m.ghHref }));
      check(`C ${scheme}: texto dos metadados`, /exemplo\.com\.br · \d+×\d+px · \d+ (KB|MB)/.test(m.meta), m.meta);
    }
    if ([1904, 760, 400].includes(width)) await shot(p, `preview-${scheme}-${width}.png`);
    await p.close();
  }
}

// estados dos botões, teclado e microinteração (tema escuro e claro)
for (const scheme of ["dark", "light"]) {
  const p = await open("/preview/preview.html?id=t1", { scheme, width: 1280 });
  const { cdp } = p;
  const style = (id) => evalIn(cdp, `(() => { const s = getComputedStyle(document.getElementById('${id}')); return { bg: s.backgroundColor, color: s.color, border: s.borderTopColor, opacity: s.opacity, outline: s.outlineStyle + ' ' + s.outlineWidth + ' ' + s.outlineColor, label: document.getElementById('${id}').textContent, state: document.getElementById('${id}').dataset.state || '' }; })()`, false);
  const idle = await style("save-png"), idleCopy = await style("copy");
  check(`D ${scheme}: salvar PNG é a ação primária (preenchida) e copiar/PDF são contorno`, idle.bg !== "rgba(0, 0, 0, 0)" && idleCopy.bg === "rgba(0, 0, 0, 0)", `png=${idle.bg} copiar=${idleCopy.bg}`);
  // hover / active
  const box = await evalIn(cdp, `(() => { const r = document.getElementById('copy').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`, false);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y }); await sleep(250);
  const hover = await style("copy");
  check(`D ${scheme}: hover muda o fundo do botão secundário`, hover.bg !== idleCopy.bg, `${idleCopy.bg} → ${hover.bg}`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 }); await sleep(250);
  const active = await style("copy");
  check(`D ${scheme}: active muda o fundo (mais forte que o hover)`, active.bg !== hover.bg, `${hover.bg} → ${active.bg}`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 600 });
  // teclado: ordem de tab e anel de foco visível
  // reinicia o ponto de partida da navegação por teclado (o clique do mouse acima deixou o foco no botão)
  await evalIn(cdp, "(() => { const t = document.getElementById('toolbar'); t.tabIndex = -1; t.focus(); t.removeAttribute('tabindex'); window.scrollTo(0,0); })()", false);
  const order = [];
  for (let i = 0; i < 4; i++) { await key(cdp, "Tab"); order.push(await evalIn(cdp, "document.activeElement.id || document.activeElement.tagName", false)); }
  check(`D ${scheme}: ordem de tab = github, copiar, PDF, PNG`, order.join(",") === "github,copy,save-pdf,save-png", order.join(","));
  await evalIn(cdp, "(() => { const t = document.getElementById('toolbar'); t.tabIndex = -1; t.focus(); t.removeAttribute('tabindex'); })()", false);
  await key(cdp, "Tab");
  const focus = await evalIn(cdp, `(() => { const e = document.activeElement; const s = getComputedStyle(e); return { id: e.id, outline: s.outlineStyle + ' ' + s.outlineWidth, color: s.outlineColor, match: e.matches(':focus-visible') }; })()`, false);
  check(`D ${scheme}: foco por teclado mostra anel visível (focus-visible)`, focus.match && focus.outline.startsWith("solid 2px"), JSON.stringify(focus));
  await shot(p, `preview-${scheme}-focus.png`);
  // microinteração de copiar
  await evalIn(cdp, "navigator.clipboard.write = async () => {}", false);
  await evalIn(cdp, "document.getElementById('copy').click()", false); await sleep(300);
  const ok1 = await style("copy");
  check(`D ${scheme}: copiar com sucesso → "imagem copiada" + estado visual`, ok1.label === "imagem copiada" && ok1.state === "success", `${ok1.label} / ${ok1.state}`);
  await shot(p, `preview-${scheme}-copiado.png`);
  await sleep(2100);
  const back = await style("copy");
  check(`D ${scheme}: volta a "copiar imagem" após ~2 s`, back.label === "copiar imagem" && back.state === "", back.label);
  await evalIn(cdp, "navigator.clipboard.write = async () => { throw new Error('negado'); }", false);
  await evalIn(cdp, "document.getElementById('copy').click()", false); await sleep(300);
  const fail = await style("copy");
  check(`D ${scheme}: falha → "erro ao copiar" + estado de erro`, fail.label === "erro ao copiar" && fail.state === "error", `${fail.label} / ${fail.state}`);
  await shot(p, `preview-${scheme}-erro-copiar.png`);
  await p.close();
}
{
  const p = await open("/preview/preview.html?id=nenhum", { width: 1280 });
  const dis = await evalIn(p.cdp, "(() => { const b = document.getElementById('copy'); return { disabled: b.disabled, opacity: getComputedStyle(b).opacity, msg: document.getElementById('message').textContent, hidden: document.getElementById('message').hidden }; })()", false);
  check("D estado disabled (captura inexistente): botões desabilitados, opacidade reduzida e mensagem em minúsculas", dis.disabled && +dis.opacity < 1 && !dis.hidden && dis.msg.startsWith("esta captura"), JSON.stringify(dis));
  await p.close();
  const r = await open("/preview/preview.html?id=t1", { reduced: true });
  const dur = await evalIn(r.cdp, "getComputedStyle(document.getElementById('copy')).transitionDuration", false);
  check("E prefers-reduced-motion: transições do botão desativadas", /^0s(, 0s)*$/.test(dur), dur);
  await r.close();
}

// ================= F. popup =================
console.log("\n== F: popup de progresso (stub de chrome.*)");
const stub = (status) => `
  window.__sent = []; window.__listeners = []; window.__status = ${JSON.stringify(status)};
  window.chrome = { runtime: { onMessage: { addListener: (l) => window.__listeners.push(l) },
    sendMessage: async (m) => { window.__sent.push(m.type); if (m.type === "capture:status") return window.__status; if (m.type === "capture:logs") return "+0ms INFO captura iniciada\\n+900ms ERROR captura falhou";
      window.__status = { tabId: 7, phase: "preparing", progress: 1 }; return window.__status; } },
    tabs: { query: async () => [{ id: 7 }] } };`;
for (const scheme of ["dark", "light"]) {
  const p = await open("/popup/popup.html", { scheme, width: 300, height: 260, stub: stub({ tabId: 7, phase: "preparing", progress: 68, detail: "Preparando a página" }) });
  const { cdp } = p;
  const emit = (status) => evalIn(cdp, `window.__listeners.forEach((l) => l({ type: "capture:progress", status: ${JSON.stringify(status)} }))`, false);
  const ui = () => evalIn(cdp, `({ title: document.getElementById('title').textContent, phase: document.getElementById('phase').textContent, pct: document.getElementById('percent').textContent, now: document.getElementById('bar').getAttribute('aria-valuenow'), width: document.getElementById('fill').style.width, errHidden: document.getElementById('error').hidden, bodyW: document.body.getBoundingClientRect().width, overflow: document.documentElement.scrollWidth - innerWidth, bar: Math.round(document.getElementById('bar').getBoundingClientRect().height) })`, false);
  let s = await ui();
  check(`F ${scheme}: layout do Figma (título, etapa, 68%, barra de 25px, 300px de largura)`, s.title === "captura em andamento..." && s.phase === "preparando conteúdo e animações" && s.pct === "68%" && s.width === "68%" && s.bar === 25 && s.bodyW === 300 && s.overflow <= 0, JSON.stringify(s));
  await shot(p, `popup-${scheme}-68.png`);
  await emit({ tabId: 7, phase: "scrolling", progress: 20, detail: "Rolando a página (30%)" }); await sleep(150);
  s = await ui();
  check(`F ${scheme}: percentual não regride (68 → 20 continua 68%)`, s.pct === "68%" && s.now === "68", s.pct);
  check(`F ${scheme}: etapa em texto secundário sem percentual adicional`, s.phase === "percorrendo a página" && !/\d%/.test(s.phase), s.phase);
  await emit({ tabId: 7, phase: "saving", progress: 100 }); await sleep(150);
  check(`F ${scheme}: 100% não aparece antes de concluído`, (await ui()).pct === "99%");
  await emit({ tabId: 7, phase: "done", progress: 100 }); await sleep(150);
  s = await ui();
  check(`F ${scheme}: 100% só em concluído`, s.pct === "100%" && s.title === "captura concluída", `${s.title} ${s.pct}`);
  await shot(p, `popup-${scheme}-100.png`);
  await emit({ tabId: 7, phase: "error", progress: 68, error: "Outro depurador já está anexado a esta aba (outra extensão?). Feche-o e tente de novo." }); await sleep(300);
  s = await ui();
  const err = await evalIn(cdp, `({ msg: document.getElementById('error-message').textContent, first: getComputedStyle(document.getElementById('error-message'), '::first-letter').textContentTransform ?? getComputedStyle(document.getElementById('error-message'), '::first-letter').textTransform, retry: document.getElementById('retry').textContent, copy: document.getElementById('copy-log').textContent, log: document.getElementById('log').textContent.length })`, false);
  check(`F ${scheme}: erro mostra mensagem, "tentar novamente", "copiar log" e log técnico`, !s.errHidden && err.msg.includes("depurador") && err.retry === "tentar novamente" && err.copy === "copiar log" && err.log > 0 && s.title === "a captura falhou", JSON.stringify(err));
  check(`F ${scheme}: mensagem do motor exibida com a 1ª letra em minúscula (CSS ::first-letter)`, err.first === "lowercase", err.first);
  await shot(p, `popup-${scheme}-erro.png`);
  await evalIn(cdp, "document.getElementById('retry').click()", false); await sleep(400);
  s = await ui();
  check(`F ${scheme}: tentar novamente envia capture:retry e recomeça a contagem`, (await evalIn(cdp, "window.__sent.includes('capture:retry')", false)) && s.errHidden && s.pct === "1%", `${s.pct}`);
  // teclado no popup
  await evalIn(cdp, "document.activeElement && document.activeElement.blur()", false);
  await emit({ tabId: 7, phase: "error", progress: 30, error: "falha" }); await sleep(200);
  await key(cdp, "Tab");
  const f = await evalIn(cdp, "({ id: document.activeElement.id, vis: document.activeElement.matches(':focus-visible') })", false);
  check(`F ${scheme}: teclado chega ao botão "tentar novamente" com foco visível`, f.id === "retry" && f.vis, JSON.stringify(f));
  await p.close();
}
{
  const p = await open("/popup/popup.html", { reduced: true, width: 300, height: 260, stub: stub({ tabId: 7, phase: "preparing", progress: 5 }) });
  const dur = await evalIn(p.cdp, "getComputedStyle(document.getElementById('fill')).transitionDuration", false);
  check("F prefers-reduced-motion: barra sem transição", /^0s(, 0s)*$/.test(dur), dur);
  await p.close();
}

browser.kill(); server.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} verificações OK`);
setTimeout(() => process.exit(results.every(Boolean) ? 0 : 1), 300);
