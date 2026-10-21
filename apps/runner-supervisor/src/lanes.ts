import { sandboxCapacity } from './sandbox-backend.js';
import type { RunnerLane } from './supervisor.js';

const SANDBOX_JOB_TYPES = ['review_revision'];
const COMMAND_JOB_TYPES = ['conversation_turn'];
const CHAT_JOB_TYPES = ['conversation_agent'];
const envConcurrency = (name: string, fallback: number): number =>
  Math.max(1, Number(process.env[name]) || fallback);

/*
 * Runner lanes. The sandbox lane is sized to the hosts' slots and holds review_revision only.
 * action_execute stays in the background lane: its optional validation sandbox is admitted by the hosts'
 * memory budget, so a fix never waits behind reviews. conversation_turn has its own lane so user commands
 * never queue behind other jobs, and conversation_agent (minutes of model time per answer) has its own so it
 * neither delays commands nor waits behind background work; every other type falls into the background lane
 * via `excludeTypes`.
 */
export function runnerLanes(): RunnerLane[] {
  return [
    {
      name: 'sandbox',
      types: SANDBOX_JOB_TYPES,
      // Sandbox hosts set the default from their slots; RUNNER_CONCURRENCY still wins.
      concurrency: envConcurrency('RUNNER_CONCURRENCY', sandboxCapacity()),
    },
    {
      name: 'command',
      types: COMMAND_JOB_TYPES,
      concurrency: envConcurrency('RUNNER_COMMAND_CONCURRENCY', 2),
    },
    {
      name: 'chat',
      types: CHAT_JOB_TYPES,
      concurrency: envConcurrency('RUNNER_CHAT_CONCURRENCY', 2),
    },
    {
      name: 'background',
      excludeTypes: [...SANDBOX_JOB_TYPES, ...COMMAND_JOB_TYPES, ...CHAT_JOB_TYPES],
      concurrency: envConcurrency('RUNNER_BACKGROUND_CONCURRENCY', 2),
    },
  ];
}
