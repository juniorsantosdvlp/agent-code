import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  DEFAULT_CONFIG,
  DEFAULT_CONFLICT_RESOLVER_CONFIG,
  type AppConfig,
  type ConflictResolutionReport,
  type ConflictResolverConfig
} from '@shared/ipc'
import { usePlanningModel } from '../planning/usePlanningModel'
import { SettingsModal } from './SettingsModal'
import { UiProvider } from './UiProvider'

function stubApi(config: AppConfig): Record<string, ReturnType<typeof vi.fn>> {
  const api = {
    getConfig: vi.fn(async (): Promise<AppConfig> => config),
    setConfig: vi.fn(async () => {}),
    getCacheInfo: vi.fn(async () => ({ dir: 'C:/dados', dbPath: 'C:/dados/app.db' })),
    getAppVersion: vi.fn(async () => '0.0.0'),
    getChromeBridgeStatus: vi.fn(async () => ({
      listening: false,
      port: null,
      connected: false,
      extensionVersion: null,
      userAgent: null
    })),
    onChromeControlChanged: vi.fn(() => () => {}),
    onChromeBridgeStatusChanged: vi.fn(() => () => {}),
    checkUpdateStatus: vi.fn(async () => ({
      appVersion: '0.0.0',
      instalado: null,
      fork: { atualizado: true, commitsAtras: 0, sha: 'abc123' },
      original: { atualizado: true, commitsAtras: 0, sha: 'abc123' },
      verificadoEm: new Date().toISOString()
    })),
    forceUpdate: vi.fn(async () => ({ disparado: true })),
    getUpdateProgress: vi.fn(async () => ({ estado: 'ocioso', percentual: 0, fase: '' })),
    getConflictResolverConfig: vi.fn(async (): Promise<ConflictResolverConfig> => ({ ...DEFAULT_CONFLICT_RESOLVER_CONFIG })),
    setConflictResolverConfig: vi.fn(
      async (patch: Partial<ConflictResolverConfig>): Promise<ConflictResolverConfig> => ({
        ...DEFAULT_CONFLICT_RESOLVER_CONFIG,
        ...patch
      })
    ),
    getLastConflictResolution: vi.fn(async (): Promise<ConflictResolutionReport | null> => null),
    openInFolder: vi.fn(async () => ({ ok: true, message: '' })),
    codexStatus: vi.fn(async () => ({ connected: false }))
  }
  ;(window as unknown as { api: unknown }).api = api
  return api as unknown as Record<string, ReturnType<typeof vi.fn>>
}

const view = async (): Promise<void> => {
  await act(async () => {
    render(
      <UiProvider>
        <SettingsModal
          onClose={() => undefined}
          skipPerms={false}
          onToggleSkipPerms={() => undefined}
          windowsControlEnabled={false}
          onToggleWindowsControl={() => undefined}
        />
      </UiProvider>
    )
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Configurações → Geral: Planejamento', () => {
  it('o modelo do Agent Manager saiu daqui — é trocado no próprio chat de planejamento', async () => {
    stubApi({ ...DEFAULT_CONFIG })
    await view()
    await waitFor(() => expect(screen.getAllByRole('button').length).toBeGreaterThan(0))
    expect(screen.queryByLabelText('Modelo do Agent Manager')).toBeNull()
    expect(screen.queryByLabelText('Esforço do Agent Manager')).toBeNull()
  })
})

// Incidente: com o banco offline a leitura falhava, a tela liberava os padrões
// (keys vazias) e cada interruptor mandava o grupo inteiro — apagando a key real.
describe('Configurações: leitura que falha e gravação só do campo alterado', () => {
  const typeSafeToggle = (): HTMLInputElement =>
    screen.getByText(/TypeSafe — decisões rápidas/).closest('label')!.querySelector('input')!

  it('getConfig rejeita: aviso + Tentar de novo, controles travados, nada é gravado; retry habilita', async () => {
    const config = { ...DEFAULT_CONFIG, typesafe: { ...DEFAULT_CONFIG.typesafe, apiKey: 'ts-real' } }
    const api = stubApi(config)
    // Toda leitura falha (a seção do Chrome também lê a config) até o banco voltar.
    api.getConfig.mockRejectedValue(new Error('Storage autoritativo offline.'))
    await view()

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Storage autoritativo offline.')
    expect(typeSafeToggle().matches(':disabled')).toBe(true)
    expect((screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(typeSafeToggle())
    expect(api.setConfig).not.toHaveBeenCalled()

    api.getConfig.mockResolvedValue(config)
    await act(async () => {
      fireEvent.click(screen.getByText('Tentar de novo'))
    })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(typeSafeToggle().matches(':disabled')).toBe(false)
    expect((screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('o interruptor do TypeSafe grava só {typesafe:{enabled}}, sem a apiKey', async () => {
    const api = stubApi({ ...DEFAULT_CONFIG, typesafe: { ...DEFAULT_CONFIG.typesafe, apiKey: 'ts-real' } })
    await view()
    await waitFor(() => expect(typeSafeToggle().matches(':disabled')).toBe(false))

    fireEvent.click(typeSafeToggle())
    expect(api.setConfig).toHaveBeenLastCalledWith({ typesafe: { enabled: true } })
  })

  it('a key do TypeSafe grava só {typesafe:{apiKey}} ao sair do campo', async () => {
    const api = stubApi({ ...DEFAULT_CONFIG, typesafe: { ...DEFAULT_CONFIG.typesafe, enabled: true } })
    await view()
    const input = await screen.findByPlaceholderText('Cole a key de typesafe.ai')
    await waitFor(() => expect(input.matches(':disabled')).toBe(false))

    fireEvent.change(input, { target: { value: ' ts-nova ' } })
    fireEvent.blur(input)
    expect(api.setConfig).toHaveBeenLastCalledWith({ typesafe: { apiKey: 'ts-nova' } })
  })
})

describe('Configurações → Atualização: resolvedor de conflitos', () => {
  const resolverToggle = (): HTMLInputElement =>
    screen.getByText('Resolver conflitos da atualização com um agente').closest('label')!.querySelector('input')!

  const relatorio = (extra: Partial<ConflictResolutionReport> = {}): ConflictResolutionReport => ({
    em: '2026-10-05T12:00:00Z',
    resultado: 'resolvido',
    metodo: 'agente',
    politica: 'descartar-e-avisar',
    motivo: 'Conflito em SettingsModal.tsx juntado pelo agente.',
    shaBase: 'aaa',
    shaAntes: 'bbb',
    shaDepois: 'ccc',
    tagBackup: null,
    dryRun: false,
    commitsDescartados: [],
    arquivosResolvidos: [],
    resumo: '',
    log: null,
    ...extra
  })

  it('o switch grava só {ativo} e esconde o seletor de política ao desligar', async () => {
    const api = stubApi({ ...DEFAULT_CONFIG })
    await view()
    await waitFor(() => expect(resolverToggle().matches(':disabled')).toBe(false))
    expect(resolverToggle().checked).toBe(true)
    expect(screen.getByLabelText('Quando um commit seu foi refeito pelo original')).toBeTruthy()

    await act(async () => {
      fireEvent.click(resolverToggle())
    })
    expect(api.setConflictResolverConfig).toHaveBeenLastCalledWith({ ativo: false })
    expect(resolverToggle().checked).toBe(false)
    expect(screen.queryByLabelText('Quando um commit seu foi refeito pelo original')).toBeNull()
  })

  it('o seletor grava a política escolhida', async () => {
    const api = stubApi({ ...DEFAULT_CONFIG })
    await view()
    const select = (await screen.findByLabelText('Quando um commit seu foi refeito pelo original')) as HTMLSelectElement
    await waitFor(() => expect(select.matches(':disabled')).toBe(false))
    expect(select.value).toBe('nunca-descartar')

    await act(async () => {
      fireEvent.change(select, { target: { value: 'descartar-e-avisar' } })
    })
    expect(api.setConflictResolverConfig).toHaveBeenLastCalledWith({ politicaCommitSuperado: 'descartar-e-avisar' })
    expect(select.value).toBe('descartar-e-avisar')
  })

  it('se o main recusar a gravação, o switch volta e aparece o erro', async () => {
    const api = stubApi({ ...DEFAULT_CONFIG })
    api.setConflictResolverConfig.mockRejectedValue(new Error('Disponível só no Windows.'))
    await view()
    await waitFor(() => expect(resolverToggle().matches(':disabled')).toBe(false))

    await act(async () => {
      fireEvent.click(resolverToggle())
    })
    expect(resolverToggle().checked).toBe(true)
    expect(await screen.findByText(/Disponível só no Windows\./)).toBeTruthy()
  })

  it('config ilegível: o switch fica travado e nada é gravado', async () => {
    const api = stubApi({ ...DEFAULT_CONFIG })
    api.getConflictResolverConfig.mockRejectedValue(new Error('falhou'))
    await view()
    await waitFor(() => expect(screen.getByText('Nenhum conflito precisou de agente até agora.')).toBeTruthy())
    expect(resolverToggle().disabled).toBe(true)
    fireEvent.click(resolverToggle())
    expect(api.setConflictResolverConfig).not.toHaveBeenCalled()
  })

  it('sem relatório: texto discreto', async () => {
    stubApi({ ...DEFAULT_CONFIG })
    await view()
    expect(await screen.findByText('Nenhum conflito precisou de agente até agora.')).toBeTruthy()
  })

  it('relatório com commits descartados: lista em destaque com título, sha curto, motivo e a tag de backup', async () => {
    const api = stubApi({ ...DEFAULT_CONFIG })
    api.getLastConflictResolution.mockResolvedValue(
      relatorio({
        commitsDescartados: [
          { sha: '0123456789abcdef', titulo: 'Botão de ignorar', motivo: 'O original fez a mesma coisa em abc999.' }
        ],
        tagBackup: 'backup/minha-versao-20261005',
        log: 'C:\\logs\\resolucao.log'
      })
    )
    await view()

    const destaque = await screen.findByRole('note')
    expect(destaque.textContent).toContain('1 commit seu foi descartado')
    expect(destaque.textContent).toContain('Botão de ignorar')
    expect(destaque.textContent).toContain('0123456')
    expect(destaque.textContent).not.toContain('0123456789abcdef')
    expect(destaque.textContent).toContain('O original fez a mesma coisa em abc999.')
    expect(destaque.textContent).toContain('backup/minha-versao-20261005')
    expect(screen.getByText(/Resolvido · .* · agente do Claude/)).toBeTruthy()
    expect(screen.getByText('Conflito em SettingsModal.tsx juntado pelo agente.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Abrir log' }))
    expect(api.openInFolder).toHaveBeenCalledWith('C:\\logs\\resolucao.log')
  })

  it('relatório que falhou mostra o rótulo e o motivo, sem bloco de descartados', async () => {
    const api = stubApi({ ...DEFAULT_CONFIG })
    api.getLastConflictResolution.mockResolvedValue(
      relatorio({ resultado: 'falhou', metodo: null, motivo: 'O agente não terminou em 40 minutos.' })
    )
    await view()
    expect(await screen.findByText(/Não resolvido — atualização parada/)).toBeTruthy()
    expect(screen.getByText('O agente não terminou em 40 minutos.')).toBeTruthy()
    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Abrir log' })).toBeNull()
  })
})

describe('usePlanningModel — o seletor do chat de planejamento', () => {
  function Probe(): JSX.Element {
    const { config, setModel, setEffort } = usePlanningModel()
    return (
      <div>
        <span data-testid="cfg">{`${config.model}|${config.effort}`}</span>
        <button type="button" onClick={() => setModel('claude-sonnet-5-5')}>sonnet</button>
        <button type="button" onClick={() => setEffort('xhigh')}>xhigh</button>
      </div>
    )
  }

  it('lê a config salva e grava modelo e esforço pelo setConfig', async () => {
    const api = stubApi({ ...DEFAULT_CONFIG, planning: { model: 'auto', effort: 'medium' } })
    render(<Probe />)
    await waitFor(() => expect(api.getConfig).toHaveBeenCalled())
    expect(screen.getByTestId('cfg').textContent).toBe('auto|medium')

    fireEvent.click(screen.getByText('sonnet'))
    expect(api.setConfig).toHaveBeenLastCalledWith({ planning: { model: 'claude-sonnet-5-5', effort: 'medium' } })
    fireEvent.click(screen.getByText('xhigh'))
    expect(api.setConfig).toHaveBeenLastCalledWith({ planning: { model: 'claude-sonnet-5-5', effort: 'xhigh' } })
    expect(screen.getByTestId('cfg').textContent).toBe('claude-sonnet-5-5|xhigh')
  })
})
