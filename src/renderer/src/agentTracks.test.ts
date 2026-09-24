import { describe, it, expect } from 'vitest'
import type { ChatEvent } from '@shared/ipc'
import {
  closeRunningTracks,
  isSubagentEvent,
  MAX_FINISHED_TRACKS,
  MAX_STEPS,
  reduceTracks,
  setTrackKind,
  sortTracks,
  type TrackMap
} from './agentTracks'

const taskCall = (id: string, description: string): ChatEvent => ({
  kind: 'tool-use',
  id,
  name: 'Task',
  input: { description, prompt: 'faz aí', subagent_type: 'Explore' },
  parentToolUseId: null
})

const subCall = (id: string, parent: string, name: string, extra: Record<string, unknown> = {}): ChatEvent => ({
  kind: 'tool-use',
  id,
  name,
  input: { file_path: 'a.ts' },
  parentToolUseId: parent,
  ...extra
})

const subResult = (toolUseId: string, parent: string, text = 'ok', isError = false): ChatEvent => ({
  kind: 'tool-result',
  id: `r-${toolUseId}`,
  toolUseId,
  isError,
  text,
  parentToolUseId: parent
})

const taskResult = (toolUseId: string, isError = false): ChatEvent => ({
  kind: 'tool-result',
  id: `r-${toolUseId}`,
  toolUseId,
  isError,
  text: 'relatório final',
  parentToolUseId: null
})

function fold(events: ChatEvent[], map: TrackMap = {}): TrackMap {
  return events.reduce((acc, e) => reduceTracks(acc, e), map)
}

describe('isSubagentEvent', () => {
  it('separa o trabalho de subagente do que é do agente principal', () => {
    expect(isSubagentEvent(subCall('t1', 'task-1', 'Read'))).toBe(true)
    expect(isSubagentEvent(subResult('t1', 'task-1'))).toBe(true)
    expect(isSubagentEvent(taskCall('task-1', 'procurar X'))).toBe(false)
    expect(isSubagentEvent(taskResult('task-1'))).toBe(false)
    expect(isSubagentEvent({ kind: 'assistant-text', id: 'a', text: 'oi', final: true })).toBe(false)
  })
})

describe('reduceTracks', () => {
  it('abre a trilha tanto no nome novo (Agent) quanto no antigo (Task)', () => {
    const comAgent = fold([{ ...taskCall('a1', 'varrer imports'), name: 'Agent' } as ChatEvent])
    expect(comAgent['a1'].status).toBe('running')
    const comTask = fold([taskCall('t1', 'varrer imports')])
    expect(comTask['t1'].status).toBe('running')
    // Ferramenta comum do agente principal não vira trilha.
    expect(fold([{ ...taskCall('x1', 'nada'), name: 'Read' } as ChatEvent])).toEqual({})
  })

  it('a chamada Task abre a trilha com rótulo legível', () => {
    const map = fold([taskCall('task-1', 'procurar onde o plano é montado')])
    expect(map['task-1'].label).toContain('procurar onde o plano é montado')
    expect(map['task-1'].status).toBe('running')
    expect(map['task-1'].stepCount).toBe(0)
  })

  it('as chamadas do subagente entram na trilha, não no chat', () => {
    const map = fold([
      taskCall('task-1', 'procurar X'),
      subCall('s1', 'task-1', 'Read'),
      subCall('s2', 'task-1', 'Grep'),
      subResult('s1', 'task-1', 'conteúdo do arquivo')
    ])
    const track = map['task-1']
    expect(track.stepCount).toBe(2)
    expect(track.steps.map((s) => s.name)).toEqual(['Read', 'Grep'])
    expect(track.steps[0].result).toBe('conteúdo do arquivo')
    expect(track.steps[0].endedAt).toBeTypeOf('number')
  })

  it('o resultado da Task fecha a trilha', () => {
    const map = fold([taskCall('task-1', 'procurar X'), subCall('s1', 'task-1', 'Read'), taskResult('task-1')])
    expect(map['task-1'].status).toBe('done')
    expect(map['task-1'].endedAt).toBeTypeOf('number')
  })

  it('Task com erro fecha a trilha como erro', () => {
    const map = fold([taskCall('task-1', 'procurar X'), taskResult('task-1', true)])
    expect(map['task-1'].status).toBe('error')
  })

  it('adota subagente cuja Task não foi vista (app reconectou no meio)', () => {
    const map = fold([
      subCall('s1', 'task-perdida', 'Bash', { subagentType: 'Explore', taskDescription: 'auditar imports' })
    ])
    expect(map['task-perdida'].label).toBe('Explore: auditar imports')
    expect(map['task-perdida'].status).toBe('running')
    expect(map['task-perdida'].stepCount).toBe(1)
  })

  it('rótulo melhor chegando depois substitui o provisório', () => {
    const map = fold([
      subCall('s1', 'task-1', 'Read'),
      subCall('s2', 'task-1', 'Grep', { subagentType: 'Explore', taskDescription: 'mapear rotas' })
    ])
    expect(map['task-1'].label).toBe('Explore: mapear rotas')
  })

  it('description vem de taskDescription, depois input.description, depois input.subject', () => {
    const open = (id: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}): TrackMap =>
      fold([{ kind: 'tool-use', id, name: 'Task', input, parentToolUseId: null, ...extra } as ChatEvent])

    const porTask = open('t1', { description: 'da entrada', prompt: 'P' }, { taskDescription: '  do SDK  ' })
    expect(porTask.t1.description).toBe('do SDK')

    const porDescription = open('t2', { description: 'da entrada', subject: 'assunto', prompt: 'P' })
    expect(porDescription.t2.description).toBe('da entrada')

    const porSubject = open('t3', { subject: 'assunto', prompt: 'P' })
    expect(porSubject.t3.description).toBe('assunto')
  })

  it('description NUNCA vem do prompt (o rótulo exibido continua caindo nele)', () => {
    const map = fold([
      {
        kind: 'tool-use',
        id: 't1',
        name: 'Agent',
        input: { prompt: 'SEGREDO: enunciado inteiro', description: '   ', subagent_type: 'Explore' },
        subagentType: 'Explore',
        parentToolUseId: null
      } as ChatEvent
    ])
    expect(map.t1.description).toBeUndefined()
    expect('description' in map.t1).toBe(false)
    expect(map.t1.label).toBe('Explore: SEGREDO: enunciado inteiro')
    // Passo do subagente sem taskDescription não inventa description.
    expect(fold([subCall('s1', 't1', 'Read')], map).t1.description).toBeUndefined()
  })

  it('adoção com taskDescription já nasce com description', () => {
    const map = fold([
      subCall('s1', 'task-perdida', 'Bash', { subagentType: 'Explore', taskDescription: 'auditar imports' })
    ])
    expect(map['task-perdida'].description).toBe('auditar imports')
  })

  it('label tardio também preenche a description', () => {
    let map = fold([
      {
        kind: 'tool-use',
        id: 'task-1',
        name: 'Task',
        input: { prompt: 'só prompt aqui' },
        parentToolUseId: null
      } as ChatEvent
    ])
    expect(map['task-1'].description).toBeUndefined()
    map = fold([subCall('s1', 'task-1', 'Grep', { subagentType: 'Explore', taskDescription: 'mapear rotas' })], map)
    expect(map['task-1'].description).toBe('mapear rotas')
    expect(map['task-1'].label).toBe('Explore: mapear rotas')

    // Adoção sem descrição que ganha uma depois.
    const adotada = fold([
      subCall('s1', 'task-2', 'Read'),
      subCall('s2', 'task-2', 'Grep', { subagentType: 'Explore', taskDescription: 'mapear rotas' })
    ])
    expect(adotada['task-2'].description).toBe('mapear rotas')
  })

  it('não deixa a trilha crescer sem limite (mas o contador é real)', () => {
    const events: ChatEvent[] = [taskCall('task-1', 'muita coisa')]
    for (let i = 0; i < MAX_STEPS + 25; i++) events.push(subCall(`s${i}`, 'task-1', 'Read'))
    const track = fold(events)['task-1']
    expect(track.steps).toHaveLength(MAX_STEPS)
    expect(track.stepCount).toBe(MAX_STEPS + 25)
    expect(track.steps[track.steps.length - 1].id).toBe(`s${MAX_STEPS + 24}`) // manteve o fim, não o começo
  })

  it('evento que não é de trilha devolve o MESMO objeto (evita re-render à toa)', () => {
    const map = fold([taskCall('task-1', 'procurar X')])
    expect(reduceTracks(map, { kind: 'assistant-text', id: 'a', text: 'oi', final: false })).toBe(map)
    expect(reduceTracks(map, { kind: 'thinking', id: 't', text: 'hmm' })).toBe(map)
  })

  it('resultado de trilha desconhecida não cria lixo', () => {
    expect(reduceTracks({}, subResult('s1', 'task-fantasma'))).toEqual({})
    expect(reduceTracks({}, taskResult('task-fantasma'))).toEqual({})
  })
})

describe('sortTracks / closeRunningTracks', () => {
  it('rodando primeiro, depois as mais recentes', () => {
    let map = fold([taskCall('t1', 'primeira'), taskCall('t2', 'segunda')])
    map = reduceTracks(map, taskResult('t2'))
    const order = sortTracks(map).map((t) => t.id)
    expect(order[0]).toBe('t1') // a que ainda roda vem antes
  })

  it('fim de turno não deixa ninguém girando pra sempre', () => {
    const map = fold([taskCall('t1', 'primeira'), taskCall('t2', 'segunda')])
    const closed = closeRunningTracks(map)
    expect(Object.values(closed).every((t) => t.status === 'done')).toBe(true)
    // Nada a fechar → mesmo objeto de volta.
    expect(closeRunningTracks(closed)).toBe(closed)
  })
})

describe('setTrackKind', () => {
  it('define o tipo normalizado na trilha', () => {
    const map = fold([taskCall('t1', 'revisar login')])
    const next = setTrackKind(map, 't1', 'Segurança')
    expect(next).not.toBe(map)
    expect(next['t1'].tipo).toBe('seguranca')
    // Não mexe no resto da trilha.
    expect(next['t1'].label).toBe(map['t1'].label)
    expect(map['t1'].tipo).toBeUndefined()
  })

  it('define UMA vez só: segunda classificação devolve o MESMO objeto', () => {
    const map = setTrackKind(fold([taskCall('t1', 'revisar login')]), 't1', 'seguranca')
    const again = setTrackKind(map, 't1', 'frontend')
    expect(again).toBe(map)
    expect(again['t1'].tipo).toBe('seguranca')
  })

  it('trilha inexistente devolve o MESMO objeto', () => {
    const map = fold([taskCall('t1', 'revisar login')])
    expect(setTrackKind(map, 'fantasma', 'dados')).toBe(map)
  })

  it('tipo inválido vira "outros"', () => {
    const map = fold([taskCall('t1', 'x'), taskCall('t2', 'y')])
    expect(setTrackKind(map, 't1', '   ')['t1'].tipo).toBe('outros')
    expect(setTrackKind(map, 't2', undefined)['t2'].tipo).toBe('outros')
  })

  it('reduceTracks preserva o tipo ao somar passos, resultados e fechar', () => {
    let map = setTrackKind(fold([taskCall('t1', 'revisar login')]), 't1', 'seguranca')
    map = fold(
      [
        subCall('s1', 't1', 'Read'),
        subCall('s2', 't1', 'Grep', { subagentType: 'Explore', taskDescription: 'rótulo novo' }),
        subResult('s1', 't1'),
        taskResult('t1')
      ],
      map
    )
    expect(map['t1'].stepCount).toBe(2)
    expect(map['t1'].status).toBe('done')
    expect(map['t1'].tipo).toBe('seguranca')
  })

  it('closeRunningTracks preserva o tipo', () => {
    const map = setTrackKind(fold([taskCall('t1', 'revisar login')]), 't1', 'dados')
    const closed = closeRunningTracks(map)
    expect(closed['t1'].status).toBe('done')
    expect(closed['t1'].tipo).toBe('dados')
  })

  it('o corte de trilhas terminadas (trimTracks) preserva o tipo das que ficam', () => {
    let map: TrackMap = {}
    let now = 1000
    for (let i = 0; i < MAX_FINISHED_TRACKS + 3; i++) {
      map = reduceTracks(map, taskCall(`t${i}`, `tarefa ${i}`), now++)
      map = setTrackKind(map, `t${i}`, i % 2 === 0 ? 'frontend' : 'testes')
      map = reduceTracks(map, taskResult(`t${i}`), now++)
    }
    const kept = Object.values(map)
    expect(kept).toHaveLength(MAX_FINISHED_TRACKS)
    for (const t of kept) {
      const i = Number(t.id.slice(1))
      expect(t.tipo).toBe(i % 2 === 0 ? 'frontend' : 'testes')
    }
  })
})
