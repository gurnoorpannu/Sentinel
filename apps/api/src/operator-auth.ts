import { timingSafeEqual } from 'node:crypto';

export function hasValidOperatorToken(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  const prefix = 'Bearer ';
  if (!authorization?.startsWith(prefix)) {
    return false;
  }

  const presented = Buffer.from(authorization.slice(prefix.length), 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
