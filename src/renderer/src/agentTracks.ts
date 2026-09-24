import type { ChatEvent } from '@shared/ipc'
import { FALLBACK_KIND, normalizeKind } from '@shared/agentKind'

/**
 * Live view of WHO is working inside a conversation — the agents panel's data.
 *
 * The chat feed only ever shows the main agent. Every call a subagent makes
 * arrives tagged with the `Task` tool-use that spawned it (`parentToolUseId`),
 * and instead of being dropped (as it used to be) it lands here, in a store
 * that is completely separate from `Conversation.messages`. That separation is
 * the whole point: the panel gains the detail without the chat gaining noise.
 *
 * This module is pure — no React, no IPC — so the routing rules are unit
 * testable on their own.
 */

/** One call made inside a track, with its result once it lands. */
export interface TrackStep {
  /** The tool-use id (also how the matching tool-result finds it back). */
  id: string
  name: string
  input: unknown
  startedAt: number
  endedAt?: number
  isError?: boolean
  /** Result text, trimmed — the panel shows a preview, not the whole payload. */
  result?: string
}

export interface AgentTrack {
  /** The `Task` tool-use id that spawned this subagent — the track's identity. */
  id: string
  /** Human label ("Explore: onde o plano é montado"), never a raw tool id. */
  label: string
  /**
   * A descrição REAL da delegação — `taskDescription`, `input.description` ou
   * `input.subject`, nessa ordem —, sem prefixo e sem corte. NUNCA o
   * `input.prompt`: o prompt é o enunciado inteiro (pode trazer código,
   * histórico, dados do usuário) e é por isso que ele não sai daqui para o
   * classificador de tipo. Ausente quando o SDK não mandou descrição nenhuma;
   * o `label` ainda cai no prompt para exibição, esta não.
   */
  description?: string
  /** Subagent kind reported by the SDK (`Explore`, `general-purpose`, …). */
  subagentType?: string
  /**
   * Tipo de DOMÍNIO do trabalho ("seguranca", "frontend"…), já normalizado por
   * `normalizeKind` — é o que o Escritório usa para agrupar mesas em ilhas.
   * NÃO é o `subagentType` do SDK: aquele diz quem foi chamado, este diz sobre
   * o quê. Chega depois da abertura (vem de uma classificação) e, uma vez
   * definido, não muda — ver `setTrackKind`.
   */
  tipo?: string
  status: 'running' | 'done' | 'error'
  startedAt: number
  endedAt?: number
  /** Total calls made by this subagent (steps may be trimmed; this is not). */
  stepCount: number
  steps: TrackStep[]
}

/** Tracks of one conversation, most recently started first. */
export type TrackMap = Record<string, AgentTrack>

/**
 * Tools that spawn a subagent. The SDK renamed this over time (`Task` in older
 * builds, `Agent` in the current one) and both still show up depending on the
 * bundled CLI — confirmed live: a real run emitted `Agent`, so keying only on
 * `Task` left the panel permanently empty.
 */
const SPAWN_TOOLS = new Set(['Task', 'Agent'])

/** Steps kept per track. A long-running subagent can make hundreds of calls and
 *  the panel only ever shows the tail — the rest stays in the CLI transcript. */
export const MAX_STEPS = 60
/** Finished tracks kept per conversation (running ones are never dropped). */
export const MAX_FINISHED_TRACKS = 12
const RESULT_PREVIEW = 2000

/** True for an event that belongs to a subagent rather than the main agent. */
export function isSubagentEvent(e: ChatEvent): boolean {
  if (e.kind === 'tool-use') return e.parentToolUseId != null
  if (e.kind === 'tool-result') return e.parentToolUseId != null
  return false
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim()
  return undefined
}

/** Build a readable label from whatever the SDK gave us, in order of quality. */
function labelFor(input: unknown, subagentType?: string, taskDescription?: string): string {
  const i = (input ?? {}) as Record<string, unknown>
  const text =
    firstString(taskDescription, i.description, i.subject, i.prompt) ?? 'Subagente'
  const short = text.length > 80 ? `${text.slice(0, 79)}…` : text
  return subagentType ? `${subagentType}: ${short}` : short
}

/**
 * A descrição de verdade da delegação, ou `undefined`. Mesma ordem do
 * `labelFor`, mas SEM o `input.prompt` no fim — ver `AgentTrack.description`.
 */
function descriptionFor(input: unknown, taskDescription?: string): string | undefined {
  const i = (input ?? {}) as Record<string, unknown>
  return firstString(taskDescription, i.description, i.subject)
}

function trimSteps(steps: TrackStep[]): TrackStep[] {
  return steps.length > MAX_STEPS ? steps.slice(steps.length - MAX_STEPS) : steps
}

/** Drop the oldest FINISHED tracks once there are too many; running ones stay. */
function trimTracks(map: TrackMap): TrackMap {
  const finished = Object.values(map)
    .filter((t) => t.status !== 'running')
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
  if (finished.length <= MAX_FINISHED_TRACKS) return map
  const drop = new Set(finished.slice(MAX_FINISHED_TRACKS).map((t) => t.id))
  const next: TrackMap = {}
  for (const [id, track] of Object.entries(map)) if (!drop.has(id)) next[id] = track
  return next
}

/**
 * Fold one agent event into a conversation's tracks. Returns the SAME map when
 * the event doesn't concern the panel, so callers can skip the state update.
 */
export function reduceTracks(map: TrackMap, e: ChatEvent, now = Date.now()): TrackMap {
  if (e.kind === 'tool-use') {
    // Main agent delegating (`Task`): opens a track, still "running".
    if (e.parentToolUseId == null) {
      if (!SPAWN_TOOLS.has(e.name)) return map
      const description = descriptionFor(e.input, e.taskDescription)
      const track: AgentTrack = {
        id: e.id,
        label: labelFor(e.input, e.subagentType, e.taskDescription),
        ...(description ? { description } : {}),
        ...(e.subagentType ? { subagentType: e.subagentType } : {}),
        status: 'running',
        startedAt: now,
        stepCount: 0,
        steps: []
      }
      return trimTracks({ ...map, [e.id]: track })
    }

    // A subagent whose opening Task we never saw (app reconnected mid-flight):
    // adopt it instead of dropping its work on the floor.
    const existing: AgentTrack = map[e.parentToolUseId] ?? {
      id: e.parentToolUseId,
      label: labelFor(undefined, e.subagentType, e.taskDescription),
      ...(e.subagentType ? { subagentType: e.subagentType } : {}),
      status: 'running',
      startedAt: now,
      stepCount: 0,
      steps: []
    }
    const step: TrackStep = { id: e.id, name: e.name, input: e.input, startedAt: now }
    // A late taskDescription is the track's real description from now on
    // (this also covers the adoption above, which starts without one).
    const lateDescription = descriptionFor(undefined, e.taskDescription)
    return {
      ...map,
      [existing.id]: {
        ...existing,
        ...(lateDescription ? { description: lateDescription } : {}),
        // A late label beats the placeholder one.
        label: e.taskDescription
          ? labelFor(undefined, e.subagentType ?? existing.subagentType, e.taskDescription)
          : existing.label,
        stepCount: existing.stepCount + 1,
        steps: trimSteps([...existing.steps, step])
      }
    }
  }

  if (e.kind === 'tool-result') {
    // The Task call coming back closes the track it opened.
    if (e.parentToolUseId == null) {
      const track = map[e.toolUseId]
      if (!track) return map
      return trimTracks({
        ...map,
        [track.id]: { ...track, status: e.isError ? 'error' : 'done', endedAt: now }
      })
    }
    const track = map[e.parentToolUseId]
    if (!track) return map
    const i = track.steps.findIndex((s) => s.id === e.toolUseId)
    if (i < 0) return map
    const steps = [...track.steps]
    steps[i] = {
      ...steps[i],
      endedAt: now,
      isError: e.isError,
      result: e.text.length > RESULT_PREVIEW ? `${e.text.slice(0, RESULT_PREVIEW)}…` : e.text
    }
    return { ...map, [track.id]: { ...track, steps } }
  }

  return map
}

/** Panel ordering: running first, then most recent. */
export function sortTracks(map: TrackMap): AgentTrack[] {
  return Object.values(map).sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1
    if (b.status === 'running' && a.status !== 'running') return 1
    return b.startedAt - a.startedAt
  })
}

/**
 * Define o tipo de domínio de uma trilha — UMA vez só. A mesa não pode trocar
 * de ilha porque uma segunda classificação discordou da primeira; a única
 * mudança permitida é sair de "sem tipo" (que o Escritório mostra em
 * `outros`). Trilha inexistente ou já classificada devolve o MESMO map, para
 * quem chama pular o setState. Tipo inválido vira `FALLBACK_KIND`: a
 * classificação aconteceu, só não disse nada útil.
 */
export function setTrackKind(map: TrackMap, trackId: string, kind: unknown): TrackMap {
  const track = map[trackId]
  if (!track || track.tipo !== undefined) return map
  return { ...map, [trackId]: { ...track, tipo: normalizeKind(kind) ?? FALLBACK_KIND } }
}

/** Close every still-running track — the turn ended, nothing is working now. */
export function closeRunningTracks(map: TrackMap, now = Date.now()): TrackMap {
  let changed = false
  const next: TrackMap = {}
  for (const [id, track] of Object.entries(map)) {
    if (track.status === 'running') {
      changed = true
      next[id] = { ...track, status: 'done', endedAt: now }
    } else {
      next[id] = track
    }
  }
  return changed ? next : map
}
