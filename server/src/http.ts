// Small helpers shared by the route modules.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A required string field, trimmed, with a length check. */
export function str(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw new HttpError(400, `Campo "${field}" é obrigatório.`);
  const v = value.trim();
  if (v.length < min || v.length > max) throw new HttpError(400, `"${field}" deve ter entre ${min} e ${max} caracteres.`);
  return v;
}
