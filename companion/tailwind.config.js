export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#f7f7f5',
        surface: { DEFAULT: '#fafaf9', '2': '#f0f0ee' },
        editor: '#ffffff',
        primary: { DEFAULT: '#202123', hover: '#35363a', tint: 'rgba(32,33,35,0.06)' },
        ink: { DEFAULT: '#202123', muted: '#6e6e80', dim: '#8e8ea0', faint: '#acacbe' },
        line: '#e5e5e2',
        mint: '#10a37f',
        sky: '#0d8de3',
        coral: '#d0342c',
        gold: '#b7791f',
      },
    },
  },
  plugins: [],
}
