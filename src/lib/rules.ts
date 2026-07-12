// TRAP 结构化规则库 — 数据模型、编译逻辑、ID 生成。
// 数据存 .agentboard/rules.json；编译结果写 AGENTS.md 供 codex 原生读取。

export type RuleCategory = 'tools' | 'role' | 'approach' | 'policy'

export interface Rule {
  id: string
  category: RuleCategory
  title: string
  body: string
  enabled: boolean
}

export interface RulesFile {
  version: 1
  rules: Rule[]
}

export const EMPTY_RULES_FILE: RulesFile = { version: 1, rules: [] }

/** TRAP 四类中文名 */
export const CATEGORY_LABELS: Record<RuleCategory, string> = {
  tools: '工具约束',
  role: '角色设定',
  approach: '方法流程',
  policy: '红线策略',
}

/** TRAP 顺序 */
export const CATEGORY_ORDER: RuleCategory[] = ['tools', 'role', 'approach', 'policy']

/** 简单 ID 生成（无需 crypto） */
let _counter = 0
export function genId(): string {
  _counter += 1
  return `r_${Date.now().toString(36)}_${_counter.toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 把 enabled 规则按四类分组，生成结构化 AGENTS.md。
 * 禁用规则不进输出；无任何 enabled 规则时返回空串。
 */
export function compileToAgentsMd(rules: Rule[]): string {
  const enabled = rules.filter((r) => r.enabled)
  if (enabled.length === 0) return ''

  const header =
    '<!-- 本文件由 AgentBoard 规则面板生成，可直接编辑；结构化规则见 .agentboard/rules.json -->\n\n'

  const sections: string[] = []
  for (const cat of CATEGORY_ORDER) {
    const items = enabled.filter((r) => r.category === cat)
    if (items.length === 0) continue
    const lines: string[] = [`## ${CATEGORY_LABELS[cat]}\n`]
    for (const rule of items) {
      lines.push(`### ${rule.title}\n`)
      lines.push(`${rule.body.trim()}\n`)
    }
    sections.push(lines.join('\n'))
  }

  return header + sections.join('\n')
}

/** 四类各一条中文示例模板 */
export function defaultTemplateRules(): Rule[] {
  return [
    {
      id: genId(),
      category: 'tools',
      title: '禁止修改的文件与目录',
      body: '不要修改 legacy/ 目录和 *.generated.ts 文件；不要直接提交到 main 分支。',
      enabled: true,
    },
    {
      id: genId(),
      category: 'role',
      title: '角色与语言偏好',
      body: '始终以高级全栈工程师的视角回应；代码注释和提交信息使用中文；遇到歧义主动澄清再动手。',
      enabled: true,
    },
    {
      id: genId(),
      category: 'approach',
      title: '代码风格与验证流程',
      body: 'TypeScript 严格模式，缩进 2 空格，禁用 any；每次改动后运行 npx tsc --noEmit；涉及 UI 时用现有 Tailwind token，不引入新库。',
      enabled: true,
    },
    {
      id: genId(),
      category: 'policy',
      title: '不可逾越的红线',
      body: '禁止删除或覆盖用户数据文件；禁止在未经确认的情况下执行破坏性命令（rm -rf、drop table 等）；涉及密钥/凭证的操作必须先获得用户明确授权。',
      enabled: true,
    },
  ]
}