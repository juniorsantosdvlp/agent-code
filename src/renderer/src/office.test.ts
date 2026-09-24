import { describe, it, expect } from 'vitest'
import type { AgentTrack, TrackMap, TrackStep } from './agentTracks'
import { buildOffice, MAX_DESKS, PRINCIPAL_KIND, type OfficeInput } from './office'

const step = (id: string, name: string): TrackStep => ({ id, name, input: {}, startedAt: 1 })

function track(id: string, over: Partial<AgentTrack> = {}): AgentTrack {
  return {
    id,
    label: `Explore: tarefa ${id}`,
    subagentType: 'Explore',
    status: 'running',
    startedAt: 100,
    stepCount: 0,
    steps: [],
    ...over
  }
}

function mapOf(...tracks: AgentTrack[]): TrackMap {
  return Object.fromEntries(tracks.map((t) => [t.id, t]))
}

const idle: OfficeInput['principal'] = { state: 'idle' }

describe('buildOffice', () => {
  it('a ilha principal existe mesmo sem trilha nenhuma', () => {
    const office = buildOffice({ tracks: {}, principal: idle })
    expect(office).toHaveLength(1)
    expect(office[0].kind).toBe(PRINCIPAL_KIND)
    expect(office[0].label).toBe('Principal')
    expect(office[0].desks).toHaveLength(1)
    expect(office[0].desks[0]).toMatchObject({ id: 'principal', name: 'Principal', state: 'idle' })
    expect(office[0].summary).toBe('ociosa')
  })

  it('a principal é sempre a primeira e reflete o estado do agente principal', () => {
    const office = buildOffice({
      tracks: mapOf(track('a', { tipo: 'arquitetura' })),
      principal: { state: 'working', line: 'delegando', startedAt: 50 }
    })
    expect(office[0].kind).toBe(PRINCIPAL_KIND)
    expect(office[0].desks[0]).toMatchObject({ state: 'working', label: 'delegando', startedAt: 50 })
    expect(office[0].working).toBe(1)
  })

  it('trilha sem tipo senta em "outros" e se muda quando o tipo chega', () => {
    const semTipo = buildOffice({ tracks: mapOf(track('a')), principal: idle })
    expect(semTipo.map((i) => i.kind)).toEqual(['principal', 'outros'])
    expect(semTipo[1].desks[0].kind).toBe('outros')

    const comTipo = buildOffice({ tracks: mapOf(track('a', { tipo: 'seguranca' })), principal: idle })
    expect(comTipo.map((i) => i.kind)).toEqual(['principal', 'seguranca'])
    expect(comTipo[1].label).toBe('Segurança')
  })

  it('trilha com tipo "principal" não invade a ilha do agente principal', () => {
    const office = buildOffice({ tracks: mapOf(track('a', { tipo: 'principal' })), principal: idle })
    expect(office[0].desks).toHaveLength(1)
    expect(office.map((i) => i.kind)).toEqual(['principal', 'outros'])
  })

  it(`8 trilhas num tipo → ${MAX_DESKS} mesas + overflow 2, contagens na ilha inteira`, () => {
    const tracks: AgentTrack[] = []
    for (let i = 0; i < 8; i++) {
      // As duas mais antigas e paradas ficam de fora; uma delas falhou.
      const status: AgentTrack['status'] = i === 0 ? 'error' : i === 1 ? 'done' : 'running'
      tracks.push(track(`t${i}`, { tipo: 'dados', status, startedAt: 100 + i }))
    }
    const [, dados] = buildOffice({ tracks: mapOf(...tracks), principal: idle })
    expect(dados.kind).toBe('dados')
    expect(dados.total).toBe(8)
    expect(dados.desks).toHaveLength(MAX_DESKS)
    expect(dados.overflow).toBe(2)
    expect(dados.working).toBe(6)
    expect(dados.attention).toBe(1)
    expect(dados.summary).toBe('6 trabalhando · 1 precisa de atenção')
    // Ninguém trabalhando foi escondido pelo "+N".
    expect(dados.desks.every((d) => d.state === 'working')).toBe(true)
  })

  it('ordem das ilhas: DEFAULT_KINDS na ordem, depois alfabética, "outros" por último', () => {
    const office = buildOffice({
      tracks: mapOf(
        track('a', { tipo: 'zeta' }),
        track('b'), // outros
        track('c', { tipo: 'testes' }),
        track('d', { tipo: 'devops' }),
        track('e', { tipo: 'arquitetura' }),
        track('f', { tipo: 'seguranca' })
      ),
      principal: idle
    })
    expect(office.map((i) => i.kind)).toEqual([
      'principal',
      'arquitetura',
      'seguranca',
      'testes',
      'devops',
      'zeta',
      'outros'
    ])
  })

  it('só entram ilhas com pelo menos uma mesa', () => {
    const office = buildOffice({ tracks: mapOf(track('a', { tipo: 'frontend' })), principal: idle })
    expect(office.map((i) => i.kind)).toEqual(['principal', 'frontend'])
  })

  it('estados: running → working, error → failed, done → idle', () => {
    const [, ilha] = buildOffice({
      tracks: mapOf(
        track('ok', { tipo: 'testes', status: 'done', startedAt: 300, endedAt: 400 }),
        track('rodando', { tipo: 'testes', status: 'running', startedAt: 100 }),
        track('erro', { tipo: 'testes', status: 'error', startedAt: 200, endedAt: 250 })
      ),
      principal: idle
    })
    const byTrack = Object.fromEntries(ilha.desks.map((d) => [d.trackId, d]))
    expect(byTrack['rodando'].state).toBe('working')
    expect(byTrack['erro'].state).toBe('failed')
    expect(byTrack['ok'].state).toBe('idle')
    expect(byTrack['ok'].endedAt).toBe(400)
    // Trabalhando primeiro, depois falha, depois parado — mesmo o parado sendo o mais recente.
    expect(ilha.desks.map((d) => d.trackId)).toEqual(['rodando', 'erro', 'ok'])
    expect(ilha.summary).toBe('1 trabalhando · 1 precisa de atenção')
  })

  it('empate de estado desempata por início mais recente', () => {
    const [, ilha] = buildOffice({
      tracks: mapOf(
        track('velha', { tipo: 'dados', startedAt: 100 }),
        track('nova', { tipo: 'dados', startedAt: 300 }),
        track('meio', { tipo: 'dados', startedAt: 200 })
      ),
      principal: idle
    })
    expect(ilha.desks.map((d) => d.trackId)).toEqual(['nova', 'meio', 'velha'])
  })

  it('tool = último passo, só enquanto roda; nome e rótulo vêm da trilha', () => {
    const [, ilha] = buildOffice({
      tracks: mapOf(
        track('r', {
          tipo: 'frontend',
          steps: [step('s1', 'Read'), step('s2', 'Edit')],
          stepCount: 2
        }),
        track('d', { tipo: 'frontend', status: 'done', steps: [step('s3', 'Grep')], stepCount: 1 }),
        track('sem', { tipo: 'frontend', subagentType: undefined, label: 'varrer imports' })
      ),
      principal: idle
    })
    const byTrack = Object.fromEntries(ilha.desks.map((d) => [d.trackId, d]))
    expect(byTrack['r'].tool).toBe('Edit')
    expect(byTrack['r'].stepCount).toBe(2)
    expect(byTrack['r'].name).toBe('Explore')
    expect(byTrack['r'].label).toBe('Explore: tarefa r')
    expect(byTrack['d'].tool).toBeUndefined()
    expect(byTrack['sem'].tool).toBeUndefined()
    expect(byTrack['sem'].name).toBe('subagente')
    expect(byTrack['sem'].id).toBe('track:sem')
  })

  it('resumo no plural', () => {
    const [, ilha] = buildOffice({
      tracks: mapOf(
        track('a', { tipo: 'dados', status: 'error' }),
        track('b', { tipo: 'dados', status: 'error' })
      ),
      principal: idle
    })
    expect(ilha.summary).toBe('2 precisam de atenção')
  })
})
