/** @type {import('tailwindcss').Config} */
// v0.11 Codex 风白色系浅色设计系统 — 白底、极浅灰分层、细浅边框、近黑文字、
// 克制中性强调色。浅色唯一，无深色切换。圆角保持不变，阴影极轻。
// 注：为降低翻皮改动量，旧 token 名（sakura/lavender/sky/mint/gold/coral/
// ink/line/surface 等）保留别名，只改色值——全站组件自动传导。
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // 底与面（白底三层，靠极浅灰分层）
        bg: '#f7f7f5',          // 应用最底 / 活动栏（暖白）
        editor: '#ffffff',      // 编辑器 / 主内容区（纯白）
        surface: '#fafaf9',     // 侧栏 / 面板底（旧 surface 别名）
        'surface-2': '#f0f0ee', // hover / 选中 / 内嵌块（最深的浅灰层）
        elevated: '#f0f0ee',    // 弹层 / hover（同 surface-2）
        // 描边（细、浅、低调）
        line: '#e6e6e3',
        'line-soft': '#efefec',
        'line-strong': '#d6d6d2',
        border: '#e6e6e3',
        'border-soft': '#efefec',
        'border-strong': '#d6d6d2',
        // 强调（Codex 式中性近黑，统一 primary/sakura/lavender）
        primary: '#202123',
        'primary-hover': '#3a3a38',
        'primary-active': '#101010',
        'primary-tint': 'rgba(32, 33, 35, 0.06)',
        accent: '#202123',
        'accent-soft': 'rgba(32, 33, 35, 0.06)',
        // 语义色（浅底上够深可读）
        running: '#0d8de3',     // info/sky 蓝（运行中）
        done: '#10a37f',        // OpenAI 绿（完成）
        awaiting: '#b7791f',    // gold 暖棕黄（等待）
        failed: '#d0342c',      // coral 红（失败）
        todo: '#8a8a85',        // dim 灰（待办）
        // 文字（映射 ink/text 系，近黑不纯黑，正文 on #fff ≥ 7:1）
        text: '#1f1f1e',
        'text-muted': '#55554f',
        'text-dim': '#8a8a85',
        'text-faint': '#b3b3ad',
        ink: '#1f1f1e',
        'ink-muted': '#55554f',
        'ink-dim': '#8a8a85',
        'ink-faint': '#b3b3ad',
        // v0.6 旧点缀色 -> Codex 浅色映射（保持类名可用）
        sakura: '#202123',      // 旧 sakura 粉紫 -> 中性近黑
        lavender: '#202123',    // 旧 lavender 蓝紫 -> 中性近黑
        sky: '#0d8de3',         // 旧 sky 蓝 -> info 蓝
        mint: '#10a37f',        // 旧 mint 绿 -> OpenAI 绿
        gold: '#b7791f',        // 旧 gold 黄 -> warning 暖棕黄
        coral: '#d0342c',       // 旧 coral 红 -> error 红
      },
      borderRadius: {
        card: '0.875rem',   // 14px — 卡片/面板大圆角（P-ai 风）
        pop: '0.875rem',    // 14px — 弹层
        btn: '0.625rem',    // 10px — 按钮/输入
        input: '0.625rem',  // 10px — 输入框
        chip: '0.5rem',     // 8px  — chip/tag
        icon: '0.625rem',   // 10px — 图标按钮
      },
      boxShadow: {
        // 浅色极轻阴影 — 卡片几乎无影，弹层轻投影
        card: '0 1px 2px rgba(0, 0, 0, 0.06)',
        pop: '0 8px 24px rgba(0, 0, 0, 0.12)',
        // 旧 glow-* / glass 名 -> 映射（保持类名可用，浅色无发光）
        'glow-primary': '0 1px 2px rgba(0, 0, 0, 0.06)',
        'glow-sakura': '0 1px 2px rgba(0, 0, 0, 0.06)',
        'glow-lavender': '0 1px 2px rgba(0, 0, 0, 0.06)',
        'glow-sky': '0 1px 2px rgba(0, 0, 0, 0.06)',
        'glow-mint': '0 1px 2px rgba(0, 0, 0, 0.06)',
        'glow-gold': '0 1px 2px rgba(0, 0, 0, 0.06)',
        'glow-coral': '0 1px 2px rgba(0, 0, 0, 0.06)',
        glass: '0 8px 24px rgba(0, 0, 0, 0.12)',
      },
      fontFamily: {
        rounded: [
          'Inter',
          '"Source Han Sans SC"',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          'system-ui',
          'sans-serif',
        ],
        sans: [
          'Inter',
          '"Source Han Sans SC"',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          'system-ui',
          'sans-serif',
        ],
        mono: [
          '"JetBrains Mono"',
          '"Cascadia Code"',
          'ui-monospace',
          'Consolas',
          'SFMono-Regular',
          'Menlo',
          'monospace',
        ],
      },
      backgroundImage: {
        // 签名渐变：仅品牌点（logo/主按钮）使用，中性近黑→石墨
        'grad-primary': 'linear-gradient(120deg, #3a3a38 0%, #202123 100%)',
      },
      keyframes: {
        'float-soft': {
          '0%,100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-3px)' },
        },
      },
      animation: {
        'float-soft': 'float-soft 3.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
