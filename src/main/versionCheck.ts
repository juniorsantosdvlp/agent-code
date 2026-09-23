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
import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { UpdateRefStatus, UpdateStatus } from '../shared/ipc'

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
    const estado = JSON.parse(bruto) as EstadoAutoUpdate
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

export async function checkUpdateStatus(appVersion: string): Promise<UpdateStatus> {
  const [instalado, fork, original] = await Promise.all([
    lerEstadoInstalado(),
    compararComRemoto('origin', 'minha-versao', 'minha-versao'),
    compararComRemoto('upstream', 'main', 'main')
  ])
  return { appVersion, instalado, fork, original, verificadoEm: new Date().toISOString() }
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
  try {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-InstalarApp',
        ...(fecharAgora ? ['-Force'] : [])
      ],
      { detached: true, stdio: 'ignore', windowsHide: true }
    )
    let falhou: Error | undefined
    child.on('error', (error) => {
      falhou = error
    })
    child.unref()
    // Give the spawn a beat to fail fast (missing powershell.exe, etc.) before
    // we report success — anything after this point is the script's own job.
    await new Promise((resolve) => setTimeout(resolve, 200))
    if (falhou) return { disparado: false, erro: falhou.message }
    return { disparado: true }
  } catch (error) {
    return { disparado: false, erro: error instanceof Error ? error.message : String(error) }
  }
}
