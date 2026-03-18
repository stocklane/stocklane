'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme, type ThemePreference } from '@/contexts/ThemeContext';
import { authenticatedFetch } from '@/lib/api-client';
import { supabase } from '@/lib/supabaseClient';
import { useSearchParams } from 'next/navigation';

interface AccountSettings {
  shopifyStoreDomain: string | null;
  shopifyConnected: boolean;
  shopifyConnectedAt: string | null;
}

export default function AccountPage() {
  const { user } = useAuth();
  const { theme, setTheme } = useTheme();
  const searchParams = useSearchParams();
  const [settings, setSettings] = useState<AccountSettings | null>(null);
  const [loading, setLoading] = useState(true);

  // Email form
  const [newEmail, setNewEmail] = useState('');
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailMessage, setEmailMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Shopify form
  const [shopifyDomain, setShopifyDomain] = useState('');
  const [shopifyConnecting, setShopifyConnecting] = useState(false);
  const [shopifySaving, setShopifySaving] = useState(false);
  const [shopifyMessage, setShopifyMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    loadSettings();

    // Check for OAuth callback params
    const shopifyStatus = searchParams.get('shopify');
    if (shopifyStatus === 'connected') {
      setShopifyMessage({ type: 'success', text: 'Shopify account connected successfully!' });
    } else if (shopifyStatus === 'error') {
      const msg = searchParams.get('message') || 'Failed to connect Shopify';
      setShopifyMessage({ type: 'error', text: msg });
    }
  }, [searchParams]);

  const loadSettings = async () => {
    try {
      const res = await authenticatedFetch('/api/account');
      const data = await res.json();
      if (data.success) {
        setSettings(data.data.settings);
        if (data.data.settings.shopifyStoreDomain) {
          setShopifyDomain(data.data.settings.shopifyStoreDomain);
        }
      }
    } catch (err) {
      console.error('Failed to load settings:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmail.trim()) return;

    setEmailSaving(true);
    setEmailMessage(null);

    try {
      const { error } = await supabase.auth.updateUser({ email: newEmail.trim() });

      if (!error) {
        setEmailMessage({ type: 'success', text: 'A confirmation link has been sent to your new email address. Please click it to complete the change.' });
        setNewEmail('');
      } else {
        setEmailMessage({ type: 'error', text: error.message || 'Failed to update email' });
      }
    } catch (err) {
      setEmailMessage({ type: 'error', text: 'Failed to update email' });
    } finally {
      setEmailSaving(false);
    }
  };

  const handleConnectShopify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shopifyDomain.trim()) return;

    setShopifyConnecting(true);
    setShopifyMessage(null);

    // Open a blank tab immediately to avoid popup blockers
    const authTab = window.open('about:blank', '_blank');

    try {
      // Call our OAuth initiation endpoint to get the Shopify auth URL
      const res = await authenticatedFetch(
        `/api/auth/shopify?shop=${encodeURIComponent(shopifyDomain.trim())}`
      );
      const data = await res.json();

      if (data.success && data.authUrl) {
        // Redirect the blank tab to Shopify's OAuth consent screen
        if (authTab) {
          authTab.location.href = data.authUrl;
        } else {
          // If popup was blocked anyway, try opening it now
          window.open(data.authUrl, '_blank');
        }
        
        setShopifyConnecting(false);
        setShopifyMessage({ type: 'success', text: 'Shopify authorization was opened in a new tab. Please complete the process there then return here.' });
      } else {
        if (authTab) authTab.close();
        setShopifyMessage({ type: 'error', text: data.error || 'Failed to start Shopify connection' });
        setShopifyConnecting(false);
      }
    } catch (err) {
      if (authTab) authTab.close();
      setShopifyMessage({ type: 'error', text: 'Failed to connect to Shopify' });
      setShopifyConnecting(false);
    }
  };

  const handleDisconnectShopify = async () => {
    if (!confirm('Are you sure you want to disconnect your Shopify account?')) return;

    setShopifySaving(true);
    setShopifyMessage(null);

    try {
      const res = await authenticatedFetch('/api/account', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'disconnect_shopify' }),
      });
      const data = await res.json();

      if (data.success) {
        setShopifyMessage({ type: 'success', text: data.message });
        setSettings({
          shopifyStoreDomain: null,
          shopifyConnected: false,
          shopifyConnectedAt: null,
        });
        setShopifyDomain('');
      } else {
        setShopifyMessage({ type: 'error', text: data.error || 'Failed to disconnect' });
      }
    } catch (err) {
      setShopifyMessage({ type: 'error', text: 'Failed to disconnect Shopify' });
    } finally {
      setShopifySaving(false);
    }
  };

  const themeOptions: { value: ThemePreference; label: string; icon: React.ReactNode }[] = [
    {
      value: 'light',
      label: 'Light',
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707M17.657 17.657l-.707-.707M6.343 6.343l-.707-.707M12 8a4 4 0 100 8 4 4 0 000-8z" />
        </svg>
      ),
    },
    {
      value: 'dark',
      label: 'Dark',
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        </svg>
      ),
    },
    {
      value: 'system',
      label: 'System',
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
      ),
    },
  ];

  return (
    <div className="h-full overflow-y-auto">
    <div className="max-w-2xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-stone-900 dark:text-stone-100 mb-8">Account Settings</h1>

      {/* Appearance Section */}
      <section className="bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 rounded-xl p-6 mb-6">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100 mb-1">Appearance</h2>
        <p className="text-sm text-stone-500 dark:text-stone-400 mb-4">Choose your preferred colour scheme.</p>
        <div className="flex gap-2">
          {themeOptions.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setTheme(opt.value)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                theme === opt.value
                  ? 'border-amber-600 bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
                  : 'border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-stone-700'
              }`}
            >
              {opt.icon}
              {opt.label}
            </button>
          ))}
        </div>
      </section>

      {/* Email Section */}
      <section className="bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 rounded-xl p-6 mb-6">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100 mb-1">Email Address</h2>
        <p className="text-sm text-stone-500 dark:text-stone-400 mb-4">
          Current email: <span className="text-stone-700 dark:text-stone-300">{user?.email}</span>
        </p>

        <form onSubmit={handleUpdateEmail} className="space-y-4">
          <div>
            <label htmlFor="newEmail" className="block text-sm font-medium text-stone-600 dark:text-stone-400 mb-1">
              New email address
            </label>
            <input
              id="newEmail"
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="Enter new email address"
              className="w-full px-3 py-2 bg-white dark:bg-stone-900 border border-stone-300 dark:border-stone-600 rounded-lg text-stone-900 dark:text-stone-100 text-sm placeholder-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:border-transparent"
              required
            />
          </div>

          {emailMessage && (
            <div
              className={`text-sm px-3 py-2 rounded-lg ${
                emailMessage.type === 'success'
                  ? 'bg-green-50 text-green-700 border border-green-200'
                  : 'bg-red-50 text-red-700 border border-red-200'
              }`}
            >
              {emailMessage.text}
            </div>
          )}

          <button
            type="submit"
            disabled={emailSaving || !newEmail.trim()}
            className="px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {emailSaving ? 'Updating...' : 'Update Email'}
          </button>
        </form>
      </section>

      {/* Shopify Section */}
      <section className="bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 rounded-xl p-6">
        <div className="flex items-center gap-3 mb-1">
          <img src="/Shopify_icon.svg" alt="Shopify" className="w-6 h-6" />
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">Shopify Integration</h2>
          {settings?.shopifyConnected && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700 border border-green-200">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
              Connected
            </span>
          )}
        </div>
        <p className="text-sm text-stone-500 dark:text-stone-400 mb-4">
          Link your Shopify store to sync orders and inventory.
        </p>

        {settings?.shopifyConnected ? (
          <div className="space-y-4">
            <div className="bg-stone-50 dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-stone-700 dark:text-stone-300">
                    {settings.shopifyStoreDomain}
                  </p>
                  {settings.shopifyConnectedAt && (
                    <p className="text-xs text-stone-500 dark:text-stone-400 mt-1">
                      Connected {new Date(settings.shopifyConnectedAt).toLocaleDateString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </p>
                  )}
                </div>
                <img src="/Shopify_icon.svg" alt="Shopify" className="w-8 h-8" />
              </div>
            </div>

            {shopifyMessage && (
              <div
                className={`text-sm px-3 py-2 rounded-lg ${
                  shopifyMessage.type === 'success'
                    ? 'bg-green-50 text-green-700 border border-green-200'
                    : 'bg-red-50 text-red-700 border border-red-200'
                }`}
              >
                {shopifyMessage.text}
              </div>
            )}

            <button
              onClick={handleDisconnectShopify}
              disabled={shopifySaving}
              className="px-4 py-2 bg-white dark:bg-stone-900 text-red-600 text-sm font-medium rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors border border-stone-300 dark:border-stone-600"
            >
              {shopifySaving ? 'Disconnecting...' : 'Disconnect Shopify'}
            </button>
            <Link
              href="/inventory/shopify-sync"
              className="inline-flex items-center gap-2 px-4 py-2 bg-white dark:bg-stone-900 text-stone-700 dark:text-stone-300 text-sm font-medium rounded-lg hover:bg-stone-50 dark:hover:bg-stone-700 transition-colors border border-stone-300 dark:border-stone-600"
            >
              <img src="/Shopify_icon.svg" alt="Shopify" className="w-4 h-4" />
              Open Shopify sync
            </Link>
          </div>
        ) : (
          <form onSubmit={handleConnectShopify} className="space-y-4">
            <div>
              <label htmlFor="shopifyDomain" className="block text-sm font-medium text-stone-600 mb-1">
                Store domain
              </label>
              <input
                id="shopifyDomain"
                type="text"
                value={shopifyDomain}
                onChange={(e) => setShopifyDomain(e.target.value)}
                placeholder="your-store.myshopify.com"
                className="w-full px-3 py-2 bg-white dark:bg-stone-900 border border-stone-300 dark:border-stone-600 rounded-lg text-stone-900 dark:text-stone-100 text-sm placeholder-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:border-transparent"
                required
              />
              <p className="text-xs text-stone-500 dark:text-stone-400 mt-1">
                e.g. your-store.myshopify.com
              </p>
            </div>

            {shopifyMessage && (
              <div
                className={`text-sm px-3 py-2 rounded-lg ${
                  shopifyMessage.type === 'success'
                    ? 'bg-green-50 text-green-700 border border-green-200'
                    : 'bg-red-50 text-red-700 border border-red-200'
                }`}
              >
                {shopifyMessage.text}
              </div>
            )}

            <button
              type="submit"
              disabled={shopifyConnecting || !shopifyDomain.trim()}
              className="px-4 py-2 bg-[#7ea33d] text-white text-sm font-medium rounded-lg hover:bg-[#8ebf4d] disabled:opacity-50 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-2"
            >
              <img src="/Shopify_icon.svg" alt="Shopify" className="w-4 h-4" />
              {shopifyConnecting ? 'Redirecting to Shopify...' : 'Connect with Shopify'}
            </button>
            <p className="text-xs text-stone-500 dark:text-stone-400">
              You&apos;ll be redirected to Shopify to authorize access to your store.
            </p>
          </form>
        )}
      </section>
    </div>
    </div>
  );
}
