import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'bun:test';
import { watchInterrupts } from '../src/interrupt';

const setup = () => {
  const source = new EventEmitter();
  const logs: string[] = [];
  const exits: number[] = [];
  const interrupts = watchInterrupts(source, { log: m => logs.push(m), exit: code => exits.push(code) });
  return { source, logs, exits, interrupts };
};

describe('watchInterrupts', () => {
  test('the first SIGINT aborts the run gracefully: no exit yet, a hint about a second Ctrl+C', () => {
    const { source, logs, exits, interrupts } = setup();
    expect(interrupts.signal.aborted).toBe(false);
    expect(interrupts.interruptedBy).toBeUndefined();
    source.emit('SIGINT');
    expect(interrupts.signal.aborted).toBe(true);
    expect(interrupts.interruptedBy).toBe('SIGINT');
    expect(exits).toEqual([]);
    expect(logs).toEqual([
      '[evals] SIGINT: cancelling the current task and writing a partial report (send it again to exit now)',
    ]);
  });

  test('a second signal exits at once with the signal exit code', () => {
    const { source, exits, logs } = setup();
    source.emit('SIGTERM');
    source.emit('SIGINT');
    expect(exits).toEqual([130]);
    expect(logs.at(-1)).toBe('[evals] SIGINT again: exiting now without cleanup');
    const term = setup();
    term.source.emit('SIGINT');
    term.source.emit('SIGTERM');
    expect(term.exits).toEqual([143]);
  });

  test('dispose removes the listeners', () => {
    const { source, interrupts } = setup();
    expect(source.listenerCount('SIGINT')).toBe(1);
    expect(source.listenerCount('SIGTERM')).toBe(1);
    interrupts.dispose();
    expect(source.listenerCount('SIGINT')).toBe(0);
    expect(source.listenerCount('SIGTERM')).toBe(0);
  });
});
