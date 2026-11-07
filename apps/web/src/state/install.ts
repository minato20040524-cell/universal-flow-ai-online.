import { useSyncExternalStore } from 'react';

/**
 * Installing the web app (a PWA). Chrome on Android and desktop fires
 * `beforeinstallprompt` once the app qualifies; it is kept here so an
 * "Install app" button can show the browser's own install dialog later.
 */

type InstallPromptEvent = Event & { prompt: () => Promise<void> };

const isInstallPrompt = (event: Event): event is InstallPromptEvent => 'prompt' in event && typeof event.prompt === 'function';

const listeners = new Set<() => void>();
let pending: InstallPromptEvent | undefined;

const notify = () => {
  for (const listener of listeners) listener();
};

/** Call once at startup, before React renders: the event can fire very early. */
export const startInstallSupport = (): void => {
  window.addEventListener('beforeinstallprompt', (event) => {
    if (!isInstallPrompt(event)) return;
    // Keep Chrome's own mini bar away; the app shows its button instead.
    event.preventDefault();
    pending = event;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    pending = undefined;
    notify();
  });
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    });
  }
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useInstallPrompt = () => {
  const available = useSyncExternalStore(subscribe, () => pending !== undefined);
  const install = async () => {
    const event = pending;
    if (!event) return;
    pending = undefined;
    notify();
    await event.prompt();
  };
  return { available, install };
};
