// Shared Channel platform identity: label + logo. Used by Agent channel settings
// and the Team AI page so every surface shows the same brand mark for a Bot.
import telegramIcon from '../ImSettings/assets/telegram.png';
import feishuIcon from '../ImSettings/assets/feishu.jpeg';
import dingtalkIcon from '../ImSettings/assets/dingtalk.svg';
import { findPromotedByPlatform } from '../ImSettings/promotedPlugins';
import { MessageIcon } from '@/components/icons';

const PLATFORM_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  feishu: '飞书',
  dingtalk: '钉钉',
};

export function getChannelPlatformLabel(type: string): string {
  if (type.startsWith('openclaw:')) {
    const promoted = findPromotedByPlatform(type);
    if (promoted) return promoted.name;
    return type.slice('openclaw:'.length);
  }
  return PLATFORM_LABELS[type] || type;
}

const LOGOS: Record<string, string> = { telegram: telegramIcon, feishu: feishuIcon, dingtalk: dingtalkIcon };

export function ChannelPlatformIcon({ type, className = 'h-5 w-5' }: { type: string; className?: string }) {
  const src = LOGOS[type] ?? findPromotedByPlatform(type)?.icon;
  const label = getChannelPlatformLabel(type);
  if (!src) return <MessageIcon className={`${className} text-[var(--ink-muted)]`} aria-label={label} />;
  return <img src={src} alt={label} className={`${className} rounded object-cover`} />;
}
