import { useTranslation } from 'react-i18next';
import type { PermissionOperation, PermissionReview } from '../../shared/types/runtime';

const textClass = 'max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-[var(--ink-secondary)]';

/** Render effect facts supplied by Runtime; never infer approval details from streamed tool text. */
export function PermissionReviewDetails({ review }: { review: PermissionReview }) {
  const { t } = useTranslation('chat');
  const operation = review.operation;
  const label = (key: string) => t(`shell.permissionPrompt.${key}`);
  const field = (name: string, value: string | undefined) => value === undefined ? null : (
    <div className="mt-2"><div className="mb-1 text-xs text-[var(--ink-muted)]">{name}</div><pre className={textClass}>{value}</pre></div>
  );
  const content = (value: PermissionOperation) => {
    switch (value.kind) {
      case 'command': return <>{field(value.dialect === 'pwsh' ? 'PowerShell' : 'Bash', value.command)}{field(label('cwd'), value.cwd)}{field(label('purpose'), value.description)}</>;
      case 'web_search': return <>{field(label('query'), value.query)}{field(label('provider'), value.provider)}{field(label('allowedDomains'), value.allowedDomains?.join(', '))}{field(label('blockedDomains'), value.blockedDomains?.join(', '))}</>;
      case 'web_fetch': return <>{field('URL', value.url)}{field(label('purpose'), value.prompt)}</>;
      case 'file_change': return <>
        {field(label('file'), value.path)}
        <div className="mt-2 text-xs text-[var(--ink-muted)]">{label(value.action)}{value.replacements === undefined ? '' : ` · ${label('replacements')}: ${value.replacements}`}</div>
        <details className="mt-2" open><summary className="cursor-pointer text-xs text-[var(--ink-muted)]">{label('fullChange')}</summary>
          {field(label('before'), value.before)}{field(label('after'), value.after)}
        </details>
      </>;
      case 'generic': return <>{field(label('action'), value.action)}{field(label('target'), value.target)}{field(label('arguments'), value.arguments === undefined ? undefined : JSON.stringify(value.arguments, null, 2))}</>;
      default: return field(label('arguments'), JSON.stringify(value, null, 2));
    }
  };
  if (!review.operation || !review.scope || !review.actor) return <pre className={textClass}>{JSON.stringify(review, null, 2)}</pre>;
  return <>
    <p className="mt-1 text-xs text-[var(--ink-muted)]">{review.actor.origin === 'root' ? label('rootAgent') : `${label('childAgent')} · ${review.actor.agentId}`}</p>
    {content(operation)}
    <div className="mt-3 border-t border-[var(--warning)]/20 pt-2 text-xs leading-relaxed text-[var(--ink-muted)]">
      {t(review.scope.lifetimeMs === null ? 'shell.permissionPrompt.sessionRuleScope' : 'shell.permissionPrompt.ruleScope', {
        tool: review.scope.tool, target: review.scope.target,
        ...(review.scope.lifetimeMs === null ? {} : { hours: review.scope.lifetimeMs / 3_600_000 }),
      })}
    </div>
  </>;
}
