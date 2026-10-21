import { describe, expect, it } from 'vitest';
import { createPool } from '../src/index.js';

describe('createPool', () => {
  it('handles idle connection errors instead of letting them kill the process', async () => {
    const seen: string[] = [];
    const pool = createPool({ connectionString: 'postgres://u:p@127.0.0.1:1/db', onIdleError: (e) => void seen.push(e.message) });
    // An unhandled `error` event would throw here (EventEmitter semantics).
    expect(() => pool.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();
    expect(seen).toEqual(['Connection terminated unexpectedly']);
    await pool.end();
  });

  it('has a default listener', async () => {
    const pool = createPool({ connectionString: 'postgres://u:p@127.0.0.1:1/db' });
    expect(pool.listenerCount('error')).toBe(1);
    await pool.end();
  });
});
