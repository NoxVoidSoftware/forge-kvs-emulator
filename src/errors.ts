/**
 * Errors returned by the emulated storage service.
 *
 * The emulator answers like the Forge KVS REST API: a non-2xx response with a
 * `{ code, message }` body. The real `@forge/kvs` client turns that into a
 * `ForgeKvsAPIError` with the same `code`, so application code sees exactly
 * what it would see on Forge.
 */

/**
 * Error codes the emulator returns.
 *
 * Codes marked "documented" appear in the Forge documentation or SDK; the
 * others are the emulator's best approximation of undocumented behaviour and
 * may differ from Forge. Prefer asserting on the documented ones.
 */
export const ErrorCode = {
  /** Documented (SDK): read or delete of a missing key. `@forge/kvs` maps it to `undefined`. */
  KEY_NOT_FOUND: 'KEY_NOT_FOUND',
  /** Documented. */
  EMPTY_KEY: 'EMPTY_KEY',
  /** Documented: the key does not match the allowed pattern. */
  INVALID_KEY: 'INVALID_KEY',
  /** Documented: keys are limited to 500 characters. */
  KEY_TOO_LONG: 'KEY_TOO_LONG',
  /** Documented: value larger than 240 KiB. */
  MAX_SIZE: 'MAX_SIZE',
  /** Documented: object nested too deeply. */
  MAX_DEPTH: 'MAX_DEPTH',
  /** Documented: entity value does not match the declared attribute type. */
  INVALID_ENTITY_VALUE: 'INVALID_ENTITY_VALUE',
  /** Observed on Forge: an entity attribute with an empty (or blank) string. */
  EMPTY_PROPERTY_VALUE: 'EMPTY_PROPERTY_VALUE',
  /** Documented: the entity name is not valid. */
  INVALID_ENTITY_TYPE: 'INVALID_ENTITY_TYPE',
  /** Approximation: the entity is not declared in the manifest. */
  ENTITY_NOT_FOUND: 'ENTITY_NOT_FOUND',
  /** Approximation: the attribute is not declared for the entity (strict mode). */
  UNKNOWN_ENTITY_ATTRIBUTE: 'UNKNOWN_ENTITY_ATTRIBUTE',
  /** Approximation: the index is not declared, or its partition is wrong. */
  INVALID_INDEX: 'INVALID_INDEX',
  /** Approximation: combined index values exceed 900 B (range) / 1700 B (partition). */
  INDEX_VALUE_TOO_LARGE: 'INDEX_VALUE_TOO_LARGE',
  /** Approximation: `keyPolicy: 'FAIL_IF_EXISTS'` and the key exists. */
  KEY_ALREADY_EXISTS: 'KEY_ALREADY_EXISTS',
  /** Approximation: a transaction condition did not hold; nothing was written. */
  CONDITION_CHECK_FAILED: 'CONDITION_CHECK_FAILED',
  /** Approximation: malformed transaction (empty, duplicate keys, too many operations). */
  INVALID_TRANSACTION: 'INVALID_TRANSACTION',
  /** Approximation: the value is missing or of an unsupported type (e.g. `null`). */
  INVALID_VALUE: 'INVALID_VALUE',
  /** Approximation: the cursor was not issued by this emulator. */
  INVALID_CURSOR: 'INVALID_CURSOR',
  /** Approximation: malformed request (unknown condition, bad limit...). */
  INVALID_REQUEST: 'INVALID_REQUEST',
  /** Approximation: too many items in a batch request. */
  BATCH_TOO_LARGE: 'BATCH_TOO_LARGE',
  /** Approximation: request to an endpoint the emulator does not know. */
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED'
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** An error the emulated service responds with. */
export class KvsServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly context?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = 'KvsServiceError';
    this.status = status;
    this.code = code;
    this.context = context;
  }

  toBody(): { code: string; message: string; context?: Record<string, unknown> } {
    return this.context
      ? { code: this.code, message: this.message, context: this.context }
      : { code: this.code, message: this.message };
  }
}

/** Shorthand for a 400 error. */
export const badRequest = (code: string, message: string, context?: Record<string, unknown>): KvsServiceError =>
  new KvsServiceError(400, code, message, context);

/** The emulator was configured with an invalid schema or options. */
export class EmulatorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmulatorConfigError';
  }
}
