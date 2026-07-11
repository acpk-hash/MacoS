/** @type {import('tailwindcss').Config} */
// v0.9 Trae 风深色专业 IDE 设计系统 — 色值/圆角/阴影/字体以
// docs/v0.9-design-trae-ide.md 为准。深色唯一，无浅色切换。
// 注：为降低翻皮改动量，v0.6/v0.7 的旧 token 名（sakura/lavender/sky/mint/
// gold/coral/ink/line/surface 等）作为「深色别名」保留，映射到 v0.9 token。
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // 底与面（深）
        bg: '#17171b',          // 应用最底 / 活动栏
        editor: '#1e1e22',      // 编辑器 / 主内容区
        surface: '#202024',     // 侧栏 / 面板（旧 surface 别名）
        'surface-2': '#26262c', // hover / 内嵌块
        elevated: '#26262c',    // 弹层 / hover
        // 描边（边框主导分层）
        line: '#2c2c33',
        'line-soft': '#242429',
        'line-strong': '#3a3a44',
        border: '#2c2c33',
        'border-soft': '#242429',
        'border-strong': '#3a3a44',
        // 强调（Trae 感，克制紫蓝）
        primary: '#8b7cff',
        'primary-hover': '#9a8dff',
        'primary-active': '#7a6bf0',
        'primary-tint': 'rgba(139, 124, 255, 0.14)',
        accent: '#8b7cff',
        'accent-soft': 'rgba(139, 124, 255, 0.14)',
        // 语义色（GitHub 深色语义色系）
        running: '#5b8cff',
        done: '#3fb950',
        awaiting: '#d29922',
        failed: '#f85149',
        todo: '#8a8a95',
        // 文字（浅字，深底上）
        text: '#e6e6ea',
        'text-muted': '#b4b4be',
        'text-dim': '#8a8a95',
        ink: '#e6e6ea',
        'ink-muted': '#b4b4be',
        'ink-dim': '#8a8a95',
        'ink-faint': '#63636e',
        // v0.6 旧点缀色 -> v0.9 深色映射（保持类名可用）
        sakura: '#8b7cff',
        lavender: '#8b7cff',
        sky: '#5b8cff',
        mint: '#3fb950',
        gold: '#d29922',
        coral: '#f85149',
      },
      borderRadius: {
        card: '8px',
        pop: '10px',
        btn: '6px',
        input: '6px',
        chip: '5px',
        icon: '6px',
      },
      boxShadow: {
        // IDE 靠边框分层，阴影几乎不用；弹层深投影 + 细边
        card: '0 1px 2px rgba(0, 0, 0, 0.35)',
        pop: '0 8px 28px rgba(0, 0, 0, 0.5)',
        // 旧 glow-* / glass 名 -> 映射（保持类名可用，无发光）
        'glow-primary': '0 1px 2px rgba(0, 0, 0, 0.35)',
        'glow-sakura': '0 1px 2px rgba(0, 0, 0, 0.35)',
        'glow-lavender': '0 1px 2px rgba(0, 0, 0, 0.35)',
        'glow-sky': '0 1px 2px rgba(0, 0, 0, 0.35)',
        'glow-mint': '0 1px 2px rgba(0, 0, 0, 0.35)',
        'glow-gold': '0 1px 2px rgba(0, 0, 0, 0.35)',
        'glow-coral': '0 1px 2px rgba(0, 0, 0, 0.35)',
        glass: '0 8px 28px rgba(0, 0, 0, 0.5)',
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
        // 签名渐变：仅品牌点（logo/主按钮）使用
        'grad-primary': 'linear-gradient(120deg, #8b7cff 0%, #5b8cff 100%)',
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
