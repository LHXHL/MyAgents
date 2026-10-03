import { AlertIcon, LoaderIcon } from '@/components/icons';
import { useTranslation } from 'react-i18next';
import type { ImageAttachment } from '@/components/chat-input/types';

/**
 * Unified "AI 启动中" boot overlay — the frosted-glass loading state shown from the
 * instant a chat is entered (Launcher→Chat) until the session is ready.
 *
 * Rendered in TWO phases so the whole entry is ONE continuous loading state:
 *   1. App's Suspense fallback while the lazy Chat chunk resolves (before mount) —
 *      replaces the old blank paper div that read as "nothing happened".
 *   2. Chat's in-page overlay during the sidecar cold boot (after mount), driven by
 *      the `show` prop.
 *
 * The shell stays mounted so a persisted restore can re-arm it without a remount
 * gap. Dismiss is animated; appearance is instant (no enter transition),
 * which prevents the old content from flashing before the shell becomes opaque.
 */
export default function ChatBootOverlay({
    show = true,
    error = null,
    onRetry,
    initialMessage,
}: {
    show?: boolean;
    error?: string | null;
    onRetry?: () => void;
    initialMessage?: { text: string; images?: ImageAttachment[] };
}) {
    const { t } = useTranslation('chat');
    const hasError = show && Boolean(error);

    return (
        <div
            aria-hidden={!show}
            aria-live={show ? 'polite' : undefined}
            className={`absolute inset-0 z-30 flex ${initialMessage ? 'flex-col justify-start gap-6 overflow-y-auto px-6 py-8' : 'items-center justify-center'} bg-[var(--paper-elevated)]/80 backdrop-blur-sm ${show ? 'opacity-100' : 'pointer-events-none opacity-0 transition-opacity duration-300 ease-out'}`}
        >
            {initialMessage && (
                <div className="mx-auto flex w-full max-w-3xl flex-col items-end gap-3" data-startup-query>
                    {initialMessage.images?.map(image => (
                        <img key={image.id} src={image.preview} alt={image.name ?? image.file?.name ?? ''} className="h-24 max-w-full rounded-lg object-contain" />
                    ))}
                    {initialMessage.text && (
                        <article className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-[var(--message-user-bg)] p-4 text-[var(--ink)]">
                            {initialMessage.text}
                        </article>
                    )}
                </div>
            )}
            <div className={`flex max-w-md flex-col items-center gap-3 px-6 text-center ${initialMessage ? 'self-center' : ''}`}>
                {hasError
                    ? <AlertIcon className="h-6 w-6 text-[var(--error)]" />
                    : <LoaderIcon className={`h-6 w-6 text-[var(--ink-muted)] ${show ? 'animate-spin' : ''}`} />}
                <p className="text-sm text-[var(--ink-muted)]">
                    {hasError ? t('shell.boot.restoreFailed') : t('shell.boot.loading')}
                </p>
                {hasError && <p className="text-xs text-[var(--ink-faint)]">{error}</p>}
                {hasError && onRetry && (
                    <button
                        type="button"
                        onClick={onRetry}
                        className="rounded-md border border-[var(--line)] px-3 py-1.5 text-xs text-[var(--ink-muted)] hover:bg-[var(--paper-hover)] hover:text-[var(--ink)]"
                    >
                        {t('shell.boot.retry')}
                    </button>
                )}
            </div>
        </div>
    );
}
