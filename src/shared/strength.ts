/**
 * Rough password strength 0..3 (weak, fair, strong, very strong) from length and character classes.
 * No dictionary: it only has to separate "short and plain" from "long and mixed".
 */
export function passwordLevel(pw: string): 0 | 1 | 2 | 3 {
  const pool = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].reduce((n, re, i) => n + (re.test(pw) ? [26, 26, 10, 33][i]! : 0), 0);
  const bits = pw.length * Math.log2(Math.max(pool, 2));
  return bits < 40 ? 0 : bits < 60 ? 1 : bits < 80 ? 2 : 3;
}
