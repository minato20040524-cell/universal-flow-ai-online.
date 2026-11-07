import type { Credential, InstalledIntegration, MarketplacePlugin } from './types.js';

/** Plain-language wording and grouping rules shared by the pages. */

export type Lamp = { tone: 'ready' | 'attention' | 'fault' | 'off'; label: string };

/** One status per integration, the most urgent problem first. */
export const integrationLamp = (integration: InstalledIntegration, credentials: readonly Credential[], needsAccount: boolean): Lamp => {
  if (integration.status === 'revoked') return { tone: 'fault', label: 'Withdrawn by its publisher' };
  if (!integration.enabled) return { tone: 'off', label: 'Disabled' };
  if (integration.status === 'testing') return { tone: 'attention', label: 'Run a test to activate' };
  const own = credentials.filter((credential) => credential.pluginId === integration.pluginId);
  if (needsAccount) {
    if (own.some((credential) => credential.status === 'connected')) return { tone: 'ready', label: 'Ready' };
    if (own.length > 0) return { tone: 'fault', label: own.some((credential) => credential.status === 'expired') ? 'Account expired' : 'Connection failed' };
    return { tone: 'attention', label: 'Connect an account' };
  }
  return { tone: 'ready', label: 'Ready' };
};

export const describePermission = (permission: string): string => {
  if (permission.startsWith('network:*.')) return `Send requests to any address under ${permission.slice('network:*.'.length)}`;
  if (permission.startsWith('network:')) return `Send requests to ${permission.slice('network:'.length)}`;
  if (permission === 'storage:read') return 'Read files stored in Universal Flow';
  if (permission === 'storage:write') return 'Save files in Universal Flow';
  if (permission === 'webhook:receive') return 'Receive incoming webhooks';
  return permission;
};

export const describeSource = (source: MarketplacePlugin['source']): string =>
  ({ official: 'Official', community: 'Community', custom: 'Your workspace' })[source];

export const installsLabel = (installs: number): string => (installs === 1 ? 'Used by 1 workspace' : `Used by ${installs.toLocaleString('en')} workspaces`);

const DAY_MS = 86_400_000;

export const relativeDate = (epochMs: number, now: number): string => {
  const days = Math.floor((now - epochMs) / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(epochMs).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
};

export type MarketplaceShelf = { id: string; title: string; description: string; plugins: MarketplacePlugin[] };

const byInstalls = (a: MarketplacePlugin, b: MarketplacePlugin) => b.installs - a.installs || a.name.localeCompare(b.name);
const byNewest = (a: MarketplacePlugin, b: MarketplacePlugin) => b.registeredAt - a.registeredAt || a.name.localeCompare(b.name);

/** Shelves for the marketplace front page; empty shelves are dropped. */
export const marketplaceShelves = (plugins: readonly MarketplacePlugin[], now: number): MarketplaceShelf[] => {
  const recent = plugins.filter((plugin) => now - plugin.registeredAt < 30 * DAY_MS);
  const shelves: MarketplaceShelf[] = [
    { id: 'featured', title: 'Featured', description: 'Official integrations maintained by Universal Flow.', plugins: plugins.filter((plugin) => plugin.source === 'official').sort(byInstalls).slice(0, 8) },
    { id: 'popular', title: 'Popular', description: 'Installed by the most workspaces.', plugins: plugins.filter((plugin) => plugin.installs > 0).sort(byInstalls).slice(0, 8) },
    { id: 'new', title: 'New', description: 'Published in the last 30 days.', plugins: [...recent].sort(byNewest).slice(0, 8) },
    { id: 'ai', title: 'AI applications', description: 'Language, image, video and voice models.', plugins: plugins.filter((plugin) => plugin.category.startsWith('ai-')).sort(byInstalls) },
    { id: 'community', title: 'Community plugins', description: 'Built by other developers and reviewed before listing.', plugins: plugins.filter((plugin) => plugin.source === 'community').sort(byInstalls) },
    { id: 'custom', title: 'Built in this workspace', description: 'Custom APIs your team added.', plugins: plugins.filter((plugin) => plugin.source === 'custom').sort(byNewest) },
  ];
  return shelves.filter((shelf) => shelf.plugins.length > 0);
};
