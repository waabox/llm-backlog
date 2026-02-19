import React, { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../contexts/AuthContext";

interface GoogleCredentialResponse {
	credential: string;
}

declare global {
	interface Window {
		google?: {
			accounts: {
				id: {
					initialize: (config: {
						client_id: string;
						callback: (response: GoogleCredentialResponse) => void;
					}) => void;
					renderButton: (
						element: HTMLElement,
						config: { theme: string; size: string; width: number },
					) => void;
				};
			};
		};
	}
}

interface LoginPageProps {
	clientId: string;
}

export default function LoginPage({ clientId }: LoginPageProps) {
	const [sdkLoaded, setSdkLoaded] = useState(false);
	const [isLoggingIn, setIsLoggingIn] = useState(false);
	const buttonRef = useRef<HTMLDivElement>(null);
	const { login, error, clearError } = useAuth();

	useEffect(() => {
		if (document.getElementById("google-signin-sdk")) {
			if ((window as any).google) setSdkLoaded(true);
			return;
		}

		const script = document.createElement("script");
		script.id = "google-signin-sdk";
		script.src = "https://accounts.google.com/gsi/client";
		script.async = true;
		script.onload = () => {
			setSdkLoaded(true);
		};
		document.head.appendChild(script);
	}, []);

	const handleCredential = useCallback(
		async (response: GoogleCredentialResponse) => {
			setIsLoggingIn(true);
			clearError();
			try {
				await login(response.credential);
			} catch {
				// Error handled by AuthContext
			} finally {
				setIsLoggingIn(false);
			}
		},
		[login, clearError],
	);

	useEffect(() => {
		if (!sdkLoaded || !window.google || !buttonRef.current) {
			return;
		}

		window.google.accounts.id.initialize({
			client_id: clientId,
			callback: handleCredential,
		});

		window.google.accounts.id.renderButton(buttonRef.current, {
			theme: "outline",
			size: "large",
			width: 300,
		});
	}, [sdkLoaded, clientId, handleCredential]);

	return (
		<div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-900">
			<div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-8 shadow-sm dark:border-gray-700 dark:bg-gray-800">
				<div className="mb-8 text-center">
					<h1 className="text-2xl font-bold text-gray-900 dark:text-white">
						Backlog.md
					</h1>
					<p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
						Sign in to continue
					</p>
				</div>

				{error && (
					<div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400">
						{error}
					</div>
				)}

				{isLoggingIn ? (
					<div className="flex justify-center">
						<div className="text-sm text-gray-500 dark:text-gray-400">
							Signing in...
						</div>
					</div>
				) : (
					<div className="flex justify-center">
						<div ref={buttonRef} />
					</div>
				)}

				{!sdkLoaded && !isLoggingIn && (
					<div className="flex justify-center">
						<div className="text-sm text-gray-400">Loading...</div>
					</div>
				)}
			</div>
		</div>
	);
}
