'use client';

import { useCallback, useEffect, useState } from 'react';
import { Download, PlusSquare, Share, Smartphone, X } from 'lucide-react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export function PwaInstallPrompt({ onInstalled }: { onInstalled?: () => void }) {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isIos, setIsIos] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  const [dismissed, setDismissed] = useState(true); // default true until mounted
  const [showIosGuide, setShowIosGuide] = useState(false);

  useEffect(() => {
    // 1. Check if already installed / running standalone
    const standaloneMode =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    setIsStandalone(standaloneMode);
    if (standaloneMode) return;

    // 2. Check dismissal status safely
    try {
      const wasDismissed = sessionStorage.getItem('societyos_pwa_dismissed') === 'true';
      setDismissed(wasDismissed);
    } catch {
      setDismissed(false);
    }

    // 3. Detect iOS / iPadOS
    const ua = window.navigator.userAgent.toLowerCase();
    const isIosDevice =
      /iphone|ipad|ipod/.test(ua) ||
      (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
    setIsIos(isIosDevice);

    // 4. Register Service Worker for PWA installability & offline caching
    if ('serviceWorker' in navigator && typeof window !== 'undefined') {
      navigator.serviceWorker
        .register('/sw.js')
        .catch(() => {
          // SW registration progressive enhancement
        });
    }

    // 5. Listen for Chrome/Android beforeinstallprompt
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setDeferredPrompt(null);
      setIsStandalone(true);
      if (onInstalled) onInstalled();
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, [onInstalled]);

  // Handle escape key to dismiss iOS guide modal
  useEffect(() => {
    if (!showIosGuide) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowIosGuide(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showIosGuide]);

  const handleInstallClick = useCallback(async () => {
    if (deferredPrompt) {
      const promptEvent = deferredPrompt;
      setDeferredPrompt(null);
      try {
        await promptEvent.prompt();
        const choice = await promptEvent.userChoice;
        if (choice.outcome === 'accepted') {
          setIsStandalone(true);
          if (onInstalled) onInstalled();
        }
      } catch {
        // Prevent unhandled promise rejection if event state has expired
      }
    } else if (isIos) {
      setShowIosGuide(true);
    }
  }, [deferredPrompt, isIos, onInstalled]);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    setShowIosGuide(false);
    try {
      sessionStorage.setItem('societyos_pwa_dismissed', 'true');
    } catch {
      // Ignore sessionStorage exceptions in strict private modes
    }
  }, []);

  // Do not display if already standalone or user dismissed
  if (isStandalone) return null;
  if (dismissed && !showIosGuide) return null;
  // If neither Android install prompt nor iOS device, return null
  if (!deferredPrompt && !isIos) return null;

  return (
    <div className="pwa-install-banner" role="region" aria-label="Install SocietyOS App">
      <div className="pwa-install-content">
        <div className="pwa-install-icon" aria-hidden="true">
          <Smartphone size={22} strokeWidth={1.8} />
        </div>
        <div className="pwa-install-text">
          <div className="pwa-install-title">Install SocietyOS on your phone</div>
          <p className="pwa-install-desc">
            Add to your home screen for instant visitor passes, fast PIN sharing, and offline gate access.
          </p>
        </div>
      </div>

      <div className="pwa-install-actions">
        {deferredPrompt ? (
          <button
            className="btn btn-small btn-primary"
            type="button"
            onClick={() => void handleInstallClick()}
          >
            <Download size={14} /> Install App
          </button>
        ) : isIos ? (
          <button
            className="btn btn-small btn-primary"
            type="button"
            onClick={() => setShowIosGuide(true)}
          >
            <Download size={14} /> Install App
          </button>
        ) : null}

        <button
          className="btn-ghost btn-small"
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss install banner"
        >
          <X size={14} />
        </button>
      </div>

      {showIosGuide && (
        <div className="pwa-ios-modal-backdrop" onClick={() => setShowIosGuide(false)}>
          <div
            className="pwa-ios-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ios-guide-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="pwa-ios-head">
              <h3 id="ios-guide-title" className="pwa-ios-title">
                Install SocietyOS on iPhone & iPad
              </h3>
              <button
                className="btn-ghost btn-small"
                type="button"
                onClick={() => setShowIosGuide(false)}
                aria-label="Close guide"
              >
                <X size={16} />
              </button>
            </div>
            <div className="pwa-ios-steps">
              <div className="pwa-ios-step">
                <span className="pwa-ios-number">1</span>
                <div>
                  Tap the <strong>Share</strong> button in Safari's toolbar (bottom on iPhone, top on iPad){' '}
                  <span className="pwa-inline-badge">
                    <Share size={13} style={{ display: 'inline', verticalAlign: '-1px' }} /> Share
                  </span>
                  .
                </div>
              </div>
              <div className="pwa-ios-step">
                <span className="pwa-ios-number">2</span>
                <div>
                  Scroll down the share sheet and tap{' '}
                  <span className="pwa-inline-badge">
                    <PlusSquare size={13} style={{ display: 'inline', verticalAlign: '-1px' }} /> Add to
                    Home Screen
                  </span>
                  .
                </div>
              </div>
              <div className="pwa-ios-step">
                <span className="pwa-ios-number">3</span>
                <div>
                  Tap <strong>Add</strong> in the top-right corner. SocietyOS will appear as a native app
                  on your home screen.
                </div>
              </div>
            </div>
            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
              <button
                className="btn btn-primary btn-small"
                type="button"
                onClick={() => setShowIosGuide(false)}
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
