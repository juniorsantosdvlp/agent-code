import { z } from 'zod'
import { Channels, type AgentKindResult } from '../../shared/ipc'
import { classifyAgentKind, KIND_INPUT_MAX_CHARS, KIND_LIST_MAX, type ClassifyAgentKindReq } from './classifyAgentKind'

/**
 * Handler de agentKind:classify. O index.ts só chama registerAgentKindIpc com
 * o ipcMain.handle dele.
 *
 * Fronteira: o payload passa por zod (descrição string não vazia, cortada em
 * KIND_INPUT_MAX_CHARS; até KIND_LIST_MAX tipos, cada um cortado em 30) e
 * nenhuma exceção atravessa o IPC — sem tipo é `{ ok: false }`, e o renderer
 * fica com o recuo.
 */

export type KindIpcListener = (event: unknown, ...args: unknown[]) => unknown

export interface AgentKindIpcDeps {
  /** Mesmo formato de ipcMain.handle. */
  handle: (channel: string, listener: KindIpcListener) => void
  /** Para o teste; padrão: classifyAgentKind (claude-haiku-4-5). */
  classify?: (req: ClassifyAgentKindReq) => Promise<string | null>
}

/** Teto de cada tipo recebido — o mesmo do tipo normalizado. */
const EXISTING_KIND_MAX_CHARS = 30

const ClassifyKindReq = z.strictObject({
  description: z.string().transform((s) => s.slice(0, KIND_INPUT_MAX_CHARS)),
  existing: z
    .array(z.string().transform((s) => s.slice(0, EXISTING_KIND_MAX_CHARS)))
    .max(KIND_LIST_MAX)
})

export function registerAgentKindIpc(deps: AgentKindIpcDeps): void {
  const classify = deps.classify ?? ((req: ClassifyAgentKindReq) => classifyAgentKind(req))
  deps.handle(Channels.agentKindClassify, async (_event, payload): Promise<AgentKindResult> => {
    const parsed = ClassifyKindReq.safeParse(payload)
    if (!parsed.success || !parsed.data.description.trim()) return { ok: false }
    try {
      const kind = await classify(parsed.data)
      return typeof kind === 'string' && kind ? { ok: true, kind } : { ok: false }
    } catch {
      return { ok: false }
    }
  })
}
