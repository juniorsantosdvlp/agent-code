/**
 * O TIPO de domínio de um agente — "segurança", "frontend", "dados" — que o
 * Escritório usa para juntar mesas em ilhas.
 *
 * Não confundir com o `subagentType` do SDK (`Explore`, `executor`…): aquele
 * diz QUEM foi chamado, este diz SOBRE O QUÊ ele está trabalhando. O valor vem
 * de um modelo classificando a delegação, então chega sujo — com acento, caixa
 * trocada, aspas, markdown, "Tipo: …" na frente. Tudo passa por aqui antes de
 * virar chave de agrupamento: "Segurança" e "seguranca" têm que cair na MESMA
 * ilha, senão o usuário vê duas ilhas iguais lado a lado.
 *
 * Módulo puro e compartilhado (main e renderer), sem dependência nenhuma.
 */

/** Para onde vai tudo que não tem tipo reconhecível — nunca fica sem ilha. */
export const FALLBACK_KIND = 'outros'

/** Os tipos que o app sugere de saída, já normalizados e na ordem das ilhas. */
export const DEFAULT_KINDS: readonly string[] = [
  'arquitetura',
  'seguranca',
  'frontend',
  'dados',
  'testes',
  'outros'
]

/** Teto do tipo normalizado: é chave e rótulo de ilha, não uma frase. */
const MAX_KIND_LENGTH = 30

/** Sinônimos de "sem tipo" — o modelo responde em inglês às vezes. */
const FALLBACK_ALIASES = new Set(['outro', 'outros', 'other', 'others'])

/** Rótulo com acento para os tipos que o app conhece. `Map`, não objeto: o
 *  tipo vem do modelo, e "constructor" não pode achar um rótulo no protótipo. */
const KNOWN_LABELS = new Map<string, string>([
  ['arquitetura', 'Arquitetura'],
  ['seguranca', 'Segurança'],
  ['frontend', 'Frontend'],
  ['dados', 'Dados'],
  ['testes', 'Testes'],
  ['outros', 'Outros'],
  ['principal', 'Principal']
])

/** Aspas, pontuação e espaço nas PONTAS ("  Arquitetura. ", "'dados'"). */
const EDGE_NOISE = /^[\s"'`´“”‘’«».,;:!?()[\]{}*#>-]+|[\s"'`´“”‘’«».,;:!?()[\]{}*#>-]+$/g
/** "tipo:", "kind =" e afins na frente do valor. */
const KIND_PREFIX = /^(?:tipo|kind)\s*[:=]\s*/

/**
 * Chave canônica do tipo: minúscula, sem acento, palavras unidas por '-', só
 * `[a-z0-9-]`, até 30 caracteres. Qualquer coisa que não seja string, ou que
 * fique vazia depois da limpeza, vira `null` — quem chama decide o fallback.
 */
export function normalizeKind(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let s = raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    // NFD separa "ç" em "c" + cedilha; `\p{M}` apaga todas as marcas soltas.
    .replace(/\p{M}/gu, '')
  s = s.replace(EDGE_NOISE, '').replace(KIND_PREFIX, '').replace(EDGE_NOISE, '')
  s = s
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  // Cortar pode deixar um '-' pendurado no fim ("infra-estrutura-de-" …).
  s = s.slice(0, MAX_KIND_LENGTH).replace(/-+$/g, '')
  if (!s) return null
  return FALLBACK_ALIASES.has(s) ? FALLBACK_KIND : s
}

/**
 * Lê o tipo da resposta do classificador. Só a primeira linha com conteúdo
 * conta — modelo gosta de explicar a escolha logo abaixo — e ela vem limpa de
 * marcador de lista, negrito, crases, aspas e do "Tipo:" antes do valor.
 */
export function parseKindReply(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const first = raw.split(/\r?\n/).find((l) => l.trim().length > 0)
  if (!first) return null
  const clean = first
    .replace(/[`*~]/g, '')
    .replace(/^\s*(?:#+|>+|[-+•]|\d+[.)])\s+/, '')
    .replace(/["“”«»]/g, '')
    .trim()
    .replace(/^(?:tipo|kind)\s*[:=]\s*/i, '')
  return normalizeKind(clean)
}

/** Rótulo de exibição: com acento para os conhecidos, capitalizado para o resto. */
export function kindLabel(kind: string): string {
  const known = KNOWN_LABELS.get(kind)
  if (known) return known
  const spaced = kind.replace(/-/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * União normalizada de várias listas de tipos, sem duplicata. Os de
 * `DEFAULT_KINDS` presentes vêm primeiro, na ordem de lá; o resto segue na
 * ordem em que apareceu — a lista não pode embaralhar a cada chamada.
 */
export function mergeKinds(...lists: Array<Iterable<string>>): string[] {
  const seen = new Set<string>()
  for (const list of lists) {
    for (const raw of list) {
      const k = normalizeKind(raw)
      if (k) seen.add(k)
    }
  }
  const defaults = DEFAULT_KINDS.filter((k) => seen.has(k))
  const rest = [...seen].filter((k) => !DEFAULT_KINDS.includes(k))
  return [...defaults, ...rest]
}
