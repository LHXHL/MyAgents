import {
  compileProductExtensionSnapshot,
  type CompileProductExtensionSnapshotInput,
} from '../../product-extensions/compiler';

export {
  compileProductCommand as compileManagedCodexCommand,
  __revisionForManagedCodexExtensionTests,
} from '../../product-extensions/compiler';
export type CompileManagedCodexExtensionSnapshotInput = CompileProductExtensionSnapshotInput;

export function compileManagedCodexExtensionSnapshot(input: CompileManagedCodexExtensionSnapshotInput) {
  return compileProductExtensionSnapshot({
    ...input,
    admitSkill: input.agentRoleTarget === 'dsh' ? undefined : (skill, reports) => {
      const frontmatter = skill.frontmatter ?? {};
      const unsupported = (['allowed-tools', 'context', 'agent'] as const).filter(field => Boolean(frontmatter[field]));
      if (!unsupported.length) return true;
      reports.push({ component: 'skills', id: `${skill.sourceId}:${skill.name}`, state: 'unsupported',
        code: 'skill_unsupported_fields', message: `Unsupported fields: ${unsupported.join(', ')}` });
      return false;
    },
  });
}
