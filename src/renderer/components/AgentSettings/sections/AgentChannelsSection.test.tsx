import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentConfig, ChannelType } from '../../../../shared/types/agent';
import AgentChannelsSection from './AgentChannelsSection';

vi.mock('@/components/OverlayBackdrop', () => ({
  default: ({ children }: { children: ReactNode }) => <div data-testid="overlay">{children}</div>,
}));

vi.mock('../channels/ChannelPlatformSelect', () => ({
  default: ({ onSelect }: { onSelect: (platform: ChannelType) => void }) => (
    <div>
      <span>platform-picker</span>
      <button type="button" onClick={() => onSelect('dingtalk')}>pick-dingtalk</button>
    </div>
  ),
}));

vi.mock('../channels/ChannelWizard', () => ({
  default: ({ platform, onCancel, onComplete }: {
    platform: ChannelType;
    onCancel: () => void;
    onComplete: (channelId: string) => void;
  }) => (
    <div>
      <span>wizard-{platform}</span>
      <button type="button" onClick={onCancel}>wizard-cancel</button>
      <button type="button" onClick={() => onComplete('channel-1')}>wizard-complete</button>
    </div>
  ),
}));

vi.mock('../channels/ChannelDetailView', () => ({ default: () => null }));

vi.mock('@/config/services/agentConfigService', () => ({
  startAndEnableAgentChannel: vi.fn(),
  stopAndDisableAgentChannel: vi.fn(),
}));

const agent: AgentConfig = {
  id: 'agent-1',
  name: 'Agent',
  enabled: false,
  permissionMode: 'auto',
  channels: [],
};

describe('AgentChannelsSection direct entry', () => {
  it('returns a registry deep link to Channels but keeps normal Add navigation intact', () => {
    const onConsumed = vi.fn();
    render(
      <AgentChannelsSection
        agent={agent}
        onAgentChanged={vi.fn()}
        initialAddPlatform="telegram"
        onInitialAddPlatformConsumed={onConsumed}
      />,
    );

    expect(screen.getByText('wizard-telegram')).toBeInTheDocument();
    expect(onConsumed).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('platform-picker')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'wizard-cancel' }));
    expect(screen.queryByText('wizard-telegram')).not.toBeInTheDocument();
    expect(screen.queryByText('platform-picker')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /添加|Add/u }));
    expect(screen.getByText('platform-picker')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'pick-dingtalk' }));
    expect(screen.getByText('wizard-dingtalk')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'wizard-cancel' }));
    expect(screen.getByText('platform-picker')).toBeInTheDocument();
  });

  it('does not reopen a consumed registry intent after the section remounts', () => {
    const first = render(
      <AgentChannelsSection
        agent={agent}
        onAgentChanged={vi.fn()}
        initialAddPlatform="telegram"
        onInitialAddPlatformConsumed={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'wizard-cancel' }));
    first.unmount();

    render(
      <AgentChannelsSection
        agent={agent}
        onAgentChanged={vi.fn()}
      />,
    );

    expect(screen.queryByText('wizard-telegram')).not.toBeInTheDocument();
    expect(screen.queryByText('platform-picker')).not.toBeInTheDocument();
  });
});
