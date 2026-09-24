import { IconBoard, IconCollapseRight, IconGlobe, IconOffice } from './Icons'

export type RightPane = 'browser' | 'board' | 'office'

interface Props {
  active: RightPane
  onSelect: (pane: RightPane) => void
  /** Collapses the whole right pane into the vertical rail. */
  onCollapse: () => void
  /** Subagents running right now — acende as abas Quadro e Escritório: o
   *  elenco inteiro (executor por cartão, po/vigia/crítico/memória por coluna)
   *  vive no Quadro, e as mesas de cada um no Escritório. */
  liveAgents: number
  /** Open preview tabs — shown as a small count on the Navegador tab. */
  browserTabs: number
  /** Progresso do quadro (concluídas/total) — `null` quando não há tarefa. */
  boardProgress: { done: number; total: number } | null
  /** Agentes da conversa aberta (nº de trilhas) — contador da aba Escritório. */
  officeAgents: number
}

/**
 * Segmented switch at the top of the right-hand pane: Navegador ⇄ Quadro ⇄
 * Escritório. A antiga aba "Agentes" foi fundida no Quadro — o elenco de quem
 * trabalha aparece como bolinhas no próprio Quadro (por cartão para o
 * executor, por cabeçalho de coluna para po/vigia/crítico/memória) — e
 * continua sem slot próprio. O Escritório NÃO é o elenco de volta: é outra
 * VISÃO dos mesmos agentes, agrupados pelo TIPO do trabalho (segurança,
 * frontend, dados…) em vez de por papel ou por cartão, para ler de relance
 * onde o time está gastando esforço.
 */
export function RightPaneTabs({
  active,
  onSelect,
  onCollapse,
  liveAgents,
  browserTabs,
  boardProgress,
  officeAgents
}: Props): JSX.Element {
  return (
    <div className="pane-tabs" role="tablist" aria-label="Painel da direita">
      <button
        type="button"
        role="tab"
        aria-selected={active === 'browser'}
        className={`pane-tab${active === 'browser' ? ' on' : ''}`}
        onClick={() => onSelect('browser')}
        title="Navegador / preview"
      >
        <IconGlobe size={14} />
        Navegador
        {browserTabs > 0 && <span className="pane-tab-count">{browserTabs}</span>}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={active === 'board'}
        className={`pane-tab${active === 'board' ? ' on' : ''}${liveAgents > 0 ? ' live' : ''}`}
        onClick={() => onSelect('board')}
        title="Quadro: as tarefas do projeto e quem está trabalhando em cada uma"
      >
        <IconBoard size={14} />
        Quadro
        {boardProgress && boardProgress.total > 0 && (
          <span className="pane-tab-count">{`${boardProgress.done}/${boardProgress.total}`}</span>
        )}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={active === 'office'}
        className={`pane-tab${active === 'office' ? ' on' : ''}${liveAgents > 0 ? ' live' : ''}`}
        onClick={() => onSelect('office')}
        title="Escritório: quem está trabalhando, agrupado por tipo"
      >
        <IconOffice size={14} />
        Escritório
        {officeAgents > 0 && <span className="pane-tab-count">{officeAgents}</span>}
      </button>
      <button type="button" className="nav-btn pane-collapse" onClick={onCollapse} title="Recolher painel">
        <IconCollapseRight />
      </button>
    </div>
  )
}
