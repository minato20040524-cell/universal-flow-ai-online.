/** Line icons for modules and stage controls; 24px grid, drawn with currentColor. */

const PATHS: Record<string, string> = {
  play: 'M8 5.5v13l10-6.5z',
  bolt: 'M13 3 5 13.5h6L10 21l8-10.5h-6z',
  split: 'M5 5h5l4 7h5M14 12l-4 7H5M16 9l3 3-3 3',
  repeat: 'M17 2.5 20.5 6 17 9.5M3.5 11V9a3 3 0 0 1 3-3h14M7 21.5 3.5 18 7 14.5M20.5 13v2a3 3 0 0 1-3 3h-14',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  'user-check': 'M15 20v-1.5A3.5 3.5 0 0 0 11.5 15h-5A3.5 3.5 0 0 0 3 18.5V20M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM16 11l2 2 4-4',
  shuffle: 'M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5',
  brain: 'M9.5 4.5A3 3 0 0 0 6.5 7a3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 .5V6.5a2.5 2.5 0 0 0-3-2zM14.5 4.5a3 3 0 0 1 3 2.5 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 .5',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9.5h.01',
  film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 9h4M16 9h4M4 15h4M16 15h4',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21',
  share: 'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.6 13.5l6.8 4M15.4 6.5l-6.8 4',
  message: 'M4 5h16v11H9l-5 4z',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  cloud: 'M7 18a4.5 4.5 0 0 1-.5-9 6 6 0 0 1 11.5 1.5A3.75 3.75 0 0 1 17.5 18z',
  file: 'M14 3H6v18h12V7zM14 3v4h4M9 12h6M9 16h6',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  webhook: 'M10 7.5a3.5 3.5 0 1 1 5 3.2l2.5 4.8M7.6 12.2l-2.6 4.8a3.5 3.5 0 1 0 6.5 1.5h6M17.5 18.5a3.5 3.5 0 1 0-1.5-6.7',
  plug: 'M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5',
  'rotate-left': 'M3.5 4v5h5M4.2 13.5A8 8 0 1 0 6 6.3L3.5 9',
  'rotate-right': 'M20.5 4v5h-5M19.8 13.5A8 8 0 1 1 18 6.3L20.5 9',
  'tilt-up': 'M4 17l8-8 8 8M4 21h16',
  'tilt-down': 'M4 9l8 8 8-8M4 3h16',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  cube: 'M12 2.5 20.5 7v10L12 21.5 3.5 17V7zM3.5 7 12 11.5 20.5 7M12 11.5v10',
  square: 'M4 4h16v16H4z',
  undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  tidy: 'M4 5h6v5H4zM14 5h6v5h-6zM9 14h6v5H9zM7 10v2h10v-2M12 12v2',
  close: 'M6 6l12 12M18 6 6 18',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  back: 'M15 5l-7 7 7 7',
  data: 'M4 7h3l3 10 4-14 3 11h3',
};

export const Icon = ({ name, size = 18, title }: { name: string; size?: number; title?: string }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={name === 'play' ? 0 : 1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    role={title ? 'img' : undefined}
    aria-hidden={title ? undefined : true}
    className="icon"
  >
    {title ? <title>{title}</title> : null}
    <path d={PATHS[name] ?? PATHS.plug} fill={name === 'play' ? 'currentColor' : 'none'} />
  </svg>
);
