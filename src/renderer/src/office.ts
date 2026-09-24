import { DEFAULT_KINDS, FALLBACK_KIND, kindLabel, normalizeKind } from '@shared/agentKind'
import type { AgentTrack, TrackMap } from './agentTracks'
import type { CrewState } from './crew'

/**
 * O ESCRITÓRIO — os agentes da conversa sentados em mesas, agrupadas em ilhas
 * pelo TIPO de domínio do trabalho (segurança, frontend, dados…).
 *
 * O eixo é o terceiro do app: `agentTracks` conta delegações, `crew` conta
 * papéis, e aqui a unidade é o ASSUNTO. Uma mesa por trilha, e a ilha diz de
 * relance onde o time está gastando esforço — "três em segurança, um em dados"
 * — sem o usuário ler rótulo por rótulo.
 *
 * Módulo puro (sem React, sem IPC) para as regras serem testáveis sozinhas.
 */

/** Uma mesa: um agente em cena, com o que ele está fazendo agora. */
export interface OfficeDesk {
  /** Estável por trilha (`track:<id>`), para o React não remontar a mesa. */
  id: string
  trackId?: string
  name: string
  label: string
  kind: string
  state: CrewState
  /** Ferramenta da última chamada — só enquanto a trilha roda. */
  tool?: string
  stepCount: number
  startedAt?: number
  endedAt?: number
}

export interface OfficeIsland {
  kind: string
  label: string
  /** No máximo `MAX_DESKS`; o resto vira o "+N" de `overflow`. */
  desks: OfficeDesk[]
  overflow: number
  total: number
  /** Contagens da ilha INTEIRA, não só das mesas visíveis — senão o "+N"
   *  esconderia justamente quem está falhando. */
  working: number
  attention: number
  summary: string
}

/** Mesas visíveis por ilha. Mais que isso a ilha vira um paredão e perde o
 *  ponto, que é ler o esforço de relance. */
export const MAX_DESKS = 6

/** A ilha do agente principal — sempre presente, sempre a primeira. */
export const PRINCIPAL_KIND = 'principal'

export interface OfficeInput {
  tracks: TrackMap
  principal: { state: CrewState; line?: string; startedAt?: number }
  /** Reservado para regras que dependem do relógio; injetável no teste. */
  now?: number
}

/** Quem pede olhar primeiro: trabalhando, depois quem precisa de ação, depois
 *  os parados. `asking` não vem de trilha, mas a ordem fica completa. */
const STATE_RANK: Record<CrewState, number> = { working: 0, asking: 1, failed: 2, idle: 3 }

function deskState(track: AgentTrack): CrewState {
  if (track.status === 'running') return 'working'
  return track.status === 'error' ? 'failed' : 'idle'
}

/**
 * Tipo da mesa. Trilha ainda sem classificação senta em `outros` e se muda
 * quando o tipo chegar. Normaliza de novo por defesa (o campo é opcional e
 * pode ter vindo de um estado persistido antigo), e um tipo "principal" cai em
 * `outros`: a ilha principal é do agente principal, de mais ninguém.
 */
function deskKind(track: AgentTrack): string {
  const k = normalizeKind(track.tipo) ?? FALLBACK_KIND
  return k === PRINCIPAL_KIND ? FALLBACK_KIND : k
}

function deskFromTrack(track: AgentTrack): OfficeDesk {
  const state = deskState(track)
  const last = track.steps[track.steps.length - 1]
  return {
    id: `track:${track.id}`,
    trackId: track.id,
    name: track.subagentType || 'subagente',
    label: track.label,
    kind: deskKind(track),
    state,
    ...(state === 'working' && last ? { tool: last.name } : {}),
    stepCount: track.stepCount,
    startedAt: track.startedAt,
    ...(track.endedAt === undefined ? {} : { endedAt: track.endedAt })
  }
}

/** Estado primeiro; no empate, quem começou mais recentemente. */
function compareDesks(a: OfficeDesk, b: OfficeDesk): number {
  const byState = STATE_RANK[a.state] - STATE_RANK[b.state]
  if (byState !== 0) return byState
  return (b.startedAt ?? 0) - (a.startedAt ?? 0)
}

/** Ordem das ilhas: as sugeridas na ordem de `DEFAULT_KINDS`, depois as
 *  demais em ordem alfabética, e `outros` sempre por último — é a gaveta. */
function compareKinds(a: string, b: string): number {
  if (a === b) return 0
  if (a === FALLBACK_KIND) return 1
  if (b === FALLBACK_KIND) return -1
  const ia = DEFAULT_KINDS.indexOf(a)
  const ib = DEFAULT_KINDS.indexOf(b)
  if (ia >= 0 && ib >= 0) return ia - ib
  if (ia >= 0) return -1
  if (ib >= 0) return 1
  return a.localeCompare(b)
}

/** "2 trabalhando · 1 precisa de atenção"; nada acontecendo é "ociosa". */
function islandSummary(working: number, attention: number): string {
  const parts: string[] = []
  if (working > 0) parts.push(`${working} trabalhando`)
  if (attention > 0) parts.push(`${attention} ${attention > 1 ? 'precisam' : 'precisa'} de atenção`)
  return parts.length > 0 ? parts.join(' · ') : 'ociosa'
}

function makeIsland(kind: string, all: OfficeDesk[]): OfficeIsland {
  const sorted = [...all].sort(compareDesks)
  const desks = sorted.slice(0, MAX_DESKS)
  const working = sorted.filter((d) => d.state === 'working').length
  const attention = sorted.filter((d) => d.state === 'asking' || d.state === 'failed').length
  return {
    kind,
    label: kindLabel(kind),
    desks,
    overflow: sorted.length - desks.length,
    total: sorted.length,
    working,
    attention,
    summary: islandSummary(working, attention)
  }
}

/**
 * Monta o escritório inteiro: a ilha principal primeiro, depois uma ilha por
 * tipo que tenha pelo menos uma mesa. Ilha vazia não aparece — mobília sem
 * ninguém só empurra as ilhas ocupadas para longe.
 */
export function buildOffice(input: OfficeInput): OfficeIsland[] {
  const principal: OfficeDesk = {
    id: PRINCIPAL_KIND,
    name: 'Principal',
    label: input.principal.line ?? '',
    kind: PRINCIPAL_KIND,
    state: input.principal.state,
    stepCount: 0,
    ...(input.principal.startedAt === undefined ? {} : { startedAt: input.principal.startedAt })
  }

  const byKind = new Map<string, OfficeDesk[]>()
  for (const track of Object.values(input.tracks)) {
    const desk = deskFromTrack(track)
    const list = byKind.get(desk.kind) ?? []
    list.push(desk)
    byKind.set(desk.kind, list)
  }

  const islands: OfficeIsland[] = [makeIsland(PRINCIPAL_KIND, [principal])]
  for (const kind of [...byKind.keys()].sort(compareKinds)) {
    islands.push(makeIsland(kind, byKind.get(kind) ?? []))
  }
  return islands
}
