'use client';

import { useState, useEffect, useRef } from 'react';
import { useNotifications } from '@/contexts/NotificationContext';

interface NotificationBellProps {
    position?: 'bottom-right' | 'top-right' | 'bottom-left' | 'top-left' | 'right-top';
    showLabel?: boolean;
    label?: string;
}

export default function NotificationBell({
    position = 'bottom-right',
    showLabel = false,
    label = 'Activity'
}: NotificationBellProps) {
    const { notifications, unreadCount, loading, markAllAsRead } = useNotifications();
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handleToggle = async () => {
        const nextState = !isOpen;
        setIsOpen(nextState);

        if (nextState && unreadCount > 0) {
            // Mark all as read when opening
            await markAllAsRead();
        }
    };

    const formatDate = (dateString: string) => {
        const date = new Date(dateString);
        return date.toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    };

    return (
        <div className={showLabel ? "w-full" : "relative"} ref={dropdownRef}>
            <button
                onClick={handleToggle}
                className={`flex items-center justify-center transition-colors text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 ${showLabel ? 'w-full px-3 py-2 rounded-xl gap-2' : 'p-2 rounded-full relative'
                    }`}
                aria-label={label}
            >
                <div className="relative">
                    <svg
                        className="w-4 h-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth="2"
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                        />
                    </svg>
                    {unreadCount > 0 && (
                        <span className={`absolute ${showLabel ? '-top-1 -right-1' : 'top-0 right-0'} block h-2 w-2 rounded-full bg-red-500 ring-2 ring-white dark:ring-stone-900`} />
                    )}
                </div>
                {showLabel && (
                    <span className="text-sm font-medium">{label}</span>
                )}
            </button>

            {isOpen && (
                <div className={`absolute ${position === 'bottom-right' ? 'right-0 mt-2 top-full' :
                    position === 'top-right' ? 'right-0 mb-2 bottom-full' :
                        position === 'bottom-left' ? 'left-0 mt-2 top-full' :
                            position === 'top-left' ? 'left-0 mb-2 bottom-full' :
                                position === 'right-top' ? `left-full ${showLabel ? 'ml-0' : 'ml-2'} bottom-0` :
                                    'right-0 mt-2 top-full'
                    } w-80 bg-white dark:bg-stone-800 rounded-xl shadow-xl border border-stone-200 dark:border-stone-700 z-50 overflow-hidden transform transition-all animate-in fade-in ${position.startsWith('top') ? 'slide-in-from-bottom-2' :
                        position.startsWith('right') ? 'slide-in-from-left-2' :
                            'slide-in-from-top-2'
                    } duration-200`}>
                    <div className="px-4 py-3 border-b border-stone-100 dark:border-stone-700 flex items-center justify-between">
                        <h3 className="text-sm font-semibold text-stone-900 dark:text-stone-100">Activity</h3>
                        {unreadCount > 0 && (
                            <span className="text-[10px] font-bold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400 px-1.5 py-0.5 rounded-full uppercase tracking-wider">
                                {unreadCount} New
                            </span>
                        )}
                    </div>
                    <div className="max-h-[400px] overflow-y-auto">
                        {loading ? (
                            <div className="p-8 text-center">
                                <div className="inline-block animate-spin rounded-full h-4 w-4 border-b-2 border-amber-600 mb-2"></div>
                                <p className="text-xs text-stone-500">Loading activity...</p>
                            </div>
                        ) : notifications.length === 0 ? (
                            <div className="p-8 text-center">
                                <p className="text-sm text-stone-500">No recent activity</p>
                            </div>
                        ) : (
                            <div className="divide-y divide-stone-50 dark:divide-stone-700/50">
                                {notifications.map((notification) => (
                                    <div
                                        key={notification.id}
                                        className={`px-4 py-3 transition-colors hover:bg-stone-50 dark:hover:bg-stone-700/50 ${!notification.is_read ? 'bg-amber-50/30 dark:bg-amber-900/10' : ''
                                            }`}
                                    >
                                        <div className="flex flex-col gap-1">
                                            <div className="flex items-center justify-between gap-2">
                                                <span className="text-[10px] font-bold text-amber-600 dark:text-amber-500 uppercase tracking-widest">
                                                    {notification.type}
                                                </span>
                                                <span className="text-[10px] text-stone-400 dark:text-stone-500 tabular-nums">
                                                    {formatDate(notification.created_at)}
                                                </span>
                                            </div>
                                            <p className="text-sm text-stone-900 dark:text-stone-200 leading-snug">
                                                {notification.message}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
