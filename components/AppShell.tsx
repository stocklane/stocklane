'use client';

import type { ReactNode } from 'react';
import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import MobileNav from '@/components/MobileNav';
import { useAuth } from '@/contexts/AuthContext';

interface AppShellProps {
  children: ReactNode;
}

export default function AppShell({ children }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem('sl_sidebar_collapsed');
    if (stored !== null) {
      setCollapsed(stored === 'true');
    }
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted) {
      localStorage.setItem('sl_sidebar_collapsed', String(collapsed));
    }
  }, [collapsed, mounted]);
  const { user, loading } = useAuth();
  const pathname = usePathname();

  // Public routes that don't require authentication
  const publicRoutes = ['/login', '/signup', '/reset-password'];
  const isPublicRoute = publicRoutes.includes(pathname);

  // Show loading spinner while checking auth
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f9f9f8] dark:bg-stone-900">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-amber-600"></div>
      </div>
    );
  }

  // If not authenticated and not on public route, show login prompt
  if (!user && !isPublicRoute) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f9f9f8] dark:bg-stone-900 px-4">
        <div className="max-w-md w-full text-center">
          <h1 className="text-3xl font-bold text-stone-900 dark:text-stone-100 mb-4">Welcome to stocklane.ai</h1>
          <p className="text-stone-500 dark:text-stone-400 mb-8">Please sign in to access your inventory and purchase orders</p>
          <div className="space-y-4">
            <a
              href="/login"
              className="block w-full py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-amber-600 hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-600 dark:focus:ring-offset-stone-900"
            >
              Sign In
            </a>
            <a
              href="/signup"
              className="block w-full py-2 px-4 border border-stone-200 dark:border-stone-700 text-sm font-medium rounded-md text-stone-700 dark:text-stone-300 bg-white dark:bg-stone-800 hover:bg-stone-50 dark:hover:bg-stone-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-600 dark:focus:ring-offset-stone-900"
            >
              Create Account
            </a>
          </div>
        </div>
      </div>
    );
  }

  // If on public route, render without shell
  if (isPublicRoute) {
    return <>{children}</>;
  }

  // Authenticated user - show full app shell
  return (
    <div className="h-[100dvh] flex overflow-hidden bg-[#f9f9f8] dark:bg-stone-900">
      <MobileNav />
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((prev) => !prev)}
      />
      <main
        className={`flex-1 pb-20 sm:pb-0 pt-16 sm:pt-0 transition-[margin-left] duration-200 overflow-hidden min-w-0 flex flex-col ${collapsed ? 'sm:ml-24' : 'sm:ml-48 lg:ml-56'
          }`}
      >
        {children}
      </main>
    </div>
  );
}
