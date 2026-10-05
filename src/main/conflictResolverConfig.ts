// Resolvedor de conflitos da atualização automática, lado do app: a tela de
// Configurações › Atualização liga/desliga o agente e escolhe a política em
// resolver-conflitos.json, e mostra o que o script registrou em
// ultima-resolucao.json. Quem de fato resolve é
// scripts/sincronizar-e-instalar-agent-code.ps1 — os nomes dos campos são
// contrato com ele (ver src/shared/ipc.ts).
//
// Os dois arquivos ficam em %LOCALAPPDATA%\AgentCodeAutoUpdate, junto do
// estado.json lido por src/main/versionCheck.ts. O PowerShell grava com BOM;
// aqui a leitura tolera BOM e a gravação sai em UTF-8 sem BOM, que o
// ConvertFrom-Json do script lê do mesmo jeito.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CONFLICT_RESOLVER_POLICIES,
  DEFAULT_CONFLICT_RESOLVER_CONFIG,
  type ConflictResolutionReport,
  type ConflictResolverConfig,
  type ConflictResolverPolicy
} from '../shared/ipc'

const CONFIG_ARQUIVO = 'resolver-conflitos.json'
const RELATORIO_ARQUIVO = 'ultima-resolucao.json'

const estadoDir = (): string => join(process.env.LOCALAPPDATA || '', 'AgentCodeAutoUpdate')

type Bruto = Record<string, unknown>

/** null = arquivo ausente, ilegível ou que não é um objeto JSON. */
async function lerObjeto(caminho: string): Promise<Bruto | null> {
  try {
    const valor: unknown = JSON.parse((await readFile(caminho, 'utf8')).replace(/^﻿/, ''))
    return valor && typeof valor === 'object' && !Array.isArray(valor) ? (valor as Bruto) : null
  } catch {
    return null
  }
}

const ehPolitica = (v: unknown): v is ConflictResolverPolicy =>
  typeof v === 'string' && (CONFLICT_RESOLVER_POLICIES as readonly string[]).includes(v)

const ehTimeout = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0

function normalizarConfig(bruto: Bruto | null): ConflictResolverConfig {
  const d = DEFAULT_CONFLICT_RESOLVER_CONFIG
  return {
    ativo: typeof bruto?.ativo === 'boolean' ? bruto.ativo : d.ativo,
    politicaCommitSuperado: ehPolitica(bruto?.politicaCommitSuperado) ? bruto.politicaCommitSuperado : d.politicaCommitSuperado,
    modelo: typeof bruto?.modelo === 'string' ? bruto.modelo : d.modelo,
    timeoutMinutos: ehTimeout(bruto?.timeoutMinutos) ? bruto.timeoutMinutos : d.timeoutMinutos
  }
}

/** Config da máquina; arquivo ou campo ausente (ou inválido) cai no padrão do script. */
export async function lerConfigResolver(dir = estadoDir()): Promise<ConflictResolverConfig> {
  return normalizarConfig(await lerObjeto(join(dir, CONFIG_ARQUIVO)))
}

/**
 * Grava só os campos do patch, por cima do que já está no arquivo — campos que
 * o app não conhece (o script pode ganhar outros) continuam lá. Valor inválido
 * rejeita a gravação inteira em vez de gravar meio patch. Escrita atômica
 * (.tmp + rename): o script nunca lê um arquivo pela metade.
 */
export async function gravarConfigResolver(patch: unknown, dir = estadoDir()): Promise<ConflictResolverConfig> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Configuração inválida.')
  const p = patch as Bruto
  const mudancas: Bruto = {}
  if ('ativo' in p) {
    if (typeof p.ativo !== 'boolean') throw new Error('"ativo" precisa ser verdadeiro ou falso.')
    mudancas.ativo = p.ativo
  }
  if ('politicaCommitSuperado' in p) {
    if (!ehPolitica(p.politicaCommitSuperado)) {
      throw new Error(`Política inválida: ${String(p.politicaCommitSuperado)}. Use ${CONFLICT_RESOLVER_POLICIES.join(' ou ')}.`)
    }
    mudancas.politicaCommitSuperado = p.politicaCommitSuperado
  }
  if ('modelo' in p) {
    if (typeof p.modelo !== 'string') throw new Error('"modelo" precisa ser texto.')
    mudancas.modelo = p.modelo.trim()
  }
  if ('timeoutMinutos' in p) {
    if (!ehTimeout(p.timeoutMinutos)) throw new Error('"timeoutMinutos" precisa ser um número inteiro maior que zero.')
    mudancas.timeoutMinutos = p.timeoutMinutos
  }

  const caminho = join(dir, CONFIG_ARQUIVO)
  // Arquivo corrompido não tem o que preservar: vira o patch sobre os padrões.
  const atual = (await lerObjeto(caminho)) ?? {}
  const proximo = { ...atual, ...mudancas }
  await mkdir(dir, { recursive: true })
  const tmp = `${caminho}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(proximo, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
    await rename(tmp, caminho)
  } finally {
    await unlink(tmp).catch(() => undefined)
  }
  return normalizarConfig(proximo)
}

const texto = (v: unknown): string => (typeof v === 'string' ? v : '')
const textoOuNulo = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

function umDe<T extends string>(v: unknown, opcoes: readonly T[]): T | null {
  return typeof v === 'string' && (opcoes as readonly string[]).includes(v) ? (v as T) : null
}

/**
 * Último relatório do resolvedor, ou null quando o script nunca precisou dele
 * (arquivo ausente) ou o arquivo está ilegível. Campo faltando ou de tipo
 * errado vira vazio: a tela mostra o que der, nunca quebra.
 */
export async function lerUltimaResolucao(dir = estadoDir()): Promise<ConflictResolutionReport | null> {
  const r = await lerObjeto(join(dir, RELATORIO_ARQUIVO))
  if (!r) return null
  const descartados = Array.isArray(r.commitsDescartados) ? r.commitsDescartados : []
  return {
    em: textoOuNulo(r.em),
    resultado: umDe(r.resultado, ['resolvido', 'falhou', 'desligado', 'pulado'] as const),
    metodo: umDe(r.metodo, ['renormalize', 'agente'] as const),
    politica: umDe(r.politica, CONFLICT_RESOLVER_POLICIES),
    motivo: texto(r.motivo),
    shaBase: textoOuNulo(r.shaBase),
    shaAntes: textoOuNulo(r.shaAntes),
    shaDepois: textoOuNulo(r.shaDepois),
    tagBackup: textoOuNulo(r.tagBackup),
    dryRun: r.dryRun === true,
    commitsDescartados: descartados
      .filter((c): c is Bruto => !!c && typeof c === 'object' && !Array.isArray(c))
      .map((c) => ({ sha: texto(c.sha), titulo: texto(c.titulo), motivo: texto(c.motivo) })),
    arquivosResolvidos: Array.isArray(r.arquivosResolvidos)
      ? r.arquivosResolvidos.filter((a): a is string => typeof a === 'string')
      : [],
    resumo: texto(r.resumo),
    log: textoOuNulo(r.log)
  }
}
