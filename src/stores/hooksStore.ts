// hooksStore — Hooks 顶级大类状态（zustand + localStorage 持久化）。
// 数据模型：HookDef（内置精选 hook）+ installedHookIds（用户已安装集合）。
// 每次 install/uninstall 自动调后端 hooks_sync 同步 active-hooks.json。
import { create } from 'zustand'

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

async function tauriInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

// ── 类型 ──────────────────────────────────────────────────────────────────────

export type HookCategory = 'quality' | 'test' | 'deploy' | 'format' | 'security' | 'workflow'

export interface HookDef {
  id: string
  name: string
  description: string
  category: HookCategory
  trigger: string
  agentInstruction: string
  manualOnly?: boolean
}

// ── 内置 Hook 精选（>= 15 条） ──────────────────────────────────────────────

export const BUILTIN_HOOKS: HookDef[] = [
  // Quality
  {
    id: 'pre-commit-lint',
    name: 'Pre-commit Lint',
    description: '提交前自动运行 linter 检查代码质量',
    category: 'quality',
    trigger: 'pre-commit',
    agentInstruction: '在用户准备提交代码前，自动运行 eslint、ruff 或项目配置的 linter，报告所有错误和警告，阻止带错误的提交。',
  },
  {
    id: 'auto-format',
    name: 'Auto Format',
    description: '保存文件时自动格式化代码',
    category: 'quality',
    trigger: 'on-save',
    agentInstruction: '写完文件后自动运行 prettier、black 或项目配置的格式化工具，确保代码风格统一，报告格式化了哪些文件。',
  },
  {
    id: 'code-review-check',
    name: 'Code Review Check',
    description: '变更完成时自动做代码审查',
    category: 'quality',
    trigger: 'post-edit',
    agentInstruction: '每次完成一组文件修改后，自动审查变更的正确性、可维护性和潜在 bug，以清单形式报告发现的问题和改进建议。',
  },
  // Test
  {
    id: 'auto-test',
    name: 'Auto Test',
    description: '代码变更后自动运行相关测试',
    category: 'test',
    trigger: 'post-edit',
    agentInstruction: '检测到代码变更后，自动运行与修改文件相关的单元测试（jest、pytest、cargo test 等），报告通过/失败结果和失败详情。',
  },
  {
    id: 'test-coverage',
    name: 'Test Coverage',
    description: '检查测试覆盖率是否达标',
    category: 'test',
    trigger: 'post-test',
    agentInstruction: '运行完测试后，检查测试覆盖率报告，如果覆盖率低于 80% 或新增代码未被覆盖，提醒用户补充测试用例。',
  },
  {
    id: 'snapshot-update',
    name: 'Snapshot Update',
    description: '自动更新过时的测试快照',
    category: 'test',
    trigger: 'post-test',
    agentInstruction: '当快照测试失败时，对比旧快照与新输出的差异，如果变更是预期的，自动更新快照文件并报告更新了哪些快照。',
    manualOnly: true,
  },
  // Deploy
  {
    id: 'pre-deploy-check',
    name: 'Pre-deploy Check',
    description: '部署前执行完整性检查',
    category: 'deploy',
    trigger: 'pre-deploy',
    agentInstruction: '在部署前检查：所有测试通过、没有未提交的变更、环境变量配置完整、依赖版本锁定，逐项报告检查结果。',
  },
  {
    id: 'docker-build-check',
    name: 'Docker Build Check',
    description: '验证 Docker 镜像能否成功构建',
    category: 'deploy',
    trigger: 'pre-deploy',
    agentInstruction: '在部署前尝试执行 docker build（dry-run 或实际构建），检查 Dockerfile 语法、依赖安装和构建步骤是否成功，报告构建日志中的错误。',
  },
  // Format
  {
    id: 'import-sort',
    name: 'Import Sort',
    description: '自动排序 import 语句',
    category: 'format',
    trigger: 'on-save',
    agentInstruction: '保存文件时自动检查并排序 import/require 语句，按照标准库、第三方库、本地模块的顺序分组排列，保持一致的导入风格。',
  },
  {
    id: 'trailing-whitespace',
    name: 'Trailing Whitespace',
    description: '清除行尾空白和多余空行',
    category: 'format',
    trigger: 'on-save',
    agentInstruction: '保存文件时自动清除行尾多余空白字符、文件末尾多余空行，确保文件以单个换行符结尾，报告清理了多少处。',
  },
  // Security
  {
    id: 'secret-scan',
    name: 'Secret Scan',
    description: '扫描代码中的硬编码密钥和凭据',
    category: 'security',
    trigger: 'pre-commit',
    agentInstruction: '在提交前扫描变更文件，检测硬编码的 API Key、密码、Token、私钥等敏感信息，发现后阻止提交并报告具体位置和类型。',
  },
  {
    id: 'dependency-audit',
    name: 'Dependency Audit',
    description: '审计依赖包的已知安全漏洞',
    category: 'security',
    trigger: 'post-install',
    agentInstruction: '当依赖发生变更时，运行 npm audit、pip-audit 或 cargo audit 检查已知安全漏洞，按严重程度分级报告，并建议升级方案。',
  },
  // Workflow
  {
    id: 'auto-commit-message',
    name: 'Auto Commit Message',
    description: '根据变更自动生成 commit 消息',
    category: 'workflow',
    trigger: 'pre-commit',
    agentInstruction: '分析暂存区的变更内容，自动生成简洁准确的 commit 消息（遵循 Conventional Commits 规范），供用户确认或修改后提交。',
  },
  {
    id: 'changelog-entry',
    name: 'Changelog Entry',
    description: '自动生成 CHANGELOG 条目',
    category: 'workflow',
    trigger: 'pre-release',
    agentInstruction: '在发布前分析自上次发布以来的所有提交，自动生成 CHANGELOG 条目，按 Added/Changed/Fixed/Removed 分类整理，供用户审阅。',
    manualOnly: true,
  },
  {
    id: 'branch-naming',
    name: 'Branch Naming',
    description: '检查分支命名是否符合团队规范',
    category: 'workflow',
    trigger: 'pre-push',
    agentInstruction: '推送前检查当前分支名是否符合团队约定的命名规范（如 feat/xxx、fix/xxx、chore/xxx），不符合时提醒用户修改分支名。',
  },
]

const STORAGE_KEY = 'iris.hooks.v1'

function loadInstalledIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveInstalledIds(ids: string[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
}

// ── Store ────────────────────────────────────────────────────────────────────

interface HooksState {
  installedHookIds: string[]

  install: (id: string) => void
  uninstall: (id: string) => void
  isInstalled: (id: string) => boolean
  getActive: () => HookDef[]
}

async function syncToBackend(installedIds: string[]) {
  if (!isTauri) return
  const hooks = installedIds
    .map((id) => BUILTIN_HOOKS.find((h) => h.id === id))
    .filter((h): h is HookDef => !!h)
    .map((h) => ({ id: h.id, instruction: h.agentInstruction }))
  try {
    await tauriInvoke('hooks_sync', { hooks })
  } catch {
    // 后端不可用时静默（不阻塞前端）
  }
}

export const useHooksStore = create<HooksState>((set, get) => ({
  installedHookIds: loadInstalledIds(),

  install: (id: string) => {
    const current = get().installedHookIds
    if (current.includes(id)) return
    const next = [...current, id]
    saveInstalledIds(next)
    set({ installedHookIds: next })
    void syncToBackend(next)
  },

  uninstall: (id: string) => {
    const current = get().installedHookIds
    const next = current.filter((x) => x !== id)
    saveInstalledIds(next)
    set({ installedHookIds: next })
    void syncToBackend(next)
  },

  isInstalled: (id: string) => {
    return get().installedHookIds.includes(id)
  },

  getActive: () => {
    const ids = get().installedHookIds
    return BUILTIN_HOOKS.filter((h) => ids.includes(h.id))
  },
}))
