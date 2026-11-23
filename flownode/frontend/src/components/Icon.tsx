import type { SVGProps } from 'react';

const P: Record<string, string> = {
  dashboard: 'M3 3h8v8H3zM13 3h8v5h-8zM13 10h8v11h-8zM3 13h8v8H3z',
  nodes: 'M6 3a3 3 0 100 6 3 3 0 000-6zM18 15a3 3 0 100 6 3 3 0 000-6zM6 15a3 3 0 100 6 3 3 0 000-6zM9 6h6a3 3 0 013 3v3M6 9v6',
  collab: 'M4 5h16v10H9l-5 4zM8 9h8M8 12h5',
  agents: 'M12 3a4 4 0 100 8 4 4 0 000-8zM4 21a8 8 0 0116 0',
  skills: 'M12 2l2.4 5.6L20 9l-4.2 3.8L17 19l-5-3-5 3 1.2-6.2L4 9l5.6-1.4z',
  builders: 'M3 21h18M5 21V10l7-6 7 6v11M10 21v-6h4v6',
  files: 'M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2z',
  approvals: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM8.5 12l2.5 2.5L16 9.5',
  analytics: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 00-2-1.2L14 3h-4l-.5 2.6a7 7 0 00-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1c.6.5 1.3.9 2 1.2L10 21h4l.5-2.6c.7-.3 1.4-.7 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
  play: 'M7 4l13 8-13 8z',
  pause: 'M7 4h3v16H7zM14 4h3v16h-3z',
  stop: 'M6 6h12v12H6z',
  retry: 'M4 12a8 8 0 108-8H8M8 4L5 7l3 3',
  save: 'M5 3h12l4 4v14H3V3zM7 3v6h8V3M7 21v-7h10v7',
  export: 'M12 3v12M7 8l5-5 5 5M4 17v4h16v-4',
  load: 'M12 15V3M7 10l5 5 5-5M4 17v4h16v-4',
  bell: 'M6 9a6 6 0 1112 0c0 6 2 7 2 7H4s2-1 2-7M10 20a2 2 0 004 0',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  document: 'M6 3h8l5 5v13H6zM14 3v5h5M9 13h7M9 17h7',
  image: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M8.5 9.5h.01',
  video: 'M3 6h12v12H3zM15 10l6-3v10l-6-3',
  audio: 'M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  model3d: 'M12 2l9 5v10l-9 5-9-5V7zM12 12l9-5M12 12L3 7M12 12v10',
  dataset: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  folder: 'M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2z',
  send: 'M3 11l18-8-8 18-2-8z',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l5 5 9-10',
  menu: 'M4 6h16M4 12h16M4 18h16',
  chat: 'M4 5h16v11H10l-5 4v-4H4z',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14',
  expand: 'M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6',
  zap: 'M13 2L4 14h7l-1 8 9-12h-7z',
  alert: 'M12 3l10 18H2zM12 10v5M12 18h.01',
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 18, ...rest }: { name: string; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
      <path d={P[name] ?? P.document} />
    </svg>
  );
}

export const kindIcon = (kind: string): string => (kind === 'model3d' ? 'model3d' : P[kind] ? kind : 'document');
export const iconPath = (name: string): string => P[name] ?? P.document!;
