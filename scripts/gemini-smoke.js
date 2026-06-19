'use strict';
const { getProvider } = require('../src/v3/llm/LLMProvider');
(async () => {
  const g = getProvider('gemini');
  console.log('provider:', g.name);
  try {
    const r = await g.classify('iniciei linha de producao do plant sterols lote 0218', {});
    console.log('GEMINI OK →', JSON.stringify(r).slice(0, 300));
  } catch (e) { console.log('GEMINI ERRO:', e.message); process.exit(1); }
  process.exit(0);
})();
