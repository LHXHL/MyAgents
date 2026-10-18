import { managementApi } from './management-api-client';

type ChannelIdentity = { platform: string | null; pluginId: string | null };
type ConfiguredChannel = { id: string; type?: string; name?: string; enabled?: boolean; openclawPluginId?: string };

/** Installation names are not protocol aliases. Only the App's live adapter
 * can report a registered plugin platform; a stopped plugin stays unknown. */
export async function readChannelIdentities(): Promise<Map<string, ChannelIdentity>> {
  const response = await managementApi('/api/im/channels');
  const channels = response.ok && Array.isArray(response.channels) ? response.channels : [];
  return new Map(channels.map(channel => [channel.channelId ?? channel.botId, {
    platform: channel.platform ?? null,
    pluginId: channel.pluginId ?? null,
  }]));
}

export function projectConfiguredChannel(channel: ConfiguredChannel, identities: Map<string, ChannelIdentity>) {
  const pluginId = channel.type?.startsWith('openclaw:') ? (channel.openclawPluginId ?? channel.type.slice('openclaw:'.length)) : null;
  return {
    id: channel.id,
    // Published config field retained for compatibility; never used as protocol identity.
    type: channel.type,
    platform: identities.get(channel.id)?.platform ?? (pluginId ? null : channel.type ?? null),
    pluginId,
    name: channel.name,
    enabled: channel.enabled,
  };
}

/** CLI-only projection. Internal turn context and send resolution keep their
 * existing owner snapshot; discovery does not rewrite that execution state. */
export function projectScopedChannels(channels: Array<Record<string, unknown>>, identities: Map<string, ChannelIdentity>) {
  return channels.map(channel => ({
    ...channel,
    platform: identities.get(String(channel.channelId))?.platform
      ?? (typeof channel.platform === 'string' && !channel.platform.startsWith('openclaw:') ? channel.platform : null),
    pluginId: identities.get(String(channel.channelId))?.pluginId ?? null,
  }));
}
