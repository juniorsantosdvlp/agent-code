// Compares the local dev clone (C:\source\agent-code) against the fork and
// the original project, for the "Atualização" section of the Settings
// screen — and lets that screen trigger scripts/sincronizar-e-instalar-agent-code.ps1
// on demand instead of waiting for the next tick of scripts/loop-manter-atualizado.ps1.
//
// Why a hardcoded path: this whole auto-update apparatus (the PowerShell
// scripts, the Startup shortcut, this module) only exists for this one
// developer's one machine — see scripts/loop-manter-atualizado.ps1 and
// memory agent-code-fork-fluxo-de-branches. Making the path configurable
// would be complexity nobody else benefits from.
//
// Every git call is isolated: a failed fetch (offline, git missing, timeout)
// turns into `{ erro }` for just that section, never an exception that would
// blank the whole Settings screen.
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { UpdateProgress, UpdateRefStatus, UpdateStatus } from '../shared/ipc'

const REPO_PATH = 'C:\\source\\agent-code'
const GIT_TIMEOUT_MS = 15_000

function execGit(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: REPO_PATH, windowsHide: true, timeout: GIT_TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          reject(err)
          return
        }
        resolve(stdout.toString().trim())
      }
    )
  })
}

/** Fetches `remote branch`, then compares local `localRef` against it. Never throws. */
async function compararComRemoto(remote: string, branch: string, localRef: string): Promise<UpdateRefStatus> {
  try {
    await execGit(['fetch', remote, branch])
    const remoteRef = `${remote}/${branch}`
    const [sha, atras] = await Promise.all([
      execGit(['rev-parse', '--short', remoteRef]),
      execGit(['rev-list', '--count', `${localRef}..${remoteRef}`])
    ])
    const commitsAtras = Number.parseInt(atras, 10)
    return { atualizado: commitsAtras === 0, commitsAtras, sha }
  } catch (error) {
    return {
      atualizado: false,
      commitsAtras: null,
      sha: null,
      erro: error instanceof Error ? error.message : String(error)
    }
  }
}

interface EstadoAutoUpdate {
  shaInstalado?: string
  versaoInstalada?: string
  instaladoEm?: string
  shaEmpacotado?: string
  caminhoInstalador?: string
}

const ESTADO_DIR = (): string => join(process.env.LOCALAPPDATA || '', 'AgentCodeAutoUpdate')

async function lerJson<T>(caminho: string): Promise<T | null> {
  try {
    // PowerShell grava com BOM; JSON.parse rejeita.
    return JSON.parse((await readFile(caminho, 'utf8')).replace(/^﻿/, '')) as T
  } catch {
    return null
  }
}

function processoVivo(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * The script writes progresso.json while it runs and deletes it at the end;
 * a leftover file from a killed run is ignored by checking its pid. Once it
 * is gone, "ready to restart" is read from estado.json: a package built for a
 * newer SHA than the installed one.
 */
export async function lerProgressoAtualizacao(): Promise<UpdateProgress> {
  const progresso = await lerJson<{ percentual?: number; fase?: string; pid?: number }>(
    join(ESTADO_DIR(), 'progresso.json')
  )
  if (progresso?.pid && processoVivo(progresso.pid)) {
    return {
      estado: 'andamento',
      percentual: Math.max(0, Math.min(99, progresso.percentual ?? 0)),
      fase: progresso.fase ?? ''
    }
  }
  const estado = await lerJson<EstadoAutoUpdate>(join(ESTADO_DIR(), 'estado.json'))
  if (
    estado?.shaEmpacotado &&
    estado.shaEmpacotado !== estado.shaInstalado &&
    estado.caminhoInstalador &&
    (await stat(estado.caminhoInstalador).then(() => true, () => false))
  ) {
    return { estado: 'pronto', percentual: 100, fase: 'Pronta para instalar' }
  }
  return { estado: 'ocioso', percentual: 0, fase: '' }
}

/** Best-effort read of what the loop script last actually installed. Null if absent/unreadable/empty. */
async function lerEstadoInstalado(): Promise<UpdateStatus['instalado']> {
  const caminho = join(
    process.env.LOCALAPPDATA || '',
    'AgentCodeAutoUpdate',
    'estado.json'
  )
  try {
    const bruto = await readFile(caminho, 'utf8')
    // PowerShell grava o estado com BOM; JSON.parse rejeita.
    const estado = JSON.parse(bruto.replace(/^﻿/, '')) as EstadoAutoUpdate
    if (!estado.shaInstalado) return null
    return {
      sha: estado.shaInstalado,
      versao: estado.versaoInstalada || '',
      em: estado.instaladoEm || ''
    }
  } catch {
    return null
  }
}

type Historico = NonNullable<UpdateStatus['historico']>

async function lerCommitsRecentes(): Promise<Historico['commits']> {
  try {
    const saida = await execGit(['log', '-8', '--format=%h%x09%cI%x09%s', 'minha-versao'])
    return saida
      .split('\n')
      .filter(Boolean)
      .map((linha) => {
        const [sha, quando, ...resto] = linha.split('\t')
        return { sha, quando, assunto: resto.join('\t') }
      })
  } catch {
    return []
  }
}

// Só o que conta a história de uma tentativa de atualização; o resto do log
// (saída de git/npm/testes) é ruído numa tela de Configurações.
const EVENTO_RELEVANTE =
  /(sync ok|build ok|instalacao concluida|reaberto|ABORTADO|AVISO|guard indica|fechando em|pedido de reinicio)/

async function lerEventosDoLog(caminho: string): Promise<Historico['eventos']> {
  try {
    const bruto = await readFile(caminho, 'utf8')
    return bruto
      .split(/\r?\n/)
      .map((linha) => /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] (.*)$/.exec(linha))
      .filter((m): m is RegExpExecArray => m !== null && EVENTO_RELEVANTE.test(m[2]))
      .map((m) => ({ quando: m[1], texto: m[2].replace(/\s+/g, ' ').slice(0, 160) }))
  } catch {
    return []
  }
}

async function lerHistorico(): Promise<Historico> {
  const estadoDir = join(process.env.LOCALAPPDATA || '', 'AgentCodeAutoUpdate')
  const [commits, sync, relaunch] = await Promise.all([
    lerCommitsRecentes(),
    lerEventosDoLog(join(estadoDir, 'logs', 'sincronizar-build-instalar.log')),
    lerEventosDoLog(join(process.env.TEMP || '', 'agent-code-relaunch.log'))
  ])
  const eventos = [...sync, ...relaunch]
    .sort((a, b) => (a.quando < b.quando ? -1 : a.quando > b.quando ? 1 : 0))
    .slice(-12)
    .reverse()
  return { commits, eventos }
}

export async function checkUpdateStatus(appVersion: string): Promise<UpdateStatus> {
  const [instalado, fork, original, historico] = await Promise.all([
    lerEstadoInstalado(),
    compararComRemoto('origin', 'minha-versao', 'minha-versao'),
    compararComRemoto('upstream', 'main', 'main'),
    lerHistorico()
  ])
  return { appVersion, instalado, fork, original, verificadoEm: new Date().toISOString(), historico }
}

/**
 * Fires scripts/sincronizar-e-instalar-agent-code.ps1 -InstalarApp, detached —
 * same spawn pattern as armAppRelauncher (src/main/appRelauncher.ts). No
 * `-Force` by default: the script runs NOW instead of at the next 5min/3h tick
 * but still checks restart-guard.json and defers (retrying every 5min, see the
 * exit-code-20 path) if any session is busy. With `fecharAgora` it passes
 * `-Force`, closing the app even with busy sessions — a separate, confirmed
 * button in Settings, since it interrupts running agents.
 */
export async function triggerForceUpdate(
  fecharAgora = false
): Promise<{ disparado: boolean; erro?: string }> {
  const script = join(REPO_PATH, 'scripts', 'sincronizar-e-instalar-agent-code.ps1')
  // Two things learned the hard way (23/09/2026):
  //  - `spawn(..., { detached: true })` launches powershell.exe as a console-less
  //    DETACHED_PROCESS, which exits without running the script — the button
  //    "worked" (toast) but nothing happened.
  //  - the script must outlive the app (it closes and reinstalls it), so it is
  //    created through WMI (Win32_Process.Create): the new process is a child of
  //    WmiPrvSE, not of this app, and survives it being killed.
  const linhaDeComando =
    `powershell.exe -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "${script}" -InstalarApp` +
    (fecharAgora ? ' -Force' : '')
  const comando =
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create ` +
    `-Arguments @{ CommandLine = '${linhaDeComando}' }; exit [int]$r.ReturnValue`
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', comando],
      { windowsHide: true, timeout: 15_000 },
      (error) => {
        if (error) {
          resolve({ disparado: false, erro: error.message })
          return
        }
        resolve({ disparado: true })
      }
    )
  })
}
