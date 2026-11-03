// Capture Strategy Engine (v0.5.0): decide, a partir de sinais OBSERVÁVEIS (não de bibliotecas), se a
// captura pode ser direta ou precisa da preparação completa (a estratégia da v0.4.0, mantida como
// fallback seguro). Só usa CDP (sem chrome.*): roda em Node nos testes.
//
// Regra de ouro: na dúvida (sinal ausente, ruidoso ou inconclusivo) => "full". Fidelidade vale mais
// que velocidade. A rolagem de preparação funciona como sonda: se nada reagiu a ela, a página é estática
// para fins de captura. Falsos positivos (full sem necessidade) custam tempo; falsos negativos
// (direct indevido) custam fidelidade e por isso as condições são deliberadamente restritivas.
import type { Cdp } from "./cdp.ts";
import { evaluate } from "./page-prep.ts";

export interface PageSignals {
  /** Animações CSS/WAAPI finitas em andamento. */
  finite: number;
  /** Animações em repetição infinita (decorativas; não impedem a captura direta). */
  infinite: number;
  /** Animações vinculadas à rolagem (animation-timeline: scroll()/view()). */
  scrollLinked: number;
  images: number;
  imagesComplete: number;
  lazyPending: number;
  iframes: number;
  scrollHeight: number;
  scrollTrigger: number;
  gsap: boolean;
  gsapActive: number;
  fontsLoading: boolean;
  /** Mutações do DOM acumuladas desde o último reset. */
  mutations: number;
}

export type StrategyMode = "direct" | "full";

export interface Decision {
  mode: StrategyMode;
  /** Motivos legíveis (vão para o log técnico). */
  reasons: string[];
}

export interface DecisionInput {
  /** Sinais lidos antes de rolar (página em repouso). */
  initial: PageSignals;
  /** A espera inicial terminou com a página assentada. */
  initialSettled: boolean;
  /** Mutações do DOM durante a espera inicial (ruído de base da página). */
  baselineMutations: number;
  /** Sinais lidos no fim da rolagem. */
  afterScroll: PageSignals;
  /** A rolagem foi interrompida por limite de segurança. */
  scrollTruncated: boolean;
}

// Tolerância de altura (px) entre antes e depois da rolagem: abaixo disso é arredondamento.
const HEIGHT_EPSILON = 2;

export function decide(input: Partial<DecisionInput> | null | undefined): Decision {
  const { initial, initialSettled, baselineMutations, afterScroll, scrollTruncated } = input ?? {};
  // Qualquer dado ausente = inconclusivo => estratégia completa.
  if (!initial || !afterScroll || initialSettled === undefined || baselineMutations === undefined || scrollTruncated === undefined) {
    return { mode: "full", reasons: ["sinais inconclusivos"] };
  }
  const why: string[] = [];
  if (!initialSettled) why.push("animações não assentaram antes de rolar");
  if (baselineMutations > 0) why.push(`página já mutável em repouso (${baselineMutations} mutações): ruído impede provar estabilidade`);
  if (scrollTruncated) why.push("rolagem interrompida pelo limite de segurança");
  if (initial.scrollTrigger > 0 || afterScroll.scrollTrigger > 0) why.push("ScrollTrigger presente");
  if (initial.gsapActive > 0 || afterScroll.gsapActive > 0) why.push("animações GSAP em andamento");
  if (initial.scrollLinked > 0 || afterScroll.scrollLinked > 0) why.push("animações vinculadas à rolagem (scroll-driven)");
  if (initial.iframes > 0 || afterScroll.iframes > 0) why.push("iframes (conteúdo de outro documento)");
  if (initial.lazyPending > 0) why.push(`${initial.lazyPending} imagens lazy pendentes antes de rolar`);
  if (afterScroll.lazyPending > 0 || afterScroll.images > afterScroll.imagesComplete) why.push("imagens ainda pendentes após a rolagem");
  if (afterScroll.imagesComplete !== initial.imagesComplete || afterScroll.images !== initial.images) why.push("imagens carregadas/criadas pela rolagem");
  if (Math.abs(afterScroll.scrollHeight - initial.scrollHeight) > HEIGHT_EPSILON) why.push("a altura da página mudou durante a rolagem");
  if (afterScroll.mutations > 0) why.push(`o DOM mudou durante a rolagem (${afterScroll.mutations} mutações)`);
  if (afterScroll.finite > 0) why.push(`${afterScroll.finite} animações finitas disparadas pela rolagem`);
  if (afterScroll.fontsLoading) why.push("fontes ainda carregando");
  if (why.length) return { mode: "full", reasons: why };
  return { mode: "direct", reasons: ["nenhum sinal de reação à rolagem (DOM, imagens, altura, animações, bibliotecas)"] };
}

export const readSignals = (cdp: Cdp) => evaluate<PageSignals>(cdp, "window.__fp.signals()");
export const resetMutations = (cdp: Cdp) => evaluate<void>(cdp, "window.__fp.resetMutations()");

// Verificação após voltar ao topo (caminho direto): nada pode ter reagido à rolagem de volta.
export function verifyAtTop(afterScroll: PageSignals, atTop: PageSignals, changedElements: number): string[] {
  const why: string[] = [];
  if (atTop.mutations > afterScroll.mutations) why.push(`o DOM mudou ao voltar ao topo (${atTop.mutations - afterScroll.mutations} mutações)`);
  if (atTop.finite > 0) why.push(`${atTop.finite} animações finitas em andamento ao voltar ao topo`);
  if (atTop.gsapActive > 0) why.push("animações GSAP ao voltar ao topo");
  if (Math.abs(atTop.scrollHeight - afterScroll.scrollHeight) > HEIGHT_EPSILON) why.push("a altura mudou ao voltar ao topo");
  if (changedElements > 0) why.push(`${changedElements} elementos com opacidade/transform diferentes do estado inicial`);
  return why;
}
