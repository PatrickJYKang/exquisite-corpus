# exquisite-corpus

A minimal CLI for generating exquisite-corpus style chained texts using OpenRouter models.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Put your OpenRouter API key in `.env`:

```env
OPENROUTER_API_KEY=your_key_here
```

3. Create a text file with one starting line per line.

4. Fill `models.txt` with one OpenRouter model ID per line.

## Usage

```bash
npm run generate -- --input seeds.txt --models-file models.txt --variants 2 --output output/corpus.jsonl --text-output output/out.txt
```

## Output

The command writes two outputs:

- `output/corpus.jsonl` with one JSON record per chain run containing:

  - `seed`
  - `variant`
  - `status`
  - `finalLine`
  - `steps`
  - `errors`
  - `createdAt`

- `output/out.txt` with one saved chain per block, including partial chains, where each successful line is annotated inline with its source in brackets and any failures are summarized at the end

## Notes

- Each model is used in the order listed in `models.txt`.
- Each model sees only the immediately previous line, not the full history.
- `--variants` controls how many independent chains are run per seed.
- `out.txt` includes the original seed as `[seed]` and generated lines as `[model-id]`.
- Each model request times out after 10 seconds.
- Failed or timed-out models are skipped, and the chain continues from the last successful line.
- `.env` is ignored by git.
- You can optionally set `OPENROUTER_REFERER` and `OPENROUTER_TITLE` in `.env`.
