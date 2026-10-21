import facts from './imPlatformCapabilities.json';

/** Installed adapter capabilities, shared with Rust. Unknown plugins retain
 * their existing controls; the platform must actually deliver the events. */
export function imPlatformCapabilities(platform: string): {
  groups: 'none' | 'mention' | 'all' | 'unknown';
  accessControl: boolean;
  prerequisite?: string;
} {
  return Object.hasOwn(facts, platform)
    ? facts[platform as keyof typeof facts] as { groups: 'none' | 'mention' | 'all'; prerequisite?: string; accessControl: boolean }
    : { groups: 'unknown', prerequisite: 'plugin', accessControl: true };
}
