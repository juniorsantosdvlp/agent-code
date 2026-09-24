import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdateProgress } from '../../../shared/ipc'
import { UiProvider } from '../ui/UiProvider'
import { IndicadorAtualizacao } from './IndicadorAtualizacao'

function montar(progresso: UpdateProgress, forceUpdate = vi.fn(async () => ({ disparado: true }))) {
  ;(window as unknown as { api: unknown }).api = {
    getUpdateProgress: vi.fn(async () => progresso),
    forceUpdate
  }
  render(
    <UiProvider>
      <IndicadorAtualizacao />
    </UiProvider>
  )
  return forceUpdate
}

describe('IndicadorAtualizacao', () => {
  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  it('não mostra nada sem atualização acontecendo', async () => {
    montar({ estado: 'ocioso', percentual: 0, fase: '' })
    await waitFor(() => expect(window.api.getUpdateProgress).toHaveBeenCalled())
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.queryByRole('button', { name: /reiniciar/i })).toBeNull()
  })

  it('mostra a barra com o percentual enquanto atualiza', async () => {
    montar({ estado: 'andamento', percentual: 32, fase: 'Rodando os testes' })
    const barra = await screen.findByRole('progressbar')
    expect(barra.getAttribute('aria-valuenow')).toBe('32')
    expect(barra.textContent).toContain('32%')
  })

  it('com o pacote pronto, o botão confirma e reinicia forçando', async () => {
    const forceUpdate = montar({ estado: 'pronto', percentual: 100, fase: 'Pronta para instalar' })
    fireEvent.click(await screen.findByRole('button', { name: 'Reiniciar e atualizar' }))
    const confirmar = await screen.findAllByRole('button', { name: 'Reiniciar e atualizar' })
    fireEvent.click(confirmar[confirmar.length - 1])
    await waitFor(() => expect(forceUpdate).toHaveBeenCalledWith(true))
  })
})
