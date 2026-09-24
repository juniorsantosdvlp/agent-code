import { useEffect, useState } from 'react'
import type { UpdateProgress } from '../../../shared/ipc'
import { useUI } from '../ui/UiProvider'

// Item discreto de "barra de status" no canto inferior direito, como o aviso de
// atualização das IDEs: some quando não há nada acontecendo, mostra a barra de
// progresso enquanto sincronizar-e-instalar-agent-code.ps1 roda e, com o
// pacote novo pronto, vira o botão "Reiniciar e atualizar".

const INTERVALO_MS = 3000

export function IndicadorAtualizacao(): JSX.Element | null {
  const { confirm, notify } = useUI()
  const [progresso, setProgresso] = useState<UpdateProgress | null>(null)
  const [reiniciando, setReiniciando] = useState(false)

  useEffect(() => {
    if (typeof window.api?.getUpdateProgress !== 'function') return
    let vivo = true
    const ler = (): void => {
      window.api.getUpdateProgress().then(
        (p) => vivo && setProgresso(p),
        () => undefined
      )
    }
    ler()
    const id = window.setInterval(ler, INTERVALO_MS)
    return () => {
      vivo = false
      window.clearInterval(id)
    }
  }, [])

  if (!progresso || progresso.estado === 'ocioso') return null

  const reiniciar = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Reiniciar e atualizar?',
      message:
        'O Agent Code fecha agora, instala a versão nova e reabre sozinho. Agentes trabalhando nas conversas são interrompidos.',
      confirmLabel: 'Reiniciar e atualizar',
      danger: true
    })
    if (!ok) return
    setReiniciando(true)
    const { disparado, erro } = await window.api.forceUpdate(true)
    if (!disparado) {
      setReiniciando(false)
      notify('erro', `Não consegui reiniciar para atualizar: ${erro || 'erro desconhecido'}.`)
    }
  }

  if (progresso.estado === 'pronto') {
    return (
      <div className="indicador-atualizacao pronto">
        <button type="button" onClick={() => void reiniciar()} disabled={reiniciando}>
          <span className="ponto" aria-hidden="true" />
          {reiniciando ? 'Reiniciando…' : 'Reiniciar e atualizar'}
        </button>
      </div>
    )
  }

  return (
    <div
      className="indicador-atualizacao"
      role="progressbar"
      aria-label="Atualização do Agent Code"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progresso.percentual}
      title={`Atualizando o Agent Code — ${progresso.fase}`}
    >
      <span className="rotulo">Atualizando {progresso.percentual}%</span>
      <span className="trilho">
        <span className="preenchido" style={{ width: `${progresso.percentual}%` }} />
      </span>
    </div>
  )
}
