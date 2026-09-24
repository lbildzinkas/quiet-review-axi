import { z } from 'zod'
import { QuietReviewError } from '../errors.js'
import { runSubprocess, type SubprocessOutcome } from '../infra/subprocess.js'
import { buildLabelRequest } from './label-check.js'
import type { LabelBackend } from './label-model.js'

// The label model reached through the Pi coding agent CLI (spec 10.6), run as a subprocess in
// print mode. Pi holds the provider sign-in, so a flat-rate subscription answers and this
// program never sees a credential. Each call costs $0 against --max-cost.
const COMMAND = 'pi'
const PROVIDER = 'pi'
export const DEFAULT_PI_TIMEOUT_SECONDS = 300
const VERSION_TIMEOUT_MS = 30_000
// Pi adds its working directory to the system prompt, so it runs in a fixed one (R17).
const WORKING_DIRECTORY = '/'
const MAX_MESSAGE_CHARACTERS = 200

export interface PiBackendOptions {
  // A Pi model pattern, such as `zai-coding-cn/glm-5.3`.
  model: string
  // Pi's thinking level, such as `max`.
  thinking: string
  timeoutSeconds: number
  // The environment pi runs in: its PATH finds `pi`, its HOME holds pi's sign-in.
  env: Record<string, string | undefined>
  redact: (text: string) => string
}

// What is cached for one answer: the answer text and the facts the call log records.
const piResponseSchema = z.object({
  text: z.string(),
  model: z.string(),
  response_id: z.string().nullable(),
  input_tokens: z.number().int().nonnegative().nullable(),
  output_tokens: z.number().int().nonnegative().nullable(),
  stop_reason: z.string(),
  cli_version: z.string(),
})

type PiResponse = z.infer<typeof piResponseSchema>

export function piBackend(options: PiBackendOptions): LabelBackend<PiResponse> {
  let version: string | null = null
  const timeoutMs = options.timeoutSeconds * 1000
  return {
    provider: PROVIDER,
    model: options.model,
    describe: `${options.model} through pi`,
    request(item) {
      // The fixed template's messages (spec 10.6): the instructions as pi's system prompt and
      // the evidence on stdin, so comment text never appears in the process arguments.
      const [system, user] = buildLabelRequest(item, options.model).messages
      return {
        endpoint: COMMAND,
        body: {
          args: [
            '--print',
            '--mode',
            'json',
            '--model',
            options.model,
            '--thinking',
            options.thinking,
            '--no-session',
            '--no-tools',
            '--no-extensions',
            '--no-skills',
            '--no-prompt-templates',
            '--no-context-files',
            '--no-themes',
            '--no-approve',
            '--offline',
            '--system-prompt',
            system?.content ?? '',
          ],
          stdin: user?.content ?? '',
        },
      }
    },
    fits: async () => true,
    async call(request) {
      version ??= await readVersion(options)
      const { args, stdin } = request.body as { args: string[]; stdin: string }
      const outcome = await run(options, args, stdin, timeoutMs)
      const message = lastAnswer(outcome.stdout)
      if (!message)
        throw new QuietReviewError(
          'INVALID_RESPONSE',
          'The label model gave no answer through pi: its output holds no assistant message',
        )
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        const reason = options.redact(message.errorMessage ?? message.stopReason)
        throw new QuietReviewError(
          'PROVIDER_ERROR',
          `The label model call through pi failed: ${firstLine(reason)}`,
          [RESUME_HELP, 'Check the subscription with `pi` itself, then run the check stage again'],
          { providerBody: reason },
        )
      }
      const usage = message.usage
      return {
        response: {
          text: message.content
            .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
            .join(''),
          model: message.model,
          response_id: message.responseId ?? null,
          input_tokens: usage
            ? usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
            : null,
          output_tokens: usage ? usage.output : null,
          stop_reason: message.stopReason,
          cli_version: version,
        },
        costUsd: 0,
        costSource: 'subscription',
      }
    },
    validate(cached) {
      const parsed = piResponseSchema.safeParse(cached)
      return parsed.success ? parsed.data : null
    },
    read: (response) => ({
      content: response.text,
      snapshot: response.model,
      responseId: response.response_id,
      inputTokens: response.input_tokens,
      outputTokens: response.output_tokens,
      logFields: { cli_version: response.cli_version },
    }),
  }
}

const RESUME_HELP = 'Answers already given are cached, so a re-run asks only about the rest'

// Runs pi and returns its output when it exited 0; any other end stops the check stage.
async function run(
  options: PiBackendOptions,
  args: string[],
  stdin: string,
  timeoutMs: number,
): Promise<{ stdout: string }> {
  const outcome = await runSubprocess({
    command: COMMAND,
    args,
    stdin,
    env: options.env,
    cwd: WORKING_DIRECTORY,
    timeoutMs,
  })
  return exitedCleanly(outcome, options, timeoutMs)
}

function exitedCleanly(
  outcome: SubprocessOutcome,
  options: PiBackendOptions,
  timeoutMs: number,
): { stdout: string } {
  if (outcome.kind === 'not-found')
    throw new QuietReviewError(
      'PROVIDER_ERROR',
      'The label backend pi is not installed: no `pi` on PATH',
      [
        'Install the Pi coding agent CLI and sign it in to the provider of label_check.model',
        'Check that pi can reach the model with `pi --list-models`',
      ],
    )
  if (outcome.kind === 'timeout')
    throw new QuietReviewError('PROVIDER_ERROR', `pi did not answer within ${timeoutMs / 1000} s`, [
      RESUME_HELP,
    ])
  if (outcome.code === 0) return { stdout: outcome.stdout }
  const stderr = options.redact(outcome.stderr.trim())
  const how =
    outcome.code === null ? `was stopped by ${outcome.signal}` : `exited with code ${outcome.code}`
  throw new QuietReviewError(
    'PROVIDER_ERROR',
    `pi ${how}${stderr === '' ? '' : `: ${firstLine(stderr)}`}`,
    [RESUME_HELP],
    { providerBody: stderr },
  )
}

async function readVersion(options: PiBackendOptions): Promise<string> {
  const outcome = await runSubprocess({
    command: COMMAND,
    args: ['--version'],
    env: options.env,
    cwd: WORKING_DIRECTORY,
    timeoutMs: VERSION_TIMEOUT_MS,
  })
  const { stdout } = exitedCleanly(outcome, options, VERSION_TIMEOUT_MS)
  return stdout.trim().split('\n').pop()?.trim() || 'unknown'
}

// The parts of pi's JSON event stream this reads: the final assistant message.
const assistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  model: z.string(),
  responseId: z.string().optional(),
  usage: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      cacheRead: z.number().int().nonnegative().optional(),
      cacheWrite: z.number().int().nonnegative().optional(),
    })
    .optional(),
  stopReason: z.string(),
  errorMessage: z.string().optional(),
})

// The last `message_end` event that carries an assistant message; lines that are not JSON,
// or events of other kinds, are skipped.
function lastAnswer(stdout: string): z.infer<typeof assistantMessageSchema> | null {
  let answer: z.infer<typeof assistantMessageSchema> | null = null
  for (const line of stdout.split('\n')) {
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof event !== 'object' || event === null) continue
    const { type, message } = event as { type?: unknown; message?: unknown }
    if (type !== 'message_end') continue
    const parsed = assistantMessageSchema.safeParse(message)
    if (parsed.success) answer = parsed.data
  }
  return answer
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').slice(0, MAX_MESSAGE_CHARACTERS)
}
