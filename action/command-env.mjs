import { existsSync } from 'node:fs';

const SECRET_NAME = /TOKEN|SECRET|PASSW|CREDENTIAL|API_?KEY|PRIVATE|AUTH/i;
const RUNNER_NAME = /^(ACTIONS_|GITHUB_|RUNNER_|INPUT_|STATE_|LLM_|EXA_|CONTEXT7_|WINNOWL_)/;

/** The runner's toolchain environment (PATH, JAVA_HOME, …) without anything that looks like a credential. */
export function commandEnv(env, user) {
  const home = `/home/${user}`;
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || RUNNER_NAME.test(k) || SECRET_NAME.test(k)) continue;
    if (['HOME', 'USER', 'LOGNAME', 'MAIL', 'SSH_AUTH_SOCK', 'OLDPWD', 'PWD', 'SUDO_COMMAND', 'SUDO_USER', 'SUDO_UID', 'SUDO_GID'].includes(k)) continue;
    out[k] = v;
  }
  // Tool homes the commands must write to move to the command user's home; toolchains stay readable.
  if (env.HOME && !out.RUSTUP_HOME && existsSync(`${env.HOME}/.rustup`)) out.RUSTUP_HOME = `${env.HOME}/.rustup`;
  out.CARGO_HOME = `${home}/.cargo`;
  return { ...out, HOME: home, USER: user, LOGNAME: user, CI: 'true' };
}
