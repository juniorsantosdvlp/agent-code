import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { UiProvider } from '../ui/UiProvider'
import { Sidebar } from './Sidebar'
import type { Conversation } from '../types'

// Seção "Chats" recolhível (lembrada no localStorage) e o limite da barra
// lateral acima do desenho do agente secreto.

const CHAVE = 'agentcode.sidebar.chatsCollapsed'

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  localStorage.clear()
})

function conv(id: string, title: string): Conversation {
  return {
    id,
    title,
    cwd: 'C:/proj/meu-app',
    model: 'claude-opus-4-8',
    sdkSessionId: null,
    messages: [],
    tokens: { context: 0, output: 0, cost: 0 },
    createdAt: 1,
    updatedAt: 2
  }
}

const RECENTES = [conv('a', 'Relatório de vendas'), conv('b', 'Ajuste do instalador'), conv('c', 'Planilha de estoque')]

function renderSidebar(): void {
  render(
    <UiProvider>
      <Sidebar
        collapsed={false}
        onToggleCollapse={() => {}}
        projects={[]}
        recents={RECENTES}
        activeId={null}
        busyIds={new Set()}
        onSelect={() => {}}
        onNewChat={() => {}}
        onNewProject={() => {}}
        onNewChatIn={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        onSelectResult={() => {}}
      />
    </UiProvider>
  )
}

const cabecalho = (): HTMLElement => screen.getByRole('button', { name: /chats/i })

describe('Sidebar — seção Chats recolhível', () => {
  it('abre expandida por padrão, com o cabeçalho como botão aria-expanded', () => {
    renderSidebar()
    expect(cabecalho().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Relatório de vendas')).toBeTruthy()
    expect(cabecalho().querySelector('.caret.open')).not.toBeNull()
  })

  it('clicar recolhe a lista e mostra a contagem; clicar de novo expande', () => {
    renderSidebar()
    fireEvent.click(cabecalho())
    expect(cabecalho().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Relatório de vendas')).toBeNull()
    expect(cabecalho().querySelector('.side-section-count')?.textContent).toBe('3')

    fireEvent.click(cabecalho())
    expect(cabecalho().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Relatório de vendas')).toBeTruthy()
    expect(cabecalho().querySelector('.side-section-count')).toBeNull()
  })

  it('lembra o estado entre sessões (grava e relê do localStorage)', () => {
    renderSidebar()
    fireEvent.click(cabecalho())
    expect(localStorage.getItem(CHAVE)).toBe('1')

    // "Nova sessão": desmonta e monta de novo — volta recolhida.
    cleanup()
    renderSidebar()
    expect(cabecalho().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Planilha de estoque')).toBeNull()

    fireEvent.click(cabecalho())
    expect(localStorage.getItem(CHAVE)).toBe('0')
  })

  it('com busca ativa a lista aparece mesmo recolhida, e some ao limpar a busca', () => {
    localStorage.setItem(CHAVE, '1')
    renderSidebar()
    expect(screen.queryByText('Ajuste do instalador')).toBeNull()

    const busca = screen.getByPlaceholderText('Buscar conversas ou projetos…')
    fireEvent.change(busca, { target: { value: 'instalador' } })
    expect(cabecalho().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Ajuste do instalador')).toBeTruthy()
    expect(screen.queryByText('Relatório de vendas')).toBeNull()

    fireEvent.change(busca, { target: { value: '' } })
    expect(cabecalho().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Ajuste do instalador')).toBeNull()
    // A busca não mexe no que ficou gravado.
    expect(localStorage.getItem(CHAVE)).toBe('1')
  })
})

describe('Sidebar — limite acima do agente secreto', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
  const regra = (seletor: string): string => {
    const m = css.match(new RegExp(`(?:^|\\n)${seletor.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`))
    if (!m) throw new Error(`regra ${seletor} não encontrada`)
    return m[1]
  }

  it('a reserva sai da altura e do recuo do desenho, mais uma folga', () => {
    expect(css).toMatch(
      /--agente-secreto-reserva:\s*calc\(var\(--agente-secreto-altura\) \+ var\(--agente-secreto-margem\) \+ 12px\)/
    )
    const agente = regra('.agente-secreto')
    expect(agente).toMatch(/height:\s*var\(--agente-secreto-altura\)/)
    expect(agente).toMatch(/bottom:\s*var\(--agente-secreto-margem\)/)
    expect(agente).toMatch(/width:\s*var\(--agente-secreto-largura\)/)
  })

  it('as variáveis batem com LARGURA/ALTURA do componente', () => {
    const tsx = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/AgenteSecreto.tsx'), 'utf8')
    const largura = tsx.match(/const LARGURA = (\d+)/)?.[1]
    const altura = tsx.match(/const ALTURA = (\d+)/)?.[1]
    expect(css).toContain(`--agente-secreto-largura: ${largura}px;`)
    expect(css).toContain(`--agente-secreto-altura: ${altura}px;`)
  })

  it('a rolagem da barra aberta e o trilho da recolhida terminam acima do desenho', () => {
    expect(regra('.sidebar-scroll')).toMatch(/margin-bottom:\s*var\(--agente-secreto-reserva\)/)
    expect(regra('.rail-projects')).toMatch(/margin-bottom:\s*var\(--agente-secreto-reserva\)/)
  })
})
