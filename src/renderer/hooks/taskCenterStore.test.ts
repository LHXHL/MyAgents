import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionClientMocks = vi.hoisted(() => ({
    deleteSession: vi.fn(),
    getSessions: vi.fn(),
    updateSession: vi.fn(),
}));

vi.mock('@/api/sessionClient', () => ({
    deleteSession: sessionClientMocks.deleteSession,
    getSessions: sessionClientMocks.getSessions,
    updateSession: sessionClientMocks.updateSession,
}));

import {
    actions,
    filterTombstoned,
    sortSessionsByLastActive,
    computeCronBotInfoMap,
    computeSessionTagsMap,
    resolveFloatingBallBoundSession,
    getSnapshot,
    __resetTaskCenterStoreForTest,
    __setTaskCenterSessionsForTest,
} from './taskCenterStore';
import type { SessionMetadata } from '@/api/sessionClient';
import type { CronTask } from '@/types/cronTask';
import type { AgentConfig } from '../../shared/types/agent';
import type { AgentStatusMap } from '@/hooks/useAgentStatuses';

const sess = (id: string, lastActiveAt: string): SessionMetadata =>
    ({ id, lastActiveAt } as unknown as SessionMetadata);

const favoriteSession = (favorite?: boolean): SessionMetadata => {
    const base: SessionMetadata = {
        id: 's1',
        agentDir: '/ws',
        title: 'Session',
        createdAt: '2026-06-20T00:00:00.000Z',
        lastActiveAt: '2026-06-20T00:00:00.000Z',
    };
    return favorite === undefined ? base : { ...base, favorite };
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

beforeEach(() => {
    __resetTaskCenterStoreForTest();
    vi.clearAllMocks();
    sessionClientMocks.deleteSession.mockResolvedValue(true);
    sessionClientMocks.getSessions.mockResolvedValue([]);
});

describe('filterTombstoned', () => {
    it('returns the same array reference when there are no tombstones', () => {
        const data = [sess('a', 'x')];
        expect(filterTombstoned(data, new Set())).toBe(data);
    });
    it('drops tombstoned ids', () => {
        const data = [sess('a', 'x'), sess('b', 'y')];
        expect(filterTombstoned(data, new Set(['a'])).map((s) => s.id)).toEqual(['b']);
    });
});

describe('sortSessionsByLastActive', () => {
    it('sorts desc by lastActiveAt without mutating the input', () => {
        const data = [sess('old', '2020-01-01T00:00:00Z'), sess('new', '2026-01-01T00:00:00Z')];
        expect(sortSessionsByLastActive(data).map((s) => s.id)).toEqual(['new', 'old']);
        expect(data.map((s) => s.id)).toEqual(['old', 'new']); // input untouched
    });
});

describe('computeCronBotInfoMap', () => {
    it('maps channel id → {name, platform}, falling back to agent name', () => {
        const agents = [{
            name: 'Agent A',
            channels: [{ id: 'c1', name: '', type: 'telegram' }, { id: 'c2', name: 'Named', type: 'feishu' }],
        }] as unknown as AgentConfig[];
        const m = computeCronBotInfoMap(agents);
        expect(m.get('c1')).toEqual({ name: 'Agent A', platform: 'telegram' });
        expect(m.get('c2')).toEqual({ name: 'Named', platform: 'feishu' });
    });
});

describe('computeSessionTagsMap', () => {
    const noStatuses = {} as AgentStatusMap;
    it('running scheduled cron → cron tag; one-shot (at) → background tag; idle → no tag', () => {
        const sessions = [sess('s-cron', 'x'), sess('s-at', 'y'), sess('s-none', 'z')];
        const crons = [
            { status: 'running', sessionId: 's-cron', schedule: { kind: 'every' } },
            { status: 'running', sessionId: 's-at', schedule: { kind: 'at' } },
            { status: 'idle', sessionId: 's-none', schedule: { kind: 'every' } },
        ] as unknown as CronTask[];
        const m = computeSessionTagsMap(sessions, crons, [], noStatuses, null);
        expect(m.get('s-cron')).toEqual([{ type: 'cron' }]);
        expect(m.get('s-at')).toEqual([{ type: 'background' }]);
        expect(m.has('s-none')).toBe(false);
    });
    it('tags explicit background session ids', () => {
        const m = computeSessionTagsMap([sess('bg', 'x')], [], ['bg'], noStatuses, null);
        expect(m.get('bg')).toEqual([{ type: 'background' }]);
    });
    it('prefers internalSessionId over sessionId for cron mapping', () => {
        const crons = [{ status: 'running', sessionId: 'outer', internalSessionId: 'internal', schedule: { kind: 'every' } }] as unknown as CronTask[];
        const m = computeSessionTagsMap([sess('internal', 'x')], crons, [], noStatuses, null);
        expect(m.get('internal')).toEqual([{ type: 'cron' }]);
    });
    it('悬浮球当前绑定的 session → floatingBall 标签（与其它标签可叠加）', () => {
        const m = computeSessionTagsMap(
            [sess('fb-sid', 'x'), sess('other', 'y')],
            [{ status: 'running', sessionId: 'fb-sid', schedule: { kind: 'every' } }] as unknown as CronTask[],
            [],
            noStatuses,
            'fb-sid',
        );
        expect(m.get('fb-sid')).toEqual([{ type: 'floatingBall' }, { type: 'cron' }]);
        expect(m.has('other')).toBe(false);
    });
});

describe('resolveFloatingBallBoundSession', () => {
    it('enabled 开且 devGate 未显式关闭时视为渠道在线、返回绑定 sid', () => {
        expect(
            resolveFloatingBallBoundSession({
                floatingBallEnabled: true,
                floatingBallSessionId: 'sid-1',
            }),
        ).toBe('sid-1');
        expect(
            resolveFloatingBallBoundSession({
                floatingBallDevGate: true,
                floatingBallEnabled: true,
                floatingBallSessionId: 'sid-1',
            }),
        ).toBe('sid-1');
    });
    it('gate 显式关闭 / 本体未启用 / 无绑定 / 无配置 → null（IM channel offline 同语义，不打标）', () => {
        expect(
            resolveFloatingBallBoundSession({
                floatingBallDevGate: false,
                floatingBallEnabled: true,
                floatingBallSessionId: 'sid-1',
            }),
        ).toBeNull();
        expect(
            resolveFloatingBallBoundSession({
                floatingBallDevGate: true,
                floatingBallEnabled: false,
                floatingBallSessionId: 'sid-1',
            }),
        ).toBeNull();
        expect(
            resolveFloatingBallBoundSession({ floatingBallDevGate: true, floatingBallEnabled: true }),
        ).toBeNull();
        expect(resolveFloatingBallBoundSession(null)).toBeNull();
    });
});

describe('store snapshot', () => {
    it('getSnapshot returns a stable reference (required by useSyncExternalStore)', () => {
        __resetTaskCenterStoreForTest();
        const a = getSnapshot();
        const b = getSnapshot();
        expect(a).toBe(b);
        expect(a.isLoading).toBe(true);
        expect(a.sessions).toEqual([]);
        expect(a.sessionTagsMap.size).toBe(0);
    });
});

describe('actions.setSessionFavorite', () => {
    it('optimistically updates then rolls back when PATCH fails', async () => {
        __setTaskCenterSessionsForTest([favoriteSession(false)]);
        sessionClientMocks.updateSession.mockRejectedValueOnce(new Error('write failed'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        try {
            const success = await actions.setSessionFavorite('s1', true);

            expect(success).toBe(false);
            expect(sessionClientMocks.updateSession).toHaveBeenCalledWith('s1', { favorite: true });
            expect(!!getSnapshot().sessions[0]?.favorite).toBe(false);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('serializes opposite in-flight requests so the final intent wins', async () => {
        __setTaskCenterSessionsForTest([favoriteSession(false)]);
        sessionClientMocks.getSessions.mockResolvedValue([favoriteSession()]);
        const firstPatch = deferred<SessionMetadata | null>();
        const secondPatch = deferred<SessionMetadata | null>();
        sessionClientMocks.updateSession
            .mockImplementationOnce(() => firstPatch.promise)
            .mockImplementationOnce(() => secondPatch.promise);

        const firstResult = actions.setSessionFavorite('s1', true);
        expect(getSnapshot().sessions[0]?.favorite).toBe(true);

        const secondResult = actions.setSessionFavorite('s1', false);
        expect(!!getSnapshot().sessions[0]?.favorite).toBe(false);
        expect(sessionClientMocks.updateSession).toHaveBeenCalledTimes(1);

        firstPatch.resolve(favoriteSession(true));
        await Promise.resolve();
        await Promise.resolve();

        expect(sessionClientMocks.updateSession).toHaveBeenCalledTimes(2);
        expect(sessionClientMocks.updateSession).toHaveBeenNthCalledWith(2, 's1', { favorite: false });

        secondPatch.resolve(favoriteSession());
        await expect(Promise.all([firstResult, secondResult])).resolves.toEqual([true, true]);
        expect(!!getSnapshot().sessions[0]?.favorite).toBe(false);
    });
});
