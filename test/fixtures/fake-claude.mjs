#!/usr/bin/env node
// A stand-in for `claude -p --input-format stream-json`: each user line gets a two-call turn
// whose usage numbers are the ones a real haiku turn reported (1-hour cache, $1/M input).
import { createInterface } from 'node:readline';

const out = m => process.stdout.write(JSON.stringify(m) + '\n');
const call = (id, input, write, read, output, content) => ({
  type: 'assistant',
  message: {
    id,
    content,
    usage: { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write }, output_tokens: output },
  },
});
let turn = 0;
createInterface({ input: process.stdin }).on('line', line => {
  if (!JSON.parse(line).message) return;
  turn++;
  const n = turn;
  out(call(`a${n}`, 10, 28939, 0, 4, [{ type: 'thinking' }]));
  out(call(`a${n}`, 10, 28939, 0, 4, [{ type: 'tool_use', id: `t${n}`, name: 'Read', input: { file_path: 'a.txt' } }]));
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: 'hello world' }] } });
  out(call(`b${n}`, 8, 1135, 28939, 1, [{ type: 'text', text: 'hello' }]));
  // modelUsage is the process's total so far, by model.
  out({
    type: 'result',
    total_cost_usd: 0.0668399 * n,
    usage: { input_tokens: 18, cache_creation_input_tokens: 30074, cache_read_input_tokens: 28939, output_tokens: 562 },
    modelUsage: { 'claude-haiku-4-5': { inputTokens: 928 * n, outputTokens: 574 * n, cacheReadInputTokens: 28939 * n, cacheCreationInputTokens: 30074 * n, costUSD: 0.0668399 * n, contextWindow: 200000 } },
  });
});
