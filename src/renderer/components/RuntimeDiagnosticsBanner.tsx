/**
 * RuntimeDiagnosticsBanner — surface blocking Runtime failures and actionable
 * Managed Codex extension lifecycle states in the chat header (issue #194).
 *
 * Design rules (v2 — post user feedback):
 *
 * 1. **Only blocking or extension-actionable issues render here.** Anything the user can still keep
 *    working through (e.g. `app/list` 403 — apps unavailable but chat works,
 *    individual MCP server failed — others still usable, feature flag query
 *    failed — purely informational) is logged via `chat:log` instead and is
 *    visible in the Logs panel. Non-blocking noise on the chat header was the
 *    bug v1 of this banner had: users saw yellow warning for every transient
 *    Codex backend hiccup.
 *
 *    Actionable set today:
 *      • `auth.requiresLogin === true` — without a credential, every turn
 *        will 401 immediately. User must `codex login` (or equivalent).
 *      • All four diagnostic RPCs returned errors — suggests Codex itself
 *        is broken, not a single subsystem.
 *      • Extension snapshot failed, is waiting for a restart/idle boundary,
 *        or contains an unsupported component the user must resolve.
 *        Invalid optional component entries are skipped and stay in logs.
 *
 * 2. **Always visible close button.** v1 made the X conditional on a
 *    `onDismiss` prop the caller forgot to pass — so the banner had no way
 *    to be dismissed at all. v2 uses internal dismissal state, automatically
 *    reset when a NEW diagnostic snapshot arrives (different timestamp), so
 *    each meaningful diagnostic event is shown at most once.
 *
 * 3. **Expanded view kept** for the rare case the banner does fire — shows
 *    the full picture (auth / features / MCP / apps / env). Click banner
 *    title to expand/collapse.
 */

import { AlertTriangle, Bot, ChevronDown, ChevronRight, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  RuntimeDiagnostics,
  RuntimeDiagnosticsCallStatus,
} from '../../shared/types/runtime';

interface RuntimeDiagnosticsBannerProps {
  diagnostics: RuntimeDiagnostics | null;
  onDiagnose?: (diagnostics: RuntimeDiagnostics) => void;
}

/** Tight definition: things the user CANNOT proceed without fixing. */
interface BlockingAssessment {
  isBlocking: boolean;
  /** Headline shown next to the disclosure caret. Single line, ≤ 60 chars. */
  headline: string;
  /** All actionable problems (blocking + adjacent context). Shown in expanded view. */
  allProblems: string[];
}

function statusError(s: RuntimeDiagnosticsCallStatus | undefined): string | null {
  if (s && typeof s === 'object' && 'error' in s) return String(s.error);
  return null;
}

type ChatTranslator = (key: string, options?: Record<string, unknown>) => string;

function assessBlocking(d: RuntimeDiagnostics, t: ChatTranslator): BlockingAssessment {
  const allProblems: string[] = [];

  const authErr = statusError(d.status.auth);
  const appsErr = statusError(d.status.apps);
  const mcpErr = statusError(d.status.mcpServers);
  const featErr = statusError(d.status.features);

  // ── Collect ALL problems for expanded-view context ──
  if (d.auth?.requiresLogin) allProblems.push(t('shell.runtimeDiagnostics.problems.needsCodexLogin'));
  if (authErr) allProblems.push(t('shell.runtimeDiagnostics.problems.authQueryFailed', { error: authErr.slice(0, 80) }));
  if (appsErr) allProblems.push(t('shell.runtimeDiagnostics.problems.appListFailed', { error: appsErr.slice(0, 80) }));
  if (mcpErr) allProblems.push(t('shell.runtimeDiagnostics.problems.mcpStatusFailed', { error: mcpErr.slice(0, 80) }));
  if (featErr) allProblems.push(t('shell.runtimeDiagnostics.problems.featureFlagFailed', { error: featErr.slice(0, 80) }));
  if (d.apps) {
    const inaccessible = d.apps.filter(a => a.isEnabled && !a.isAccessible);
    if (inaccessible.length > 0) {
      const names = inaccessible.map(a => a.id).slice(0, 3).join(', ');
      const more = inaccessible.length > 3 ? '…' : '';
      allProblems.push(t('shell.runtimeDiagnostics.problems.appsInaccessible', {
        count: inaccessible.length,
        names: `${names}${more}`,
      }));
    }
  }
  if (d.mcpServers) {
    const failed = d.mcpServers.filter(s => s.state === 'failed');
    if (failed.length > 0) {
      allProblems.push(t('shell.runtimeDiagnostics.problems.mcpServersFailed', {
        names: failed.map(s => s.name).slice(0, 3).join(', '),
      }));
    }
  }
  if (d.issues) {
    for (const issue of d.issues) {
      allProblems.push(`${issue.title}：${issue.message.slice(0, 100)}`);
    }
  }
  const hasUnsupportedExtensionComponent = d.extensions?.components.some(
    component => component.state === 'unsupported',
  ) ?? false;

  // ── Decide blocking ──
  const blockingIssue = d.issues?.find(issue => issue.severity === 'error');
  if (blockingIssue) {
    return {
      isBlocking: true,
      headline: blockingIssue.title.slice(0, 60),
      allProblems,
    };
  }
  if (d.extensions?.state === 'failed') {
    return {
      isBlocking: true,
      headline: t('shell.runtimeDiagnostics.headlines.extensionsFailed'),
      allProblems,
    };
  }
  if (d.extensions?.state === 'deferred_until_idle') {
    return {
      isBlocking: true,
      headline: t('shell.runtimeDiagnostics.headlines.extensionsDeferred'),
      allProblems,
    };
  }
  if (d.extensions?.state === 'pending_next_start') {
    return {
      isBlocking: true,
      headline: t('shell.runtimeDiagnostics.headlines.extensionsPending'),
      allProblems,
    };
  }
  if (hasUnsupportedExtensionComponent) {
    return {
      isBlocking: true,
      headline: t('shell.runtimeDiagnostics.headlines.extensionsPartial'),
      allProblems,
    };
  }
  // Rule A: explicitly needs login → cannot proceed
  if (d.auth?.requiresLogin) {
    return { isBlocking: true, headline: t('shell.runtimeDiagnostics.headlines.needsCodexLogin'), allProblems };
  }
  // Rule B: every diagnostic RPC errored → runtime is fundamentally broken
  const allFour = [authErr, appsErr, mcpErr, featErr].filter(Boolean).length;
  if (allFour >= 4) {
    return {
      isBlocking: true,
      headline: t('shell.runtimeDiagnostics.headlines.allDiagnosticsFailed'),
      allProblems,
    };
  }
  // Everything else is non-blocking → no banner. Logs panel still has it.
  return { isBlocking: false, headline: '', allProblems };
}

function renderStatusLabel(s: RuntimeDiagnosticsCallStatus | undefined, t: ChatTranslator): string {
  if (s === 'ok') return 'ok';
  if (s === 'unsupported') return t('shell.runtimeDiagnostics.status.unsupported');
  if (s && typeof s === 'object' && 'error' in s) {
    return t('shell.runtimeDiagnostics.status.failed', { error: String(s.error).slice(0, 100) });
  }
  return t('shell.runtimeDiagnostics.status.notReported');
}

export default function RuntimeDiagnosticsBanner({
  diagnostics,
  onDiagnose,
}: RuntimeDiagnosticsBannerProps) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Reset dismissal whenever a fresh diagnostic snapshot arrives. The
  // timestamp is the natural identity — same RuntimeDiagnostics props can
  // re-arrive if the user navigates away and back, but a NEW snapshot
  // (after session restart / runtime re-init) means the user should see
  // it again.
  //
  // Using React's "Reset state on prop change" pattern (render-time setState
  // with a prev-value guard) rather than useEffect — same shape as
  // TerminalReasonBanner. Avoids the `react-hooks/set-state-in-effect`
  // anti-pattern lint and runs synchronously without an extra commit cycle.
  const [prevTimestamp, setPrevTimestamp] = useState(diagnostics?.timestamp);
  if (diagnostics?.timestamp !== prevTimestamp) {
    setPrevTimestamp(diagnostics?.timestamp);
    setDismissed(false);
    setExpanded(false);
  }

  const assessment = useMemo(
    () => (diagnostics ? assessBlocking(diagnostics, t) : null),
    [diagnostics, t],
  );

  if (!diagnostics || !assessment) return null;
  // Silently swallow non-actionable diagnostics.
  // Sidecar emits them as chat:log entries which surface in the Logs panel.
  if (!assessment.isBlocking) return null;
  if (dismissed) return null;

  return (
    <div className="relative z-10 flex-shrink-0 border-b border-[var(--line)] bg-[var(--warning-bg)] px-4 py-2 text-xs text-[var(--ink)]">
      <div className="mx-auto flex max-w-3xl items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--warning)]" />
        <div className="flex-1 min-w-0">
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            className="flex items-center gap-1 font-semibold hover:underline focus:outline-none"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {assessment.headline}
          </button>
          {expanded && (
            <div className="mt-2 space-y-3">
              {assessment.allProblems.length > 0 && (
                <div>
                  <div className="font-semibold mb-1">{t('shell.runtimeDiagnostics.sections.problems')}</div>
                  <ul className="list-disc pl-4 space-y-0.5">
                    {assessment.allProblems.map((p, i) => <li key={i}>{p}</li>)}
                  </ul>
                </div>
              )}

              <div>
                {diagnostics.extensions && (
                  <div>
                    <div className="font-semibold">
                      {t('shell.runtimeDiagnostics.sections.extensions')} [{diagnostics.extensions.state}]
                    </div>
                    <div className="text-[var(--ink-muted)] font-mono text-xs leading-tight">
                      desired: {diagnostics.extensions.desiredRevision.slice(0, 12) || '(none)'} • effective: {diagnostics.extensions.effectiveRevision?.slice(0, 12) ?? '(none)'}
                    </div>
                    <ul className="list-disc pl-4 mt-1 space-y-0.5 text-[var(--ink-muted)]">
                      {diagnostics.extensions.components.map((item, index) => (
                        <li key={`${item.component}:${item.id ?? ''}:${item.code}:${index}`}>
                          {t('shell.runtimeDiagnostics.problems.extensionComponent', {
                            component: item.component,
                            id: item.id ? `/${item.id}` : '',
                            state: item.state,
                            reason: item.message ?? item.code,
                          })}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div>
                <div className="font-semibold">
                  {t('shell.runtimeDiagnostics.sections.auth')} [{renderStatusLabel(diagnostics.status.auth, t)}]
                </div>
                {diagnostics.auth && (
                  <div className="text-[var(--ink-muted)]">
                    method: {diagnostics.auth.authMethod ?? '(null)'}
                    {diagnostics.auth.requiresLogin && t('shell.runtimeDiagnostics.requiresLoginSuffix')}
                  </div>
                )}
              </div>

              <div>
                <div className="font-semibold">
                  {t('shell.runtimeDiagnostics.sections.featureFlags')} [{renderStatusLabel(diagnostics.status.features, t)}]
                </div>
                {diagnostics.features && diagnostics.features.length > 0 && (
                  <div className="text-[var(--ink-muted)] flex flex-wrap gap-x-2 gap-y-0.5">
                    {diagnostics.features.slice(0, 12).map(f => (
                      <span key={f.name} className={f.enabled ? '' : 'opacity-60 line-through'}>
                        {f.name}
                      </span>
                    ))}
                    {diagnostics.features.length > 12 && <span>(+{diagnostics.features.length - 12})</span>}
                  </div>
                )}
              </div>

              <div>
                <div className="font-semibold">
                  {t('shell.runtimeDiagnostics.sections.mcpServers')} [{renderStatusLabel(diagnostics.status.mcpServers, t)}]
                </div>
                {diagnostics.mcpServers && diagnostics.mcpServers.length > 0 && (
                  <ul className="list-disc pl-4 space-y-0.5 text-[var(--ink-muted)]">
                    {diagnostics.mcpServers.map(s => (
                      <li key={s.name}>
                        {s.name} • tools={s.toolCount} resources={s.resourceCount ?? 0}
                        {s.authStatus ? ` • auth=${s.authStatus}` : ''}
                        {s.state ? ` • state=${s.state}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <div className="font-semibold">
                  {t('shell.runtimeDiagnostics.sections.apps')} [{renderStatusLabel(diagnostics.status.apps, t)}]
                </div>
                {diagnostics.apps && diagnostics.apps.length > 0 && (
                  <ul className="list-disc pl-4 space-y-0.5 text-[var(--ink-muted)]">
                    {diagnostics.apps.map(a => (
                      <li
                        key={a.id}
                        className={a.isEnabled && !a.isAccessible ? 'text-[var(--warning)]' : ''}
                      >
                        {a.isEnabled ? '✅ ' : '⚪ '}
                        {a.isAccessible
                          ? t('shell.runtimeDiagnostics.appAccessible')
                          : t('shell.runtimeDiagnostics.appInaccessible')}
                        {a.id}
                        {a.needsAuth ? ' • needs-auth' : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <div className="font-semibold">{t('shell.runtimeDiagnostics.sections.effectiveEnv')}</div>
                <div className="text-[var(--ink-muted)] font-mono text-xs leading-tight">
                  <div>cwd: {diagnostics.effectiveEnv.cwd}</div>
                  <div>HTTP_PROXY:  {diagnostics.effectiveEnv.proxy?.http ?? '(unset)'}</div>
                  <div>HTTPS_PROXY: {diagnostics.effectiveEnv.proxy?.https ?? '(unset)'}</div>
                  <div>NO_PROXY:    {diagnostics.effectiveEnv.proxy?.no ?? '(unset)'}</div>
                  <div>proxyPolicy: {diagnostics.effectiveEnv.proxyPolicy ?? 'myagents'}</div>
                  <div>
                    MYAGENTS_PROXY_INJECTED: {diagnostics.effectiveEnv.myagentsProxyInjected
                      ? t('shell.runtimeDiagnostics.yes')
                      : t('shell.runtimeDiagnostics.no')}
                  </div>
                  <div>
                    secrets: openai={diagnostics.effectiveEnv.hasOpenaiApiKey ? '✓' : '✗'} •
                    anthropic={diagnostics.effectiveEnv.hasAnthropicApiKey ? '✓' : '✗'} •
                    codex-home={diagnostics.effectiveEnv.hasCodexHome ? '✓' : '✗'}
                  </div>
                </div>
              </div>

              <div className="text-xs text-[var(--ink-muted)] italic">
                {t('shell.runtimeDiagnostics.snapshot', { timestamp: diagnostics.timestamp })}
                <code className="ml-1">myagents diagnose runtime {diagnostics.runtime}</code>
              </div>
            </div>
          )}
        </div>
        {onDiagnose && (
          <button
            type="button"
            onClick={() => onDiagnose(diagnostics)}
            className="rounded p-0.5 text-[var(--ink-subtle)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--accent)]"
            title={t('shell.diagnostics.askHelper')}
            aria-label={t('shell.diagnostics.askHelper')}
          >
            <Bot className="h-3.5 w-3.5" />
          </button>
        )}
        {/* Close button — always rendered in v2. v1 made it conditional on a
            callback prop that was usually omitted, leaving users no way out. */}
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label={t('shell.common.close')}
          title={t('shell.runtimeDiagnostics.closeTitle')}
          className="flex-shrink-0 rounded p-0.5 text-[var(--ink-muted)] hover:bg-[var(--paper-hover)] hover:text-[var(--ink)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
