import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import CustomSelect from '../../components/CustomSelect';
import type { AppConfig, DshCollaborationModelRef, DshCollaborationSettings as Settings, Provider } from '../../../shared/config-types';
import { getProviderExecutionConstraint } from '../../../shared/integrated-runtimes/provider-constraints';

const keyFor = (ref: DshCollaborationModelRef) => JSON.stringify([ref.providerId, ref.modelId]);

export function DshCollaborationSettings({ value, providers, updateConfig }: {
  value: Settings | undefined;
  providers: readonly Provider[];
  updateConfig: (value: Partial<AppConfig>) => Promise<void>;
}) {
  const { t } = useTranslation('settings');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [newRole, setNewRole] = useState('');
  const settings = value ?? {};
  const models = providers.filter(provider => {
    try {
      const constraint = getProviderExecutionConstraint(provider);
      return provider.enabled !== false && constraint.kind === 'portable' && constraint.credentialKind === 'api-key';
    }
    catch { return false; }
  }).flatMap(provider => provider.models.map(model => ({ providerId: provider.id, modelId: model.model, label: `${provider.name} · ${model.model}` })));
  const save = async (patch: Partial<Settings>) => {
    setBusy(true); setError('');
    try { await updateConfig({ dshCollaboration: { ...settings, ...patch } }); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const reference = (key: string): DshCollaborationModelRef | undefined => {
    const model = models.find(model => keyFor(model) === key);
    return model ? { providerId: model.providerId, modelId: model.modelId } : undefined;
  };
  const modelSelect = (selected: DshCollaborationModelRef | undefined, onChange: (ref: DshCollaborationModelRef | undefined) => void, label: string) => (
    <div role="group" aria-label={label} className="min-w-0"><CustomSelect disabled={busy} size="md" value={selected ? keyFor(selected) : ''}
      onChange={key => onChange(reference(key))} options={[
        { value: '', label: t('collaboration.inherit') },
        ...(selected && !models.some(model => keyFor(model) === keyFor(selected)) ? [{ value: keyFor(selected), label: `${t('collaboration.unavailable')} · ${selected.modelId}` }] : []),
        ...models.map(model => ({ value: keyFor(model), label: model.label })),
      ]} /></div>
  );
  const roles = [...new Set(['general', 'Explore', 'Plan', ...(settings.roleModels ?? []).map(row => row.role)])];
  return <section className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
    <h3 className="text-base font-medium text-[var(--ink)]">{t('collaboration.title')}</h3>
    <p className="mt-2 text-sm text-[var(--ink-muted)]">{t('collaboration.description')}</p>
    <fieldset disabled={busy} className="mt-4 grid gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {([
          ['maxDepth', 1, 8, 'depth'], ['maxActiveChildren', 32, 32, 'active'], ['maxRetainedChildren', 256, 256, 'retained'],
        ] as const).map(([field, fallback, maximum, label]) => <label key={field} className="grid gap-1 text-sm text-[var(--ink-secondary)]">
          {t(`collaboration.${label}`)}
          <input key={`${field}:${settings[field] ?? fallback}`} type="number" min={1} max={maximum} defaultValue={settings[field] ?? fallback} aria-label={t(`collaboration.${label}`)}
            className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2"
            onBlur={event => { const next = Number(event.target.value); if (Number.isInteger(next) && next >= 1 && next <= maximum) {
              void save(field === 'maxRetainedChildren' ? { [field]: next, maxActiveChildren: Math.min(settings.maxActiveChildren ?? 32, next) }
                : field === 'maxActiveChildren' ? { [field]: next, maxRetainedChildren: Math.max(settings.maxRetainedChildren ?? 256, next) } : { [field]: next });
            } }} />
        </label>)}
      </div>
      <p className="text-xs text-[var(--ink-muted)]">{t('collaboration.depthHint')}</p>
      <label className="grid gap-1 text-sm text-[var(--ink-secondary)]">{t('collaboration.strategy')}
        <CustomSelect disabled={busy} size="md" value={settings.modelPolicy ?? 'inherit'} onChange={value => {
          const mode = value as NonNullable<Settings['modelPolicy']>;
          if (mode === 'fixed' && !settings.fixedModel) { const first = models[0]; if (first) void save({ modelPolicy: mode, fixedModel: { providerId: first.providerId, modelId: first.modelId } }); }
          else void save({ modelPolicy: mode });
        }} options={[
          { value: 'inherit', label: t('collaboration.inherit') },
          ...(models.length > 0 || settings.fixedModel ? [{ value: 'fixed', label: t('collaboration.fixed') }] : []),
          { value: 'agent', label: t('collaboration.agent') },
        ]} />
      </label>
      {settings.modelPolicy === 'fixed' && modelSelect(settings.fixedModel, ref => { if (ref) void save({ fixedModel: ref }); }, t('collaboration.fixed'))}
      <div className="grid gap-2"><h4 className="text-sm font-medium text-[var(--ink)]">{t('collaboration.roles')}</h4>
        {roles.map(role => <div key={role} className="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3">
          <span className="truncate text-sm text-[var(--ink-secondary)]" title={role}>{role}</span>
          {modelSelect(settings.roleModels?.find(row => row.role === role), ref => void save({ roleModels: [
            ...(settings.roleModels ?? []).filter(row => row.role !== role), ...(ref ? [{ ...ref, role }] : []),
          ] }), `${t('collaboration.roles')} ${role}`)}
        </div>)}
        <div className="flex gap-2"><input value={newRole} maxLength={256} onChange={event => setNewRole(event.target.value)} placeholder={t('collaboration.roleName')}
          className="min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm" />
          <button type="button" disabled={!newRole.trim() || !models.length || roles.includes(newRole.trim())} onClick={() => {
            const first = models[0]; if (first) { void save({ roleModels: [...(settings.roleModels ?? []), { providerId: first.providerId, modelId: first.modelId, role: newRole.trim() }] }); setNewRole(''); }
          }} className="rounded-lg border border-[var(--line)] px-3 py-2 text-sm">{t('collaboration.addRole')}</button>
        </div>
      </div>
      <details><summary className="cursor-pointer text-sm font-medium text-[var(--ink)]">{t('collaboration.authorized')} ({settings.allowedModels?.length ?? 0})</summary>
        <p className="my-2 text-xs text-[var(--ink-muted)]">{t('collaboration.authorizedHint')}</p>
        <div className="grid max-h-64 gap-2 overflow-auto">{models.map(model => {
          const checked = settings.allowedModels?.some(ref => keyFor(ref) === keyFor(model)) ?? false;
          return <label key={keyFor(model)} className="flex items-center gap-2 text-sm text-[var(--ink-secondary)]"><input type="checkbox" checked={checked}
            disabled={!checked && (settings.allowedModels?.length ?? 0) >= 64} onChange={() => void save({ allowedModels: checked
              ? settings.allowedModels?.filter(ref => keyFor(ref) !== keyFor(model))
              : [...(settings.allowedModels ?? []), { providerId: model.providerId, modelId: model.modelId }] })} />{model.label}</label>;
        })}</div>
      </details>
      <label className="grid gap-1 text-sm text-[var(--ink-secondary)]">{t('collaboration.timing')}
        <CustomSelect disabled={busy} size="md" value={settings.messageDelivery ?? 'realtime'}
          onChange={value => void save({ messageDelivery: value as 'realtime' | 'turn' })} options={[
            { value: 'realtime', label: t('general.queueRealtime') }, { value: 'turn', label: t('general.queueTurn') },
          ]} />
      </label>
      <p className="text-xs text-[var(--ink-muted)]">{t('collaboration.timingHint')}</p>
    </fieldset>
    {error && <p role="alert" className="mt-3 text-sm text-[var(--error)]">{error}</p>}
  </section>;
}
