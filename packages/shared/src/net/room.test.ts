import { describe, expect, it } from 'vitest';

import { MATCH, TICK_DT } from '../config/match.ts';
import { Room, type RoomMember } from './room.ts';

const KEY = 'transport-key';

/** A room with one connected player, bound to `KEY`. */
function seated(): { room: Room; member: RoomMember } {
  const room = new Room(() => {});
  room.handle(KEY, { t: 'hello', name: 'A' });
  const member = [...room.members.values()][0]!;
  return { room, member };
}

describe('Room input handling', () => {
  it('keeps a one-shot choice until a tick consumes it', () => {
    // Movement is pumped at 30 Hz and the sim ticks at 20, so a draft pick is
    // very often followed by a plain movement input before any tick reads it.
    // If that overwrites the pick, the choice is silently dropped and the
    // player sits out the whole auto-pick timer.
    const { room, member } = seated();

    room.handle(KEY, { t: 'input', seq: 1, dirX: 0, dirY: 0, draftChoice: 2 });
    room.handle(KEY, { t: 'input', seq: 2, dirX: 1, dirY: 0 });

    expect(member.input.draftChoice, 'the pick was clobbered by a movement input').toBe(2);
    expect(member.input.dirX, 'movement should still be the latest').toBe(1);
  });

  it('clears a one-shot choice once a tick has consumed it', () => {
    const { room, member } = seated();
    room.setReady(member.id, true);
    room.start();

    room.handle(KEY, { t: 'input', seq: 1, dirX: 0, dirY: 0, chestChoice: 1 });
    room.advance(TICK_DT);

    expect(member.input.chestChoice, 'a consumed choice must not repeat').toBeUndefined();
  });

  it('starts the match as soon as the only human has drafted', () => {
    // Bots pick the instant the draft opens, so one human picking is the last
    // thing the draft is waiting on — play should begin there, not on the timer.
    const { room, member } = seated();
    room.setReady(member.id, true);
    room.start();
    expect(room.world?.phase).toBe('draft');

    room.handle(KEY, { t: 'input', seq: 1, dirX: 0, dirY: 0, draftChoice: 0 });
    room.advance(TICK_DT);

    expect(room.world?.phase, 'play should begin on the pick, not the timer').toBe('playing');
    expect(room.world!.draftRemaining, 'the draft timer barely ran').toBeGreaterThan(
      MATCH.draftSeconds - 1,
    );
  });
});
