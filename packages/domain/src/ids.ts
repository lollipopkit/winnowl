/** Internal entity id (UUIDv7). */
export type Uuid = string;

/** Provider-native id; always a string, never assume an integer. */
export type ProviderNativeId = string;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function isUuidV7(value: string): boolean {
  return isUuid(value) && value.charAt(14) === '7';
}
