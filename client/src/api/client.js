import axios from 'axios';
import {
  createRefreshCoordinator,
  isRefreshResultCurrent,
  SessionChangedError,
  shouldRefreshAfterUnauthorized,
  STORAGE_ACCESS_KEY,
  STORAGE_REFRESH_KEY,
} from './refreshCoordinator';

const baseURL = `${import.meta.env.VITE_API_URL || ''}/api`;

const client = axios.create({ baseURL });

let accessToken = null;
let refreshToken = null;
let onLogout = () => {};

/** Called once by AuthContext so this module can read/update the current session. */
export function configureAuth({ getTokens, onSessionExpired }) {
  const { access, refresh } = getTokens();
  accessToken = access;
  refreshToken = refresh;
  onLogout = onSessionExpired;
}

export function setTokens(access, refresh) {
  accessToken = access;
  if (refresh) refreshToken = refresh;
}

export function clearTokens() {
  accessToken = null;
  refreshToken = null;
}

client.interceptors.request.use((config) => {
  if (config._refreshSession) {
    if (!isRefreshResultCurrent(localStorage, config._refreshSession)) {
      throw new SessionChangedError('Session changed before request dispatch');
    }
    config.headers.Authorization = `Bearer ${config._refreshSession.accessToken}`;
  } else if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

const synchronizedRefresh = createRefreshCoordinator({
  get lockManager() {
    return typeof navigator === 'undefined' ? null : navigator.locks;
  },
  get storage() {
    return localStorage;
  },
  refreshRequest: async (token) => {
    const res = await axios.post(`${baseURL}/auth/refresh`, { refreshToken: token });
    return res.data.data;
  },
  onTokens: setTokens,
});

let refreshPromise = null;

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_ACCESS_KEY && event.key !== STORAGE_REFRESH_KEY) return;

    const latestAccess = localStorage.getItem(STORAGE_ACCESS_KEY);
    const latestRefresh = localStorage.getItem(STORAGE_REFRESH_KEY);
    if (latestAccess && latestRefresh) {
      setTokens(latestAccess, latestRefresh);
    } else if (!latestAccess && !latestRefresh) {
      clearTokens();
      onLogout();
    }
  });
}

client.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    const status = error.response?.status;

    if (shouldRefreshAfterUnauthorized({
      status,
      retried: original._retry,
      refreshToken,
      url: original.url,
    })) {
      original._retry = true;
      try {
        if (!refreshPromise) {
          const currentToken = refreshToken;
          refreshPromise = synchronizedRefresh(currentToken).finally(() => {
            refreshPromise = null;
          });
        }
        const tokens = await refreshPromise;
        if (!isRefreshResultCurrent(localStorage, tokens)) {
          throw new SessionChangedError('Session changed before request retry');
        }
        original._refreshSession = tokens;
        original.headers.Authorization = `Bearer ${tokens.accessToken}`;
        return client(original);
      } catch (refreshError) {
        if (!(refreshError instanceof SessionChangedError)) {
          clearTokens();
          onLogout();
        }
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);

export default client;
