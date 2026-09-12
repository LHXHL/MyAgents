import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { RecordTrackTimeline } from '@/../shared/types/record';
import { recordPlaybackPosition, sourcePlaybackRecordMs } from '@/utils/recordPlayback';

interface PlaybackSource {
  ref: RefObject<HTMLAudioElement | null>;
  src: string;
  timeline?: RecordTrackTimeline;
}
interface Options {
  sources: PlaybackSource[];
  durationMs: number;
  onPosition: (recordMs: number) => void;
  onPlaying: (playing: boolean) => void;
  onStarted: () => void;
  onFinished: () => void;
  onError: () => void;
}

/** The existing Record detail owns this transport. Original media elements
 * have different clocks; a single Record clock coordinates seeks, silent gaps,
 * drift rates and the period after one source has ended. */
export function useRecordPlayback(options: Options) {
  const optionsRef = useRef(options);
  // Media events and timers observe the committed UI. Layout runs before
  // browser callbacks can observe a new source, without exposing an abandoned
  // concurrent render to an already running transport.
  useLayoutEffect(() => { optionsRef.current = options; });
  const transport = useRef({ recordMs: 0, startedAt: null as number | null, wanted: false,
    pending: false, epoch: 0, mounted: false, timer: undefined as ReturnType<typeof setTimeout> | undefined,
    lastPositionAt: -Infinity });
  const tickRef = useRef<() => void>(() => undefined);

  const clockPosition = useCallback(() => {
    const state = transport.current;
    const position = state.recordMs + (state.startedAt === null ? 0 : Math.max(0, performance.now() - state.startedAt));
    return optionsRef.current.durationMs > 0 ? Math.min(optionsRef.current.durationMs, position) : position;
  }, []);

  const pause = useCallback(() => {
    const state = transport.current;
    state.recordMs = clockPosition(); state.startedAt = null;
    state.wanted = false; state.pending = false; state.epoch += 1;
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.timer = undefined;
    for (const source of optionsRef.current.sources) source.ref.current?.pause();
    optionsRef.current.onPlaying(false);
    optionsRef.current.onPosition(state.recordMs);
  }, [clockPosition]);

  const fail = useCallback(() => {
    pause();
    optionsRef.current.onError();
  }, [pause]);

  const positionSources = useCallback((recordMs: number, force: boolean, muted: boolean) => {
    return optionsRef.current.sources.map((source) => {
      const audio = source.ref.current;
      const duration = audio && Number.isFinite(audio.duration) ? audio.duration : Infinity;
      const position = recordPlaybackPosition(source.timeline, recordMs, duration);
      if (audio) {
        audio.muted = muted || !position.audible;
        if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
          if (position.playbackRate < 0.0625 || position.playbackRate > 16) throw new Error('Unsupported Record playback rate');
          audio.playbackRate = position.playbackRate;
          if (force || Math.abs(audio.currentTime - position.sourceSeconds) > 0.04) {
            audio.currentTime = position.sourceSeconds;
          }
        }
        if (!position.audible && !audio.paused) audio.pause();
      }
      return { audio, position };
    });
  }, []);

  const startAt = useCallback((recordMs: number) => {
    const state = transport.current;
    if (!state.mounted || !state.wanted || state.pending) return;
    state.recordMs = recordMs; state.startedAt = null;
    try {
      const sources = positionSources(recordMs, true, true);
      // Preload metadata owns readiness. The clock stays at this exact Record
      // position until all currently audible sources can be positioned.
      if (sources.some(({ audio, position }) => position.audible
        && (!audio || audio.readyState < HTMLMediaElement.HAVE_METADATA))) return;
      const epoch = state.epoch;
      state.pending = true;
      const plays = sources.filter(({ position }) => position.audible)
        .map(({ audio }) => audio!.paused ? audio!.play() : Promise.resolve());
      void Promise.all(plays).then(() => {
        if (!state.mounted || !state.wanted || state.epoch !== epoch) return;
        positionSources(recordMs, true, false);
        state.pending = false; state.startedAt = performance.now();
        optionsRef.current.onStarted();
        tickRef.current();
      }).catch(() => {
        if (state.mounted && state.wanted && state.epoch === epoch) fail();
      });
    } catch { fail(); }
  }, [fail, positionSources]);

  const tick = useCallback(() => {
    const state = transport.current;
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.timer = undefined;
    if (!state.mounted || !state.wanted) return;
    const recordMs = clockPosition();
    if (recordMs >= optionsRef.current.durationMs) { pause(); optionsRef.current.onFinished(); return; }
    if (!state.pending) {
      try {
        const sources = positionSources(recordMs, false, state.startedAt === null);
        if (state.startedAt === null || sources.some(({ audio, position }) => position.audible && (!audio || audio.paused))) {
          startAt(recordMs);
        }
        if (performance.now() - state.lastPositionAt >= 50) {
          optionsRef.current.onPosition(recordMs); state.lastPositionAt = performance.now();
        }
      } catch { fail(); return; }
    }
    if (state.wanted) state.timer = setTimeout(() => tickRef.current(), 25);
  }, [clockPosition, fail, pause, positionSources, startAt]);
  useLayoutEffect(() => { tickRef.current = tick; }, [tick]);

  const seek = useCallback((recordMs: number) => {
    const state = transport.current;
    state.epoch += 1; state.pending = false;
    state.recordMs = Math.max(0, optionsRef.current.durationMs > 0 ? Math.min(recordMs, optionsRef.current.durationMs) : recordMs);
    state.startedAt = null;
    for (const source of optionsRef.current.sources) source.ref.current?.pause();
    try { positionSources(state.recordMs, true, state.wanted); } catch { fail(); return; }
    optionsRef.current.onPosition(state.recordMs);
    if (state.wanted) tickRef.current();
  }, [fail, positionSources]);

  const getPosition = useCallback(() => {
    const state = transport.current;
    const source = optionsRef.current.sources[0];
    const audio = source?.ref.current;
    // Native/external seeks made while paused can be adopted only when the
    // source actually represents the current media position, not in a gap.
    if (!state.wanted && audio && audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      try {
        const duration = Number.isFinite(audio.duration) ? audio.duration : Infinity;
        if (recordPlaybackPosition(source.timeline, state.recordMs, duration).audible) {
          return Math.min(optionsRef.current.durationMs, sourcePlaybackRecordMs(source.timeline, audio.currentTime));
        }
      } catch { return state.recordMs; }
    }
    return clockPosition();
  }, [clockPosition]);

  const toggle = useCallback(() => {
    const state = transport.current;
    if (state.wanted) { pause(); return; }
    if (optionsRef.current.sources.length === 0 || optionsRef.current.durationMs <= 0) return;
    state.recordMs = getPosition();
    if (state.recordMs >= optionsRef.current.durationMs) state.recordMs = 0;
    state.wanted = true; state.epoch += 1;
    optionsRef.current.onPlaying(true);
    tickRef.current();
  }, [getPosition, pause]);

  const metadataReady = useCallback(() => {
    const state = transport.current;
    try { positionSources(clockPosition(), true, state.wanted && state.startedAt === null); } catch { fail(); return; }
    if (state.wanted) tickRef.current();
  }, [clockPosition, fail, positionSources]);

  const timeUpdated = useCallback(() => {
    if (transport.current.wanted) { tickRef.current(); return; }
    const recordMs = getPosition();
    transport.current.recordMs = recordMs;
    optionsRef.current.onPosition(recordMs);
  }, [getPosition]);

  // Identical inventories read again after a note edit are the same resource;
  // object identity must not pause playback. Source/map changes revoke pending
  // play promises and retain the user's Record position for the next seek.
  const sourceIdentity = JSON.stringify(options.sources.map(({ src, timeline }) => ({ src, timeline })));
  useEffect(() => {
    const state = transport.current;
    const elements = optionsRef.current.sources.map((source) => source.ref.current);
    state.mounted = true;
    metadataReady();
    return () => {
      pause(); state.mounted = false;
      // A source may have been removed/replaced before this cleanup. Its old
      // element can still play after detaching from the DOM.
      for (const element of elements) element?.pause();
    };
  }, [sourceIdentity, metadataReady, pause]);

  return { seek, toggle, pause, getPosition, metadataReady, timeUpdated, fail };
}
