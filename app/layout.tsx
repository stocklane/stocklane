import type { Metadata } from "next";
import "./globals.css";
import AppShell from "@/components/AppShell";
import { AuthProvider } from "@/contexts/AuthContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { NotificationProvider } from "@/contexts/NotificationContext";

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export const metadata: Metadata = {
  title: "stocklane.ai",
  description: "Inventory and purchase order management",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className="antialiased bg-[#f9f9f8] dark:bg-stone-900 text-stone-900 dark:text-stone-100 font-sans"
      >
        <ThemeProvider>
          <AuthProvider>
            <NotificationProvider>
              <AppShell>{children}</AppShell>
            </NotificationProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
