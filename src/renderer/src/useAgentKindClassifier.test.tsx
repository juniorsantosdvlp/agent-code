import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { DEFAULT_KINDS, FALLBACK_KIND } from '@shared/agentKind'
import { reduceTracks, type AgentTrack, type TrackMap } from './agentTracks'
import {
  MAX_DESCRIPTION_CHARS,
  MAX_EXISTING_KINDS,
  OFFICE_KINDS_KEY,
  knownKinds,
  parsePersistedKinds,
  pendingClassifications,
  trackDescription,
  useAgentKindClassifier,
  withLearnedKind
} from './useAgentKindClassifier'

function track(id: string, over: Partial<AgentTrack> = {}): AgentTrack {
  return {
    id,
    label: `Explore: descrição de ${id}`,
    description: `descrição de ${id}`,
    subagentType: 'Explore',
    status: 'running',
    startedAt: 1,
    stepCount: 0,
    steps: [],
    ...over
  }
}

// ---------------------------------------------------------------------------
// Funções puras
// ---------------------------------------------------------------------------

describe('trackDescription', () => {
  it('usa a description da trilha, aparada — nunca o rótulo', () => {
    expect(
      trackDescription(track('t1', { label: 'executor: rótulo qualquer', description: '  revisar o login  ' }))
    ).toBe('revisar o login')
  })
  it('trilha sem description (rótulo que caiu no prompt) → vazio', () => {
    expect(trackDescription(track('t1', { label: 'Explore: conteúdo do prompt', description: undefined }))).toBe('')
    expect(trackDescription({ description: '   ' })).toBe('')
  })
  it(`corta em ${MAX_DESCRIPTION_CHARS} caracteres`, () => {
    const out = trackDescription({ description: `${'a'.repeat(MAX_DESCRIPTION_CHARS)}FIM` })
    expect(out).toHaveLength(MAX_DESCRIPTION_CHARS)
    expect(out).not.toContain('FIM')
  })
})

describe('pendingClassifications', () => {
  it('lista só trilhas sem tipo e ainda não pedidas, de todas as conversas', () => {
    const tracks: Record<string, TrackMap> = {
      c1: { a: track('a'), b: track('b', { tipo: 'dados' }) },
      c2: { c: track('c'), d: track('d') }
    }
    const out = pendingClassifications(tracks, new Set(['d']))
    expect(out.map((p) => [p.convId, p.track.id])).toEqual([
      ['c1', 'a'],
      ['c2', 'c']
    ])
  })
})

describe('knownKinds', () => {
  it('junta sugeridos, aprendidos e atribuídos, sem duplicata', () => {
    const tracks: Record<string, TrackMap> = { c1: { a: track('a', { tipo: 'infra' }) } }
    expect(knownKinds(['mobile', 'Dados'], tracks)).toEqual([...DEFAULT_KINDS, 'mobile', 'infra'])
  })
  it(`nunca passa de ${MAX_EXISTING_KINDS} tipos (o IPC recusa listas maiores)`, () => {
    const many = Array.from({ length: 80 }, (_, i) => `tipo-${i}`)
    const tracks: Record<string, TrackMap> = { c1: { a: track('a', { tipo: 'infra' }) } }
    const out = knownKinds(many, tracks)
    expect(out).toHaveLength(MAX_EXISTING_KINDS)
    // O corte descarta aprendidos, nunca os sugeridos.
    expect(out.slice(0, DEFAULT_KINDS.length)).toEqual([...DEFAULT_KINDS])
  })
})

describe('parsePersistedKinds / withLearnedKind', () => {
  it('lixo no kv vira lista vazia', () => {
    expect(parsePersistedKinds(null)).toEqual([])
    expect(parsePersistedKinds('{')).toEqual([])
    expect(parsePersistedKinds('{"a":1}')).toEqual([])
    expect(parsePersistedKinds(JSON.stringify(['Infra', 3, 'infra', 'Mobile']))).toEqual(['infra', 'mobile'])
  })
  it('só devolve lista nova quando o tipo é inédito', () => {
    expect(withLearnedKind(['infra'], 'Mobile')).toEqual(['infra', 'mobile'])
    expect(withLearnedKind(['infra'], 'infra')).toBeNull()
    expect(withLearnedKind([], 'segurança')).toBeNull() // sugerido
    expect(withLearnedKind([], '   ')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

type Api = {
  kvGet: ReturnType<typeof vi.fn>
  kvSet: ReturnType<typeof vi.fn>
  classifyAgentKind: ReturnType<typeof vi.fn>
}

let api: Api
let latest: Record<string, TrackMap> = {}
let pushTracks: (next: Record<string, TrackMap>) => void = () => undefined

function Harness({ initial }: { initial: Record<string, TrackMap> }): null {
  const [tracks, setTracks] = useState(initial)
  latest = tracks
  pushTracks = (next) => setTracks(next)
  useAgentKindClassifier(tracks, setTracks)
  return null
}

beforeEach(() => {
  latest = {}
  api = {
    kvGet: vi.fn(async () => null),
    kvSet: vi.fn(async () => undefined),
    classifyAgentKind: vi.fn(async () => ({ ok: true, kind: 'dados' }))
  }
  ;(window as unknown as { api: unknown }).api = api
})
afterEach(cleanup)

describe('useAgentKindClassifier', () => {
  it('trilha nova → uma chamada, com EXATAMENTE a description e os tipos conhecidos', async () => {
    render(
      <Harness
        initial={{
          c1: { t1: track('t1', { label: 'Explore: rótulo exibido', description: 'auditar o XSS do login' }) }
        }}
      />
    )
    await waitFor(() => expect(api.classifyAgentKind).toHaveBeenCalledTimes(1))
    expect(api.classifyAgentKind).toHaveBeenCalledWith({
      description: 'auditar o XSS do login',
      existing: [...DEFAULT_KINDS]
    })
  })

  it('trilha só com prompt (sem description) → zero chamadas e tipo "outros"', async () => {
    const soPrompt = track('t1', { label: 'Explore: SEGREDO do prompt, código colado', description: undefined })
    render(<Harness initial={{ c1: { t1: soPrompt } }} />)
    await waitFor(() => expect(latest.c1.t1.tipo).toBe(FALLBACK_KIND))
    await act(async () => undefined)
    expect(api.classifyAgentKind).not.toHaveBeenCalled()
  })

  it('trilha real aberta por um Task só com prompt nunca manda o prompt ao modelo', async () => {
    const map = reduceTracks(
      {},
      {
        kind: 'tool-use',
        id: 't1',
        name: 'Task',
        input: { prompt: 'SEGREDO: conteúdo inteiro do prompt', subagent_type: 'Explore' },
        parentToolUseId: null
      }
    )
    expect(map.t1.label).toContain('SEGREDO') // o rótulo exibido continua caindo no prompt
    render(<Harness initial={{ c1: map }} />)
    await waitFor(() => expect(latest.c1.t1.tipo).toBe(FALLBACK_KIND))
    expect(api.classifyAgentKind).not.toHaveBeenCalled()
  })

  it('resposta ok grava o tipo na trilha', async () => {
    api.classifyAgentKind.mockResolvedValue({ ok: true, kind: 'Segurança' })
    render(<Harness initial={{ c1: { t1: track('t1') } }} />)
    await waitFor(() => expect(latest.c1.t1.tipo).toBe('seguranca'))
  })

  it('mesma trilha em re-render não é pedida de novo', async () => {
    let resolve: (v: unknown) => void = () => undefined
    api.classifyAgentKind.mockImplementation(() => new Promise((r) => (resolve = r)))
    const t1 = track('t1')
    render(<Harness initial={{ c1: { t1 } }} />)
    await waitFor(() => expect(api.classifyAgentKind).toHaveBeenCalledTimes(1))
    // Re-render com a trilha ainda sem tipo (resposta pendente).
    act(() => pushTracks({ c1: { t1: { ...t1, stepCount: 3 } } }))
    act(() => pushTracks({ c1: { t1: { ...t1, stepCount: 4 } } }))
    await act(async () => resolve({ ok: true, kind: 'dados' }))
    await waitFor(() => expect(latest.c1.t1.tipo).toBe('dados'))
    expect(api.classifyAgentKind).toHaveBeenCalledTimes(1)
  })

  it('trilha nova depois da primeira gera só mais uma chamada', async () => {
    render(<Harness initial={{ c1: { t1: track('t1') } }} />)
    await waitFor(() => expect(latest.c1.t1.tipo).toBe('dados'))
    act(() => pushTracks({ ...latest, c2: { t2: track('t2') } }))
    await waitFor(() => expect(latest.c2.t2.tipo).toBe('dados'))
    expect(api.classifyAgentKind).toHaveBeenCalledTimes(2)
  })

  it('{ ok: false } → outros', async () => {
    api.classifyAgentKind.mockResolvedValue({ ok: false })
    render(<Harness initial={{ c1: { t1: track('t1') } }} />)
    await waitFor(() => expect(latest.c1.t1.tipo).toBe(FALLBACK_KIND))
  })

  it('promessa rejeitada → outros', async () => {
    api.classifyAgentKind.mockRejectedValue(new Error('ipc caiu'))
    render(<Harness initial={{ c1: { t1: track('t1') } }} />)
    await waitFor(() => expect(latest.c1.t1.tipo).toBe(FALLBACK_KIND))
  })

  it('exceção síncrona (IPC ausente) → outros, sem quebrar o render', async () => {
    api.classifyAgentKind.mockImplementation(() => {
      throw new Error('sem ponte')
    })
    render(<Harness initial={{ c1: { t1: track('t1') } }} />)
    await waitFor(() => expect(latest.c1.t1.tipo).toBe(FALLBACK_KIND))
  })

  it('persiste tipo inédito em office.kinds e o usa como conhecido depois', async () => {
    api.kvGet.mockResolvedValue(JSON.stringify(['mobile']))
    api.classifyAgentKind.mockResolvedValueOnce({ ok: true, kind: 'Infra' })
    render(<Harness initial={{ c1: { t1: track('t1') } }} />)
    await waitFor(() => expect(latest.c1.t1.tipo).toBe('infra'))
    expect(api.kvGet).toHaveBeenCalledWith(OFFICE_KINDS_KEY)
    expect(api.classifyAgentKind.mock.calls[0][0].existing).toEqual([...DEFAULT_KINDS, 'mobile'])
    expect(api.kvSet).toHaveBeenCalledWith(OFFICE_KINDS_KEY, JSON.stringify(['mobile', 'infra']))

    act(() => pushTracks({ c1: { ...latest.c1, t2: track('t2') } }))
    await waitFor(() => expect(api.classifyAgentKind).toHaveBeenCalledTimes(2))
    expect(api.classifyAgentKind.mock.calls[1][0].existing).toEqual([...DEFAULT_KINDS, 'mobile', 'infra'])
  })

  it('tipo sugerido não é persistido', async () => {
    render(<Harness initial={{ c1: { t1: track('t1') } }} />)
    await waitFor(() => expect(latest.c1.t1.tipo).toBe('dados'))
    expect(api.kvSet).not.toHaveBeenCalled()
  })

  it(`manda no máximo ${MAX_EXISTING_KINDS} tipos mesmo com muitos aprendidos`, async () => {
    api.kvGet.mockResolvedValue(JSON.stringify(Array.from({ length: 70 }, (_, i) => `tipo-${i}`)))
    render(<Harness initial={{ c1: { t1: track('t1') } }} />)
    await waitFor(() => expect(api.classifyAgentKind).toHaveBeenCalledTimes(1))
    expect(api.classifyAgentKind.mock.calls[0][0].existing.length).toBeLessThanOrEqual(MAX_EXISTING_KINDS)
  })

  it('kvGet falhando não impede a classificação', async () => {
    api.kvGet.mockRejectedValue(new Error('kv fora'))
    render(<Harness initial={{ c1: { t1: track('t1') } }} />)
    await waitFor(() => expect(latest.c1.t1.tipo).toBe('dados'))
    expect(api.classifyAgentKind.mock.calls[0][0].existing).toEqual([...DEFAULT_KINDS])
  })

  it('trilha já com tipo não é classificada', async () => {
    render(<Harness initial={{ c1: { t1: track('t1', { tipo: 'frontend' }) } }} />)
    await waitFor(() => expect(api.kvGet).toHaveBeenCalled())
    await act(async () => undefined)
    expect(api.classifyAgentKind).not.toHaveBeenCalled()
  })
})
