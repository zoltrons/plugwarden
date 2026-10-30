// Card number helpers: Luhn check, brand from the leading digits, and the grouping people read it in.

const digits = (n: string): string => n.replace(/[\s-]/g, "");

/** True when `n` is 12-19 digits with a valid Luhn checksum. */
export function luhnValid(n: string): boolean {
  const d = digits(n);
  if (!/^\d{12,19}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let v = Number(d[d.length - 1 - i]);
    if (i % 2 === 1 && (v *= 2) > 9) v -= 9;
    sum += v;
  }
  return sum % 10 === 0;
}

/** Brand names as the Bitwarden clients store them, or undefined when the prefix is not recognised. */
export function cardBrand(n: string): string | undefined {
  const d = digits(n);
  if (/^4/.test(d)) return "Visa";
  if (/^(5[1-5]|2(2[2-9]|[3-6]|7[01]|720))/.test(d)) return "Mastercard";
  if (/^3[47]/.test(d)) return "Amex";
  if (/^(6011|65|64[4-9])/.test(d)) return "Discover";
  if (/^3(0[0-5]|[68])/.test(d)) return "Diners Club";
  if (/^35(2[89]|[3-8])/.test(d)) return "JCB";
  if (/^62/.test(d)) return "UnionPay";
  return undefined;
}

/** `4111 1111 1111 1111`; American Express reads 4-6-5. Non-numeric input is returned untouched. */
export function groupCardNumber(n: string): string {
  const d = digits(n);
  if (!/^\d+$/.test(d)) return n;
  return /^3[47]/.test(d) && d.length === 15 ? `${d.slice(0, 4)} ${d.slice(4, 10)} ${d.slice(10)}` : (d.match(/.{1,4}/g) ?? []).join(" ");
}
