import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { DEFAULT_KINDS, FALLBACK_KIND, mergeKinds, normalizeKind } from '@shared/agentKind'
import { setTrackKind, type AgentTrack, type TrackMap } from './agentTracks'

/**
 * Classifica o TIPO de domínio de cada trilha ("seguranca", "frontend"…) assim
 * que ela nasce, para o Escritório sentar a mesa na ilha certa.
 *
 * Regras (as decisões ficam em funções puras, testáveis sem React):
 * - UMA chamada por trilha, na vida do app: o id vai para um Set antes da
 *   chamada sair, então nem re-render nem resposta atrasada repete o pedido.
 * - Só a DESCRIÇÃO real da delegação vai para o modelo (`track.description`:
 *   taskDescription / description / subject) — nunca o prompt, o rótulo, os
 *   passos, entradas ou resultados.
 * - Trilha SEM descrição não custa chamada: grava `outros` direto. O rótulo
 *   dela pode ter caído no prompt, e o prompt não sai daqui.
 * - A UI nunca espera: até a resposta voltar, `buildOffice` já põe a trilha em
 *   `outros`. Falha, `{ ok: false }` ou exceção gravam `outros` de vez.
 * - Os tipos que o modelo inventa ficam guardados em kv (`office.kinds`) e
 *   voltam como "tipos conhecidos" nas próximas chamadas — é o que faz duas
 *   delegações parecidas caírem na MESMA ilha em vez de em sinônimos.
 */

/** Chave do kv com os tipos aprendidos (JSON de string[]). */
export const OFFICE_KINDS_KEY = 'office.kinds'

/** Teto de `existing` por chamada. O IPC RECUSA listas maiores (zod `.max`),
 *  e uma recusa lá viraria `outros` para toda trilha dali em diante. */
export const MAX_EXISTING_KINDS = 50

/** Teto da lista persistida — os mais recentes ficam. */
export const MAX_PERSISTED_KINDS = MAX_EXISTING_KINDS

export interface PendingClassification {
  convId: string
  track: AgentTrack
}

/** Teto da descrição enviada. Mesmo número do `KIND_INPUT_MAX_CHARS` do main
 *  (que corta de novo do lado de lá); cortar aqui evita atravessar o IPC com
 *  um texto que o classificador jogaria fora. */
export const MAX_DESCRIPTION_CHARS = 300

/**
 * Texto que vai para o classificador: `track.description`, aparada e cortada
 * em `MAX_DESCRIPTION_CHARS` — ou `''` quando a trilha não tem descrição real.
 * NÃO cai no `label`: ele pode ter vindo do `input.prompt` (ver
 * `AgentTrack.description`), e o prefixo "<subagentType>: " dele diria QUEM
 * foi chamado, não SOBRE O QUÊ.
 */
export function trackDescription(track: Pick<AgentTrack, 'description'>): string {
  const d = typeof track.description === 'string' ? track.description.trim() : ''
  return d.slice(0, MAX_DESCRIPTION_CHARS).trim()
}

/** Trilhas de todas as conversas ainda sem tipo e ainda não pedidas. */
export function pendingClassifications(
  tracks: Record<string, TrackMap>,
  requested: ReadonlySet<string>
): PendingClassification[] {
  const out: PendingClassification[] = []
  for (const [convId, map] of Object.entries(tracks)) {
    for (const track of Object.values(map)) {
      if (track.tipo !== undefined || requested.has(track.id)) continue
      out.push({ convId, track })
    }
  }
  return out
}

/** Tipos já atribuídos a alguma trilha, em qualquer conversa. */
export function assignedKinds(tracks: Record<string, TrackMap>): string[] {
  const out: string[] = []
  for (const map of Object.values(tracks)) {
    for (const track of Object.values(map)) if (track.tipo) out.push(track.tipo)
  }
  return out
}

/**
 * A lista `existing` de uma chamada: sugeridos + aprendidos + já atribuídos,
 * normalizada, sem duplicata e cortada em `MAX_EXISTING_KINDS`. Os sugeridos
 * vêm primeiro (`mergeKinds`), então o corte só descarta os aprendidos mais
 * antigos, nunca a base.
 */
export function knownKinds(persisted: readonly string[], tracks: Record<string, TrackMap>): string[] {
  return mergeKinds(DEFAULT_KINDS, persisted, assignedKinds(tracks)).slice(0, MAX_EXISTING_KINDS)
}

/** Lê o que está no kv. Qualquer coisa fora de "array de strings" vira []. */
export function parsePersistedKinds(raw: string | null | undefined): string[] {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return mergeKinds(parsed.filter((v): v is string => typeof v === 'string')).slice(-MAX_PERSISTED_KINDS)
  } catch {
    return []
  }
}

/**
 * A lista a persistir depois de aprender `kind`, ou `null` quando não há nada
 * novo (tipo inválido, sugerido ou já guardado) — e aí não se escreve no kv.
 */
export function withLearnedKind(persisted: readonly string[], kind: unknown): string[] | null {
  const k = normalizeKind(kind)
  if (!k || DEFAULT_KINDS.includes(k) || persisted.includes(k)) return null
  return [...persisted, k].slice(-MAX_PERSISTED_KINDS)
}

type SetTracks = Dispatch<SetStateAction<Record<string, TrackMap>>>

export function useAgentKindClassifier(tracks: Record<string, TrackMap>, setTracks: SetTracks): void {
  const requested = useRef(new Set<string>())
  const persisted = useRef<string[]>([])
  // Espera a leitura do kv antes da primeira chamada, para os tipos aprendidos
  // entrarem já no `existing`. Leitura que falha libera do mesmo jeito.
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    const done = (raw: string | null): void => {
      if (!alive) return
      persisted.current = parsePersistedKinds(raw)
      setLoaded(true)
    }
    try {
      Promise.resolve(window.api.kvGet(OFFICE_KINDS_KEY)).then(done, () => done(null))
    } catch {
      done(null)
    }
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!loaded) return
    const pending = pendingClassifications(tracks, requested.current)
    if (pending.length === 0) return

    for (const { convId, track } of pending) {
      // Marca ANTES de chamar: a resposta é assíncrona e o próximo render não
      // pode ver a trilha como "ainda não pedida".
      requested.current.add(track.id)

      const apply = (kind: unknown): void => {
        setTracks((prev) => {
          const map = prev[convId]
          if (!map) return prev
          const next = setTrackKind(map, track.id, kind)
          return next === map ? prev : { ...prev, [convId]: next }
        })
      }
      const learn = (kind: string): void => {
        const next = withLearnedKind(persisted.current, kind)
        if (!next) return
        persisted.current = next
        try {
          Promise.resolve(window.api.kvSet(OFFICE_KINDS_KEY, JSON.stringify(next))).catch(() => undefined)
        } catch {
          // Sem kv, o tipo vale só para esta sessão.
        }
      }

      // Sem descrição real não há o que classificar: `outros` de vez, sem
      // gastar chamada de modelo (e sem nunca mandar o prompt no lugar).
      const description = trackDescription(track)
      if (!description) {
        apply(FALLBACK_KIND)
        continue
      }
      const existing = knownKinds(persisted.current, tracks)
      let call: Promise<unknown>
      try {
        call = Promise.resolve(window.api.classifyAgentKind({ description, existing }))
      } catch {
        call = Promise.reject(new Error('classifyAgentKind indisponível'))
      }
      call.then(
        (res) => {
          const r = res as { ok?: unknown; kind?: unknown } | null | undefined
          if (r && r.ok === true && typeof r.kind === 'string') {
            apply(r.kind)
            learn(r.kind)
          } else {
            apply(FALLBACK_KIND)
          }
        },
        () => apply(FALLBACK_KIND)
      )
    }
  }, [tracks, loaded, setTracks])
}
