'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { authenticatedFetch } from '@/lib/api-client';
import { useAuth } from './AuthContext';

interface Notification {
    id: string;
    type: string;
    message: string;
    metadata: any;
    is_read: boolean;
    created_at: string;
}

interface NotificationContextType {
    notifications: Notification[];
    unreadCount: number;
    loading: boolean;
    refresh: () => Promise<void>;
    markAllAsRead: () => Promise<void>;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

export function NotificationProvider({ children }: { children: ReactNode }) {
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [loading, setLoading] = useState(true);
    const { user } = useAuth();

    const fetchNotifications = useCallback(async () => {
        if (!user) return;

        try {
            const response = await authenticatedFetch('/api/notifications');
            if (response.ok) {
                const data = await response.json();
                if (data.notifications) {
                    setNotifications(data.notifications);
                }
            }
        } catch (error) {
            console.error('Failed to fetch notifications:', error);
        } finally {
            setLoading(false);
        }
    }, [user]);

    useEffect(() => {
        if (user) {
            fetchNotifications();
            // Poll every 5 minutes instead of 1 minute to reduce load
            // since we can also refresh manually or when opening the bell
            const interval = setInterval(fetchNotifications, 300000);
            return () => clearInterval(interval);
        } else {
            setNotifications([]);
            setLoading(false);
        }
    }, [user, fetchNotifications]);

    const markAllAsRead = useCallback(async () => {
        if (!user || notifications.filter(n => !n.is_read).length === 0) return;

        try {
            await authenticatedFetch('/api/notifications', {
                method: 'PATCH',
                body: JSON.stringify({}),
            });
            setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
        } catch (error) {
            console.error('Failed to mark notifications as read:', error);
        }
    }, [user, notifications]);

    const unreadCount = notifications.filter((n) => !n.is_read).length;

    const value = {
        notifications,
        unreadCount,
        loading,
        refresh: fetchNotifications,
        markAllAsRead,
    };

    return (
        <NotificationContext.Provider value={value}>
            {children}
        </NotificationContext.Provider>
    );
}

export function useNotifications() {
    const context = useContext(NotificationContext);
    if (context === undefined) {
        throw new Error('useNotifications must be used within a NotificationProvider');
    }
    return context;
}
