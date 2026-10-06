// Browser-only test build: synthetic prices generated in the page, no server.
import { demoHistory } from '../../public/js/demo-prices.mjs';
window.PSE_HOSTED = true;
window.PSE_PRICE_PROVIDER = async (symbols, from, to) => {
  const data = {};
  for (const s of symbols) data[s] = demoHistory(s, from, to);
  return { mode: 'demo', data, errors: {} };
};
