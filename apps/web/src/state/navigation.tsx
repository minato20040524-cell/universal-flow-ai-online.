import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

const LOCATION_EVENT = 'uf:navigate';

const subscribe = (onChange: () => void) => {
  window.addEventListener('popstate', onChange);
  window.addEventListener(LOCATION_EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(LOCATION_EVENT, onChange);
  };
};

const currentLocation = () => `${window.location.pathname}${window.location.search}`;

export const navigate = (to: string, options: { replace?: boolean } = {}) => {
  if (to === currentLocation()) return;
  if (options.replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  window.dispatchEvent(new Event(LOCATION_EVENT));
  window.scrollTo({ top: 0 });
};

/** Path and query of the current URL; re-renders on navigation. */
export const useLocation = () => {
  const location = useSyncExternalStore(subscribe, currentLocation);
  const url = new URL(location, window.location.origin);
  return { path: url.pathname, search: url.searchParams };
};

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string };

/** A real link (middle-click and copy work) that navigates without reloading. */
export const Link = ({ to, onClick, ...rest }: LinkProps) => {
  const { path } = useLocation();
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  const isCurrent = path === to || (to !== '/' && path.startsWith(`${to}/`));
  return <a href={to} onClick={handleClick} aria-current={isCurrent ? 'page' : undefined} {...rest} />;
};
