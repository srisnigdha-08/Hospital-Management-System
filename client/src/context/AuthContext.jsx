import { createContext, useCallback, useEffect, useState } from 'react';
import { authApi, patientApi } from '../api/endpoints';
import { configureAuth, setTokens, clearTokens } from '../api/client';
import { advanceSessionGeneration } from '../api/refreshCoordinator';

export const AuthContext = createContext(null);

const ACCESS_KEY = 'hms_access_token';
const REFRESH_KEY = 'hms_refresh_token';
const SESSION_CHANNEL = 'hms_auth_session';

function announceSessionEnded() {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(SESSION_CHANNEL);
  channel.postMessage({ type: 'session-ended' });
  channel.close();
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null); // Patient profile, when applicable
  const [isLoading, setIsLoading] = useState(true);

  const logout = useCallback(async (skipServerCall = false, announce = true) => {
    const refresh = localStorage.getItem(REFRESH_KEY);
    if (announce) advanceSessionGeneration(localStorage);
    clearTokens();
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    setUser(null);
    setProfile(null);
    if (announce) announceSessionEnded();

    if (!skipServerCall && refresh) {
      try {
        await authApi.logout(refresh);
      } catch {
        // Already unreachable/expired — proceed with local cleanup regardless.
      }
    }
  }, []);

  useEffect(() => {
    configureAuth({
      getTokens: () => ({
        access: localStorage.getItem(ACCESS_KEY),
        refresh: localStorage.getItem(REFRESH_KEY),
      }),
      onSessionExpired: () => logout(true),
    });
  }, [logout]);

  useEffect(() => {
    const channel = typeof BroadcastChannel === 'undefined'
      ? null
      : new BroadcastChannel(SESSION_CHANNEL);
    if (channel) {
      channel.onmessage = (event) => {
        if (event.data?.type === 'session-ended') logout(true, false);
      };
    }

    const handleStorage = (event) => {
      if (event.key !== ACCESS_KEY && event.key !== REFRESH_KEY) return;
      const access = localStorage.getItem(ACCESS_KEY);
      const refresh = localStorage.getItem(REFRESH_KEY);
      if (access && refresh) {
        setTokens(access, refresh);
      } else if (!access && !refresh) {
        clearTokens();
        setUser(null);
        setProfile(null);
      }
    };

    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
      channel?.close();
    };
  }, [logout]);

  const hydrateSession = useCallback(async () => {
    const access = localStorage.getItem(ACCESS_KEY);
    if (!access) {
      setIsLoading(false);
      return;
    }
    try {
      const { data } = await authApi.me();
      setUser(data.data.user);
      setProfile(data.data.profile);
    } catch {
      advanceSessionGeneration(localStorage);
      clearTokens();
      localStorage.removeItem(ACCESS_KEY);
      localStorage.removeItem(REFRESH_KEY);
      announceSessionEnded();
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    hydrateSession();
  }, [hydrateSession]);

  const persistSession = (accessToken, refreshToken, userData) => {
    localStorage.setItem(ACCESS_KEY, accessToken);
    localStorage.setItem(REFRESH_KEY, refreshToken);
    setTokens(accessToken, refreshToken);
    setUser(userData);
  };

  const login = async (email, password) => {
    const { data } = await authApi.login({ email, password });
    const { accessToken, refreshToken, user: userData } = data.data;
    persistSession(accessToken, refreshToken, userData);
    try {
      const meRes = await authApi.me();
      setProfile(meRes.data.data.profile);
    } catch {
      // ignore
    }
    return userData;
  };

  const register = async (payload) => {
    const { data } = await authApi.register(payload);
    const { accessToken, refreshToken, user: userData } = data.data;
    persistSession(accessToken, refreshToken, { ...userData, roleName: 'patient' });
    return userData;
  };

  const value = { user, profile, isLoading, login, register, logout, refreshProfile: hydrateSession };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
