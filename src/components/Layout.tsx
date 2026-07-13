import type { ReactNode } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import Logo from './Logo'
import GlobalTaskBar from './GlobalTaskBar'
import { useAuthStore } from '../stores/authStore'
import { useProviderStore } from '../stores/providerStore'

/** 活动栏图标：统一 24 viewBox 描边线稿风格（lucide 风）。 */
function NavIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[17px] w-[17px]"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

type NavItem = { to: string; label: string; title?: string; end?: boolean; icon: ReactNode }

// 大类导航：编码 / 办公 / 图像 / 视频 / 科研 / Auto / Skills / MCP / Hooks / Agent / 知识库 / 画布 / 电商 / 用量，设置固定末位。
const navItems: NavItem[] = [
  {
    to: '/',
    label: '编码',
    title: '编码 · pi 三栏工作区',
    end: true,
    icon: (
      <NavIcon>
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </NavIcon>
    ),
  },
  {
    to: '/office',
    label: '办公',
    title: '办公 · PPT / Excel / Word 智能处理',
    icon: (
      <NavIcon>
        <rect x="2" y="7" width="20" height="14" rx="2" />
        <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
      </NavIcon>
    ),
  },
  {
    to: '/image',
    label: '图像',
    title: '图像 · AI 图像生成',
    icon: (
      <NavIcon>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
      </NavIcon>
    ),
  },
  {
    to: '/video',
    label: '视频',
    title: '视频 · 视频生成与处理',
    icon: (
      <NavIcon>
        <path d="m22 8-6 4 6 4V8Z" />
        <rect x="2" y="6" width="14" height="12" rx="2" />
      </NavIcon>
    ),
  },
  {
    to: '/science',
    label: '科研',
    title: '科研 · 文献综述 / 知识库 / 自动科研',
    icon: (
      <NavIcon>
        <path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2" />
        <path d="M8.5 2h7" />
        <path d="M7 16h10" />
      </NavIcon>
    ),
  },
  {
    to: '/auto',
    label: 'Auto',
    title: 'Auto · open-science 全流水线自动科研',
    icon: (
      <NavIcon>
        <path d="M12 8V4H8" />
        <rect x="4" y="8" width="16" height="12" rx="2" />
        <path d="M2 14h2" />
        <path d="M20 14h2" />
        <path d="M15 13v2" />
        <path d="M9 13v2" />
      </NavIcon>
    ),
  },
  {
    to: '/skills',
    label: 'Skills',
    title: 'Skills · 技能市场，下载即用',
    icon: (
      <NavIcon>
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <path d="M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3" />
      </NavIcon>
    ),
  },
  {
    to: '/mcp',
    label: 'MCP',
    title: 'MCP · 工具服务器管理与安装',
    icon: (
      <NavIcon>
        <path d="M12 2L2 7l10 5 10-5-10-5Z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </NavIcon>
    ),
  },
  {
    to: '/hooks',
    label: 'Hooks',
    title: 'Hooks · 编码钩子管理与安装',
    icon: (
      <NavIcon>
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </NavIcon>
    ),
  },
  {
    to: '/agent',
    label: 'Agent',
    title: 'Agent · 会话工作流存档与复用',
    icon: (
      <NavIcon>
        <rect x="3" y="3" width="8" height="8" rx="2" />
        <path d="M7 11v4a2 2 0 0 0 2 2h4" />
        <rect x="13" y="13" width="8" height="8" rx="2" />
      </NavIcon>
    ),
  },
  {
    to: '/kb',
    label: '知识库',
    title: '知识库 · 文档管理 / 知识图谱 / 导入导出',
    icon: (
      <NavIcon>
        <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
        <path d="M8 7h6" />
        <path d="M8 11h8" />
      </NavIcon>
    ),
  },
  {
    to: '/canvas',
    label: '画布',
    title: '画布 · 思维导图 / 自由白板',
    icon: (
      <NavIcon>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M3 9h18" />
        <path d="M9 3v18" />
      </NavIcon>
    ),
  },
  {
    to: '/commerce',
    label: '电商',
    title: '跨境电商 · 选品 / 利润 / 图片 / 详情页全流水线',
    icon: (
      <NavIcon>
        <circle cx="8" cy="21" r="1" />
        <circle cx="19" cy="21" r="1" />
        <path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" />
      </NavIcon>
    ),
  },
  {
    to: '/usage',
    label: '用量',
    title: '用量 · Token 消耗与运行统计',
    icon: (
      <NavIcon>
        <path d="M3 3v18h18" />
        <path d="M18 17V9" />
        <path d="M13 17V5" />
        <path d="M8 17v-3" />
      </NavIcon>
    ),
  },
  {
    to: '/settings',
    label: '设置',
    title: '设置 · 服务商 / Key / 账号',
    icon: (
      <NavIcon>
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </NavIcon>
    ),
  },
]

// VSCode 活动栏式导航项：选中态 = 左侧 2px 强调条 + accent-soft 底 + 亮字。
const linkClass = ({ isActive }: { isActive: boolean }) =>
  [
    'group relative flex flex-col items-center justify-center gap-1 h-12 rounded-btn text-xs transition-colors duration-150',
    isActive
      ? 'text-ink bg-primary-tint font-semibold'
      : 'text-ink-dim hover:bg-surface-2 hover:text-ink-muted',
  ].join(' ')

function NavEntry({ item }: { item: NavItem }) {
  return (
    <NavLink to={item.to} end={item.end} title={item.title ?? item.label} className={linkClass}>
      {({ isActive }) => (
        <>
          {/* VSCode 式左侧强调条 */}
          <span
            aria-hidden="true"
            className={
              'absolute left-[-8px] top-1.5 bottom-1.5 w-[2px] rounded-full transition-colors ' +
              (isActive ? 'bg-primary' : 'bg-transparent')
            }
          />
          {item.icon}
          <span className="text-[10px] leading-none">{item.label}</span>
        </>
      )}
    </NavLink>
  )
}

/** 活动栏底部账号块：已登录显示用户名+退出登录；本地模式显示登录入口。 */
function AccountBlock() {
  const { loggedIn, username, logout, openPortal } = useAuthStore()
  const navigate = useNavigate()

  if (loggedIn) {
    const name = username ?? '账号'
    return (
      <div className="w-full px-2 flex flex-col items-center gap-1">
        <button
          onClick={() => navigate('/settings')}
          title={'账号：' + name + ' · 点击查看账号与同步设置'}
          className="w-8 h-8 rounded-full bg-primary text-white text-sm font-bold
                     flex items-center justify-center hover:bg-primary-hover transition-colors"
        >
          {name.charAt(0).toUpperCase()}
        </button>
        <span className="w-full text-[9px] text-ink-muted text-center truncate leading-tight" title={name}>
          {name}
        </span>
        <button
          onClick={() => void logout()}
          title="退出登录（回本地模式，本地数据保留）"
          className="text-[9px] text-ink-dim hover:text-failed transition-colors leading-none"
        >
          退出登录
        </button>
      </div>
    )
  }

  return (
    <div className="w-full px-2 flex flex-col items-center gap-1">
      <button
        onClick={openPortal}
        title="本地模式 · 点击登录以在手机和电脑间同步数据"
        className="w-8 h-8 rounded-full bg-surface-2 border border-line text-ink-dim text-xs
                   flex items-center justify-center hover:border-primary hover:text-primary transition-colors"
      >
        登
      </button>
      <span className="text-[9px] text-ink-dim text-center leading-tight">本地模式</span>
      <button
        onClick={openPortal}
        className="text-[9px] text-primary hover:text-primary-hover transition-colors leading-none"
      >
        登录
      </button>
    </div>
  )
}

/** 底部状态栏（VSCode 式细条）：账号 / 引擎状态 / 品牌，小字分段。 */
function StatusBar() {
  const { loggedIn, username, openPortal } = useAuthStore()
  const providers = useProviderStore((s) => s.providers)
  const navigate = useNavigate()

  const providerCount = providers.length

  return (
    <footer className="statusbar">
      {/* 左：账号 */}
      <button
        className="statusbar-item clickable"
        title={loggedIn ? '账号与同步设置' : '本地模式 · 点击登录同步'}
        onClick={() => (loggedIn ? navigate('/settings') : openPortal())}
      >
        <span
          className={
            'inline-block w-1.5 h-1.5 rounded-full ' +
            (loggedIn ? 'bg-done' : 'bg-ink-faint')
          }
        />
        {loggedIn ? (username ?? '账号') : '本地模式'}
      </button>
      {/* 引擎（服务商）状态 */}
      <button
        className="statusbar-item clickable"
        title="模型服务商 · 点击去设置"
        onClick={() => navigate('/settings')}
      >
        <span
          className={
            'inline-block w-1.5 h-1.5 rounded-full ' +
            (providerCount > 0 ? 'bg-running' : 'bg-awaiting')
          }
        />
        引擎 {providerCount}
      </button>
      <span className="flex-1" />
      {/* 右：品牌段 */}
      <span className="statusbar-item font-mono">UTF-8</span>
      <span className="statusbar-item">
        <Logo size={12} glyphOnly />
        Iris
      </span>
    </footer>
  )
}

export default function Layout() {
  return (
    <div className="flex flex-col h-screen text-ink bg-bg">
      <div className="flex flex-1 min-h-0">
        {/* 活动栏（VSCode activity bar 观感：最深底 + 右细边） */}
        <aside className="w-16 flex flex-col items-center py-3 gap-3 bg-bg border-r border-line flex-shrink-0 z-10 overflow-y-auto overflow-x-hidden">
          {/* Logo — Iris 彩虹女神标 + 品牌字 */}
          <div className="flex flex-col items-center gap-1">
            <Logo size={30} />
            <span className="text-[10px] font-bold text-ink-muted leading-none">Iris</span>
          </div>

          {/* 主导航：十大板块 + 设置（末位） */}
          <nav className="flex flex-col gap-0.5 w-full px-2">
            {navItems.map((item) => (
              <NavEntry key={item.to} item={item} />
            ))}
          </nav>

          {/* 账号（底部固定） */}
          <div className="mt-auto w-full">
            <AccountBlock />
          </div>
        </aside>

        {/* Main content area（编辑器底色，略亮于活动栏） */}
        <main className="flex-1 overflow-hidden bg-editor">
          <Outlet />
        </main>
      </div>

      {/* 底部全局任务条（跨板块 agent 任务可见性） */}
      <GlobalTaskBar />

      {/* 底部状态栏 */}
      <StatusBar />
    </div>
  )
}