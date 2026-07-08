/** @type {import('tailwindcss').Config} */
// v0.6 二次元设计系统（Sakura Dream）— 色值/圆角/发光以 docs/v0.6-design-system-anime.md 为准。
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // 底色（深色但不纯黑，偏深紫蓝）
        bg: '#14121f',
        surface: '#1e1b2e',
        'surface-2': '#272338',
        elevated: '#2f2a44',
        // 描边
        line: 'rgba(255,255,255,0.08)',
        'line-strong': 'rgba(180,150,255,0.22)',
        // 点缀色（霓光 pastel）
        sakura: '#ff7fbf',
        lavender: '#b58fff',
        sky: '#7fb0ff',
        mint: '#7fe7c4',
        gold: '#ffd88f',
        coral: '#ff8b9a',
        // 文字
        ink: '#ece8fb',
        'ink-muted': '#a49dc7',
        'ink-dim': '#6f6a8f',
      },
      borderRadius: {
        card: '18px',
        pop: '20px',
        btn: '12px',
        input: '12px',
        chip: '999px',
        icon: '14px',
      },
      boxShadow: {
        'glow-primary': '0 4px 20px rgba(255,127,191,0.28)',
        'glow-sakura': '0 0 8px rgba(255,127,191,0.4)',
        'glow-lavender': '0 0 8px rgba(181,143,255,0.4)',
        'glow-sky': '0 0 8px rgba(127,176,255,0.4)',
        'glow-mint': '0 0 8px rgba(127,231,196,0.4)',
        'glow-gold': '0 0 8px rgba(255,216,143,0.4)',
        'glow-coral': '0 0 8px rgba(255,139,154,0.4)',
        glass: '0 8px 30px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06)',
      },
      fontFamily: {
        rounded: [
          '"M PLUS Rounded 1c"',
          '"Varela Round"',
          'ui-rounded',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          'system-ui',
          'sans-serif',
        ],
        sans: [
          '"M PLUS Rounded 1c"',
          'ui-rounded',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          'system-ui',
          'sans-serif',
        ],
      },
      backgroundImage: {
        'grad-primary':
          'linear-gradient(135deg, #ff7fbf 0%, #b58fff 50%, #7fb0ff 100%)',
      },
      keyframes: {
        sheen: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'float-soft': {
          '0%,100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-3px)' },
        },
      },
      animation: {
        sheen: 'sheen 2.2s linear infinite',
        'float-soft': 'float-soft 3.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
