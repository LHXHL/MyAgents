import { expectTypeOf, it } from 'vitest';
import type { DesktopMessageRequest, ImMessageRequest, InjectedTurnRequest } from './types';
import type { TurnOwner, TurnTerminalObserver } from '../session-core/turn-queue';

type DesktopInput = Pick<DesktopMessageRequest, 'text' | 'sessionId' | 'workspacePath' | 'scenario'>;
type ImInput = Pick<ImMessageRequest, 'message' | 'requestId' | 'sessionId' | 'workspacePath' | 'scenario'>;

it('requires a turn boundary for an independent owner or terminal, while ordinary IM retains realtime admission', () => {
  expectTypeOf<DesktopInput>().toExtend<DesktopMessageRequest>();
  expectTypeOf<ImInput>().toExtend<ImMessageRequest>();
  expectTypeOf<DesktopInput & { onTerminal: TurnTerminalObserver }>().not.toExtend<DesktopMessageRequest>();
  expectTypeOf<ImInput & { turnOwner: TurnOwner }>().not.toExtend<ImMessageRequest>();
  expectTypeOf<ImInput & { onTerminal: TurnTerminalObserver; turnBoundaryOnly: false }>().not.toExtend<ImMessageRequest>();
  expectTypeOf<DesktopInput & { onTerminal: TurnTerminalObserver; turnBoundaryOnly: true }>().toExtend<DesktopMessageRequest>();
  expectTypeOf<ImInput & { turnOwner: TurnOwner; turnBoundaryOnly: true }>().toExtend<ImMessageRequest>();
  // A tool surface can require a boundary without owning an independent result.
  expectTypeOf<ImInput & { turnBoundaryOnly: boolean }>().toExtend<ImMessageRequest>();
  expectTypeOf<'turnBoundaryOnly'>().not.toExtend<keyof InjectedTurnRequest>();
});
