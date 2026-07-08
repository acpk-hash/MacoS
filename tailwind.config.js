/** @type {import('tailwindcss').Config} */
// v0.7 蓝白科研设计系统（Research / Academic）— 色值/圆角/阴影/字体以
// docs/v0.7-design-system-research.md 为准。浅色唯一，无暗色切换。
// 注：为降低翻皮改动量，v0.6 的旧 token 名（sakura/lavender/sky/mint/gold/
// coral/ink/line 等）作为「浅色别名」保留，映射到 v0.7 的主色/语义色/文字色。
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // 底与面（浅）
        bg: '#f7f9fc',
        surface: '#ffffff',
        'surface-2': '#f1f4f9',
        elevated: '#ffffff',
        // 描边
        line: '#e2e8f0',
        'line-strong': '#cbd7e6',
        border: '#e2e8f0',
        'border-strong': '#cbd7e6',
        // 主色（蓝）
        primary: '#2563eb',
        'primary-hover': '#1d4ed8',
        'primary-tint': '#eff4ff',
        // 语义色（科研清爽）
        running: '#2563eb',
        done: '#16a34a',
        awaiting: '#d97706',
        failed: '#dc2626',
        todo: '#64748b',
        // 文字（深色字，浅底上）
        text: '#1e293b',
        'text-muted': '#475569',
        'text-dim': '#94a3b8',
        ink: '#1e293b',
        'ink-muted': '#475569',
        'ink-dim': '#94a3b8',
        // v0.6 旧点缀色 -> v0.7 浅色映射（保持类名可用）
        sakura: '#2563eb',
        lavender: '#2563eb',
        sky: '#2563eb',
        mint: '#16a34a',
        gold: '#d97706',
        coral: '#dc2626',
      },
      borderRadius: {
        card: '12px',
        pop: '14px',
        btn: '8px',
        input: '8px',
        chip: '6px',
        icon: '8px',
      },
      boxShadow: {
        // 柔和阴影（非发光）
        card: '0 1px 3px rgba(15,23,42,0.06), 0 1px 2px rgba(15,23,42,0.04)',
        pop: '0 8px 24px rgba(15,23,42,0.12)',
        // 旧 glow-* / glass 名 -> 映射到柔和阴影（保持类名可用）
        'glow-primary': '0 1px 3px rgba(15,23,42,0.06), 0 1px 2px rgba(15,23,42,0.04)',
        'glow-sakura': '0 1px 3px rgba(15,23,42,0.06)',
        'glow-lavender': '0 1px 3px rgba(15,23,42,0.06)',
        'glow-sky': '0 1px 3px rgba(15,23,42,0.06)',
        'glow-mint': '0 1px 3px rgba(15,23,42,0.06)',
        'glow-gold': '0 1px 3px rgba(15,23,42,0.06)',
        'glow-coral': '0 1px 3px rgba(15,23,42,0.06)',
        glass: '0 8px 24px rgba(15,23,42,0.12)',
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
          'SFMono-Regular',
          'Menlo',
          'monospace',
        ],
      },
      backgroundImage: {
        // 主色蓝渐变（按钮/logo 用，非文字渐变）
        'grad-primary': 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)',
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
