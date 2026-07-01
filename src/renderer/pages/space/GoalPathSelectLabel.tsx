interface GoalPathSelectLabelProps {
  label: string;
}

function splitGoalPath(label: string): { parent: string; leaf: string } | null {
  const parts = label
    .split(' / ')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  return {
    parent: parts.slice(0, -1).join(' / '),
    leaf: parts[parts.length - 1],
  };
}

export function GoalPathSelectLabel({ label }: GoalPathSelectLabelProps) {
  const path = splitGoalPath(label);
  if (!path) {
    return <span className="block w-full truncate text-left">{label}</span>;
  }

  return (
    <span className="flex w-full min-w-0 items-baseline justify-start gap-1 text-left">
      <span className="min-w-0 truncate text-[var(--ink-muted)]/75">
        {path.parent}
      </span>
      <span className="shrink-0 text-[var(--ink-muted)]/75">/</span>
      <span className="min-w-0 max-w-full shrink-0 truncate font-semibold text-current">
        {path.leaf}
      </span>
    </span>
  );
}
