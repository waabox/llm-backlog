import React from 'react';
import ThemeToggle from './ThemeToggle';
import { useAuth } from '../contexts/AuthContext';

interface NavigationProps {
    projectName: string;
}

const Navigation: React.FC<NavigationProps> = ({projectName}) => {
    const { user, isAuthEnabled, logout } = useAuth();

    return (
        <nav className="px-8 h-18 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 transition-colors duration-200">
            <div className="h-full flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">{projectName || 'Loading...'}</h1>
                    <span className="text-sm text-gray-500 dark:text-gray-400">powered by</span>
                    <a
                        href="https://backlog.md"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-stone-600 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-300 hover:underline transition-colors duration-200"
                    >
                        Backlog.md
                    </a>
                </div>
                <div className="flex items-center gap-4">
                    {isAuthEnabled && user && (
                        <div className="flex items-center gap-3">
                            <span className="text-sm text-gray-600 dark:text-gray-400">
                                {user.name}
                                {user.role === "viewer" && (
                                    <span className="ml-1 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                                        viewer
                                    </span>
                                )}
                            </span>
                            <button
                                type="button"
                                onClick={logout}
                                className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
                            >
                                Sign out
                            </button>
                        </div>
                    )}
                    <ThemeToggle />
                </div>
            </div>
        </nav>
    );
};

export default Navigation;