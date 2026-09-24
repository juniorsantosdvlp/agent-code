import { useEffect } from 'react'
import type { AgentTrack, TrackStep } from '../agentTracks'
import type { CrewState } from '../crew'
import type { OfficeDesk } from '../office'
import { CodeBlock, extToLang } from './CodeBlock'

/**
 * O painel de detalhe do Escritório: quem é o agente da mesa selecionada e o
 * que ele fez, passo a passo, com o código destacado. Somente leitura — o
 * painel mostra o trabalho, não interfere nele.
 */

export const STATE_TEXT: Record<CrewState, string> = {
  idle: 'parado',
  working: 'trabalhando',
  asking: 'aguardando você',
  failed: 'falhou'
}

/** Um trecho de código da entrada de um passo, com rótulo opcional. */
interface InputPart {
  label?: string
  code: string
  language?: string
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function json(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? String(v)
  } catch {
    return String(v)
  }
}

/**
 * Entrada de um passo em pedaços legíveis. Edição de arquivo mostra o caminho e
 * os trechos com a linguagem do arquivo (extensão desconhecida cai na detecção
 * automática do highlight.js); Bash mostra o comando; o resto é o JSON cru,
 * indentado.
 */
export function formatStepInput(name: string, input: unknown): { path?: string; parts: InputPart[] } {
  const i = asRecord(input)
  const path = str(i.file_path)
  const lang = path ? extToLang(path) || undefined : undefined

  if (name === 'Edit' && path) {
    const parts: InputPart[] = []
    const oldS = str(i.old_string)
    const newS = str(i.new_string)
    if (oldS !== undefined) parts.push({ label: 'antes', code: oldS, language: lang })
    if (newS !== undefined) parts.push({ label: 'depois', code: newS, language: lang })
    return { path, parts }
  }
  if (name === 'MultiEdit' && path) {
    const edits = Array.isArray(i.edits) ? i.edits : []
    const parts: InputPart[] = []
    edits.forEach((e, n) => {
      const r = asRecord(e)
      const oldS = str(r.old_string)
      const newS = str(r.new_string)
      if (oldS !== undefined) parts.push({ label: `edição ${n + 1} · antes`, code: oldS, language: lang })
      if (newS !== undefined) parts.push({ label: `edição ${n + 1} · depois`, code: newS, language: lang })
    })
    return { path, parts }
  }
  if (name === 'Write' && path) {
    const content = str(i.content)
    return { path, parts: content === undefined ? [] : [{ code: content, language: lang }] }
  }
  if (name === 'Bash') {
    const command = str(i.command)
    if (command !== undefined) return { parts: [{ code: command, language: 'bash' }] }
  }
  return { parts: [{ code: json(input), language: 'json' }] }
}

function StepItem({ step, n }: { step: TrackStep; n: number }): JSX.Element {
  const { path, parts } = formatStepInput(step.name, step.input)
  const running = step.endedAt === undefined
  return (
    <li className={`office-step${step.isError ? ' is-error' : ''}`}>
      <div className="office-step-head">
        <span className="office-step-n">{n}</span>
        <span className="office-step-tool">{step.name}</span>
        {path && <span className="office-step-path" title={path}>{path}</span>}
        {running && <span className="office-step-live">em andamento</span>}
      </div>
      {parts.map((p, k) => (
        <div key={k} className="office-step-part">
          {p.label && <div className="office-step-label">{p.label}</div>}
          <CodeBlock code={p.code} language={p.language} />
        </div>
      ))}
      {step.result !== undefined && (
        <div className={`office-step-result${step.isError ? ' is-error' : ''}`}>
          <div className="office-step-label">{step.isError ? 'erro' : 'resultado'}</div>
          <pre>{step.result || '(vazio)'}</pre>
        </div>
      )}
    </li>
  )
}

export function AgentOfficeDetail({
  desk,
  track,
  onClose
}: {
  desk: OfficeDesk
  track?: AgentTrack
  onClose: () => void
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const steps = track?.steps ?? []
  const hidden = Math.max(0, desk.stepCount - steps.length)

  return (
    <aside className={`office-detail state-${desk.state}`} aria-label={`Detalhe de ${desk.name}`}>
      <header className="office-detail-head">
        <div className="office-detail-title">
          <strong>{desk.name}</strong>
          <span className={`office-detail-state state-${desk.state}`}>{STATE_TEXT[desk.state]}</span>
          {desk.trackId && (
            <span className="office-detail-count">
              {desk.stepCount} {desk.stepCount === 1 ? 'passo' : 'passos'}
            </span>
          )}
        </div>
        <button type="button" className="office-detail-close" onClick={onClose} aria-label="Fechar detalhe">
          ×
        </button>
      </header>
      {desk.label && <p className="office-detail-label">{desk.label}</p>}

      {desk.trackId ? (
        steps.length > 0 ? (
          <>
            {hidden > 0 && (
              <p className="office-detail-note">
                {hidden} {hidden === 1 ? 'passo anterior não aparece' : 'passos anteriores não aparecem'} aqui.
              </p>
            )}
            <ol className="office-steps">
              {steps.map((s, k) => (
                <StepItem key={s.id} step={s} n={hidden + k + 1} />
              ))}
            </ol>
          </>
        ) : (
          <p className="office-detail-note">Nenhum passo registrado ainda.</p>
        )
      ) : null}
    </aside>
  )
}
