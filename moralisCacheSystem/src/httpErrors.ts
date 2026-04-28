export class HttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function badRequest(message: string) {
  return new HttpError(400, message);
}

export function unauthorized(message = 'Unauthorized') {
  return new HttpError(401, message);
}

export function tooManyRequests(message = 'Too many requests') {
  return new HttpError(429, message);
}
