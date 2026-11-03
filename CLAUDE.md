# full-print

Extensão Chrome (Manifest V3) que captura páginas inteiras e exporta em PNG ou PDF.
**Diferencial:** capturar páginas com GSAP/ScrollTrigger no estado em que o usuário as veria
com tudo revelado (animações concluídas, conteúdo visível), sem alterar a aba original.
Referência funcional: https://lpnexus.vercel.app/

## Stack
- TypeScript (strict), HTML/CSS convencionais, sem React por enquanto.
- Vite (build multi-entrada, saída em `dist/`).
- Chrome DevTools Protocol via `chrome.debugger`.
- Sem backend: nenhuma captura sai da máquina do usuário. Sem telemetria.
- Compatibilidade futura com outros Chromium: evitar APIs exclusivas do Chrome sem necessidade.

## Comandos
- `npm install` — instala dependências.
- `npm run build` — typecheck + build para `dist/`.
- `npm run dev` — build em modo watch (recarregar a extensão em chrome://extensions).
- `npm run typecheck` — apenas `tsc --noEmit`.
- `node scripts/cdp-smoke.mjs <url> <saida.png> [LxA] [dpr] [scrollInicial]` — captura + restauração em Chrome headless.
- `node scripts/ui-smoke.mjs <png> <pasta> <cssW> <cssH>` — prévia (copiar/PNG/PDF) e popup, em Chrome headless.
- `node scripts/audit.mjs <pasta> [--real]` — matriz de compatibilidade (fixtures + sites reais), fidelidade por pixel.
- `node scripts/audit-experiments.mjs <pasta> [--only=e1,e2,…]` e `scripts/audit-memory.mjs` — experimentos de escala, limites, faixas, estratégias, memória.
- `node scripts/phase1-tests.mjs <pasta> [--only=t1,…]` — testes automatizados da Fase 1 (escala, faixas, fallback, erro, aba oculta, FocusGuard).
- `node scripts/phase2-tests.mjs <pasta> [--only=u,m,r] [--reps=N] [--variants=…] [--fixtures=…]` — v0.5.0: decide() unitário, matriz de tempo/fidelidade por otimização, resiliência.
- `node scripts/corpus-real.mjs <pasta> [--sites=…]` — sites reais (internet), v0.4.0 × v0.5.0, inclui gsap.com/AOS/Lenis.
- `node scripts/ui-v060.mjs <pasta>` — redesign v0.6.0: temas, larguras, estados, contraste, teclado, percentual (após `npm run build`).
- `node scripts/make-icons.mjs` — regenera public/icons a partir do logotipo minimalista.
- `node scripts/fixtures.mjs [porta]` — serve as fixtures genéricas (`/p/<nome>`) para teste manual.

Instalação local: carregar `dist/` em chrome://extensions (ver `docs/instalacao-e-testes.md`).

## Estrutura
```
public/manifest.json         manifest MV3 (copiado para dist/); sem default_popup
src/background/
  service-worker.ts          action.onClicked + mensagens do popup (só ligações)
  capture-manager.ts         orquestração: 1 captura por aba, status, badge, abre a prévia
  action-ui.ts               badge/título/popup de progresso por aba
  cdp.ts                     interface Cdp + DebuggerSession (chrome.debugger, detecção de detach)
  page-prep.ts               preparação da página (probe injetado, scroll, settle, freeze) — só CDP
  capture.ts                 fluxo completo (preparo, captura, restauração em finally) — só CDP
  signals.ts                 Strategy Engine: sinais observáveis + decide() (direct|full) + verificação no topo
  screenshot.ts              geometria 2x, plano (integral/faixas), verificação de dimensões — só CDP
  png-stitch.ts              costura faixas PNG em um PNG (streaming, sem perdas)
  focus.ts                   FocusGuard: traz a aba à frente se oculta e restaura o foco
  log.ts                     log técnico (sem dados sensíveis)
  blob.ts                    base64 -> Blob em pedaços
  active-capture.ts          registro em storage.session para recuperar sessão órfã
src/popup/                   popup de PROGRESSO (progress-view.ts = regras do percentual; barra, erro, tentar novamente, log)
src/preview/                 aba de prévia: toolbar (copiar/PNG/PDF), pdf.ts (gerador próprio)
src/shared/                  mensagens tipadas, URL, store.ts (IndexedDB), theme.css (tokens --fp-*, tema = sistema), links.ts
src/img/                     SVGs oficiais (logotipos completo/minimalista claro e escuro, github): usar como estão
public/icons/                ícones PNG da extensão (gerados por scripts/make-icons.mjs)
scripts/                     testes/auditoria em Chrome headless (fora da extensão); lib/ (browser, png), fixtures.mjs
docs/                        decisões (ADRs), roadmap e registros de teste
.claude/agents/              subagentes do projeto
```
O Vite usa `src/` como root; cada nova entrada deve ser adicionada em `build.rollupOptions.input`
em `vite.config.ts`. O service worker sai em `dist/background/service-worker.js` (caminho fixo).
`page-prep.ts` e `capture.ts` não podem usar `chrome.*` (ficam testáveis em Node); imports
internos usam extensão `.ts` e `import type`.

## Arquitetura (v0.5.0; Fase 1 em docs/decisoes/0005, Fases 2–3 em 0006)
1. **Clique no ícone** → `chrome.action.onClicked` inicia a captura da aba ativa (sem configurações).
   Uma captura por aba; cliques repetidos só mostram o progresso.
2. **Progresso** — badge do ícone (%) + popup de progresso definido por aba (`setPopup` +
   `openPopup`). O popup só exibe o status do service worker e pode ser fechado sem efeito.
   Após erro, o popup continua definido para a aba (mensagem, "Tentar novamente", log técnico).
3. **Captura** (`capture.ts`) — percorre a página para a própria página disparar lazy load e
   animações, espera as animações assentarem, congela os ScrollTriggers de "replay", volta ao
   topo, espera de novo, captura e restaura tudo no `finally`. **Resolução efetiva = max(2, DPR)**
   (`clip.scale = efetiva/DPR`); tenta captura integral e recorre a **faixas** (`clip.y`, costura sem perdas)
   se exceder limiares conservadores ou falhar; **verifica as dimensões reais do PNG** (erro claro, nunca
   redução silenciosa). Aba oculta é trazida à frente (`FocusGuard`) e o foco é restaurado em `finally`.
   **Não** força opacity/transform e **não** emula prefers-reduced-motion (ADR 0003).
4. **Armazenamento** — o PNG vai como Blob para o IndexedDB (`shared/store.ts`; TTL 24 h, últimas 5).
5. **Prévia** — nova aba `preview/preview.html?id=…` lê do IndexedDB. Copiar, Salvar PNG e Salvar PDF
   só acontecem por clique do usuário, dentro da própria página (sem `downloads`/`offscreen`).

## Decisões de produto aprovadas (ADR 0004)
- **2x é a resolução-alvo obrigatória**; nunca reduzir a escala em silêncio. Acima dos limites: faixas sem perda ou erro claro.
- Um clique captura a página inteira; PNG e PDF na prévia; processamento **adaptativo** (estática sem preparação desnecessária).
- Sem depender de GSAP nem de código do Nexus. **Estado atual (v0.3.0) ainda não cumpre 2x nem o adaptativo:** ver `docs/auditoria/`.
- Não tratar limites de pixels como universais: medir (`audit-experiments.mjs`) e validar com a extensão instalada.

## Regras de desenvolvimento
- Permissões mínimas: só adicionar ao manifesto no momento em que o código que as usa for escrito,
  e registrar o motivo em `docs/decisoes/`.
- Nada de requisições de rede para servidores externos; sem código remoto (exigência MV3).
- Nenhuma captura é enviada para fora do navegador.
- A aba original deve voltar exatamente ao estado anterior, inclusive em erro (`finally`).
  A restauração é conferida por comparação de snapshots e registrada no log.
- Logs: só metadados (contagens, tempos, versões, URL sem query/hash). Nunca conteúdo da página.
- Código em TypeScript strict; sem `any` sem justificativa em comentário.
- Decisão relevante → novo arquivo em `docs/decisoes/`; testes → `docs/testes/` (dizer o que foi
  de fato executado e o que não foi).
- Mudança funcional do algoritmo de captura só com aprovação explícita (proposta primeiro, ver `docs/auditoria/02-…`).
- Não executar operações Git que alterem estado (commit, push, reset, revert, checkout…) sem
  autorização explícita do usuário.
- Não sobrescrever/excluir arquivos sem necessidade; validar `npm run build` antes de concluir uma tarefa.
- Para dúvidas sobre APIs Chrome, CDP, GSAP ou ScrollTrigger, usar o subagente `researcher`.
- Idioma: documentação e UI em pt-BR; identificadores de código em inglês.

## Status
v0.6.0 (redesign UI, ADR 0007): barra e popup conforme o Figma, tokens semânticos claro/escuro (sistema), logotipos SVG, ícones, microinteração de copiar; motor intocado. **Textos de interface sempre em minúsculas.** Testado só em headless (`scripts/ui-v060.mjs` 109/109): `docs/testes/2026-11-02-v060.md`, `docs/auditoria/08-checklist-v060.md`. Pendente: URL do github em `src/shared/links.ts`.
v0.5.0 (Fases 2–3): rolagem/esperas mais curtas (`Tuning`, `BASELINE_V040` = v0.4.0), teto global de esperas e **captura direta** só quando `decide()` prova que nada reage à rolagem (senão a estratégia completa da v0.4.0); **testado só em headless**: `docs/testes/2026-11-02-v050.md`, `docs/auditoria/06-checklist-v050.md`, `07-falsos-positivos-e-negativos.md`. Problemas conhecidos NÃO corrigidos: gsap.com (região vazia), AOS (área branca / IO-toggle), Lenis (BAD_MESSAGE na prévia), iframes cross-origin.
v0.4.0 (Fase 1): 2x garantido, faixas, verificação e guarda de aba oculta, **testados só em headless**; validar com `docs/auditoria/05-checklist-fase1.md`.
v0.3.0: um clique captura a página inteira em PNG, mostra progresso, abre a prévia e exporta
PNG/PDF/clipboard. Permissões: activeTab, debugger, storage (motivos em `docs/decisoes/0003-fluxo-e-captura-gsap.md`).
JPEG, captura por partes e outros modos: ver `docs/roadmap.md`.
