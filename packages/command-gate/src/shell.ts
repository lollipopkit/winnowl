/**
 * A POSIX-shell reader, just deep enough to see which programs a command line runs and with which
 * words. It does not execute or expand anything. Constructs whose effect cannot be read off the
 * words (command substitution, process substitution, heredocs, grouping, function definitions)
 * are reported as `opaque`: the gate then hands the command to the judge instead of trusting a
 * rule.
 */

export interface Segment {
  /** Words after redirections and leading `NAME=value` assignments are taken out. */
  argv: string[];
  /** Ends with `&`: runs in the background. */
  background: boolean;
  /** Reads the previous segment's output through a pipe. */
  piped: boolean;
}

export interface ParsedCommand {
  segments: Segment[];
  /** Why parts of the command cannot be read from its words (empty: everything could). */
  opaque: string[];
}

type Token = { kind: 'word'; text: string } | { kind: 'op'; text: string };

const OPERATORS = ['&&', '||', ';;', '|&', ';', '|', '&', '\n', '(', ')'];
const REDIRECTS = ['&>>', '&>', '>>', '>|', '>&', '<&', '<>', '<<<', '<<-', '<<', '>', '<'];

function tokenize(input: string, opaque: Set<string>): Token[] {
  const tokens: Token[] = [];
  let word = '';
  let inWord = false;
  const flush = (): void => {
    if (inWord) tokens.push({ kind: 'word', text: word });
    word = '';
    inWord = false;
  };
  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    if (c === ' ' || c === '\t' || c === '\r') {
      flush();
      i++;
      continue;
    }
    if (c === '\\') {
      if (input[i + 1] === '\n') {
        i += 2; // line continuation
        continue;
      }
      word += input[i + 1] ?? '';
      inWord = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) {
        opaque.add('unbalanced quotes');
        word += input.slice(i + 1);
        inWord = true;
        break;
      }
      word += input.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < input.length) {
        const d = input[j]!;
        if (d === '\\' && j + 1 < input.length) {
          const n = input[j + 1]!;
          word += '"\\$`\n'.includes(n) ? (n === '\n' ? '' : n) : `\\${n}`;
          j += 2;
          continue;
        }
        if (d === '"') {
          closed = true;
          break;
        }
        if (d === '`' || (d === '$' && input[j + 1] === '(')) opaque.add('command substitution');
        word += d;
        j++;
      }
      if (!closed) opaque.add('unbalanced quotes');
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === '`' || (c === '$' && input[i + 1] === '(')) {
      opaque.add('command substitution');
      word += c;
      inWord = true;
      i++;
      continue;
    }
    if ((c === '<' || c === '>') && input[i + 1] === '(') {
      opaque.add('process substitution');
      word += c;
      inWord = true;
      i++;
      continue;
    }
    if (c === '#' && !inWord) {
      const nl = input.indexOf('\n', i);
      i = nl < 0 ? input.length : nl;
      continue;
    }
    // A file-descriptor number right before a redirection belongs to it (`2>&1`).
    if ((c === '<' || c === '>') && inWord && /^\d+$/.test(word)) {
      word = '';
      inWord = false;
    }
    const redirect = REDIRECTS.find((r) => input.startsWith(r, i));
    if (redirect) {
      flush();
      if (redirect.startsWith('<<') && redirect !== '<<<') opaque.add('heredoc');
      tokens.push({ kind: 'op', text: redirect });
      i += redirect.length;
      continue;
    }
    const op = OPERATORS.find((o) => input.startsWith(o, i));
    if (op) {
      flush();
      tokens.push({ kind: 'op', text: op });
      i += op.length;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  flush();
  return tokens;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function parseCommand(input: string): ParsedCommand {
  const opaque = new Set<string>();
  const tokens = tokenize(input, opaque);
  const segments: Segment[] = [];
  let current: string[] = [];
  let piped = false;
  let nextPiped = false;
  const end = (background: boolean): void => {
    // Leading assignments set the environment of the program; they run nothing.
    let k = 0;
    while (k < current.length && ASSIGNMENT.test(current[k]!)) k++;
    const argv = current.slice(k);
    if (argv.length > 0) segments.push({ argv, background, piped });
    else if (background) opaque.add('background job');
    current = [];
    piped = nextPiped;
    nextPiped = false;
  };
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t]!;
    if (tok.kind === 'word') {
      if ((tok.text === '{' || tok.text === '}') && current.length === 0) opaque.add('command grouping');
      else if (current.length === 0 && /^[A-Za-z_][\w-]*\(\)$/.test(tok.text)) opaque.add('function definition');
      current.push(tok.text);
      continue;
    }
    if (REDIRECTS.includes(tok.text)) {
      // The redirection's target is not an argument. `>&1` / `<&0` style targets are fds.
      const target = tokens[t + 1];
      if (target?.kind === 'word') t++;
      continue;
    }
    switch (tok.text) {
      case '(':
      case ')':
        opaque.add('subshell');
        end(false);
        break;
      case ';;':
        opaque.add('case statement');
        end(false);
        break;
      case '|':
      case '|&':
        nextPiped = true;
        end(false);
        break;
      case '&':
        end(true);
        break;
      default:
        end(false);
    }
  }
  end(false);
  if (segments.some((s) => s.argv[0] === 'function' || ['if', 'then', 'for', 'while', 'until', 'case', 'do', 'done', 'fi', 'esac'].includes(s.argv[0]!))) {
    opaque.add('shell control flow');
  }
  return { segments, opaque: [...opaque] };
}
