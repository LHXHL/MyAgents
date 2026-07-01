import React from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

import AppErrorBoundary from './components/AppErrorBoundary';
import { ConfigProvider } from './config/ConfigProvider';
import { ToastProvider } from './components/Toast';
import { ImagePreviewProvider } from './context/ImagePreviewContext';
import { FloatingI18nBootstrap } from './i18n/FloatingI18nBootstrap';
import { I18nLanguageSync } from './i18n/I18nLanguageSync';
import { initFrontendLogger, setLogServerUrl, setRendererLogLabel } from './utils/frontendLogger';
import { installMacFunctionKeyGuard } from './utils/macFunctionKeyGuard';
import { installOverlayScrollbarActivity, isWindowsRendererPlatform } from './utils/overlayScrollbarActivity';

import './i18n';
import './index.css';

// Initialize frontend logger to capture React console logs
initFrontendLogger();

// Block macOS WKWebView's NSEvent function-key tofu leak globally —
// see utils/macFunctionKeyGuard.ts. Must run before React mounts so the
// document-level capture handler is attached when the first input fires.
installMacFunctionKeyGuard();

function installPlatformClass(): void {
  const platform = navigator.platform || '';
  const userAgent = navigator.userAgent || '';
  const platformText = `${platform} ${userAgent}`.toLowerCase();
  const html = document.documentElement;
  html.classList.toggle('platform-windows', isWindowsRendererPlatform(platform, userAgent));
  html.classList.toggle('platform-macos', platformText.includes('mac'));
  html.classList.toggle('platform-linux', platformText.includes('linux') || platformText.includes('x11'));
}

installPlatformClass();
installOverlayScrollbarActivity();

// Block native "Reload / Inspect Element" context menu in production.
// Keep native menu for: input fields, text selection, contenteditable, links, images, media.
if (!import.meta.env.DEV) {
  document.addEventListener('contextmenu', (e) => {
    const el = e.target as HTMLElement;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'A' || tag === 'IMG'
      || tag === 'VIDEO' || tag === 'AUDIO' || el.isContentEditable) return;
    if (window.getSelection()?.toString()) return;
    e.preventDefault();
  });
}

const root = createRoot(document.getElementById('root')!);

function bootstrapFloatingWindowLogSink(label: string): void {
  console.info(`[${label}] window boot`);
  void import('./api/tauriClient')
    .then(async ({ getGlobalServerUrlWithWait, updateGlobalServerUrl }) => {
      void import('./utils/tauriListen')
        .then(({ listenWithCleanup }) => {
          const ac = new AbortController();
          void listenWithCleanup<string>('global-sidecar:restarted', (event) => {
            const url = event.payload;
            if (!url) return;
            updateGlobalServerUrl(url);
            setLogServerUrl(url);
            console.info(`[${label}] unified log sink rebound after global restart: ${url}`);
          }, ac.signal);
        })
        .catch((err) => {
          console.warn(`[${label}] global sidecar restart listener unavailable:`, err);
        });
      const url = await getGlobalServerUrlWithWait();
      if (!url) return;
      setLogServerUrl(url);
      console.info(`[${label}] unified log sink ready: ${url}`);
    })
    .catch((err) => {
      console.warn(`[${label}] unified log sink unavailable:`, err);
    });
}

// Floating ball windows (PRD 0.2.35): the ball + companion are separate Tauri
// WebviewWindows loading this same bundle. Route by window label — they mount
// their own minimal trees (no App / ConfigProvider; they read config via the
// service layer directly). App itself is lazy so the two tiny fb windows never
// parse/execute the multi-MB main-app chunk (and the main window pays only a
// microtask + local chunk fetch).
let tauriWindowLabel: string | undefined;
try {
  tauriWindowLabel = getCurrentWebviewWindow().label;
} catch {
  tauriWindowLabel = undefined; // browser dev mode — no Tauri runtime
}

if (tauriWindowLabel === 'fb-ball') {
  setRendererLogLabel('fb-ball');
  bootstrapFloatingWindowLogSink('fb-ball');
  const BallWindow = React.lazy(() => import('./floating-ball/BallWindow'));
  document.documentElement.classList.add('fb-transparent');
  root.render(
    <AppErrorBoundary>
      <FloatingI18nBootstrap>
        <React.Suspense fallback={null}>
          <BallWindow />
        </React.Suspense>
      </FloatingI18nBootstrap>
    </AppErrorBoundary>
  );
} else if (tauriWindowLabel === 'fb-companion') {
  setRendererLogLabel('fb-companion');
  bootstrapFloatingWindowLogSink('fb-companion');
  const CompanionWindow = React.lazy(() => import('./floating-ball/CompanionWindow'));
  document.documentElement.classList.add('fb-transparent');
  root.render(
    <AppErrorBoundary>
      <FloatingI18nBootstrap>
        <ToastProvider>
          <ImagePreviewProvider>
            <React.Suspense fallback={null}>
              <CompanionWindow />
            </React.Suspense>
          </ImagePreviewProvider>
        </ToastProvider>
      </FloatingI18nBootstrap>
    </AppErrorBoundary>
  );
} else if (tauriWindowLabel === 'fb-shield') {
  setRendererLogLabel('fb-shield');
  const ShieldWindow = React.lazy(() => import('./floating-ball/ShieldWindow'));
  document.documentElement.classList.add('fb-transparent');
  root.render(
    <AppErrorBoundary>
      <React.Suspense fallback={null}>
        <ShieldWindow />
      </React.Suspense>
    </AppErrorBoundary>
  );
} else {
  const App = React.lazy(() => import('./App'));
  // Note: React.StrictMode removed to prevent double-rendering of SSE effects in development
  // StrictMode causes useEffect to run twice, which duplicates SSE events and thinking blocks
  root.render(
    <AppErrorBoundary>
      <ConfigProvider>
        <I18nLanguageSync />
        <ToastProvider>
          <ImagePreviewProvider>
            <React.Suspense fallback={null}>
              <App />
            </React.Suspense>
          </ImagePreviewProvider>
        </ToastProvider>
      </ConfigProvider>
    </AppErrorBoundary>
  );
}
