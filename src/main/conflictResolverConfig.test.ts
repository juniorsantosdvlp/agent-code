// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFLICT_RESOLVER_CONFIG } from '../shared/ipc'
import { gravarConfigResolver, lerConfigResolver, lerUltimaResolucao } from './conflictResolverConfig'

let dir: string
const BOM = '\uFEFF'

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'resolver-conflitos-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const configPath = (): string => join(dir, 'resolver-conflitos.json')
const relatorioPath = (): string => join(dir, 'ultima-resolucao.json')

describe('resolver-conflitos.json — leitura', () => {
  it('arquivo ausente → padrões do script', async () => {
    expect(await lerConfigResolver(dir)).toEqual({
      ativo: true,
      politicaCommitSuperado: 'nunca-descartar',
      modelo: '',
      timeoutMinutos: 40
    })
  })

  it('pasta inteira ausente → padrões', async () => {
    expect(await lerConfigResolver(join(dir, 'nao-existe'))).toEqual(DEFAULT_CONFLICT_RESOLVER_CONFIG)
  })

  it('tolera o BOM que o PowerShell grava', async () => {
    await writeFile(configPath(), BOM + JSON.stringify({ ativo: false, politicaCommitSuperado: 'descartar-e-avisar' }), 'utf8')
    expect(await lerConfigResolver(dir)).toEqual({
      ativo: false,
      politicaCommitSuperado: 'descartar-e-avisar',
      modelo: '',
      timeoutMinutos: 40
    })
  })

  it('campo de tipo errado ou política desconhecida cai no padrão só daquele campo', async () => {
    await writeFile(
      configPath(),
      JSON.stringify({ ativo: 'sim', politicaCommitSuperado: 'apagar-tudo', modelo: 7, timeoutMinutos: 15 }),
      'utf8'
    )
    expect(await lerConfigResolver(dir)).toEqual({
      ativo: true,
      politicaCommitSuperado: 'nunca-descartar',
      modelo: '',
      timeoutMinutos: 15
    })
  })

  it('JSON corrompido → padrões, sem lançar', async () => {
    await writeFile(configPath(), '{ ativo: tru', 'utf8')
    expect(await lerConfigResolver(dir)).toEqual(DEFAULT_CONFLICT_RESOLVER_CONFIG)
  })
})

describe('resolver-conflitos.json — gravação', () => {
  it('cria o arquivo (e a pasta) em UTF-8 sem BOM, só com o que foi pedido', async () => {
    const sub = join(dir, 'AgentCodeAutoUpdate')
    const config = await gravarConfigResolver({ ativo: false }, sub)
    expect(config).toEqual({ ...DEFAULT_CONFLICT_RESOLVER_CONFIG, ativo: false })
    const bytes = await readFile(join(sub, 'resolver-conflitos.json'))
    expect(bytes[0]).not.toBe(0xef)
    expect(JSON.parse(bytes.toString('utf8'))).toEqual({ ativo: false })
  })

  it('preserva campos desconhecidos e os outros campos do contrato (inclusive de arquivo com BOM)', async () => {
    await writeFile(
      configPath(),
      BOM + JSON.stringify({ ativo: true, modelo: 'claude-opus-5-5', timeoutMinutos: 25, extraDoScript: { x: 1 } }),
      'utf8'
    )
    const config = await gravarConfigResolver({ politicaCommitSuperado: 'descartar-e-avisar' }, dir)
    expect(config).toEqual({
      ativo: true,
      politicaCommitSuperado: 'descartar-e-avisar',
      modelo: 'claude-opus-5-5',
      timeoutMinutos: 25
    })
    const gravado = JSON.parse(await readFile(configPath(), 'utf8'))
    expect(gravado).toEqual({
      ativo: true,
      modelo: 'claude-opus-5-5',
      timeoutMinutos: 25,
      extraDoScript: { x: 1 },
      politicaCommitSuperado: 'descartar-e-avisar'
    })
  })

  it('rejeita política fora da lista e não toca no arquivo', async () => {
    const original = JSON.stringify({ politicaCommitSuperado: 'nunca-descartar' })
    await writeFile(configPath(), original, 'utf8')
    await expect(gravarConfigResolver({ politicaCommitSuperado: 'apagar-tudo' }, dir)).rejects.toThrow(/Política inválida/)
    expect(await readFile(configPath(), 'utf8')).toBe(original)
  })

  it('rejeita tipos errados nos demais campos', async () => {
    await expect(gravarConfigResolver({ ativo: 'sim' }, dir)).rejects.toThrow()
    await expect(gravarConfigResolver({ modelo: 3 }, dir)).rejects.toThrow()
    await expect(gravarConfigResolver({ timeoutMinutos: 0 }, dir)).rejects.toThrow()
    await expect(gravarConfigResolver({ timeoutMinutos: 2.5 }, dir)).rejects.toThrow()
    await expect(gravarConfigResolver(null, dir)).rejects.toThrow()
    await expect(gravarConfigResolver([], dir)).rejects.toThrow()
  })

  it('escrita atômica: não sobra .tmp na pasta', async () => {
    await gravarConfigResolver({ ativo: false }, dir)
    await gravarConfigResolver({ timeoutMinutos: 60 }, dir)
    expect(await readdir(dir)).toEqual(['resolver-conflitos.json'])
    expect(await lerConfigResolver(dir)).toEqual({ ...DEFAULT_CONFLICT_RESOLVER_CONFIG, ativo: false, timeoutMinutos: 60 })
  })

  it('arquivo corrompido é substituído pelo patch (não há o que preservar)', async () => {
    await writeFile(configPath(), 'lixo', 'utf8')
    await gravarConfigResolver({ ativo: false }, dir)
    expect(JSON.parse(await readFile(configPath(), 'utf8'))).toEqual({ ativo: false })
  })
})

describe('ultima-resolucao.json', () => {
  const completo = {
    em: '2026-10-05T12:00:00Z',
    resultado: 'resolvido',
    metodo: 'agente',
    politica: 'descartar-e-avisar',
    motivo: 'Conflito juntado.',
    shaBase: 'aaa',
    shaAntes: 'bbb',
    shaDepois: 'ccc',
    tagBackup: 'backup/minha-versao-1',
    dryRun: false,
    commitsDescartados: [{ sha: 'ddd', titulo: 'Meu commit', motivo: 'Já está no original.' }],
    arquivosResolvidos: ['src/a.ts'],
    resumo: 'Mantive os dois lados.',
    log: 'C:\\logs\\r.log'
  }

  it('ausente → null', async () => {
    expect(await lerUltimaResolucao(dir)).toBeNull()
  })

  it('corrompido ou que não é objeto → null', async () => {
    await writeFile(relatorioPath(), '{ "em": ', 'utf8')
    expect(await lerUltimaResolucao(dir)).toBeNull()
    await writeFile(relatorioPath(), '[1,2]', 'utf8')
    expect(await lerUltimaResolucao(dir)).toBeNull()
  })

  it('lê o relatório completo com BOM', async () => {
    await writeFile(relatorioPath(), BOM + JSON.stringify(completo), 'utf8')
    expect(await lerUltimaResolucao(dir)).toEqual(completo)
  })

  it('campos faltando ou de tipo errado viram vazio, sem quebrar', async () => {
    await writeFile(
      relatorioPath(),
      JSON.stringify({
        resultado: 'explodiu',
        metodo: null,
        shaDepois: null,
        tagBackup: null,
        dryRun: 'true',
        commitsDescartados: [{ sha: 'x1', titulo: 5 }, 'lixo', null],
        arquivosResolvidos: ['ok.ts', 3],
        log: ''
      }),
      'utf8'
    )
    expect(await lerUltimaResolucao(dir)).toEqual({
      em: null,
      resultado: null,
      metodo: null,
      politica: null,
      motivo: '',
      shaBase: null,
      shaAntes: null,
      shaDepois: null,
      tagBackup: null,
      dryRun: false,
      commitsDescartados: [{ sha: 'x1', titulo: '', motivo: '' }],
      arquivosResolvidos: ['ok.ts'],
      resumo: '',
      log: null
    })
  })
})
