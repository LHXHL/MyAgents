import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { channelHandoffImages } from './channel-handoff';
import type { ChannelHandoff } from '../../shared/channelHandoff';

describe('Channel handoff attachment intake', () => {
  it('uses owned copies for images/files and rejects any foreign path before admission', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'channel-handoff-'));
    try {
      const event = randomUUID();
      const directory = join(workspace, 'myagents_files', 'channel-handoff', event);
      await mkdir(directory, { recursive: true });
      const image = join(directory, 'image.png'), file = join(directory, 'report.pdf');
      await writeFile(image, Buffer.from('owned image'));
      await writeFile(file, Buffer.from('owned file'));
      const input: ChannelHandoff = { target: { connection: { channelId: 'bot', platform: 'wecom' }, conversation: { id: 'u', idType: 'userid', kind: 'direct' } }, context: 'context', attachments: [
        { path: image, name: 'image.png', mimeType: 'image/png', image: true },
        { path: file, name: 'report.pdf', mimeType: 'application/pdf', image: false },
      ] };
      expect(await channelHandoffImages(input, workspace, event)).toEqual([{ kind: 'inline_base64', name: 'image.png', mimeType: 'image/png', data: Buffer.from('owned image').toString('base64') }]);
      const outside = join(workspace, 'outside.png');
      await writeFile(outside, 'outside');
      const link = join(directory, 'link.png');
      await symlink(outside, link);
      input.attachments![0].path = link;
      await expect(channelHandoffImages(input, workspace, event)).rejects.toThrow('outside its event directory');
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });
});
