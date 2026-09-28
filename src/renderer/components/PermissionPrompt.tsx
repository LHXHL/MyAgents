import { useEffect, useRef, useState } from 'react';
import { ShieldAlert, Terminal, X, Check, CheckCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PermissionOperationDisplay, PermissionReview } from '../../shared/types/runtime';
import type { ToolPermissionHints } from '../../shared/types/toolPermission';

import type { LargeValueRef } from '../../shared/types/large-value';
import { getSessionPort } from '../api/tauriClient';
import { fetchJsonLargeValueRef } from '../api/largeValueRef';
import { PermissionReviewDetails } from './PermissionReviewDetails';
import { PermissionCommandDetails, type PermissionCommandDisplay } from './PermissionCommandDetails';

export interface PermissionRequest extends ToolPermissionHints {
    requestId: string;
    sessionId?: string | null;
    toolName: string;
    input: string;
    toolUseId?: string;
    rootToolUseId?: string;
    review?: PermissionReview;
    reviewRef?: LargeValueRef;
    display?: PermissionOperationDisplay;
    queuePosition?: number;
    queueTotal?: number;
}

interface PermissionPromptProps {
    request: PermissionRequest;
    onDecision: (requestId: string, decision: 'deny' | 'allow_once' | 'always_allow') => void | Promise<void>;
}

function legacyCommandDisplay(request: PermissionRequest): PermissionCommandDisplay | undefined {
    const tool = request.toolName.toLowerCase();
    const dialect = tool === 'pwsh' || tool === 'powershell' ? 'pwsh' : 'bash';
    if (request.display) return { ...request.display, dialect };
    if (!['bash', 'shell', 'pwsh', 'powershell'].includes(tool)) return undefined;
    try {
        const input: unknown = JSON.parse(request.input);
        if (!input || typeof input !== 'object' || !('command' in input) || typeof input.command !== 'string') return undefined;
        return {
            command: input.command, dialect,
            ...('cwd' in input && typeof input.cwd === 'string' ? { cwd: input.cwd } : {}),
            ...('description' in input && typeof input.description === 'string' ? { description: input.description } : {}),
        };
    } catch { return undefined; }
}

/**
 * Permission prompt card shown inline in the message flow
 * when Agent requests to use a tool that requires user confirmation
 */
export function PermissionPrompt({ request, onDecision }: PermissionPromptProps) {
    const { t } = useTranslation('chat');
    const [isResponding, setIsResponding] = useState(false);
    const [responded, setResponded] = useState(false);
    const [responseError, setResponseError] = useState<string | null>(null);
    const [fetchedDetails, setFetchedDetails] = useState<{ key: string; review?: PermissionReview; error?: string }>();
    const [detailsAttempt, setDetailsAttempt] = useState(0);
    const { sessionId } = request;
    const reviewRefId = request.reviewRef?.id;
    const reviewRefMime = request.reviewRef?.mimetype;
    const detailsKey = JSON.stringify([request.requestId, sessionId, reviewRefId, reviewRefMime, detailsAttempt]);
    const currentDetails = fetchedDetails?.key === detailsKey ? fetchedDetails : undefined;
    const loadedReview = reviewRefId ? currentDetails?.review : request.review;
    const sandboxEscalation = loadedReview?.scope.permissionClass === 'sandbox.escalation';
    const detailsError = currentDetails?.error;
    useEffect(() => {
        let cancelled = false;
        if (reviewRefId) {
            void (async () => {
                if (!sessionId) throw new Error('Permission details have no Session route');
                const port = await getSessionPort(sessionId);
                if (port === null) throw new Error('Permission Session is unavailable');
                const value = await fetchJsonLargeValueRef(`http://127.0.0.1:${port}`, { kind: 'ref', id: reviewRefId, mimetype: reviewRefMime });
                if (!cancelled) setFetchedDetails({ key: detailsKey, review: value as PermissionReview });
            })().catch((error: unknown) => { if (!cancelled) setFetchedDetails({ key: detailsKey, error: error instanceof Error ? error.message : String(error) }); });
        }
        return () => { cancelled = true; };
    }, [detailsKey, reviewRefId, reviewRefMime, sessionId]);
    const mountedRef = useRef(true);
    const denyRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (request.defaultToNo) denyRef.current?.focus();
    }, [request.requestId, request.defaultToNo]);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const handleDecision = async (decision: 'deny' | 'allow_once' | 'always_allow') => {
        if (isResponding || (decision === 'always_allow' && request.suppressAlwaysAllowRule)) return;
        const requestId = request.requestId;
        setIsResponding(true);
        setResponseError(null);
        try {
            await onDecision(requestId, decision);
            if (mountedRef.current) {
                setResponded(true);
            }
        } catch (error) {
            console.error('[PermissionPrompt] Permission response failed:', error);
            if (mountedRef.current) {
                setIsResponding(false);
                setResponseError(error instanceof Error ? error.message : String(error));
            }
        }
    };

    // Format tool name for display
    const formatToolName = (name: string) => {
        // mcp__playwright__browser_tabs -> Playwright: browser_tabs
        if (name.startsWith('mcp__')) {
            const parts = name.split('__');
            if (parts.length >= 3) {
                return `${parts[1]}: ${parts.slice(2).join('_')}`;
            }
        }
        return name;
    };

    // Format input for display - extract key info
    const formatInput = (input: string) => {
        try {
            const parsed = JSON.parse(input);
            // For common tools, show key parameters
            if (parsed.query) return parsed.query;
            if (parsed.command) return parsed.command;
            if (parsed.url) return parsed.url;
            if (parsed.file_path) return parsed.file_path;
            return JSON.stringify(parsed, null, 2);
        } catch {
            return input;
        }
    };

    // If already responded, show nothing
    if (responded) {
        return null;
    }

    const hasReview = !!(request.review || request.reviewRef);
    const awaitingDetails = hasReview && !loadedReview;
    // Structured review is authoritative, including while its full ref is loading.
    const commandDisplay = loadedReview?.operation?.kind === 'command'
        ? loadedReview.operation : hasReview ? undefined : legacyCommandDisplay(request);
    const actor = loadedReview?.actor;
    const formattedInput = hasReview ? '' : request.display?.command ?? formatInput(request.input);
    const queuePosition = request.queuePosition ?? 1;
    const queueTotal = request.queueTotal ?? 1;
    const showQueueProgress = queueTotal > 1;
    const progressPercent = Math.min(100, Math.max(0, (queuePosition / queueTotal) * 100));

    return (
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-200" data-tool-use-id={request.toolUseId} data-root-tool-use-id={request.rootToolUseId}>
            <div className="min-w-0 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 shadow-sm">
                {showQueueProgress && (
                    <div className="mb-3 animate-in fade-in slide-in-from-top-1 duration-200">
                        <div className="mb-1.5 text-xs font-medium text-[var(--ink-muted)]">
                            {t('shell.permissionPrompt.progress', { index: queuePosition, total: queueTotal })}
                        </div>
                        <div className="h-1 overflow-hidden rounded-full bg-[var(--warning)]/15">
                            <div
                                className="h-full rounded-full bg-[var(--warning)] transition-[width] duration-300 ease-out"
                                style={{ width: `${progressPercent}%` }}
                            />
                        </div>
                    </div>
                )}

                {commandDisplay ? <div className="flex min-w-0 items-center gap-2">
                    <Terminal className="size-4 shrink-0 text-[var(--warning)]" aria-hidden="true" />
                    <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
                        <h3 className="text-sm font-semibold text-[var(--ink)]">{t('shell.permissionPrompt.commandTitle', { shell: commandDisplay.dialect === 'pwsh' ? 'PowerShell' : 'Bash' })}</h3>
                        {actor && <span className="min-w-0 break-all text-xs text-[var(--ink-muted)]">{actor.origin === 'root' ? t('shell.permissionPrompt.rootAgent') : `${t('shell.permissionPrompt.childAgent')} · ${actor.agentId}`}</span>}
                    </div>
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--warning)]">
                        <span className="size-1 rounded-full bg-current" aria-hidden="true" />{t('shell.permissionPrompt.awaitingApproval')}
                    </span>
                </div> : <div className="flex items-center gap-2.5">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--warning)]/15">
                        <ShieldAlert className="h-4.5 w-4.5 text-[var(--warning)]" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-[var(--ink)]">{t(sandboxEscalation ? 'shell.permissionPrompt.sandboxTitle' : 'shell.permissionPrompt.title')}</div>
                        <div className="mt-0.5 text-xs text-[var(--ink-muted)]">{t(sandboxEscalation ? 'shell.permissionPrompt.sandboxSubtitle' : 'shell.permissionPrompt.subtitle')}</div>
                    </div>
                    <span className="flex items-center rounded-full bg-[var(--warning)]/15 px-2.5 py-1 text-xs font-medium text-[var(--warning)]">
                        {t('shell.permissionPrompt.badge')}
                    </span>
                </div>}

                {commandDisplay ? <PermissionCommandDetails key={detailsKey} {...commandDisplay} /> : <div className="mt-3 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning-bg)] p-3">
                    <span className="mb-1.5 inline-block rounded-md bg-[var(--warning)]/15 px-2 py-0.5 text-xs font-semibold text-[var(--warning)]">
                        {formatToolName(request.toolName)}
                    </span>
                    {loadedReview && <PermissionReviewDetails review={loadedReview} />}
                    {awaitingDetails && <div className="mt-2 text-xs text-[var(--ink-muted)]">
                        {detailsError ? <><p role="alert">{t('shell.permissionPrompt.detailsFailed')}: {detailsError}</p><button type="button" className="mt-1 underline" onClick={() => setDetailsAttempt(value => value + 1)}>{t('shell.permissionPrompt.retry')}</button></> : t('shell.permissionPrompt.loadingDetails')}
                    </div>}
                    {!hasReview && request.display?.description && (
                        <p className="mb-2 text-xs text-[var(--ink-secondary)]">{request.display.description}</p>
                    )}
                    {formattedInput && (
                        <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-[var(--ink-secondary)]">
                            {formattedInput}
                        </div>
                    )}
                    {!hasReview && request.display && (
                        <div className="mt-2 text-xs text-[var(--ink-muted)]">
                            <span>{t('shell.permissionPrompt.cwd')}: </span>
                            <span className="break-all font-mono">{request.display.cwd}</span>
                        </div>
                    )}
                </div>}

                {!commandDisplay && !hasReview && request.display?.alwaysAllowScope === 'session_workspace' && (
                    <p className="mt-2 text-xs leading-relaxed text-[var(--ink-muted)]">
                        {t('shell.permissionPrompt.sessionWorkspaceScope')}
                    </p>
                )}

                {responseError && <p role="alert" className="mt-2 text-xs text-[var(--error)]">{t('shell.permissionPrompt.responseFailed')}: {responseError}</p>}
                {/* Actions — 主操作（允许）实心琥珀靠右 */}
                <div className={`flex flex-wrap items-center gap-2 ${commandDisplay ? '-mx-4 -mb-4 mt-4 border-t border-[var(--line)] px-4 py-3' : 'mt-3'}`}>
                    <button
                        ref={denyRef}
                        type="button"
                        onClick={() => handleDecision('deny')}
                        disabled={isResponding}
                        className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50 ${commandDisplay ? 'text-sm' : 'border border-[var(--line)] text-xs hover:border-[var(--line-strong)]'}`}
                    >
                        {!commandDisplay && <X className="size-3.5" />}
                        <span>{t('shell.permissionPrompt.deny')}</span>
                    </button>

                    <div className="flex-1" />

                    {!request.suppressAlwaysAllowRule && <button
                        type="button"
                        onClick={() => handleDecision('always_allow')}
                        disabled={isResponding || awaitingDetails}
                        className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 font-medium transition-colors disabled:opacity-50 ${commandDisplay ? 'border-[var(--line)] text-sm text-[var(--ink-secondary)] hover:bg-[var(--paper-inset)]' : 'border-[var(--warning)]/20 bg-[var(--warning)]/10 text-xs text-[var(--warning)] hover:bg-[var(--warning)]/15'}`}
                    >
                        {!commandDisplay && <CheckCheck className="size-3.5" />}
                        <span>{t('shell.permissionPrompt.alwaysAllow')}</span>
                    </button>}

                    <button
                        type="button"
                        onClick={() => handleDecision('allow_once')}
                        disabled={isResponding || awaitingDetails}
                        className={`flex items-center gap-1.5 rounded-lg bg-[var(--warning)] px-3 py-1.5 font-medium text-[var(--on-warning)] transition-colors hover:brightness-110 disabled:opacity-50 ${commandDisplay ? 'text-sm' : 'text-xs'}`}
                    >
                        <Check className="size-3.5" />
                        <span>{t(commandDisplay || sandboxEscalation ? 'shell.permissionPrompt.allowOnce' : 'shell.permissionPrompt.allow')}</span>
                    </button>
                </div>
            </div>
        </div>
    );
}
