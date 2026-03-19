import { config as loadEnv } from 'dotenv';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

loadEnv();

const defaultSystemPrompt = 'Write exactly one next line based only on the previous line provided. Return only the next line, with no explanation, no quotation marks, and no extra formatting.';
const requestTimeoutMs = 10000;

function toNumber(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === '-h') {
      args.help = 'true';
      continue;
    }

    if (!current.startsWith('--')) {
      continue;
    }

    const key = current.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith('--')) {
      args[key] = 'true';
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

function printUsage() {
  console.log(`Usage:
  npm run generate -- --input seeds.txt --models-file models.txt [options]
  node src/generate.js --input seeds.txt --models-file models.txt [options]

Description:
  Generate exquisite-corpus style chains from seed lines and model IDs.
  Each model sees only the immediately previous line.
  Failed or timed-out model steps are skipped, and partial chains are still saved.

Required:
  --input <path>            Text file with one seed line per line

Model selection:
  --models-file <path>      Text file with one model ID per line
  --models <list>           Comma-separated model IDs fallback if no models file is given

Generation:
  --variants <number>       Independent chain runs per seed (default: 1)
  --temperature <number>    Sampling temperature for each model call (default: 0.9)
  --max-tokens <number>     Maximum tokens requested per generated line (default: 80)
  --system-prompt <text>    Override the default one-line continuation instruction

Output:
  --output <path>           JSONL output path (default: output/corpus.jsonl)
  --text-output <path>      Plain text output path (default: output/out.txt)

Environment:
  OPENROUTER_API_KEY        Required; loaded from .env
  OPENROUTER_REFERER        Optional; sent as HTTP-Referer
  OPENROUTER_TITLE          Optional; sent as X-Title

Behavior:
  - Each request times out after ${requestTimeoutMs}ms.
  - Chains are saved even if some models fail.
  - out.txt includes inline [model-id] attribution and an [errors: ...] summary when needed.

Examples:
  npm run generate -- --input seeds.txt --models-file models.txt
  npm run generate -- --input seeds.txt --models-file models.txt --variants 3
  npm run generate -- --input seeds.txt --models deepseek/deepseek-v3.2,google/gemini-3-flash-preview

Help:
  --help, -h                Show this message
`);
}

function normalizeContinuation(text) {
  const firstLine = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  return firstLine ?? '';
}

function normalizeErrorMessage(error) {
  if (error?.name === 'AbortError') {
    return `Timed out after ${requestTimeoutMs}ms.`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function requestContinuation({ apiKey, model, seed, temperature, maxTokens, systemPrompt }) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };

  if (process.env.OPENROUTER_REFERER) {
    headers['HTTP-Referer'] = process.env.OPENROUTER_REFERER;
  }

  if (process.env.OPENROUTER_TITLE) {
    headers['X-Title'] = process.env.OPENROUTER_TITLE;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);

  let response;

  try {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `Previous line:\n${seed}`
          }
        ]
      })
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter request failed for model ${model}: ${response.status} ${response.statusText}\n${errorText}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error(`OpenRouter returned no content for model ${model}.`);
  }

  return normalizeContinuation(content);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help === 'true') {
    printUsage();
    return;
  }

  const inputPath = args.input;
  const modelsFilePath = args['models-file'];
  const variants = Math.max(1, Math.floor(toNumber(args.variants, 1)));
  const outputPath = path.resolve(args.output ?? 'output/corpus.jsonl');
  const textOutputPath = path.resolve(args['text-output'] ?? 'output/out.txt');
  const temperature = toNumber(args.temperature, 0.9);
  const maxTokens = Math.max(1, Math.floor(toNumber(args['max-tokens'], 80)));
  const systemPrompt = args['system-prompt'] ?? defaultSystemPrompt;
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error('Missing OPENROUTER_API_KEY in .env');
  }

  if (!inputPath) {
    throw new Error('Missing required --input argument');
  }

  let models = [];

  if (modelsFilePath) {
    const resolvedModelsPath = path.resolve(modelsFilePath);
    const modelsText = await readFile(resolvedModelsPath, 'utf8');
    models = modelsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } else {
    models = String(args.models ?? '')
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean);
  }

  if (models.length === 0) {
    throw new Error('Missing models. Provide --models-file with one model ID per line, or use --models as a fallback.');
  }

  const resolvedInputPath = path.resolve(inputPath);
  const inputText = await readFile(resolvedInputPath, 'utf8');
  const seeds = inputText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (seeds.length === 0) {
    throw new Error(`No seed lines found in ${resolvedInputPath}`);
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, '', 'utf8');
  await mkdir(path.dirname(textOutputPath), { recursive: true });
  await writeFile(textOutputPath, '', 'utf8');

  const totalChains = seeds.length * variants;
  let completedChains = 0;
  let fullySuccessfulChains = 0;
  let partialChains = 0;
  let failedChains = 0;

  for (const seed of seeds) {
    for (let variant = 1; variant <= variants; variant += 1) {
      let previousLine = seed;
      const steps = [];
      const errors = [];

      for (let stepIndex = 0; stepIndex < models.length; stepIndex += 1) {
        const model = models[stepIndex];

        try {
          const continuation = await requestContinuation({
            apiKey,
            model,
            seed: previousLine,
            temperature,
            maxTokens,
            systemPrompt
          });

          steps.push({
            step: stepIndex + 1,
            model,
            promptLine: previousLine,
            continuation
          });

          console.log(`[chain ${completedChains + 1}/${totalChains}] step ${stepIndex + 1}/${models.length} ${model} | ${previousLine} -> ${continuation}`);
          previousLine = continuation;
        } catch (error) {
          const errorMessage = normalizeErrorMessage(error);

          steps.push({
            step: stepIndex + 1,
            model,
            promptLine: previousLine,
            continuation: null,
            error: errorMessage
          });

          errors.push({
            step: stepIndex + 1,
            model,
            error: errorMessage
          });

          console.error(`[chain ${completedChains + 1}/${totalChains}] step ${stepIndex + 1}/${models.length} ${model} failed: ${errorMessage}`);
        }
      }

      completedChains += 1;
      const successfulSteps = steps.filter((step) => step.continuation);
      const status = successfulSteps.length === models.length
        ? 'completed'
        : successfulSteps.length > 0
          ? 'partial'
          : 'failed';

      if (status === 'failed') {
        failedChains += 1;
      } else if (status === 'partial') {
        partialChains += 1;
      } else {
        fullySuccessfulChains += 1;
      }

      const record = {
        seed,
        variant,
        status,
        finalLine: successfulSteps.length > 0 ? successfulSteps[successfulSteps.length - 1].continuation : seed,
        steps,
        errors,
        createdAt: new Date().toISOString()
      };

      await appendFile(outputPath, `${JSON.stringify(record)}\n`, 'utf8');

      const textLines = [`${seed} [seed]`];

      for (const step of steps) {
        if (!step.continuation) {
          continue;
        }

        textLines.push(`${step.continuation} [${step.model}]`);
      }

      if (errors.length > 0) {
        const errorSummary = errors
          .map((entry) => `${entry.model}: ${entry.error.replace(/\s+/g, ' ').trim()}`)
          .join(' | ');

        textLines.push(`[errors: ${errorSummary}]`);
      }

      await appendFile(textOutputPath, `${textLines.join('\n')}\n\n`, 'utf8');
    }
  }

  console.log(`\nSaved ${completedChains} chains to ${outputPath}`);
  console.log(`Saved chain texts to ${textOutputPath}`);
  console.log(`Completed ${fullySuccessfulChains} full chains, ${partialChains} partial chains, and ${failedChains} failed chains.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
