export type OutputMode = 'human' | 'json' | 'jsonl';
export interface CliOptions {
  command: string;
  positionals: string[];
  url?: string;
  token?: string;
  tokenFile?: string;
  project?: string;
  workDir?: string;
  backend?: string;
  profile?: string;
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  session?: string;
  run?: string;
  output: OutputMode;
  answers?: string;
  action?: string;
  reply?: 'once' | 'always' | 'reject';
  requestId?: string;
  after: number;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { command: 'chat', positionals: [], output: 'human', after: 0, help: false, version: false };
  const stringFlags = new Map<string, keyof CliOptions>([
    ['--url', 'url'], ['--token', 'token'], ['--token-file', 'tokenFile'], ['--project', 'project'],
    ['--work-dir', 'workDir'], ['--backend', 'backend'], ['--profile', 'profile'], ['--model', 'model'],
    ['--reasoning-effort', 'reasoningEffort'], ['--session', 'session'], ['--run', 'run'],
    ['--answers', 'answers'], ['--action', 'action'], ['--reply', 'reply'], ['--request-id', 'requestId'],
  ]);
  let hasCommand = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') { options.positionals.push(...argv.slice(index + 1)); break; }
    if (arg === '-h' || arg === '--help') { options.help = true; continue; }
    if (arg === '-v' || arg === '--version') { options.version = true; continue; }
    if (arg === '--json' || arg === '--jsonl') {
      const mode = arg === '--json' ? 'json' : 'jsonl';
      if (options.output !== 'human' && options.output !== mode) throw new Error('--json and --jsonl are mutually exclusive.');
      options.output = mode; continue;
    }
    if (arg === '--after') {
      options.after = Number(argv[++index]);
      if (!Number.isSafeInteger(options.after) || options.after < 0) throw new Error('--after requires a non-negative integer.');
      continue;
    }
    const key = stringFlags.get(arg);
    if (key) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      Object.assign(options, { [key]: value }); continue;
    }
    if (arg.startsWith('-') && arg !== '-') throw new Error(`Unknown option: ${arg}`);
    if (!hasCommand) { options.command = arg; hasCommand = true; }
    else options.positionals.push(arg);
  }
  if (options.reply && !['once', 'always', 'reject'].includes(options.reply)) throw new Error('Invalid permission reply.');
  if (options.reasoningEffort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(options.reasoningEffort)) throw new Error('Invalid reasoning effort.');
  if (options.action && !['submit', 'decline', 'cancel', 'save', 'revise', 'execute'].includes(options.action)) throw new Error('Invalid interaction action.');
  return options;
}

export const HELP = `Synax — Runtime client and universal Agent CLI

Usage:
  synax [chat] [options]                  Interactive session (TTY)
  synax exec <message|-> [options]        One-shot execution; - reads stdin
  synax resume <session-id> [message]     Attach (TTY) or continue (non-TTY)
  synax watch <run-id> --session <id>     Observe an existing Run
  synax backends [--json]                List backend capabilities
  synax models <backend-id>              List backend models
  synax projects [--json]                List projects
  synax sessions [--json]                List persisted sessions
  synax approve <permission-id> --session <id> [--reply once|always|reject]
  synax answer <interaction-id> --session <id> [--answers <json>] [--action <action>]
  synax pause|cancel --session <id> [--run <id>]
  synax rpc                              Concurrent JSONL request/event protocol

Options:
  --url <url>                            Runtime URL (default: SYNAX_API or http://127.0.0.1:3210)
  --token <token> | --token-file <path>   Runtime credentials; never passed in URLs
  --project <id>                         Project ID or SYNAX_PROJECT_ID
  --work-dir <path>                      Runtime-local working directory (default: cwd)
  --backend <id>                         native, codex, claude-code, ACP...
  --profile <id>                         Session profile (default: synax)
  --model <id>                           Backend model
  --reasoning-effort <level>             low, medium, high, xhigh, max
  --session <id>                         Reuse a persisted session
  --request-id <id>                      Stable Run submission key for explicit retries
  --after <sequence>                     Reattach to a Run after a journal cursor
  --json | --jsonl                       Final JSON or event/result JSONL
  -h, --help | -v, --version

Interactive controls:
  /new /sessions /resume <id> /approve <id> [once|always|reject]
  /answer <id> <answers JSON or {"action":"execute"}> /pause /cancel /exit
  Control commands remain available while a Run is active. /exit detaches;
  Ctrl-C requests cancellation and waits for Runtime shutdown confirmation.

Environment:
  SYNAX_API, SYNAX_RUNTIME_TOKEN, SYNAX_RUNTIME_TOKEN_FILE, DATA_ROOT,
  SYNAX_PROJECT_ID, SYNAX_WORK_DIR, SYNAX_BACKEND_ID, SYNAX_PROFILE_ID
`;
