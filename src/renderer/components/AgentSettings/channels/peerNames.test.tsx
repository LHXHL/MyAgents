import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import WhitelistManager from '../../ImSettings/components/WhitelistManager';
import GroupPermissionList from '../../ImSettings/components/GroupPermissionList';
import { peerDisplayName } from '@/utils/peerDisplayName';

describe('channel peer labels', () => {
  it.each([undefined, null, '', '  ', 'id'])('falls back to ID for missing or ID-only name %s', name => {
    expect(peerDisplayName('id', name)).toBe('id');
  });
  it('keeps prototype-like IDs as IDs when the metadata map has no own name', () => {
    render(<WhitelistManager platform="openclaw:wecom" users={['__proto__', 'constructor']} displayNames={{}} onChange={vi.fn()} />);
    expect(screen.getByText('__proto__')).toBeInTheDocument();
    expect(screen.getByText('constructor')).toBeInTheDocument();
  });
  it('shows bound nickname and ID while removal still targets the original ID', () => {
    const remove = vi.fn();
    render(<WhitelistManager platform="openclaw:wecom" users={['u', 'unknown']} displayNames={{ u: 'Alice' }} onChange={remove} />);
    const label = screen.getByText('Alice（u）');
    expect(screen.getByText('unknown')).toBeInTheDocument();
    fireEvent.click(label.querySelector('button')!);
    expect(remove).toHaveBeenCalledWith(['unknown']);
  });
  it.each(['pending', 'approved'] as const)('shows group name and ID for %s records without changing the permission action key', status => {
    const approve = vi.fn();
    const remove = vi.fn();
    render(<GroupPermissionList permissions={[{ groupId: 'g', groupName: 'Team', status, platform: 'openclaw:wecom', discoveredAt: '2026-10-18' }]} onApprove={approve} onReject={vi.fn()} onRemove={remove} />);
    expect(screen.getByText('Team（g）')).toBeInTheDocument();
    if (status === 'pending') {
      fireEvent.click(screen.getByTitle('允许'));
      expect(approve).toHaveBeenCalledWith('g');
    } else {
      fireEvent.click(screen.getByRole('button', { name: '移除' }));
      expect(remove).toHaveBeenCalledWith('g');
    }
  });
});
