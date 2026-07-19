export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#f7f7f5',
        surface: { DEFAULT: '#fafaf9', '2': '#f0f0ee' },
        editor: '#ffffff',
        primary: { DEFAULT: '#202123', hover: '#35363a', tint: 'rgba(32,33,35,0.06)', active: '#101010' },
        ink: { DEFAULT: '#202123', muted: '#55554f', dim: '#8a8a85', faint: '#b3b3ad' },
        line: { DEFAULT: '#e5e5e2', soft: '#efefec', strong: '#d6d6d2' },
        mint: '#10a37f',
        sky: '#0d8de3',
        coral: '#d0342c',
        gold: '#b7791f',
        done: '#10a37f',
        running: '#0d8de3',
        awaiting: '#b7791f',
        failed: '#d0342c',
      },
      borderRadius: {
        card: '14px',
        input: '10px',
        btn: '10px',
        bubble: '16px',
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,0.06)',
        pop: '0 8px 24px rgba(0,0,0,0.12)',
      },
      spacing: {
        'safe-b': 'env(safe-area-inset-bottom, 0px)',
        'safe-t': 'env(safe-area-inset-top, 0px)',
      },
    },
  },
  plugins: [],
}
