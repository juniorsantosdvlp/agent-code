import { describe, it, expect } from 'vitest'
import {
  DEFAULT_KINDS,
  FALLBACK_KIND,
  kindLabel,
  mergeKinds,
  normalizeKind,
  parseKindReply
} from './agentKind'

describe('normalizeKind', () => {
  it('com e sem acento caem na MESMA chave', () => {
    expect(normalizeKind('Segurança')).toBe('seguranca')
    expect(normalizeKind('seguranca')).toBe('seguranca')
    expect(normalizeKind('SEGURANÇA')).toBe(normalizeKind('segurança'))
  })

  it('limpa espaço e pontuação das pontas', () => {
    expect(normalizeKind('  Arquitetura. ')).toBe('arquitetura')
    expect(normalizeKind('"dados"')).toBe('dados')
    expect(normalizeKind("'testes'!")).toBe('testes')
  })

  it('palavras internas viram hífen, sem hífen repetido', () => {
    expect(normalizeKind('Infra Estrutura')).toBe('infra-estrutura')
    expect(normalizeKind('infra_estrutura')).toBe('infra-estrutura')
    expect(normalizeKind('infra -  _ estrutura')).toBe('infra-estrutura')
  })

  it('tira o prefixo "tipo:" / "kind:"', () => {
    expect(normalizeKind('Tipo: Frontend')).toBe('frontend')
    expect(normalizeKind('kind = dados')).toBe('dados')
  })

  it('só [a-z0-9-] e no máximo 30 caracteres', () => {
    expect(normalizeKind('front/end@2')).toBe('frontend2')
    const long = normalizeKind('a'.repeat(50))
    expect(long).toHaveLength(30)
    // Corte que cairia num hífen não deixa hífen pendurado.
    expect(normalizeKind(`${'a'.repeat(29)} bbb`)).toBe('a'.repeat(29))
  })

  it('vazio ou não-string vira null', () => {
    expect(normalizeKind('')).toBeNull()
    expect(normalizeKind('   ')).toBeNull()
    expect(normalizeKind('...')).toBeNull()
    expect(normalizeKind(undefined)).toBeNull()
    expect(normalizeKind(42)).toBeNull()
  })

  it('sinônimos de "outros" viram FALLBACK_KIND', () => {
    expect(normalizeKind('Outro')).toBe(FALLBACK_KIND)
    expect(normalizeKind('outros')).toBe('outros')
    expect(normalizeKind('Other')).toBe('outros')
    expect(normalizeKind('others')).toBe('outros')
  })
})

describe('parseKindReply', () => {
  it('lê a primeira linha com conteúdo e ignora a explicação', () => {
    expect(parseKindReply('\n\n  Segurança\nPorque mexe em auth.')).toBe('seguranca')
  })

  it('tira markdown, aspas, crases e o prefixo "Tipo:"', () => {
    expect(parseKindReply('**Segurança**')).toBe('seguranca')
    expect(parseKindReply('`frontend`')).toBe('frontend')
    expect(parseKindReply('"Dados"')).toBe('dados')
    expect(parseKindReply('“Arquitetura”')).toBe('arquitetura')
    expect(parseKindReply('Tipo: testes')).toBe('testes')
    expect(parseKindReply('**Tipo:** Segurança.')).toBe('seguranca')
    expect(parseKindReply('- tipo: infra estrutura')).toBe('infra-estrutura')
    expect(parseKindReply('# Outro')).toBe('outros')
  })

  it('resposta vazia vira null', () => {
    expect(parseKindReply('')).toBeNull()
    expect(parseKindReply('  \n \n')).toBeNull()
    expect(parseKindReply('``')).toBeNull()
  })
})

describe('kindLabel', () => {
  it('tipos conhecidos ganham o acento de volta', () => {
    expect(kindLabel('seguranca')).toBe('Segurança')
    expect(kindLabel('arquitetura')).toBe('Arquitetura')
    expect(kindLabel('principal')).toBe('Principal')
    expect(kindLabel('outros')).toBe('Outros')
  })

  it('o resto: hífen vira espaço e a primeira letra sobe', () => {
    expect(kindLabel('infra-estrutura')).toBe('Infra estrutura')
    expect(kindLabel('devops')).toBe('Devops')
    // Nome que existe no protótipo de objeto não acha rótulo por engano.
    expect(kindLabel('constructor')).toBe('Constructor')
  })
})

describe('mergeKinds', () => {
  it('une normalizando, sem duplicata, DEFAULT_KINDS primeiro', () => {
    expect(mergeKinds(['DevOps', 'Segurança'], ['seguranca', 'Arquitetura', 'infra estrutura'])).toEqual([
      'arquitetura',
      'seguranca',
      'devops',
      'infra-estrutura'
    ])
  })

  it('ordem estável e descarta o que não normaliza', () => {
    expect(mergeKinds(['zeta', '', 'alfa'], new Set(['zeta', '  ']))).toEqual(['zeta', 'alfa'])
    expect(mergeKinds(DEFAULT_KINDS)).toEqual([...DEFAULT_KINDS])
    expect(mergeKinds()).toEqual([])
  })
})
