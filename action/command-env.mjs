// Broad on purpose: a toolchain variable dropped by mistake fails a build; a credential let through leaks.
const SECRET_NAME = /TOKEN|SECRET|PASS|CREDENTIAL|KEY|PRIVATE|AUTH|COOKIE|SESSION|DSN|CONN(ECTION)?_?STR|DATABASE_URL|(^|_)PAT($|_)/i;
// A URL carrying a user and password, whatever its variable is called.
const SECRET_VALUE = /:\/\/[^/\s:@]+:[^/\s@]+@/;
const RUNNER_NAME = /^(ACTIONS_|GITHUB_|RUNNER_|INPUT_|STATE_|LLM_|EXA_|CONTEXT7_|WINNOWL_)/;

/** The runner's toolchain environment (PATH, JAVA_HOME, …) without anything that looks like a credential. */
export function commandEnv(env, user) {
  const home = `/home/${user}`;
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || RUNNER_NAME.test(k) || SECRET_NAME.test(k) || SECRET_VALUE.test(v)) continue;
    if (['HOME', 'USER', 'LOGNAME', 'MAIL', 'SSH_AUTH_SOCK', 'OLDPWD', 'PWD', 'SUDO_COMMAND', 'SUDO_USER', 'SUDO_UID', 'SUDO_GID'].includes(k)) continue;
    out[k] = v;
  }
  // The runner's home is closed to commands; tool homes they write to are their own.
  out.CARGO_HOME = `${home}/.cargo`;
  return { ...out, HOME: home, USER: user, LOGNAME: user, CI: 'true' };
}
