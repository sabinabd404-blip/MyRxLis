export class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const forbidden = (msg: string) => new HttpError(403, msg);
export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const conflict = (msg: string) => new HttpError(409, msg);
export const unauthorized = (msg: string) => new HttpError(401, msg);
export const tooMany = (msg: string) => new HttpError(429, msg);
