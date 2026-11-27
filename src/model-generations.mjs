// Publicly released generations as of 2026-11-28, independent of the Devin account catalog.
// Keep the vendor release evidence and same-generation branches together.
const vendors = [
  // Cognition: https://cognition.com/blog/swe-2-1
  ['swe-2-1'],
  // Anthropic: https://www.anthropic.com/system-cards
  ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-mythos-5-2'],
  // OpenAI: https://openai.com/index/introducing-gpt-6-2-astra-sol/
  ['gpt-6-2-astra', 'gpt-6-2-sol'],
  // Google: https://blog.google/intl/en-in/products/introducing-gemini-4-neon/
  ['gemini-4-argon', 'gemini-4-carbon', 'gemini-4-hydrogen', 'gemini-4-neon'],
  // Moonshot: https://forum.moonshot.ai/t/kimi-k3-1-pro-has-launched-start-exploring-now/629
  ['kimi-k3-1-pro'],
  // Z.ai: https://docs.z.ai/devpack/latest-model — GLM-5.4 is released; no GLM-5.4 Flash yet.
  ['glm-5-4'],
  // xAI: https://docs.x.ai/developers/models
  ['grok-4-7'],
  // Meta: https://openrouter.ai/meta/muse-wonder (Devin exposes the standard branch).
  ['muse-wonder-1-0', 'muse-wonder-full-1-0'],
  // NVIDIA: https://developer.nvidia.com/topics/ai/nemotron
  ['nemotron-3-5-super', 'nemotron-3-5-super-vl', 'nemotron-3-5-lightning'],
  // DeepSeek: https://api-docs.deepseek.com/quick_start/pricing/
  ['deepseek-v4-1-flash', 'deepseek-v4-1-flash-1017']
];

const currentFamilies = new Set(vendors.flat());

// Devin family IDs can contain dots; match the family, not a guessed model version.
export const isCurrentModelFamily = (id) => typeof id === 'string'
  && currentFamilies.has(id.toLowerCase().replace(/\.(?=\d)/g, '-'));
