import { useState } from 'react';
import { Bot, User } from 'lucide-react';

type IdentityInput = {
  name?: string | null;
  email?: string | null;
  id?: string | null;
};

export function spaceDisplayName(identity: IdentityInput | null | undefined): string {
  const name = identity?.name?.trim();
  if (name) return name;
  const email = identity?.email?.trim();
  if (email) return email.split('@')[0] || email;
  return identity?.id?.trim() || 'User';
}

function initialFor(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || 'U';
}

export function SpaceAvatar({
  name,
  email,
  avatarUrl,
  size = 24,
  type = 'user',
  className = '',
}: {
  name?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  size?: number;
  type?: 'user' | 'registered_agent' | 'system';
  className?: string;
}) {
  const displayName = spaceDisplayName({ name, email });
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  const style = { width: size, height: size };
  const fallbackTextClass = size >= 48 ? 'text-base' : size >= 32 ? 'text-sm' : 'text-xs';
  if (avatarUrl && failedUrl !== avatarUrl) {
    return (
      <span className={`inline-grid shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--paper-inset)] ${className}`} style={style}>
        <img
          src={avatarUrl}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
          onError={() => setFailedUrl(avatarUrl)}
        />
      </span>
    );
  }

  return (
    <span className={`inline-grid shrink-0 place-items-center rounded-full border border-[var(--line-subtle)] bg-[var(--paper-inset)] ${fallbackTextClass} font-semibold leading-none text-[var(--ink-muted)] ${className}`} style={style}>
      {type === 'registered_agent' ? (
        <Bot className="h-3.5 w-3.5" />
      ) : type === 'system' ? (
        <User className="h-3.5 w-3.5" />
      ) : (
        <span>{initialFor(displayName)}</span>
      )}
    </span>
  );
}

export function SpaceIdentityLine({
  name,
  email,
  avatarUrl,
  type = 'user',
  avatarSize = 22,
  className = '',
  nameClassName = '',
}: {
  name?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  type?: 'user' | 'registered_agent' | 'system';
  avatarSize?: number;
  className?: string;
  nameClassName?: string;
}) {
  const label = spaceDisplayName({ name, email });
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 align-middle leading-none ${className}`}>
      <SpaceAvatar name={name} email={email} avatarUrl={avatarUrl} type={type} size={avatarSize} />
      <span className={`min-w-0 truncate leading-none ${nameClassName}`}>{label}</span>
    </span>
  );
}
