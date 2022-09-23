import { PublicKey } from '@solana/web3.js';

// Format and shorten a pubkey with ellipsis
export function formatPubkey(publicKey: PublicKey | string, halfLength = 4): string {
  const pubKey = publicKey.toString();
  return `${pubKey.substring(0, halfLength)}...${pubKey.substring(pubKey.length - halfLength)}`;
}

// Format rates
export function formatRate(rate: number, decimals?: number) {
  return parseFloat(formatRemainder((rate * 100).toFixed(decimals ?? 2))).toLocaleString() + '%';
}

// Format leverage
export function formatLeverage(leverage: number, decimals?: number) {
  return parseFloat(formatRemainder((leverage / 100).toFixed(decimals ?? 1))).toLocaleString() + 'x';
}

// Format Risk Indicator
export function formatRiskIndicator(riskIndicator?: number, decimals?: number) {
  if (!riskIndicator) {
    return '0';
  } else if (riskIndicator > 1) {
    return '>1';
  } else {
    return formatRemainder(riskIndicator.toFixed(decimals ?? 2));
  }
}

// Remove trailing 0's and decimal if necessary
export function formatRemainder(value: string): string {
  return parseFloat(value).toString();
}

// Add space between / of market pairs
export function formatMarketPair(pair: string): string {
  return pair.split('/')[0] + ' / ' + pair.split('/')[1];
}

// Remove locale formatting from number string
export function fromLocaleString(num: string): string {
  const { format } = new Intl.NumberFormat(navigator.language);
  const decimalSign = /^0(.)1$/.exec(format(0.1));
  return num.replace(new RegExp(`[^${decimalSign}\\d]`, 'g'), '.').replace(',', '');
}
