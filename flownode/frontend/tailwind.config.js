/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0B1120',
        panel: '#111827',
        panel2: '#0f172a',
        line: '#263449',
        c1: '#2196F3',
        c2: '#A855F7',
        c3: '#10B981',
        warn: '#F59E0B',
        fin: '#22D3EE',
      },
      fontFamily: { sans: ['Inter', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'], mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'] },
    },
  },
  plugins: [],
};
