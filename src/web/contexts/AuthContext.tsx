import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ApiClient, apiClient } from "../lib/api";

interface AuthUser {
	email: string;
	name: string;
	role: string;
}

interface AuthContextType {
	user: AuthUser | null;
	isLoading: boolean;
	isAuthEnabled: boolean;
	clientId: string | null;
	login: (credential: string) => Promise<void>;
	logout: () => void;
	error: string | null;
	clearError: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
	const [user, setUser] = useState<AuthUser | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [isAuthEnabled, setIsAuthEnabled] = useState(false);
	const [clientId, setClientId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;

		const initialize = async () => {
			try {
				const status = await apiClient.fetchAuthStatus();

				if (cancelled) return;

				setIsAuthEnabled(status.enabled);
				setClientId(status.clientId ?? null);

				if (!status.enabled) {
					setIsLoading(false);
					return;
				}

				const token = ApiClient.getToken();
				if (token) {
					try {
						const me = await apiClient.fetchMe();
						if (!cancelled) {
							setUser(me);
						}
					} catch {
						ApiClient.clearToken();
					}
				}
			} catch {
				// Auth status check failed, assume auth is disabled
			} finally {
				if (!cancelled) {
					setIsLoading(false);
				}
			}
		};

		initialize();

		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		const handleUnauthorized = () => {
			setUser(null);
		};

		window.addEventListener("auth:unauthorized", handleUnauthorized);
		return () => {
			window.removeEventListener("auth:unauthorized", handleUnauthorized);
		};
	}, []);

	const login = useCallback(async (credential: string) => {
		try {
			const result = await apiClient.loginWithGoogle(credential);
			setUser(result.user);
			setError(null);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Login failed";
			setError(message);
			throw err;
		}
	}, []);

	const logout = useCallback(() => {
		apiClient.logout();
		setUser(null);
	}, []);

	const clearError = useCallback(() => {
		setError(null);
	}, []);

	return (
		<AuthContext.Provider
			value={{
				user,
				isLoading,
				isAuthEnabled,
				clientId,
				login,
				logout,
				error,
				clearError,
			}}
		>
			{children}
		</AuthContext.Provider>
	);
}

export function useAuth(): AuthContextType {
	const context = useContext(AuthContext);
	if (!context) {
		throw new Error("useAuth must be used within an AuthProvider");
	}
	return context;
}
