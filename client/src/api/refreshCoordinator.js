export const REFRESH_LOCK_NAME = 'hms_auth_refresh_lock';
export const STORAGE_ACCESS_KEY = 'hms_access_token';
export const STORAGE_REFRESH_KEY = 'hms_refresh_token';
export const STORAGE_SESSION_GENERATION_KEY = 'hms_auth_session_generation';

export class SessionChangedError extends Error {
  constructor(message = 'Session changed during refresh') {
    super(message);
    this.name = 'SessionChangedError';
  }
}

function sessionGeneration(storage) {
  return storage.getItem(STORAGE_SESSION_GENERATION_KEY) || '0';
}

export function advanceSessionGeneration(storage) {
  const current = Number(sessionGeneration(storage));
  const next = Number.isSafeInteger(current) ? current + 1 : Date.now();
  storage.setItem(STORAGE_SESSION_GENERATION_KEY, String(next));
}

export function isRefreshResultCurrent(storage, tokens) {
  return sessionGeneration(storage) === tokens.sessionGeneration
    && storage.getItem(STORAGE_ACCESS_KEY) === tokens.accessToken
    && storage.getItem(STORAGE_REFRESH_KEY) === tokens.refreshToken;
}

export function shouldRefreshAfterUnauthorized({ status, retried, refreshToken, url }) {
  return status === 401 && !retried && Boolean(refreshToken) && !url?.includes('/auth/');
}

export function createRefreshCoordinator({ lockManager, storage, refreshRequest, onTokens }) {
  let localRefreshPromise = null;

  return function synchronizedRefresh(failedRefreshToken) {
    if (localRefreshPromise) return localRefreshPromise;

    if (!lockManager || typeof lockManager.request !== 'function') {
      return Promise.reject(new Error('Cross-tab refresh requires the Web Locks API'));
    }

    localRefreshPromise = lockManager.request(
      REFRESH_LOCK_NAME,
      { mode: 'exclusive' },
      async () => {
        const currentRefresh = storage.getItem(STORAGE_REFRESH_KEY);
        const currentAccess = storage.getItem(STORAGE_ACCESS_KEY);
        const currentGeneration = sessionGeneration(storage);

        if (!currentRefresh) throw new SessionChangedError('No active refresh session');

        if (currentRefresh !== failedRefreshToken && currentAccess) {
          onTokens(currentAccess, currentRefresh);
          return {
            accessToken: currentAccess,
            refreshToken: currentRefresh,
            sessionGeneration: currentGeneration,
          };
        }

        let tokens;
        try {
          tokens = await refreshRequest(currentRefresh);
        } catch (error) {
          if (storage.getItem(STORAGE_REFRESH_KEY) !== currentRefresh
            || sessionGeneration(storage) !== currentGeneration) {
            throw new SessionChangedError();
          }
          storage.removeItem(STORAGE_ACCESS_KEY);
          storage.removeItem(STORAGE_REFRESH_KEY);
          throw error;
        }

        // Logout or account switching may happen while the network request is pending.
        if (storage.getItem(STORAGE_REFRESH_KEY) !== currentRefresh
          || sessionGeneration(storage) !== currentGeneration) {
          throw new SessionChangedError('Session changed while refresh was in progress');
        }

        storage.setItem(STORAGE_ACCESS_KEY, tokens.accessToken);
        storage.setItem(STORAGE_REFRESH_KEY, tokens.refreshToken);
        onTokens(tokens.accessToken, tokens.refreshToken);
        return { ...tokens, sessionGeneration: currentGeneration };
      }
    ).finally(() => {
      localRefreshPromise = null;
    });

    return localRefreshPromise;
  };
}
