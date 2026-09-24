import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RightPaneTabs, type RightPane } from './RightPaneTabs'

afterEach(cleanup)

function setup(over: Partial<Parameters<typeof RightPaneTabs>[0]> = {}): { onSelect: ReturnType<typeof vi.fn> } {
  const onSelect = vi.fn()
  render(
    <RightPaneTabs
      active="browser"
      onSelect={onSelect}
      onCollapse={() => undefined}
      liveAgents={0}
      browserTabs={0}
      boardProgress={null}
      officeAgents={0}
      {...over}
    />
  )
  return { onSelect }
}

describe('RightPaneTabs', () => {
  it('tem as três abas na ordem Navegador, Quadro, Escritório', () => {
    setup()
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Navegador', 'Quadro', 'Escritório'])
  })

  it('a aba Escritório é selecionável', () => {
    const { onSelect } = setup()
    const tab = screen.getByRole('tab', { name: /Escritório/ })
    expect(tab.getAttribute('title')).toBe('Escritório: quem está trabalhando, agrupado por tipo')
    fireEvent.click(tab)
    expect(onSelect).toHaveBeenCalledWith('office' satisfies RightPane)
  })

  it('marca a aba ativa com aria-selected e .on', () => {
    setup({ active: 'office' })
    const office = screen.getByRole('tab', { name: /Escritório/ })
    expect(office.getAttribute('aria-selected')).toBe('true')
    expect(office.className).toContain('on')
    expect(screen.getByRole('tab', { name: /Quadro/ }).getAttribute('aria-selected')).toBe('false')
  })

  it('mostra o nº de agentes da conversa só quando há algum', () => {
    setup({ officeAgents: 3 })
    expect(screen.getByRole('tab', { name: /Escritório/ }).textContent).toBe('Escritório3')
    cleanup()
    setup({ officeAgents: 0 })
    expect(screen.getByRole('tab', { name: /Escritório/ }).querySelector('.pane-tab-count')).toBeNull()
  })

  it('acende (live) quando há subagente rodando', () => {
    setup({ liveAgents: 1 })
    expect(screen.getByRole('tab', { name: /Escritório/ }).className).toContain('live')
  })

  it('Quadro e Navegador continuam selecionáveis', () => {
    const { onSelect } = setup({ active: 'office' })
    fireEvent.click(screen.getByRole('tab', { name: /Quadro/ }))
    fireEvent.click(screen.getByRole('tab', { name: /Navegador/ }))
    expect(onSelect.mock.calls.map((c) => c[0])).toEqual(['board', 'browser'])
  })
})
