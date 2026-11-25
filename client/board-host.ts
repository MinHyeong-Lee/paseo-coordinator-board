// The screen prop updates before Expo commits the browser URL on a host switch.
const storageKey = "coordinator-board:last-viewed-route";

export function rememberBoardRoute(storage: Storage, hostId: string) {
  storage.setItem(storageKey, `/h/${encodeURIComponent(hostId)}/plugin/coordinator-board/surface/board`);
}

function parseBoardRoute(pathname: string) {
  const match = /^\/h\/([^/]+)\/plugin\/coordinator-board\/surface\/board\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return { hostId: decodeURIComponent(match[1]) };
  } catch {
    return null;
  }
}

export function previousBoardRoute(storage: Storage, sidebarHost: string, configuredHosts: readonly string[], language: string) {
  const pathname = storage.getItem(storageKey);
  if (!pathname) return null;
  const route = parseBoardRoute(pathname);
  if (!route || route.hostId === sidebarHost || !configuredHosts.includes(route.hostId)) return null;
  return pathname + "?param.language=" + encodeURIComponent(language);
}
