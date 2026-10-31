import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/fraunces';
import '@fontsource-variable/manrope';
import './globals.css';
import { SessionProvider } from '@/components/session-provider';

export const metadata: Metadata = {
  title: 'SocietyOS',
  description: 'Residential society management and intelligent gate access control',
  applicationName: 'SocietyOS',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#0d2a24',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
