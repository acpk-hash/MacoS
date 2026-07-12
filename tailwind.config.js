/** @type {import('tailwindcss').Config} */
// v0.10 P-ai 风深色设计系统 — 色值/圆角/阴影以 P-ai kawayiYokami 实测为准。
// 深色唯一，无浅色切换。大圆角 + flat 层次（靠背景色差分层，减弱阴影）。
// 注：为降低翻皮改动量，v0.6/v0.7/v0.9 的旧 token 名（sakura/lavender/sky/mint/
// gold/coral/ink/line/surface 等）保留别名，只改色值——全站组件自动传导。
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // 底与面（三层深→浅）
        bg: '#22262f',          // 应用最底 / 活动栏（最深）
        editor: '#282c34',      // 编辑器 / 主内容区（中间层）
        surface: '#22262f',     // 侧栏 / 面板底（同最深，旧 surface 别名）
        'surface-2': '#41454c', // hover / 内嵌块（最浅层）
        elevated: '#41454c',    // 弹层 / hover（同最浅层）
        // 描边（边框主导分层，细而低调）
        line: '#363b44',
        'line-soft': '#2d3239',
        'line-strong': '#4a5060',
        border: '#363b44',
        'border-soft': '#2d3239',
        'border-strong': '#4a5060',
        // 强调（P-ai 紫，统一 primary/sakura/lavender）
        primary: '#8e5da1',
        'primary-hover': '#a06fb3',
        'primary-active': '#7d5191',
        'primary-tint': 'rgba(142, 93, 161, 0.16)',
        accent: '#8e5da1',
        'accent-soft': 'rgba(142, 93, 161, 0.16)',
        // 语义色（P-ai 实测柔和语义色系）
        running: '#56b6c2',     // info/sky 青（运行中）
        done: '#9ccb9a',        // mint 绿（完成）
        awaiting: '#f6e2b7',    // gold 暖黄（等待）
        failed: '#eba0ac',      // coral 玫红（失败）
        todo: '#7a8089',        // dim 灰（待办）
        // 文字（映射 ink/text 系，不用纯白，可读性达标）
        text: '#dcdfe4',
        'text-muted': '#a8adb5',
        'text-dim': '#7a8089',
        'text-faint': '#5c6370',
        ink: '#dcdfe4',
        'ink-muted': '#a8adb5',
        'ink-dim': '#7a8089',
        'ink-faint': '#5c6370',
        // v0.6 旧点缀色 -> P-ai 深色映射（保持类名可用）
        sakura: '#8e5da1',      // 旧 sakura 粉紫 -> P-ai 主紫
        lavender: '#8e5da1',    // 旧 lavender 蓝紫 -> P-ai 主紫
        sky: '#56b6c2',         // 旧 sky 蓝 -> P-ai info 青
        mint: '#9ccb9a',        // 旧 mint 绿 -> P-ai success 绿
        gold: '#f6e2b7',        // 旧 gold 黄 -> P-ai warning 暖黄
        coral: '#eba0ac',       // 旧 coral 红 -> P-ai error 玫红
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
        // flat — 靠背景色差表达层次，阴影减弱
        card: '0 1px 3px rgba(0, 0, 0, 0.28)',
        pop: '0 6px 20px rgba(0, 0, 0, 0.4)',
        // 旧 glow-* / glass 名 -> 映射（保持类名可用，flat 风无发光）
        'glow-primary': '0 1px 3px rgba(0, 0, 0, 0.28)',
        'glow-sakura': '0 1px 3px rgba(0, 0, 0, 0.28)',
        'glow-lavender': '0 1px 3px rgba(0, 0, 0, 0.28)',
        'glow-sky': '0 1px 3px rgba(0, 0, 0, 0.28)',
        'glow-mint': '0 1px 3px rgba(0, 0, 0, 0.28)',
        'glow-gold': '0 1px 3px rgba(0, 0, 0, 0.28)',
        'glow-coral': '0 1px 3px rgba(0, 0, 0, 0.28)',
        glass: '0 6px 20px rgba(0, 0, 0, 0.4)',
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
        // 签名渐变：仅品牌点（logo/主按钮）使用，P-ai 紫
        'grad-primary': 'linear-gradient(120deg, #8e5da1 0%, #56b6c2 100%)',
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
