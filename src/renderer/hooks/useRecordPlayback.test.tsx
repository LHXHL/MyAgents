import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordTrackTimeline } from '@/../shared/types/record';
import { useRecordPlayback } from './useRecordPlayback';

function source(name: string, recordStartMs = 0, recordEndMs = 6000, ready = true) {
  const media = {
    currentTime: 0, duration: (recordEndMs - recordStartMs) / 1000,
    playbackRate: 1, muted: false, paused: true, readyState: ready ? 1 : 0,
    pause: vi.fn(() => { media.paused = true; }),
    play: vi.fn(() => { media.paused = false; return Promise.resolve(); }),
  };
  const timeline: RecordTrackTimeline = { spans: [{ sourceStart: 0, sourceEnd: (recordEndMs - recordStartMs) * 16,
    recordStart: recordStartMs * 16, recordEnd: recordEndMs * 16, quality: 'clock', discontinuity: false }] };
  return { media, ref: { current: media as unknown as HTMLAudioElement }, src: name, timeline };
}

describe('Record playback transport', () => {
  let now = 0;
  beforeEach(() => { now = 0; vi.useFakeTimers(); vi.spyOn(performance, 'now').mockImplementation(() => now); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  function setup(sources: ReturnType<typeof source>[], durationMs = 6000) {
    const callbacks = { onPosition: vi.fn(), onPlaying: vi.fn(), onStarted: vi.fn(), onFinished: vi.fn(), onError: vi.fn() };
    return { ...renderHook((props) => useRecordPlayback({ ...callbacks, ...props }), { initialProps: { sources, durationMs } }), callbacks };
  }
  async function advance(ms: number) {
    await act(async () => { now += ms; vi.advanceTimersByTime(ms); });
  }

  it('keeps the Record clock across late metadata and the earlier source ending', async () => {
    const mic = source('mic', 0, 3000); const system = source('system', 2000, 6000, false);
    const { result, callbacks, unmount } = setup([mic, system]);
    await act(async () => result.current.toggle());
    await advance(1000);
    expect(result.current.getPosition()).toBe(1000);
    system.media.readyState = 1;
    act(() => result.current.metadataReady());
    expect(mic.media.currentTime).toBe(1);
    expect(mic.media.muted).toBe(false);
    expect(system.media.paused).toBe(true);
    await advance(1000);
    expect(system.media.play).toHaveBeenCalledTimes(1);
    expect(system.media.currentTime).toBe(0);
    await advance(1500);
    expect(mic.media.paused).toBe(true);
    expect(system.media.paused).toBe(false);
    expect(system.media.currentTime).toBe(1.5);
    expect(callbacks.onFinished).not.toHaveBeenCalled();
    await advance(2500);
    expect(callbacks.onFinished).toHaveBeenCalledTimes(1);
    expect(system.media.paused).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  });

  it('waits at the requested position for metadata and preserves seeks made before Record loading', async () => {
    const mic = source('mic', 0, 6000, false);
    const { result, rerender, unmount } = setup([mic], 0);
    act(() => result.current.seek(2500));
    rerender({ sources: [mic], durationMs: 6000 });
    await act(async () => result.current.toggle());
    await advance(1000);
    expect(mic.media.play).not.toHaveBeenCalled();
    expect(result.current.getPosition()).toBe(2500);
    mic.media.readyState = 1;
    await act(async () => result.current.metadataReady());
    expect(mic.media.currentTime).toBe(2.5);
    await advance(500);
    expect(result.current.getPosition()).toBe(3000);
    unmount();
  });

  it('revokes pending starts on seek, pause and source replacement without leaving detached audio playing', async () => {
    const mic = source('mic'); const next = source('other');
    let finishPlay: () => void = () => undefined;
    mic.media.play.mockImplementation(() => { mic.media.paused = false; return new Promise<void>((resolve) => { finishPlay = resolve; }); });
    const { result, rerender, callbacks, unmount } = setup([mic]);
    act(() => result.current.toggle());
    const stale = finishPlay;
    act(() => result.current.seek(3000));
    const current = finishPlay;
    await act(async () => stale());
    expect(callbacks.onStarted).not.toHaveBeenCalled();
    expect(mic.media.muted).toBe(true);
    await act(async () => current());
    expect(mic.media.currentTime).toBe(3);
    expect(mic.media.muted).toBe(false);
    rerender({ sources: [next], durationMs: 6000 });
    expect(mic.media.paused).toBe(true);
    expect(next.media.paused).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => result.current.toggle());
    act(() => result.current.pause());
    await advance(1000);
    expect(next.media.paused).toBe(true);
    expect(result.current.getPosition()).toBe(3000);
    unmount();
  });

  it('continues through archive gaps at the mapped rate and ignores identical inventory refreshes', async () => {
    const mic = source('mic');
    mic.timeline.spans = [
      { sourceStart: 0, sourceEnd: 16000, recordStart: 16000, recordEnd: 48000, quality: 'clock', discontinuity: false },
      { sourceStart: 16000, sourceEnd: 32000, recordStart: 48000, recordEnd: 64000, quality: 'gap', discontinuity: true },
      { sourceStart: 32000, sourceEnd: 64000, recordStart: 64000, recordEnd: 96000, quality: 'clock', discontinuity: true },
    ];
    const { result, rerender, unmount } = setup([mic]);
    await act(async () => result.current.toggle());
    expect(mic.media.paused).toBe(true);
    await advance(1500);
    expect(mic.media.currentTime).toBe(0.25);
    expect(mic.media.playbackRate).toBe(0.5);
    const pauses = mic.media.pause.mock.calls.length;
    rerender({ sources: [{ ...mic, timeline: structuredClone(mic.timeline) }], durationMs: 6000 });
    expect(mic.media.pause).toHaveBeenCalledTimes(pauses);
    await advance(2000);
    expect(mic.media.paused).toBe(true);
    expect(mic.media.muted).toBe(true);
    await advance(1000);
    expect(mic.media.paused).toBe(false);
    expect(mic.media.currentTime).toBe(2.5);
    expect(mic.media.playbackRate).toBe(1);
    unmount();
    expect(mic.media.paused).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
